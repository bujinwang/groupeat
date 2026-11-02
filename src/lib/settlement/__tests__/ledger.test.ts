import { describe, expect, it } from 'vitest';

import {
  assertLedgerReconciles,
  captureEntries,
  dropLedgerTotals,
  type LedgerEntryShape,
  type LedgerOrder,
  refundEntries,
} from '../ledger';
import { proportionalApplicationFeeRefund } from '../fake-charge-port';
import { SettlementIntegrityError } from '../settlement-error';

/**
 * The ledger's arithmetic and the four identities (design §6.3).
 *
 * These are the checks that can be made in-process, with no provider. L5 — the
 * reconciliation against two Stripe balance surfaces — is M8's and is deliberately
 * absent: a check that silently passes is worse than no check.
 *
 * ## The two refunds these tests care about
 *
 * A **full** refund reverses the whole application fee. A **partial** one reverses
 * a proportional slice of it (FR-903), and the slice is Stripe's answer, not our
 * arithmetic — see `refundEntries`' docblock. Every fixture below therefore carries
 * the reversed fee explicitly, and `REVERSAL` is computed by the same model the
 * fake port uses so a hand-written off-by-one cannot slip into a fixture.
 */

const CAPTURED_ORDER = {
  id: 'order-1',
  subtotalCents: 2224,
  platformFeeCents: 178,
  refundedCents: 0,
  platformFeeReversedCents: 0,
};

const REFUNDED_ORDER = {
  id: 'order-2',
  subtotalCents: 1112,
  platformFeeCents: 89,
  refundedCents: 1112,
  platformFeeReversedCents: 89,
};

/** A half-refunded order: 556 back to the diner, and whatever Stripe returned. */
const REFUNDED_HALF_CENTS = 556;
const REFUNDED_HALF_FEE = proportionalApplicationFeeRefund({
  chargedCents: REFUNDED_ORDER.subtotalCents,
  feeCents: REFUNDED_ORDER.platformFeeCents,
  refundCents: REFUNDED_HALF_CENTS,
});
const PARTIALLY_REFUNDED_ORDER = {
  id: 'order-3',
  subtotalCents: 1112,
  platformFeeCents: 89,
  refundedCents: REFUNDED_HALF_CENTS,
  platformFeeReversedCents: REFUNDED_HALF_FEE,
};

/** Two orders: one still charged, one captured-then-refunded. Six rows. */
function sixEntries(): LedgerEntryShape[] {
  return [
    ...captureEntries({ dropId: 'drop-1', order: CAPTURED_ORDER, stripeRef: 'ch_1' }),
    ...captureEntries({ dropId: 'drop-1', order: REFUNDED_ORDER, stripeRef: 'ch_2' }),
    ...refundEntries({
      dropId: 'drop-1',
      orderId: REFUNDED_ORDER.id,
      refundedCents: REFUNDED_ORDER.subtotalCents,
      platformFeeReversedCents: REFUNDED_ORDER.platformFeeReversedCents,
      stripeRef: 're_1',
    }),
  ];
}

