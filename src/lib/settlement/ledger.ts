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
 * | L1 | `charged − refunded == Σ order.subtotalCents where !refunded` | the `Order` rows |
 * | L2 | `platformFee == Σ order.platformFeeCents where !refunded` | the `Order` rows |
 * | L3 | `refunded == Σ order.subtotalCents where refunded` | the `Order` rows |
 * | L4 | per order: `CHARGE == order.subtotalCents` and `PLATFORM_FEE == order.platformFeeCents` | the order it hangs off |
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

/** The order fields the ledger cares about. Nothing else is read. */
export type LedgerOrder = {
  readonly id: string;
  readonly subtotalCents: number;
  readonly platformFeeCents: number;
  readonly refunded: boolean;
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
 * The `ADJUSTMENT` is not optional and not a detail: under a direct charge the
 * application fee is **not** returned by a refund unless
 * `refund_application_fee: true` was passed (ADR-001 §3.2). If the reversal ever
 * failed while the `REFUND` row was written, L2 would show us holding a fee on a
 * drop that never ran — which is why `refund()` on the port is typed with
 * `reverseApplicationFee: true` and cannot be called any other way.
 */
export function refundEntries(args: {
  dropId: string;
  order: { id: string; subtotalCents: number; platformFeeCents: number };
  refundedCents: number;
  stripeRef: string;
}): readonly [LedgerEntryShape, LedgerEntryShape] {
  return [
    {
      orderId: args.order.id,
      dropId: args.dropId,
      type: 'REFUND',
      // Negative: money left the connected account, back to the diner.
      amountCents: -Math.abs(args.refundedCents),
      stripeRef: args.stripeRef,
      note: 'refund',
    },
    {
      orderId: args.order.id,
      dropId: args.dropId,
      type: 'ADJUSTMENT',
      amountCents: -Math.abs(args.order.platformFeeCents),
      stripeRef: args.stripeRef,
      note: 'application_fee_reversed',
    },
  ];
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
 */
export function assertLedgerReconciles(args: {
  dropId: string;
  entries: readonly LedgerEntryShape[];
  orders: readonly LedgerOrder[];
}): void {
  const totals = dropLedgerTotals(args.entries);
  const live = args.orders.filter((order) => !order.refunded);
  const refunded = args.orders.filter((order) => order.refunded);

  const liveSubtotal = sum(live.map((order) => order.subtotalCents));
  const livePlatformFee = sum(live.map((order) => order.platformFeeCents));
  const refundedSubtotal = sum(refunded.map((order) => order.subtotalCents));

  fail(args.dropId, 'L1', totals.capturedGrossCents, liveSubtotal, 'charged − refunded vs Σ order.subtotalCents where !refunded');
  fail(args.dropId, 'L2', totals.platformFeeCents, livePlatformFee, 'platformFee vs Σ order.platformFeeCents where !refunded');
  fail(args.dropId, 'L3', totals.refundedCents, refundedSubtotal, 'refunded vs Σ order.subtotalCents where refunded');

  // L4 — per order. Named by order id, because the point of the check is which
  // row disagrees.
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
