import { SettlementIntegrityError } from './settlement-error';

/**
 * The ledger — pure, no I/O. Design §3.4, §6.
 *
 * ## Why §8.7's single sum is replaced by four identities
 *
 * The PRD says `SUM(LedgerEntry.amountCents) == Stripe net balance change for
 * that drop`. Under a direct charge (ADR-001) one drop moves money on **two**
 * Stripe accounts, in two directions, and one of the terms is Stripe's own card
 * fee which is in no column of ours. So no single sum equals either delta. §6.1
 * states the arithmetic; this module asserts what *can* be asserted in-process,
 * against our own `Order` rows:
 *
 * | # | Identity | Reconciled against |
 * |---|---|---|
 * | L1 | `charged − refunded == Σ order.subtotalCents` | the `Order` rows |
 * | L2 | `platformFee == Σ order.platformFeeCents` | the `Order` rows |
 * | L3 | `refunded == Σ order.refundedCents` | the `Order` rows |
 * | L4 | per order: `CHARGE == order.subtotalCents`, `PLATFORM_FEE == order.platformFeeCents`, `refunded == order.refundedCents`, `fee reversed == order.platformFeeReversedCents` | the order it hangs off |
 *
 * ## Why the order side is numeric rather than a `refunded` boolean
 *
 * Until FR-903 the order side was `refunded: boolean`, which was exact for as long
 * as every refund was a full refund — and it is exactly wrong the moment one is
 * not. A half-refunded order is neither refunded nor not, so L1 and L2 had to
 * classify it wholly one way or the other and were then out by the unrefunded
 * half, while L3 compared the partial refund against the order's *full* subtotal
 * and failed on correct behaviour. A boolean cannot carry a partial refund, and
 * the failure mode was the worst available: an identity that fires when the code
 * is right.
 *
 * So the order side is the same quantity the ledger records, and every identity
 * above is a **net** comparison over all orders rather than a partition into
 * refunded and not. L1 still holds the property it was written for — a refund
 * moves the same amount on both sides — and now holds it for any mix of partial
 * and full refunds in one drop.
 *
 * ## Why the order side is stored rather than derived from the ledger
 *
 * `Order.refundedCents` and `Order.platformFeeReversedCents` duplicate what the
 * `REFUND` and `ADJUSTMENT` rows say. That duplication is the point: an identity
 * that compares the ledger to the ledger cannot fail. The two are written in one
 * transaction and are required to agree, so a ledger row written twice, written
 * with the wrong sign, or silently dropped is caught.
 *
 * ## L5 is still absent, deliberately
 *
 * L5 — the reconciliation against two Stripe balance surfaces — needs Stripe and
 * is M8's nightly job. It is deliberately absent rather than stubbed: a check that
 * silently passes is worse than no check.
 *
 * ## Sign convention (§6.2)
 *
 * Positive = money arrived; negative = money left. Every entry is denominated in
 * the account named by its `type`:
 *
 *   - `CHARGE` — connected account, from the diner — `+`
 *   - `REFUND` — connected account, back to the diner — `−`
 *   - `PLATFORM_FEE` — platform, from the connected account — `+`
 *   - `ADJUSTMENT` — platform, when an application fee is reversed — `−`
 *   - `ORGANISER_COMMISSION` — platform, paid out — `−` (not written in this slice)
 */

export type LedgerEntryType =
  | 'CHARGE'
  | 'REFUND'
  | 'PLATFORM_FEE'
  | 'ORGANISER_COMMISSION'
  | 'ADJUSTMENT';

export type LedgerEntryShape = {
  /** The `Order` row for a capture; `null` for a drop-level adjustment. */
  readonly orderId: string | null;
  readonly dropId: string;
  readonly type: LedgerEntryType;
  /** Signed. See §6.2. */
  readonly amountCents: number;
  /** Charge id, refund id, or application-fee id. */
  readonly stripeRef: string | null;
  /** `capture` | `refund` | `application_fee_reversed`. */
  readonly note: string | null;
};

export type LedgerTotals = {
  /** Σ `CHARGE`. What diners were charged. */
  readonly chargedCents: number;
  /** |Σ `REFUND`|. What went back. */
  readonly refundedCents: number;
  /** Σ (`PLATFORM_FEE` + `ADJUSTMENT`). GroupEat's revenue net of reversals. */
  readonly platformFeeCents: number;
  /** `chargedCents − refundedCents`. */
  readonly capturedGrossCents: number;
};

/**
 * The order fields the ledger cares about. Nothing else is read.
 *
 * The last two are the order's own record of what has been refunded and reversed,
 * and they are what makes L1–L4 checks rather than tautologies — see the module
 * docblock. They are **totals**, accumulated across every refund on the order, so
 * the identities work for a partial refund and a full one with no special case.
 */
export type LedgerOrder = {
  readonly id: string;
  readonly subtotalCents: number;
  readonly platformFeeCents: number;
  /** What has gone back to the diner. `0` when nothing has. */
  readonly refundedCents: number;
  /** The part of our platform fee Stripe reports as returned to us. `0` when none. */
  readonly platformFeeReversedCents: number;
};