const ORDERS: LedgerOrder[] = [CAPTURED_ORDER, REFUNDED_ORDER];

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

  it('writes a negative REFUND and a negative ADJUSTMENT for a full refund', () => {
    // §6.2: positive = money arrived, negative = money left. The ADJUSTMENT is the
    // application fee coming back, and it is not optional under a direct charge
    // (ADR-001 §3.2).
    const entries = refundEntries({
      dropId: 'drop-1',
      orderId: CAPTURED_ORDER.id,
      refundedCents: 2224,
      platformFeeReversedCents: 178,
      stripeRef: 're_1',
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'REFUND', amountCents: -2224, note: 'refund' });
    expect(entries[1]).toMatchObject({
      type: 'ADJUSTMENT',
      amountCents: -178,
      note: 'application_fee_reversed',
    });
  });

  it('writes a negative REFUND and a negative ADJUSTMENT for a partial refund', () => {
    const entries = refundEntries({
      dropId: 'drop-1',
      orderId: CAPTURED_ORDER.id,
      refundedCents: 1112,
      platformFeeReversedCents: 89,
      stripeRef: 're_2',
    });

    expect(entries[0]).toMatchObject({ type: 'REFUND', amountCents: -1112 });
    expect(entries[1]).toMatchObject({ type: 'ADJUSTMENT', amountCents: -89 });
  });

  it('reverses the fee it is told to reverse, NOT the order the refund belongs to', () => {
    // The defect this replaces: `refundEntries` wrote `-order.platformFeeCents`,
    // which was correct only while every caller passed a full refund. Here the
    // refund is 556 of 1112 and the reversed fee is 44, not 89. An implementation
    // that reached for the order's whole fee would produce -89 and show up as the
    // one-cent-and-a-half discrepancy this assertion is about.
    const entries = refundEntries({
      dropId: 'drop-1',
      orderId: REFUNDED_ORDER.id,
      refundedCents: REFUNDED_HALF_CENTS,
      platformFeeReversedCents: REFUNDED_HALF_FEE,
      stripeRef: 're_3',
    });

    const adjustment = entries.find((entry) => entry.type === 'ADJUSTMENT');
    expect(adjustment?.amountCents).toBe(-REFUNDED_HALF_FEE);
    expect(adjustment?.amountCents).not.toBe(-REFUNDED_ORDER.platformFeeCents);
  });

  it('writes no ADJUSTMENT at all when no fee was reversed', () => {
    // A `0` ADJUSTMENT would claim a reversal happened and netted out, which is a
    // different fact from "the fee was not touched". Only the REFUND row is written.
    const entries = refundEntries({
      dropId: 'drop-1',
      orderId: CAPTURED_ORDER.id,
      refundedCents: 500,
      platformFeeReversedCents: 0,
      stripeRef: 're_4',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'REFUND', amountCents: -500 });
  });

  it('refuses a negative, zero or fractional refund rather than writing a wrong row', () => {
    for (const bad of [0, -100, 12.5]) {
      expect(() =>
        refundEntries({
          dropId: 'drop-1',
          orderId: CAPTURED_ORDER.id,
          refundedCents: bad,
          platformFeeReversedCents: 10,
          stripeRef: 're_x',
        }),
      ).toThrow(SettlementIntegrityError);
    }
  });

  it('refuses a negative or fractional reversed fee', () => {
    for (const bad of [-1, 10.5]) {
      expect(() =>
        refundEntries({
          dropId: 'drop-1',
          orderId: CAPTURED_ORDER.id,
          refundedCents: 500,
          platformFeeReversedCents: bad,
          stripeRef: 're_x',
        }),
      ).toThrow(SettlementIntegrityError);
    }
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
        orderId: REFUNDED_ORDER.id,
        refundedCents: REFUNDED_ORDER.subtotalCents,
        platformFeeReversedCents: REFUNDED_ORDER.platformFeeReversedCents,
        stripeRef: 're_9',
      }),
    ];

    expect(() =>
      assertLedgerReconciles({ dropId: 'drop-2', entries, orders: [REFUNDED_ORDER] }),
    ).not.toThrow();
    expect(dropLedgerTotals(entries).platformFeeCents).toBe(0);
    expect(dropLedgerTotals(entries).capturedGrossCents).toBe(0);
  });

  /**
   * The block below is the reason this slice exists. Each test is a fact that the
   * old boolean `refunded` flag could not express, and each one fails against that
   * version.
   */
  describe('a partially refunded order', () => {
    function partialEntries(): LedgerEntryShape[] {
      return [
        ...captureEntries({ dropId: 'drop-p', order: PARTIALLY_REFUNDED_ORDER, stripeRef: 'ch_p' }),
        ...refundEntries({
          dropId: 'drop-p',
          orderId: PARTIALLY_REFUNDED_ORDER.id,
          refundedCents: REFUNDED_HALF_CENTS,
          platformFeeReversedCents: REFUNDED_HALF_FEE,
          stripeRef: 're_p',
        }),
      ];
    }

    it('reconciles, which the boolean partition could not do', () => {
      // With `refunded: true` the order left L1's "live" side entirely and arrived
      // on L3's side at its FULL subtotal, so a 556-cent refund against a 1112-cent
      // order was 556 out on two identities at once. As nets it is exact.
      expect(() =>
        assertLedgerReconciles({
          dropId: 'drop-p',
          entries: partialEntries(),
          orders: [PARTIALLY_REFUNDED_ORDER],
        }),
      ).not.toThrow();
    });

    it('leaves the unrefunded half counted as charged', () => {
      const totals = dropLedgerTotals(partialEntries());

      expect(totals.chargedCents).toBe(1112);
      expect(totals.refundedCents).toBe(556);
      expect(totals.capturedGrossCents).toBe(556);
    });

    it('keeps the fee we actually kept in our revenue', () => {
      // 89 charged, 44 or 45 returned: we keep the difference. L2 is what makes
      // this a fact rather than an assumption.
      const totals = dropLedgerTotals(partialEntries());

      expect(totals.platformFeeCents).toBe(89 - REFUNDED_HALF_FEE);
      expect(totals.platformFeeCents).toBeGreaterThan(0);
      expect(totals.platformFeeCents).toBeLessThan(89);
    });

    it('catches a reversal recorded at the whole fee instead of the proportional part', () => {
      // THE regression test for the old `refundEntries`. Same refund, same fee
      // reversal as far as the ledger row is concerned — but Stripe only gave back
      // REFUNDED_HALF_FEE, so recording 89 is a 44–45 cent overstatement of what we
      // returned and an understatement of our revenue. L2 is the identity that
      // notices, and the per-order L4 check names the order.
      const wrong = partialEntries().map((entry) =>
        entry.type === 'ADJUSTMENT'
          ? { ...entry, amountCents: -PARTIALLY_REFUNDED_ORDER.platformFeeCents }
          : entry,
      );

      let caught: unknown;
      try {
        assertLedgerReconciles({
          dropId: 'drop-p',
          entries: wrong,
          orders: [PARTIALLY_REFUNDED_ORDER],
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SettlementIntegrityError);
      expect((caught as SettlementIntegrityError).message).toContain('L2');
    });

    it('catches a refund applied to the wrong order, which the drop totals cannot see', () => {
      // L1–L3 are aggregates: moving a refund from one order to another leaves every
      // drop-level total identical, so nothing above L4 can notice. L4 does, and
      // getting the money back to the wrong diner is the failure worth catching.
      //
      // Both orders are present and correctly captured, so the ONLY thing wrong is
      // which order the REFUND row hangs off.
      const moved: LedgerEntryShape[] = [
        ...captureEntries({ dropId: 'drop-p', order: CAPTURED_ORDER, stripeRef: 'ch_p1' }),
        ...captureEntries({ dropId: 'drop-p', order: PARTIALLY_REFUNDED_ORDER, stripeRef: 'ch_p2' }),
        ...refundEntries({
          dropId: 'drop-p',
          orderId: CAPTURED_ORDER.id,
          refundedCents: REFUNDED_HALF_CENTS,
          platformFeeReversedCents: REFUNDED_HALF_FEE,
          stripeRef: 're_p',
        }),
      ];

      // The aggregates agree — which is exactly the point. The refund is attributed
      // to the OTHER order on both sides, so only the per-order check has anything
      // to be unhappy about.
      expect(() =>
        assertLedgerReconciles({
          dropId: 'drop-p',
          entries: moved,
          orders: [
            {
              ...CAPTURED_ORDER,
              refundedCents: REFUNDED_HALF_CENTS,
              platformFeeReversedCents: REFUNDED_HALF_FEE,
            },
            { ...PARTIALLY_REFUNDED_ORDER, refundedCents: 0, platformFeeReversedCents: 0 },
          ],
        }),
      ).not.toThrow();

      expect(() =>
        assertLedgerReconciles({
          dropId: 'drop-p',
          entries: moved,
          orders: [CAPTURED_ORDER, PARTIALLY_REFUNDED_ORDER],
        }),
      ).toThrow(/REFUND vs refundedCents/);
    });

    it('catches the order total and the ledger row disagreeing by one cent', () => {
      const offByOne: LedgerOrder = {
        ...PARTIALLY_REFUNDED_ORDER,
        refundedCents: REFUNDED_HALF_CENTS + 1,
      };

      // L1 fires rather than L3, because L1 aggregates the same fact and runs first.
      // Either identity would be right; the assertion is that a one-cent divergence
      // between the ledger and the order cannot pass, and that the message puts both
      // numbers in front of the reader.
      let caught: unknown;
      try {
        assertLedgerReconciles({
          dropId: 'drop-p',
          entries: partialEntries(),
          orders: [offByOne],
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SettlementIntegrityError);
      const message = (caught as SettlementIntegrityError).message;
      expect(message).toContain('556');
      expect(message).toContain('555');
      expect(message).toContain('difference 1');
    });
  });
});
