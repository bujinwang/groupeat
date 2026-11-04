import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';
import { PUBLIC_VISIBLE_STATUSES } from '@/lib/public/public-drops';
import { resolveDropView } from '@/lib/public/drop-view';
import { platformFeeCentsForOrder } from '@/lib/settlement/platform-fee';

import { feesFromSnapshot } from './fees';
import { dollars, checkQty, qtyLimitFor, refusalFromBlocked, resolveJoinMoney } from './rules';

/**
 * Quoting a join before a card exists — what the Payment Element needs.
 *
 * ## Why this is separate from `joinDrop`
 *
 * The Payment Element has to render with a `clientSecret` bound to a specific
 * amount. That amount depends on the quantity, and the diner has not submitted the
 * form yet — so the amount must be quoted **before** `joinDrop` runs, and `joinDrop`
 * is the function that creates the `DropParticipant` row.
 *
 * The obvious shortcut is to create the participant at quote time, and it is wrong
 * for two reasons that are both about money:
 *
 *   1. **A quote is not a commitment.** Every diner who opens the page and changes
 *      their mind would leave a `PENDING` row. `PENDING` counts toward capacity (it
 *      has to, or a drop oversells), so abandoned quotes would consume the drop's
 *      plates and could close a drop out from under real diners.
 *   2. **Nothing should exist to authorise before the diner says yes.** A row is an
 *      intention to charge. Creating one on page load means an intent exists for
 *      somebody who never pressed a button.
 *
 * So this module only *reads*: it resolves the drop, checks the same capacity rules,
 * and computes the same money — without writing anything.
 *
 * ## The rule that makes the two agree
 *
 * The quote and the authorisation must produce **the same cents**, and the way to
 * guarantee that is not to test it but to make them the same call. Both go through
 * `feesFromSnapshot` → `platformFeeCentsForOrder` → `resolveJoinMoney`, in that
 * order, with the same inputs read from the same frozen snapshot. The amount the
 * Payment Element displays is therefore the amount `joinDrop` will authorise, and a
 * test asserts the agreement directly rather than trusting the shared code path.
 *
 * The alternative — letting the browser send the amount — is an ADR-002 violation
 * and a trivially exploitable one: a diner could authorise one cent and the drop
 * would still count their plate.
 */

/** What a live quote needs to know. Read-only. */
export type QuoteRequest = {
  readonly publicCode: string;
  readonly qty: number;
};

export type JoinQuote = {
  readonly dropId: string;
  readonly merchantId: string;
  /** `qty × dealPriceCents`. Integer cents. The amount the Element will display. */
  readonly amountCents: number;
  /** `application_fee_amount`. Integer cents. Not shown to the diner. */
  readonly platformFeeCents: number;
  /**
   * The connected account the intent must be created on (ADR-001).
   *
   * `string`, not `string | null`: a merchant with no Connect account produces a
   * `PAYMENTS_NOT_CONFIGURED` refusal instead of a quote, so a quote that exists
   * always names an account. Typing it nullable here would force every caller to
   * re-check a condition this module has already decided, and the inevitable shape of
   * that re-check is `!` — which would let a null through to `forMerchant()` and fail
   * at Stripe instead of here.
   */
  readonly stripeAccountId: string;
  readonly qty: number;
  readonly unitPriceCents: number;
  /** `"$26.20"` — formatted once, server-side. */
  readonly amountLabel: string;
  readonly maxQty: number;
  readonly minQty: number;
  readonly maxPerCustomer: number;
};

export type QuoteRefusalReason =
  | 'NOT_FOUND'
  | 'CLOSED'
  /** The restaurant called the drop off. Distinct from `CLOSED`: not a deadline. */
  | 'CANCELLED'
  | 'SOLD_OUT'
  | 'NOT_ENOUGH_LEFT'
  | 'BAD_QTY'
  | 'PRICE_UNAVAILABLE'
  | 'PAYMENTS_NOT_CONFIGURED';

export type QuoteResult =
  | { readonly ok: true; readonly quote: JoinQuote }
  | { readonly ok: false; readonly reason: QuoteRefusalReason; readonly status: 404 | 409 | 422 | 500 | 503 };

/**
 * The same lock ordering as `joinDrop`, minus the write.
 *
 * `FOR UPDATE` is not needed: nothing is being changed, so there is no race to lose.
 * A quote that reads a momentarily stale count produces a clientSecret for an amount
 * that is still correct — the *quantity* check is re-run inside `joinDrop`'s
 * transaction, under the lock, where it counts. Being generous here and strict there
 * is the only ordering that cannot oversell.
 */