/** The two rows one captured participant writes. */
export function captureEntries(args: {
  dropId: string;
  order: { id: string; subtotalCents: number; platformFeeCents: number };
  stripeRef: string;
}): readonly [LedgerEntryShape, LedgerEntryShape] {
  return [
    {
      orderId: args.order.id,
      dropId: args.dropId,
      type: 'CHARGE',
      amountCents: args.order.subtotalCents,
      stripeRef: args.stripeRef,
      note: 'capture',
    },
    {
      orderId: args.order.id,
      dropId: args.dropId,
      type: 'PLATFORM_FEE',
      amountCents: args.order.platformFeeCents,
      stripeRef: args.stripeRef,
      note: 'capture',
    },
  ];
}

/**
 * The two rows one refunded participant writes.
 *
 * ## Why the reversed fee is an argument and not `order.platformFeeCents`
 *
 * This function used to write `-order.platformFeeCents` — the *whole* fee — while
 * taking `refundedCents` as an argument. That was correct for as long as every
 * caller passed a full refund, and wrong for every other input: on the repo's 8%
 * fee, refunding half of a 1112¢ order wrote a 44–45¢ phantom credit, because
 * Stripe reverses a proportional amount and the full fee is not proportional to
 * half a charge. Nothing failed, because the surplus landed in `ADJUSTMENT`, which
 * L3 does not check — a silent misstatement of our own revenue.
 *
 * So the reversed fee is now **read from the provider**, not assumed. Stripe's docs
 * say only that a partial refund reverses "a proportional amount of the application
 * fee" and never state the rounding; `ApplicationFee.amount_refunded` is the
 * reported answer, and `ChargePort.refund` returns it. Passing the order's full fee
 * here would require recomputing a number Stripe has already computed, and getting
 * it wrong by a cent is exactly as invisible as before.
 *
 * ## Why the ADJUSTMENT is still not optional
 *
 * Under a direct charge the application fee is **not** returned by a refund unless
 * `refund_application_fee: true` was passed (ADR-001 §3.2). If the reversal ever
 * failed while the `REFUND` row was written, L2 would show us holding a fee on a
 * drop that never ran — which is why `refund()` on the port is typed with
 * `reverseApplicationFee: true` and cannot be called any other way. A zero reversal
 * therefore writes no row at all rather than a `0` row: an `ADJUSTMENT` of zero
 * claims a reversal happened and netted out, which is a different fact from "the
 * fee was not touched".
 */
export function refundEntries(args: {
  dropId: string;
  /** Non-null: V1 writes no drop-level refund. */
  orderId: string;
  /** What the diner gets back. Positive; the sign is applied here. */
  refundedCents: number;
  /** What Stripe reports it returned of our application fee. Positive. */
  platformFeeReversedCents: number;
  stripeRef: string;
}): readonly LedgerEntryShape[] {
  if (!Number.isInteger(args.refundedCents) || args.refundedCents <= 0) {
    throw new SettlementIntegrityError({
      dropId: args.dropId,
      check: 'LEDGER_MISMATCH',
      detail: `a refund of ${args.refundedCents} cents is not a positive whole number of cents, so no refund entry is written`,
    });
  }
  if (!Number.isInteger(args.platformFeeReversedCents) || args.platformFeeReversedCents < 0) {
    throw new SettlementIntegrityError({
      dropId: args.dropId,
      check: 'LEDGER_MISMATCH',
      detail: `a reversed application fee of ${args.platformFeeReversedCents} cents is not a whole number of cents ≥ 0`,
    });
  }

  const entries: LedgerEntryShape[] = [
    {
      orderId: args.orderId,
      dropId: args.dropId,
      type: 'REFUND',
      // Negative: money left the connected account, back to the diner.
      amountCents: -args.refundedCents,
      stripeRef: args.stripeRef,
      note: 'refund',
    },
  ];

  if (args.platformFeeReversedCents > 0) {
    entries.push({
      orderId: args.orderId,
      dropId: args.dropId,
      type: 'ADJUSTMENT',
      amountCents: -args.platformFeeReversedCents,
      stripeRef: args.stripeRef,
      note: 'application_fee_reversed',
    });
  }

  return entries;
}

export function dropLedgerTotals(entries: readonly LedgerEntryShape[]): LedgerTotals {
  let chargedCents = 0;
  let refundSignedCents = 0;
  let platformFeeCents = 0;

  for (const entry of entries) {
    switch (entry.type) {
      case 'CHARGE':
        chargedCents += entry.amountCents;
        break;
      case 'REFUND':
        refundSignedCents += entry.amountCents;
        break;
      case 'PLATFORM_FEE':
      case 'ADJUSTMENT':
        platformFeeCents += entry.amountCents;
        break;
      case 'ORGANISER_COMMISSION':
        // Not written in this slice (§3.4). Counting it here would put a payout
        // inside the revenue figure the invariant is about.
        break;
    }
  }

  const refundedCents = Math.abs(refundSignedCents);
  return {
    chargedCents,
    refundedCents,
    platformFeeCents,
    capturedGrossCents: chargedCents - refundedCents,
  };
}

