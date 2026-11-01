import { AppError } from '@/lib/errors';
import { getDrop, markPublished, type DropRow } from '@/lib/db/drops';
import { prisma } from '@/lib/db/prisma';
import {
  DEFAULT_FEES,
  buildGuardrailSnapshot,
  evaluateDeal,
  validateItemCosts,
} from '@/lib/guardrail';
import type { CompleteGuardrailInput } from '@/lib/guardrail';
import { toPct } from '@/lib/db/merchants';
import { logger } from '@/lib/logging/logger';

import { validateDropQuantities, validateDropTiming } from './rules';

/**
 * FR-207 — publish a drop, refusing anything that would lose the merchant money.
 *
 * ## Why the guardrail is re-run here
 *
 * The client already evaluated a price to render the slider and the panel. That
 * evaluation is **not** evidence: the request body is attacker-controlled, and
 * the dish, the floor, or the fee constants may have changed since the form was
 * rendered. So the publish path rebuilds the input from the **database** and
 * evaluates again. Nothing money-related is trusted from the request.
 *
 * That is also why `dealPriceCents` on the drop row — not on the request — is
 * what gets evaluated. A merchant who edited the price via `PATCH` and publishes
 * separately gets the price that is actually stored.
 *
 * ## The four refusals, in the order they are checked
 *
 *   1. **Status.** Only a `DRAFT` publishes. Checked first because every later
 *      check is meaningless on a live drop.
 *   2. **Eligibility.** A dish that is not batchable, or contains alcohol, can
 *      never be a drop (FR-104, AGLC hard block). Re-checked from the database
 *      rather than trusting the draft's provenance — the dish may have been
 *      edited after the draft was created.
 *   3. **Cost data.** `validateItemCosts` and the guardrail's own completeness
 *      check, because `foodCostCents` being absurd is a merchant data-entry
 *      problem that must be fixed before anything is priced, not after.
 *   4. **Price against the floor.** The clamp. `dealPriceCents` must be at least
 *      `minViablePriceCents`; `null` means no price clears the floor and the
 *      dish cannot be a deal at this margin at all.
 *
 * Then timing and quantities (§4.1 / §8.3), then the Stripe readiness gate.
 *
 * ## What "clamping" does *not* mean
 *
 * This function never quietly raises the price. A silent adjustment would
 * publish a drop at a price the merchant never saw. It refuses and says which
 * number to use; the merchant decides.
 */

export type PublishRefusal = {
  reason:
    | 'NOT_DRAFT'
    | 'PRICE_BELOW_FLOOR'
    | 'ITEM_INELIGIBLE'
    | 'INVALID_TIMING'
    | 'INVALID_QUANTITIES'
    | 'PAYOUTS_NOT_READY';
  fieldErrors: Record<string, string>;
  message: string;
};

/**
 * Checks everything except payouts. Exported so a draft screen can show the
 * blocking problems before the merchant presses publish, using the same code the
 * publish path runs — a preview that disagrees with the server is worse than no
 * preview.
 */
