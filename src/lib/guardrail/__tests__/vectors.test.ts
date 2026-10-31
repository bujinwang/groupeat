import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEES,
  GuardrailError,
  GuardrailErrorCode,
  PanelState,
  buildDealView,
  evaluateDeal,
  minViablePrice,
} from '@/lib/guardrail';

import { VECTOR_A, VECTOR_B, VECTOR_C, VECTOR_D, VECTOR_E_MISSING } from './fixtures';

/**
 * AC-5 — PRD-v1 §7.4 vectors A…E, hard-coded, exact equality on prices.
 *
 * These five expectations are the frozen specification of the product. If one of
 * them fails, the code is wrong; the vectors are not negotiable.
 */
describe('AC-5 · PRD-v1 §7.4 test vectors', () => {
  it('vector A ($16.00 bowl) returns the lowest viable price $11.12', () => {
    expect(minViablePrice(VECTOR_A)).toBe(1112);
  });

  it('vector B ($6.50 latte) returns the lowest viable price $4.10', () => {
    expect(minViablePrice(VECTOR_B)).toBe(410);
  });

  it('vector C ($12.00 dish) returns $11.68 — a 2.7% discount is still the answer', () => {
    expect(minViablePrice(VECTOR_C)).toBe(1168);
  });

  it('vector D ($9.00 dish, $8.50 food) returns null — no price clears the floor', () => {
    expect(minViablePrice(VECTOR_D)).toBeNull();
  });

  it('vector E (missing food cost) throws INCOMPLETE_COST_DATA', () => {
    expect(() => minViablePrice(VECTOR_E_MISSING)).toThrow(GuardrailError);

    let caught: unknown;
    try {
      minViablePrice(VECTOR_E_MISSING);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GuardrailError);
    expect((caught as GuardrailError).code).toBe(GuardrailErrorCode.INCOMPLETE_COST_DATA);
  });

  it('vector E throws for null, undefined and NaN alike', () => {
    const incomplete = [
      { ...VECTOR_A, foodCostCents: null },
      { ...VECTOR_A, foodCostCents: undefined },
      { ...VECTOR_A, foodCostCents: Number.NaN },
      { ...VECTOR_A, foodCostCents: Number.POSITIVE_INFINITY },
    ];

    for (const input of incomplete) {
      expect(() => minViablePrice(input)).toThrow(GuardrailError);
      expect(() => evaluateDeal(input, input.menuPriceCents)).toThrow(GuardrailError);
      expect(() => buildDealView(input, input.menuPriceCents)).toThrow(GuardrailError);
    }
  });
});

/** PRD-v1 §7.4 table columns: fee, contribution, break-even incrementality. */
describe('AC-5 · evaluateDeal reproduces the frozen evaluation figures', () => {
  it('vector A at $11.12', () => {
    const result = evaluateDeal(VECTOR_A, 1112);

    expect(result.netContributionCents).toBeCloseTo(400.792, 6);
    expect(result.platformFeeCents).toBeCloseTo(88.96, 6);
    expect(result.walkInContributionCents).toBeCloseTo(963.6, 6);
    expect(result.breakEvenIncrementality).toBeCloseTo(0.7062, 4);
    expect(result.contributionPctOfMenu).toBeCloseTo(0.2505, 4);
    expect(result.isBelowFloor).toBe(false);
    expect(result.minViablePriceCents).toBe(1112);
  });

  it('vector B at $4.10', () => {
    const result = evaluateDeal(VECTOR_B, 410);

    expect(result.netContributionCents).toBeCloseTo(163.11, 6);
    expect(result.platformFeeCents).toBeCloseTo(60, 6);
    expect(result.walkInContributionCents).toBeCloseTo(456.15, 6);
    expect(result.breakEvenIncrementality).toBeCloseTo(0.7366, 4);
    expect(result.isBelowFloor).toBe(false);
    expect(result.minViablePriceCents).toBe(410);
  });

  it('vector C at $11.68 — profitable but unattractive', () => {
    const result = evaluateDeal(VECTOR_C, 1168);

    expect(result.netContributionCents).toBeCloseTo(300.688, 6);
    expect(result.platformFeeCents).toBeCloseTo(93.44, 6);
    expect(result.walkInContributionCents).toBeCloseTo(425.2, 6);
    expect(result.breakEvenIncrementality).toBeCloseTo(0.5858, 4);
    expect(result.isBelowFloor).toBe(false);
    expect(result.minViablePriceCents).toBe(1168);
  });

  it('vector D at full price loses money', () => {
    const result = evaluateDeal(VECTOR_D, VECTOR_D.menuPriceCents);

    expect(result.netContributionCents).toBeCloseTo(-108.1, 6);
    expect(result.platformFeeCents).toBeCloseTo(72, 6);
    expect(result.isBelowFloor).toBe(true);
    expect(result.minViablePriceCents).toBeNull();
  });
});

