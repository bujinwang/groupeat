import { describe, expect, it } from 'vitest';

import {
  assertLedgerReconciles,
  captureEntries,
  dropLedgerTotals,
  type LedgerEntryShape,
  type LedgerOrder,
  refundEntries,
} from '../ledger';
import { SettlementIntegrityError } from '../settlement-error';

/**
 * The ledger's arithmetic and the four identities (design §6.3).
 *
 * These are the checks that can be made in-process, with no provider. L5 — the
 * reconciliation against two Stripe balance surfaces — is M8's and is deliberately
 * absent: a check that silently passes is worse than no check.
 */

const CAPTURED_ORDER = { id: 'order-1', subtotalCents: 2224, platformFeeCents: 178 };
const REFUNDED_ORDER = { id: 'order-2', subtotalCents: 1112, platformFeeCents: 89 };

/** Two orders: one still charged, one captured-then-refunded. Six rows. */
function sixEntries(): LedgerEntryShape[] {
  return [
    ...captureEntries({ dropId: 'drop-1', order: CAPTURED_ORDER, stripeRef: 'ch_1' }),
    ...captureEntries({ dropId: 'drop-1', order: REFUNDED_ORDER, stripeRef: 'ch_2' }),
    ...refundEntries({
      dropId: 'drop-1',
      order: REFUNDED_ORDER,
      refundedCents: REFUNDED_ORDER.subtotalCents,
      stripeRef: 're_1',
    }),
  ];
}

const ORDERS: LedgerOrder[] = [
  { id: CAPTURED_ORDER.id, subtotalCents: 2224, platformFeeCents: 178, refunded: false },
  { id: REFUNDED_ORDER.id, subtotalCents: 1112, platformFeeCents: 89, refunded: true },
];

describe('the entry builders', () => {
  it('writes a CHARGE and a PLATFORM_FEE per capture, both positive', () => {
    const entries = captureEntries({ dropId: 'drop-1', order: CAPTURED_ORDER, stripeRef: 'ch_1' });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      orderId: 'order-1',
      type: 'CHARGE',
      amountCents: 2224,
      stripeRef: 'ch_1',
      note: 'capture',
    });
    expect(entries[1]).toMatchObject({
      orderId: 'order-1',
      type: 'PLATFORM_FEE',
      amountCents: 178,
      note: 'capture',
    });
  });

  it('writes a negative REFUND and a negative ADJUSTMENT per refund', () => {
    // §6.2: positive = money arrived, negative = money left. The ADJUSTMENT is the
    // application fee coming back, and it is not optional under a direct charge
    // (ADR-001 §3.2).
    const entries = refundEntries({
      dropId: 'drop-1',
      order: CAPTURED_ORDER,
      refundedCents: 2224,
      stripeRef: 're_1',
    });

    expect(entries[0]).toMatchObject({ type: 'REFUND', amountCents: -2224, note: 'refund' });
    expect(entries[1]).toMatchObject({
      type: 'ADJUSTMENT',
      amountCents: -178,
      note: 'application_fee_reversed',
    });
  });
});

describe('dropLedgerTotals', () => {
  it('returns all four figures, with the refunded order netted out of our revenue', () => {
    const totals = dropLedgerTotals(sixEntries());

    expect(totals.chargedCents).toBe(3336);
    expect(totals.refundedCents).toBe(1112);
    // 178 + 89 − 89: the reversal cancels the fee on the refunded order only.
    expect(totals.platformFeeCents).toBe(178);
    expect(totals.capturedGrossCents).toBe(2224);
  });

  it('is zero on an empty list, not NaN', () => {
    expect(dropLedgerTotals([])).toEqual({
      chargedCents: 0,
      refundedCents: 0,
      platformFeeCents: 0,
      capturedGrossCents: 0,
    });
  });

  it('ignores ORGANISER_COMMISSION, which this slice does not write', () => {
    // Counting a payout inside the revenue figure would break L2 the moment M7
    // starts writing it (§3.4).
    const withCommission: LedgerEntryShape[] = [
      ...sixEntries(),
      {
        orderId: null,
        dropId: 'drop-1',
        type: 'ORGANISER_COMMISSION',
        amountCents: -111,
        stripeRef: null,
        note: null,
      },
    ];

    expect(dropLedgerTotals(withCommission).platformFeeCents).toBe(178);
  });
});

describe('assertLedgerReconciles', () => {
  it('passes on a consistent drop', () => {
    expect(() =>
      assertLedgerReconciles({ dropId: 'drop-1', entries: sixEntries(), orders: ORDERS }),
    ).not.toThrow();
  });

  it('throws LEDGER_MISMATCH when a CHARGE disagrees with its order by one cent, naming both', () => {
    const entries = sixEntries();
    const tampered = entries.map((entry) =>
      entry.orderId === 'order-1' && entry.type === 'CHARGE'
        ? { ...entry, amountCents: 2225 }
        : entry,
    );

    let caught: unknown;
    try {
      assertLedgerReconciles({ dropId: 'drop-1', entries: tampered, orders: ORDERS });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SettlementIntegrityError);
    const error = caught as SettlementIntegrityError;
    expect(error.check).toBe('LEDGER_MISMATCH');
    // The numbers are the whole value of the check. L1 fires before the per-order
    // L4 check, so the message names the identity and both sides of it.
    expect(error.message).toContain('L1');
    expect(error.message).toContain('2225');
    expect(error.message).toContain('2224');
    expect(error.message).toContain('difference 1');
  });

  it('throws when an order has no CHARGE row at all', () => {
    // Money left a diner's account and our ledger does not know about it. That is
    // the failure the whole module exists to make loud.
    const entries = sixEntries().filter(
      (entry) => !(entry.orderId === 'order-2' && entry.type === 'CHARGE'),
    );

    expect(() =>
      assertLedgerReconciles({ dropId: 'drop-1', entries, orders: ORDERS }),
    ).toThrow(SettlementIntegrityError);
  });

  it('throws when our fee is unrecorded on a captured order', () => {
    const entries = sixEntries().filter(
      (entry) => !(entry.orderId === 'order-1' && entry.type === 'PLATFORM_FEE'),
    );

    expect(() =>
      assertLedgerReconciles({ dropId: 'drop-1', entries, orders: ORDERS }),
    ).toThrow(/platformFee/);
  });

  it('accepts a fully refunded drop, where every identity nets to zero', () => {
    const entries: LedgerEntryShape[] = [
      ...captureEntries({ dropId: 'drop-2', order: REFUNDED_ORDER, stripeRef: 'ch_9' }),
      ...refundEntries({
        dropId: 'drop-2',
        order: REFUNDED_ORDER,
        refundedCents: REFUNDED_ORDER.subtotalCents,
        stripeRef: 're_9',
      }),
    ];

    expect(() =>
      assertLedgerReconciles({
        dropId: 'drop-2',
        entries,
        orders: [{ id: REFUNDED_ORDER.id, subtotalCents: 1112, platformFeeCents: 89, refunded: true }],
      }),
    ).not.toThrow();
    expect(dropLedgerTotals(entries).platformFeeCents).toBe(0);
    expect(dropLedgerTotals(entries).capturedGrossCents).toBe(0);
  });
});