/**
 * L1–L4, asserted. Throws `SettlementIntegrityError('LEDGER_MISMATCH')` with both
 * sides in the message — the numbers are the whole value of the check, so a
 * message that says only "mismatch" would send the reader back to the database.
 *
 * Every identity sums over **all** orders and compares nets. There is no
 * `filter(order => order.refunded)` anywhere in this function, and that is a
 * deliberate change from the first version: a partition needs each order to be
 * wholly on one side, and a partially refunded order is on neither. See the module
 * docblock for what the boolean cost.
 */
export function assertLedgerReconciles(args: {
  dropId: string;
  entries: readonly LedgerEntryShape[];
  orders: readonly LedgerOrder[];
}): void {
  const totals = dropLedgerTotals(args.entries);

  // L1 — every cent charged, less every cent refunded, equals what the orders say
  // was charged. A refund that moves one side and not the other fails here.
  fail(args.dropId, 'L1', totals.capturedGrossCents, sum(args.orders.map((order) => order.subtotalCents - order.refundedCents)), 'charged − refunded vs Σ (order.subtotalCents − order.refundedCents)');

  // L2 — our revenue net of reversals equals the fees the orders still hold. A
  // reversal recorded at the wrong amount fails here, which is the check the old
  // boolean version could not make on a partial refund.
  fail(args.dropId, 'L2', totals.platformFeeCents, sum(args.orders.map((order) => order.platformFeeCents - order.platformFeeReversedCents)), 'platformFee vs Σ (order.platformFeeCents − order.platformFeeReversedCents)');

  // L3 — what the ledger says went back equals what the orders say went back.
  fail(args.dropId, 'L3', totals.refundedCents, sum(args.orders.map((order) => order.refundedCents)), 'refunded vs Σ order.refundedCents');

  // L4 — per order. Named by order id, because the point of the check is which
  // row disagrees. L1–L3 are aggregate, so two orders wrong in opposite
  // directions cancel and pass; L4 is what notices.
  for (const order of args.orders) {
    const charge = args.entries.find((entry) => entry.orderId === order.id && entry.type === 'CHARGE');
    if (!charge) {
      throw new SettlementIntegrityError({
        dropId: args.dropId,
        check: 'LEDGER_MISMATCH',
        detail: `L4: order ${order.id} has no CHARGE entry, so ${order.subtotalCents} was charged with nothing recorded`,
      });
    }
    fail(args.dropId, 'L4', charge.amountCents, order.subtotalCents, `CHARGE vs subtotalCents for order ${order.id}`);

    const fee = args.entries.find(
      (entry) => entry.orderId === order.id && entry.type === 'PLATFORM_FEE',
    );
    if (!fee) {
      throw new SettlementIntegrityError({
        dropId: args.dropId,
        check: 'LEDGER_MISMATCH',
        detail: `L4: order ${order.id} has no PLATFORM_FEE entry, so our fee of ${order.platformFeeCents} is unrecorded`,
      });
    }
    fail(args.dropId, 'L4', fee.amountCents, order.platformFeeCents, `PLATFORM_FEE vs platformFeeCents for order ${order.id}`);

    // L4, refunds — per order, because a refund on the WRONG order is invisible to
    // L1–L3: the drop-level totals are identical whether the money went back to
    // the right diner or the wrong one.
    const refundedOnLedger = -sum(
      args.entries
        .filter((entry) => entry.orderId === order.id && entry.type === 'REFUND')
        .map((entry) => entry.amountCents),
    );
    fail(args.dropId, 'L4', refundedOnLedger, order.refundedCents, `REFUND vs refundedCents for order ${order.id}`);

    // L4, reversals — and this one is the reason `platformFeeReversedCents` is a
    // column of its own. A reversed fee that is not proportional to the refund is a
    // number nobody can check by arithmetic, because Stripe does not document the
    // rounding; the only thing that can be checked is that we recorded what it said.
    const reversedOnLedger = -sum(
      args.entries
        .filter((entry) => entry.orderId === order.id && entry.type === 'ADJUSTMENT')
        .map((entry) => entry.amountCents),
    );
    fail(args.dropId, 'L4', reversedOnLedger, order.platformFeeReversedCents, `ADJUSTMENT vs platformFeeReversedCents for order ${order.id}`);
  }
}

function fail(
  dropId: string,
  identity: string,
  ledgerSide: number,
  orderSide: number,
  what: string,
): void {
  if (ledgerSide === orderSide) {
    return;
  }
  throw new SettlementIntegrityError({
    dropId,
    check: 'LEDGER_MISMATCH',
    detail: `${identity}: ${what} — ledger says ${ledgerSide}, orders say ${orderSide} (difference ${ledgerSide - orderSide})`,
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
