import { describe, expect, it } from 'vitest';

import {
  GuardrailError,
  GuardrailErrorCode,
  assertCompleteCostData,
  checkCostPlausibility,
  hasInvalidCostData,
  validateItemCosts,
} from '@/lib/guardrail';
import type { CompleteGuardrailInput } from '@/lib/guardrail';

import { VECTOR_A, VECTOR_D } from './fixtures';

/**
 * AC-9 (pure half) — the cost invariant is one predicate, shared by the client
 * form, the route handler and the seed. PRD-sprint1 §7.4.
 */
describe('validateItemCosts · the cost invariant', () => {
  const valid = {
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
  };

  it('returns no issues for a valid item', () => {
    expect(validateItemCosts(valid)).toEqual([]);
  });

  it('accepts an omitted prep time and a zero packaging cost', () => {
    expect(
      validateItemCosts({ ...valid, packagingCents: 0, prepMinutes: null, batchYield: 1 }),
    ).toEqual([]);
    expect(validateItemCosts({ ...valid, prepMinutes: undefined })).toEqual([]);
  });

  it('rejects foodCost >= menuPrice', () => {
    expect(validateItemCosts({ ...valid, foodCostCents: 1600 })).toEqual([
      { field: 'foodCostCents', code: 'COST_EXCEEDS_PRICE' },
    ]);
  });

  it('rejects foodCost + packaging === menuPrice (the vector D trap)', () => {
    expect(
      validateItemCosts({ ...valid, menuPriceCents: 900, foodCostCents: 850, packagingCents: 50 }),
    ).toEqual([{ field: 'foodCostCents', code: 'COST_EXCEEDS_PRICE' }]);
  });

  it('requires an ingredient cost', () => {
    expect(validateItemCosts({ ...valid, foodCostCents: null })).toEqual([
      { field: 'foodCostCents', code: 'REQUIRED' },
    ]);
    expect(validateItemCosts({ ...valid, foodCostCents: undefined })).toEqual([
      { field: 'foodCostCents', code: 'REQUIRED' },
    ]);
  });

  it('rejects NaN and negative costs', () => {
    expect(validateItemCosts({ ...valid, foodCostCents: Number.NaN })).toEqual([
      { field: 'foodCostCents', code: 'NOT_A_NUMBER' },
    ]);
    expect(validateItemCosts({ ...valid, foodCostCents: -1 })).toEqual([
      { field: 'foodCostCents', code: 'NEGATIVE' },
    ]);
    expect(validateItemCosts({ ...valid, packagingCents: -1 })).toEqual([
      { field: 'packagingCents', code: 'NEGATIVE' },
    ]);
  });

  it('bounds the menu price to 1 … 50000 cents', () => {
    expect(validateItemCosts({ ...valid, menuPriceCents: 0 })).toEqual([
      { field: 'menuPriceCents', code: 'OUT_OF_RANGE' },
    ]);
    expect(validateItemCosts({ ...valid, menuPriceCents: 50001 })).toEqual([
      { field: 'menuPriceCents', code: 'TOO_LARGE' },
    ]);
    expect(validateItemCosts({ ...valid, menuPriceCents: 50000, foodCostCents: 100 })).toEqual([]);
  });

  it('bounds the batch yield to 1 … 200 whole units', () => {
    expect(validateItemCosts({ ...valid, batchYield: 0 })).toEqual([
      { field: 'batchYield', code: 'OUT_OF_RANGE' },
    ]);
    expect(validateItemCosts({ ...valid, batchYield: 201 })).toEqual([
      { field: 'batchYield', code: 'TOO_LARGE' },
    ]);
    expect(validateItemCosts({ ...valid, batchYield: 2.5 })).toEqual([
      { field: 'batchYield', code: 'OUT_OF_RANGE' },
    ]);
  });

  it('bounds the prep time to 1 … 240 whole minutes when present', () => {
    expect(validateItemCosts({ ...valid, prepMinutes: 0 })).toEqual([
      { field: 'prepMinutes', code: 'OUT_OF_RANGE' },
    ]);
    expect(validateItemCosts({ ...valid, prepMinutes: 241 })).toEqual([
      { field: 'prepMinutes', code: 'OUT_OF_RANGE' },
    ]);
  });

  it('flags the invalid cost relationship without throwing', () => {
    expect(hasInvalidCostData({ menuPriceCents: 900, foodCostCents: 850, packagingCents: 60 })).toBe(
      true,
    );
    expect(hasInvalidCostData({ menuPriceCents: 900, foodCostCents: 850, packagingCents: 30 })).toBe(
      false,
    );
    // Missing food cost is a different state, not an invalid one.
    expect(hasInvalidCostData({ menuPriceCents: 900, foodCostCents: null, packagingCents: 30 })).toBe(
      false,
    );
    expect(hasInvalidCostData({ menuPriceCents: 0, foodCostCents: 0, packagingCents: 0 })).toBe(
      true,
    );
  });
});

describe('assertCompleteCostData · the completeness guard', () => {
  it('narrows a complete input unchanged', () => {
    const complete = assertCompleteCostData(VECTOR_A);
    expect(complete.foodCostCents).toBe(480);
    expect(complete.menuPriceCents).toBe(1600);
    expect(complete.stripePct).toBe(VECTOR_A.stripePct);
  });

  it('throws INCOMPLETE_COST_DATA for null, undefined, NaN and Infinity', () => {
    for (const foodCostCents of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      let caught: unknown;
      try {
        assertCompleteCostData({ ...VECTOR_A, foodCostCents });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GuardrailError);
      expect((caught as GuardrailError).code).toBe(GuardrailErrorCode.INCOMPLETE_COST_DATA);
    }
  });
});

/**
 * The plausibility bands are advisories: `foodCost < 15%` or `> 70%` of the menu
 * price warns, and nothing ever blocks (lead's addition, PRD-sprint1 §7.4).
 */
describe('checkCostPlausibility · non-blocking warnings', () => {
  const at = (foodCostCents: number): CompleteGuardrailInput => ({
    ...VECTOR_A,
    menuPriceCents: 1000,
    foodCostCents,
    packagingCents: 0,
  });

  it('warns when the ingredient cost is implausibly low', () => {
    expect(checkCostPlausibility(at(149))).toEqual(['FOOD_COST_IMPLAUSIBLY_LOW']);
  });

  it('warns when the ingredient cost is implausibly high', () => {
    expect(checkCostPlausibility(at(701))).toEqual(['FOOD_COST_IMPLAUSIBLY_HIGH']);
  });

  it('says nothing inside the band, including exactly on both edges', () => {
    expect(checkCostPlausibility(at(150))).toEqual([]);
    expect(checkCostPlausibility(at(500))).toEqual([]);
    expect(checkCostPlausibility(at(700))).toEqual([]);
  });

  it('never throws and never blocks — vector D and vector A are both silent or warned', () => {
    expect(() => checkCostPlausibility({ ...VECTOR_D })).not.toThrow();
    // $8.50 of food on a $9.00 dish is 94% — implausible, and still only a warning.
    expect(checkCostPlausibility({ ...VECTOR_D })).toEqual(['FOOD_COST_IMPLAUSIBLY_HIGH']);
    // $4.80 on $16.00 is 30% — inside the band.
    expect(checkCostPlausibility({ ...VECTOR_A })).toEqual([]);
  });
});
