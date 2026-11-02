import { isGuardrailError, readGuardrailSnapshot, type FeeConstants } from '@/lib/guardrail';

/**
 * Reading the fee constants a drop was **published** with, in one place.
 *
 * ## Why this is its own module
 *
 * It began as a private helper in `join/service.ts`. Slice 2b needs the identical
 * numbers to create the PaymentIntent that backs the Payment Element, and the two
 * options were to duplicate the extraction or to share it. Duplicating it would
 * create precisely the defect ADR-002 exists to prevent: two places that decide how
 * money is read. The first rename of a snapshot field would then leave the join page
 * quoting one amount and authorising another, and nothing would fail — the
 * authorisation and the confirmation would simply disagree, invisibly, until a diner
 * read their statement.
 *
 * It is not in `rules.ts` because `rules.ts` is deliberately import-free: the join
 * page imports its constants, and anything that pulls in a module with imports drags
 * that module's whole graph into the browser bundle. This file is server-side only
 * by nature — it reads a snapshot — so it belongs next to the service that uses it.
 *
 * ## Why an unreadable snapshot is `null` rather than an exception
 *
 * `public-drops.ts` deliberately falls back to the dish's current menu price so that
 * a diner holding a link still sees a page. That is right for **display**. Charging
 * a card on a guessed fee is not the same act, so every money path treats `null` as
 * a refusal (`PRICE_UNAVAILABLE`) and logs it as the data error it is.
 */

/**
 * The fee constants in force when the drop was published.
 *
 * Reading `DEFAULT_FEES` instead would re-price a published drop the day the
 * platform changed its fee, so two diners on the same drop would pay different fees
 * depending on when they joined. The snapshot is the only correct source (M5 design
 * §11.1), which is why `platformFeeCentsForOrder` requires it and has no default.
 */
export function feesFromSnapshot(snapshot: unknown): FeeConstants | null {
  try {
    const { input } = readGuardrailSnapshot(snapshot);
    return {
      platformFeePct: input.platformFeePct,
      platformFeeFloorCents: input.platformFeeFloorCents,
      platformFeeCapCents: input.platformFeeCapCents,
      stripePct: input.stripePct,
      stripeFixedCents: input.stripeFixedCents,
    };
  } catch (error) {
    if (!isGuardrailError(error)) throw error;
    return null;
  }
}

/** Re-exported so callers do not import the guardrail module for one type. */
export type { FeeConstants };