/**
 * The frozen display figures from PRD-sprint1 §6.4 / ARCHITECTURE-sprint1 §3.2.
 * These are what the merchant reads, so they are asserted at the view layer.
 */
describe('AC-5 · display figures from the frozen copy', () => {
  it('vector A renders $11.12 · $4.88 · $4.01 · $0.89', () => {
    const view = buildDealView(VECTOR_A, 1112);

    expect(view.dealPriceCents).toBe(1112);
    expect(view.savingCents).toBe(488);
    expect(view.discountPct).toBe(31);
    expect(view.breakdown).toEqual({
      netContributionCents: 401,
      platformFeeCents: 89,
      cardFeeCents: 62,
      ingredientsAndPackagingCents: 560,
    });
    expect(view.contributionPctOfMenu).toBe(25);
    expect(view.floorPctOfMenu).toBe(25);
    expect(view.floorCents).toBe(400);
    expect(view.pointsAboveFloor).toBe(0);
    expect(view.breakEvenCountOf100).toBe(71);
    expect(view.guidanceBucket).toBe('TIGHT');
    expect(view.state).toBe(PanelState.FLOOR);
  });

  it('vector B renders $4.10 · $1.63 · $0.60', () => {
    const view = buildDealView(VECTOR_B, 410);

    expect(view.savingCents).toBe(240);
    expect(view.discountPct).toBe(37);
    expect(view.breakdown).toEqual({
      netContributionCents: 163,
      platformFeeCents: 60,
      cardFeeCents: 42,
      ingredientsAndPackagingCents: 145,
    });
    expect(view.breakEvenCountOf100).toBe(74);
    expect(view.state).toBe(PanelState.FLOOR);
  });

  it('vector C renders $11.68 · $3.01 · $0.93 and resolves to THIN', () => {
    const view = buildDealView(VECTOR_C, 1168);

    expect(view.savingCents).toBe(32);
    expect(view.discountPct).toBe(3);
    expect(view.breakdown).toEqual({
      netContributionCents: 301,
      platformFeeCents: 93,
      cardFeeCents: 64,
      ingredientsAndPackagingCents: 710,
    });
    expect(view.state).toBe(PanelState.THIN);
  });

  it('vector D resolves to INFEASIBLE at the menu price', () => {
    const view = buildDealView(VECTOR_D, VECTOR_D.menuPriceCents);

    expect(view.minViablePriceCents).toBeNull();
    expect(view.floorCents).toBe(225);
    expect(view.breakdown.netContributionCents).toBe(-108);
    expect(view.state).toBe(PanelState.INFEASIBLE);
  });
});

describe('PRD-v1 §7.2 · the fee primitives are used verbatim', () => {
  it('the platform fee is clamped into [60, 200] cents', () => {
    // 8% of 410 = 32.80 → clamped up to the 60-cent floor.
    expect(evaluateDeal(VECTOR_B, 410).platformFeeCents).toBe(60);
    // 8% of 1600 = 128 → inside the band.
    expect(evaluateDeal(VECTOR_A, 1600).platformFeeCents).toBeCloseTo(128, 6);
    // 8% of 5000 = 400 → clamped down to the 200-cent cap.
    expect(
      evaluateDeal({ ...DEFAULT_FEES, menuPriceCents: 5000, foodCostCents: 1000, packagingCents: 0, floorPctOfMenu: 0.25 }, 5000)
        .platformFeeCents,
    ).toBe(200);
  });
});
