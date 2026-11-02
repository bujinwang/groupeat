import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { platformFeeCentsForOrder, platformFeeCentsPerUnit } from '../platform-fee';

/**
 * ADR-004 §4: the platform fee is rounded **per unit, then multiplied**.
 *
 * This is the file that makes that decision executable. Until it existed the rule
 * was prose in `settle.ts` and a hand-written expression in five test files —
 * `qty * roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES))` — which is three
 * places to get one number wrong, and none of them is the code that will eventually
 * write `DropParticipant.platformFeeCents`.
 *
 * The two vectors below are the reason the distinction is not pedantic. Both are
 * taken from ADR-004 §4.2, and both are cases where rounding the order total
 * produces a *different, wrong* number rather than the same number by luck.
 */

describe('per unit, then multiplied', () => {
  it('pins ADR-004 vector A: three plates at $11.12 carry 267, not 200', () => {
    // roundHalfUp(platformFeeAt(1112)) = roundHalfUp(88.96) = 89, so 3 × 89 = 267.
    // Rounding the $33.36 order total instead hits the $2.00 cap once: 200.
    const perUnit = platformFeeCentsPerUnit({ dealPriceCents: 1112, fees: DEFAULT_FEES });
    expect(perUnit).toBe(89);

    expect(platformFeeCentsForOrder({ qty: 3, dealPriceCents: 1112, fees: DEFAULT_FEES })).toBe(267);

    // The wrong answer, computed the wrong way, so the assertion above is not
    // measuring the same expression twice.
    const perOrder = roundHalfUp(platformFeeAt(3 * 1112, DEFAULT_FEES));
    expect(perOrder).toBe(200);
    expect(perOrder).not.toBe(267);
  });

  it('pins ADR-004 §4.2 vector B: three plates at $5.00 clear the 60c floor three times', () => {
    // roundHalfUp(platformFeeAt(500)) = roundHalfUp(40) = 60, the floor. Three
    // plates: 180. Rounding the $15.00 total once: roundHalfUp(120) = 120.
    expect(platformFeeCentsPerUnit({ dealPriceCents: 500, fees: DEFAULT_FEES })).toBe(60);
    expect(platformFeeCentsForOrder({ qty: 3, dealPriceCents: 500, fees: DEFAULT_FEES })).toBe(180);

    expect(roundHalfUp(platformFeeAt(1500, DEFAULT_FEES))).toBe(120);
  });

  it('is linear in qty by construction, for every price it accepts', () => {
    // The property the merchant's promise rests on: the fee per plate does not
    // depend on how many plates one diner happened to order. Checked over a spread
    // of prices including both clamp boundaries, so a future change that starts
    // rounding the total fails on a price the author did not have in mind.
    const prices = [1, 100, 500, 750, 1112, 1500, 2499, 2500, 3000, 5560, 10_000, 99_999];
    for (const dealPriceCents of prices) {
      const unit = platformFeeCentsPerUnit({ dealPriceCents, fees: DEFAULT_FEES });
      for (const qty of [1, 2, 3, 5, 12, 40]) {
        expect(
          platformFeeCentsForOrder({ qty, dealPriceCents, fees: DEFAULT_FEES }),
          `${String(qty)} × ${String(dealPriceCents)}`,
        ).toBe(qty * unit);
      }
    }
  });

  it('returns an integer for every input, so no fractional cent can reach the ledger', () => {
    // `platformFeeAt` returns a float (88.96). If the rounding moved to the wrong
    // side of the multiplication, the result would carry a fraction and
    // `LedgerEntry.amountCents` — an Int column — would be written with a truncated
    // or rejected value. That is a silent money bug, so it is asserted directly.
    for (const dealPriceCents of [1, 7, 13, 1112, 1234, 9999]) {
      for (const qty of [1, 3, 7, 25]) {
        const cents = platformFeeCentsForOrder({ qty, dealPriceCents, fees: DEFAULT_FEES });
        expect(Number.isInteger(cents), `${String(cents)} must be a whole cent`).toBe(true);
        expect(cents).toBeGreaterThan(0);
      }
    }
  });
});

describe('what it refuses', () => {
  it('rejects a qty that is not a positive integer', () => {
    for (const qty of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => platformFeeCentsForOrder({ qty, dealPriceCents: 1112, fees: DEFAULT_FEES })).toThrow(
        RangeError,
      );
    }
  });

  it('rejects a price that is not a positive integer', () => {
    for (const dealPriceCents of [0, -100, 11.12, Number.NaN]) {
      expect(() => platformFeeCentsForOrder({ qty: 1, dealPriceCents, fees: DEFAULT_FEES })).toThrow(
        RangeError,
      );
    }
  });

  it('names the field and the value, because a RangeError in a join path is read at 2am', () => {
    expect(() => platformFeeCentsForOrder({ qty: 0, dealPriceCents: 1112, fees: DEFAULT_FEES })).toThrow(
      /qty must be a positive integer, got 0/,
    );
  });

  it('requires the fee constants, so which fees to use is a decision at every call site', () => {
    // Not a runtime assertion — a compile-time one. `fees` has no default because a
    // default would be `DEFAULT_FEES`, i.e. *today's* constants, and a drop
    // published last month must be priced with the constants frozen in its
    // snapshot. A default is how that distinction silently disappears.
    //
    // The type test is the presence of this line: it would not compile without
    // `fees`, which is what makes the argument above enforceable rather than
    // aspirational.
    const withFees: Parameters<typeof platformFeeCentsForOrder>[0] = {
      qty: 1,
      dealPriceCents: 1112,
      fees: DEFAULT_FEES,
    };
    expect(platformFeeCentsForOrder(withFees)).toBe(89);
  });
});