export async function quoteJoin(request: QuoteRequest): Promise<QuoteResult> {
  const qty = request.qty;

  const drop = await prisma.drop.findFirst({
    /**
     * The same visibility set the public page uses, not `PUBLISHED` alone.
     *
     * ## What the narrower filter silently did
     *
     * It was `status: { in: ['PUBLISHED'] }`, which reads as the obvious choice — you
     * can only quote a drop that is open. But everything the refusal mapping below
     * exists to say was therefore unreachable: a `CANCELLED` drop answered
     * `NOT_FOUND` ("check the link — it may have been mistyped"), and so did a
     * `FAILED` or already-`LOCKED` one. Meanwhile `/d/:code` and `/d/:code/join` both
     * load through `getPublicDrop`, which *does* accept those statuses, so the page
     * rendered "The restaurant called this drop off" next to a join form the API then
     * refused as if the code were wrong. The five-line comment justifying the
     * `CANCELLED` arm, and the harness header's status table, both described
     * behaviour no request could reach.
     *
     * `joinDrop` never had the bug: it locks the row by code with no status filter and
     * refuses with the right reason. This is the only place the two disagreed.
     *
     * ## Why this is not an information leak
     *
     * The rule `NOT_FOUND` protects is that a guessed code must not reveal a `DRAFT`.
     * `PUBLIC_VISIBLE_STATUSES` is that rule already written down, and it is what the
     * page itself filters on — so anything reachable here is a drop whose page is
     * public anyway. Reusing the constant rather than restating the list means the two
     * cannot drift apart again.
     */
    where: { publicCode: request.publicCode, status: { in: [...PUBLIC_VISIBLE_STATUSES] } },
    select: {
      id: true,
      merchantId: true,
      status: true,
      dealPriceCents: true,
      minQty: true,
      maxQty: true,
      maxPerCustomer: true,
      cutoffAt: true,
      windowStart: true,
      windowEnd: true,
      guardrailSnapshot: true,
      merchant: { select: { stripeAccountId: true } },
    },
  });

  if (!drop) {
    // A draft and a mistyped code answer identically, exactly as in `joinDrop`: a
    // guessed code must not reveal that an unpublished drop exists.
    return { ok: false, reason: 'NOT_FOUND', status: 404 };
  }

  // Capacity, summed over the same population `joinDrop` uses — `PENDING` included,
  // because a plate being authorised is a plate taken. A quote that ignored pending
  // joins would offer a card form for a drop that is about to refuse it.
  const soldRows = await prisma.$queryRaw<{ sold: number }[]>`
    SELECT COALESCE(SUM("qty"), 0)::int AS "sold"
      FROM "DropParticipant"
     WHERE "dropId" = ${drop.id}
       AND "authStatus" IN ('PENDING', 'AUTHORIZED')`;
  const soldQty = Number(soldRows[0]?.sold ?? 0);

  const view = resolveDropView({
    status: drop.status,
    minQty: drop.minQty,
    maxQty: drop.maxQty,
    cutoffAt: drop.cutoffAt,
    windowStart: drop.windowStart,
    windowEnd: drop.windowEnd,
    joinedQty: soldQty,
    now: new Date(),
  });

  const qtyCheck = checkQty(qty, qtyLimitFor(drop.maxPerCustomer));
  if (!qtyCheck.ok) {
    return { ok: false, reason: 'BAD_QTY', status: 422 };
  }

  const blocked = refusalFromBlocked(view.joinBlockedReason, qty, drop.maxQty - soldQty);
  if (blocked !== null) {
    // The join vocabulary is wider than the quote's: a quote can meet a drop that is
    // closed, sold out, short of plates, or already failed, but it cannot meet the
    // ones that are about a specific diner (`BAD_PHONE`, `PAYMENT_DECLINED`) because
    // it happens before any of that.
    //
    // Mapped exhaustively rather than with a fallthrough: a reason added to
    // `JoinRefusalReason` later should make this fail to compile, not silently
    // become `CLOSED` and tell a diner the wrong thing.
    const reason: QuoteRefusalReason =
      blocked === 'SOLD_OUT'
        ? 'SOLD_OUT'
        : blocked === 'NOT_ENOUGH_LEFT'
          ? 'NOT_ENOUGH_LEFT'
          : blocked === 'CANCELLED'
            ? // Its own member rather than `CLOSED`, for the same reason `joinBlockedReason`
              // has one: a diner told "ordering has closed" about a drop cancelled at noon
              // would go looking for a cutoff that never mattered. `FAILED` maps to `CLOSED`
              // here because a quote on a failed drop is asking "can I still get in" and the
              // honest answer is no; a cancellation is worth naming because it is a decision
              // somebody made, and it is the fact that stops them waiting for a re-run.
              'CANCELLED'
            : 'CLOSED';
    return { ok: false, reason, status: 409 };
  }

  const fees = feesFromSnapshot(drop.guardrailSnapshot);
  if (fees === null) {
    // A published drop whose snapshot this build cannot read. A data error: logged
    // with the drop id so it can be found without waiting for a diner to complain.
    logger.error('join.pricing_unavailable', { dropId: drop.id });
    return { ok: false, reason: 'PRICE_UNAVAILABLE', status: 500 };
  }

  // The one money algorithm (ADR-002/ADR-004 §4): round per unit, then multiply.
  const platformFeeCents = platformFeeCentsForOrder({
    qty,
    dealPriceCents: drop.dealPriceCents,
    fees,
  });

  const money = resolveJoinMoney({ qty, dealPriceCents: drop.dealPriceCents, platformFeeCents });
  if (!money.ok) {
    logger.error('join.pricing_unavailable', { dropId: drop.id });
    return { ok: false, reason: 'PRICE_UNAVAILABLE', status: 500 };
  }

  // A merchant who has not finished Connect onboarding cannot take a card. Refusing
  // here means the diner is told before filling in the form, rather than after.
  const stripeAccountId = drop.merchant.stripeAccountId;
  if (!stripeAccountId) {
    return { ok: false, reason: 'PAYMENTS_NOT_CONFIGURED', status: 503 };
  }

  return {
    ok: true,
    quote: {
      dropId: drop.id,
      merchantId: drop.merchantId,
      amountCents: money.money.amountCents,
      platformFeeCents: money.money.platformFeeCents,
      stripeAccountId,
      qty,
      unitPriceCents: money.money.unitPriceCents,
      // Formatted by the one formatter, not here. A sentence containing money is a
      // type signature (CONTRIBUTING.md), and a second `(cents/100).toFixed(2)` is a
      // second rounding rule that disagrees on a boundary and gets blamed on tax.
      amountLabel: dollars(money.money.amountCents),
      maxQty: drop.maxQty,
      minQty: drop.minQty,
      maxPerCustomer: drop.maxPerCustomer,
    },
  };
}