export async function reviewForPublish(args: {
  drop: DropRow;
  now: Date;
}): Promise<{ refusals: PublishRefusal[]; input: CompleteGuardrailInput | null }> {
  const { drop, now } = args;
  const refusals: PublishRefusal[] = [];

  if (drop.status !== 'DRAFT') {
    refusals.push({
      reason: 'NOT_DRAFT',
      fieldErrors: {},
      message: 'This drop has already been published.',
    });
    // Nothing else is meaningful on a live drop.
    return { refusals, input: null };
  }

  const [item, merchant] = await Promise.all([
    prisma.menuItem.findUnique({
      where: { id: drop.menuItemId },
      select: {
        id: true,
        merchantId: true,
        menuPriceCents: true,
        foodCostCents: true,
        packagingCents: true,
        batchYield: true,
        prepMinutes: true,
        isBatchable: true,
        containsAlcohol: true,
        archivedAt: true,
      },
    }),
    prisma.merchant.findUnique({
      where: { id: drop.merchantId },
      select: { floorPctOfMenu: true },
    }),
  ]);

  if (!item) {
    throw AppError.notFound('That dish could not be found.');
  }
  if (!merchant) {
    throw AppError.notFound('That merchant could not be found.');
  }

  // (2) Eligibility, from the database, not from the draft.
  if (item.containsAlcohol) {
    refusals.push({
      reason: 'ITEM_INELIGIBLE',
      fieldErrors: {
        menuItemId: 'This dish contains alcohol, which cannot be sold as a drop in Alberta.',
      },
      message: 'This dish cannot be a drop.',
    });
  }
  if (!item.isBatchable) {
    refusals.push({
      reason: 'ITEM_INELIGIBLE',
      fieldErrors: { menuItemId: 'This dish is marked as not batchable.' },
      message: 'This dish cannot be a drop.',
    });
  }
  if (item.archivedAt !== null) {
    refusals.push({
      reason: 'ITEM_INELIGIBLE',
      fieldErrors: { menuItemId: 'This dish has been archived.' },
      message: 'This dish cannot be a drop.',
    });
  }

  // (3) Cost data. The same predicate the item form used, re-run.
  const issues = validateItemCosts({
    menuPriceCents: item.menuPriceCents,
    foodCostCents: item.foodCostCents,
    packagingCents: item.packagingCents,
    batchYield: item.batchYield,
    prepMinutes: item.prepMinutes,
  });
  if (issues.length > 0) {
    refusals.push({
      reason: 'ITEM_INELIGIBLE',
      fieldErrors: {
        menuItemId: 'This dish has a cost problem. Fix the dish, then publish this drop.',
      },
      message: 'This dish cannot be a drop until its costs are fixed.',
    });
  }

  const input: CompleteGuardrailInput = {
    ...DEFAULT_FEES,
    menuPriceCents: item.menuPriceCents,
    foodCostCents: item.foodCostCents,
    packagingCents: item.packagingCents,
    // The `Decimal` boundary, handled in exactly one place.
    floorPctOfMenu: toPct(merchant.floorPctOfMenu),
  };

  // (4) The clamp. Only meaningful when the cost data is sound.
  if (issues.length === 0) {
    const evaluation = evaluateDeal(input, drop.dealPriceCents);

    if (evaluation.minViablePriceCents === null) {
      refusals.push({
        reason: 'PRICE_BELOW_FLOOR',
        fieldErrors: {
          dealPriceCents:
            'No price clears your minimum margin on this dish. Try a different dish, or change your minimum margin.',
        },
        message: 'This dish cannot be a deal at your minimum margin.',
      });
    } else if (
      evaluation.isBelowFloor ||
      drop.dealPriceCents < evaluation.minViablePriceCents
    ) {
      // Names the exact number, so the fix is mechanical rather than a guess.
      refusals.push({
        reason: 'PRICE_BELOW_FLOOR',
        fieldErrors: {
          dealPriceCents: `The lowest price that still works is $${(evaluation.minViablePriceCents / 100).toFixed(2)}.`,
        },
        message: 'That price loses you money.',
      });
    }

    if (drop.dealPriceCents > item.menuPriceCents) {
      // A "deal" above the menu price is a pricing error, and shipping it would
      // also break the Competition Act requirement that a discount be real
      // (PRD-v1 §15.2).
      refusals.push({
        reason: 'PRICE_BELOW_FLOOR',
        fieldErrors: {
          dealPriceCents: `A deal has to be cheaper than the menu price of $${(item.menuPriceCents / 100).toFixed(2)}.`,
        },
        message: 'The deal price is higher than the menu price.',
      });
    }
  }

  // Timing (§8.3) and quantities (§4.1). `now` is the prospective publish time.
  const timingIssues = validateDropTiming(
    { windowStart: drop.windowStart, windowEnd: drop.windowEnd, cutoffAt: drop.cutoffAt },
    now,
  );
  const quantityIssues = validateDropQuantities({
    minQty: drop.minQty,
    maxQty: drop.maxQty,
    batchYield: item.batchYield,
  });

  if (timingIssues.length > 0) {
    refusals.push({
      reason: 'INVALID_TIMING',
      fieldErrors: Object.fromEntries(timingIssues.map((issue) => [issue.field, issue.message])),
      message: 'Check the dates for this drop.',
    });
  }
  if (quantityIssues.length > 0) {
    refusals.push({
      reason: 'INVALID_QUANTITIES',
      fieldErrors: Object.fromEntries(
        quantityIssues.map((issue) => [issue.field, issue.message]),
      ),
      message: 'Check how many you need and how many you will make.',
    });
  }

  return { refusals, input };
}

/**
 * Publishes a draft and freezes its snapshot, exactly once.
 *
 * `payoutsReady` is pre-resolved by the caller rather than checked in here for
 * two reasons: this module stays free of a Stripe import, and a test can
 * exercise the refusal without a fake port.
 */
export async function publishDrop(args: {
  merchantIds: readonly string[];
  dropId: string;
  actorId: string;
  now: Date;
  /** `false` means Stripe onboarding is not READY. `true` means it is. */
  payoutsReady: boolean;
}): Promise<{ drop: DropRow; snapshot: ReturnType<typeof buildGuardrailSnapshot> }> {
  const drop = await getDrop(args.merchantIds, args.dropId);

  const { refusals, input } = await reviewForPublish({ drop, now: args.now });

  if (refusals.length > 0) {
    for (const refusal of refusals) {
      logger.info('drop.publish_refused', {
        actorId: args.actorId,
        dropId: drop.id,
        reason: refusal.reason,
      });
    }

    // Merge every refusal's field errors so a form can mark all of them at once,
    // but take the **first refusal's field message as the thrown message** when
    // there is exactly one field involved.
    //
    // Why: the 422's `message` is what a caller without field-aware rendering
    // shows the user, and "Check the dates for this drop." is useless where the
    // actual problem is "Joining has to close within 5 days of publishing."
    // The specific sentence is already written; losing it here would be a
    // presentation bug that costs the merchant a support call.
    const fieldErrors: Record<string, string> = {};
    for (const refusal of refusals) {
      for (const [field, text] of Object.entries(refusal.fieldErrors)) {
        // First writer wins: two refusals naming the same field would otherwise
        // show whichever happened to be merged last.
        fieldErrors[field] ??= text;
      }
    }

    const fieldMessages = Object.values(fieldErrors);
    const message =
      fieldMessages.length === 1 ? (fieldMessages[0] ?? refusals[0]!.message) : refusals[0]!.message;

    throw AppError.validation(fieldErrors, message);
  }

  // The payouts gate (FR-102). Checked last so the merchant fixes their own
  // numbers first — a missing Stripe account is not their job in the moment.
  if (!args.payoutsReady) {
    logger.info('drop.publish_refused', {
      actorId: args.actorId,
      dropId: drop.id,
      reason: 'PAYOUTS_NOT_READY',
    });
    throw new AppError(
      409,
      'Finish payout setup before publishing a drop. Diners cannot be charged until payouts work.',
    );
  }

  // `input` is non-null whenever the drop is a draft with no refusals; the
  // early return above covers the only path that leaves it null.
  if (input === null) {
    throw new Error('reviewForPublish returned no input for a draft with no refusals.');
  }

  const snapshot = buildGuardrailSnapshot(input, drop.dealPriceCents, args.now.toISOString());

  const published = await markPublished({
    id: drop.id,
    publishedAt: args.now,
    guardrailSnapshot: snapshot,
  });

  logger.info('drop.published', {
    actorId: args.actorId,
    dropId: published.id,
    merchantId: published.merchantId,
    dealPriceCents: published.dealPriceCents,
  });

  return { drop: published, snapshot };
}
