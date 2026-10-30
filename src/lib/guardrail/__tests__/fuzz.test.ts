import { describe, expect, it } from 'vitest';

import {
  GuardrailError,
  buildDealView,
  cardFeeAt,
  evaluateDeal,
  minViablePrice,
  platformFeeAt,
} from '@/lib/guardrail';

import { FUZZ_CASE_COUNT, mulberry32, randomValidInputs } from './fixtures';

/**
 * AC-6 — 1,000 random valid inputs must produce finite, non-negative fees and no
 * exception other than `INCOMPLETE_COST_DATA`.
 *
 * "No negative result" applies to fees and prices. `contributionCents` may
 * legitimately be negative: vector D is exactly that case, and hiding it would
 * be the bug.
 */
describe('AC-6 · fuzz over 1,000 valid inputs', () => {
  it('never emits NaN, Infinity or a negative fee', () => {
    const inputs = randomValidInputs(FUZZ_CASE_COUNT);
    const rng = mulberry32(0x5eed);

    for (const input of inputs) {
      const menuPrice = input.menuPriceCents;
      const windowStart = Math.ceil(menuPrice * 0.5);
      const dealPrice = windowStart + Math.floor(rng() * (menuPrice - windowStart + 1));

      const evaluation = evaluateDeal(input, dealPrice);
      const view = buildDealView(input, dealPrice);
      const minViable = minViablePrice(input);

      const figures: [string, number][] = [
        ['evaluation.contributionCents', evaluation.contributionCents],
        ['evaluation.contributionPctOfMenu', evaluation.contributionPctOfMenu],
        ['evaluation.fullPriceContributionCents', evaluation.fullPriceContributionCents],
        ['evaluation.breakEvenIncrementality', evaluation.breakEvenIncrementality],
        ['evaluation.platformFeeCents', evaluation.platformFeeCents],
        ['view.savingCents', view.savingCents],
        ['view.discountPct', view.discountPct],
        ['view.contributionCentsExact', view.contributionCentsExact],
        ['view.contributionPctOfMenu', view.contributionPctOfMenu],
        ['view.floorPctOfMenu', view.floorPctOfMenu],
        ['view.floorCents', view.floorCents],
        ['view.pointsAboveFloor', view.pointsAboveFloor],
        ['view.fullPriceContributionCents', view.fullPriceContributionCents],
        ['view.breakEvenCountOf100', view.breakEvenCountOf100],
        ['view.breakdown.contributionCents', view.breakdown.contributionCents],
        ['view.breakdown.platformFeeCents', view.breakdown.platformFeeCents],
        ['view.breakdown.cardFeeCents', view.breakdown.cardFeeCents],
        [
          'view.breakdown.ingredientsAndPackagingCents',
          view.breakdown.ingredientsAndPackagingCents,
        ],
      ];

      for (const [name, value] of figures) {
        expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
      }

      expect(evaluation.platformFeeCents).toBeGreaterThanOrEqual(0);
      expect(platformFeeAt(dealPrice, input)).toBeGreaterThanOrEqual(0);
      expect(cardFeeAt(dealPrice, input)).toBeGreaterThanOrEqual(0);
      expect(view.breakdown.platformFeeCents).toBeGreaterThanOrEqual(0);
      expect(view.breakdown.cardFeeCents).toBeGreaterThanOrEqual(0);
      expect(view.breakEvenCountOf100).toBeGreaterThanOrEqual(0);
      expect(view.breakEvenCountOf100).toBeLessThanOrEqual(100);

      if (minViable !== null) {
        expect(minViable).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the only exception the module may throw is INCOMPLETE_COST_DATA', () => {
    const inputs = randomValidInputs(FUZZ_CASE_COUNT, 0xbeef);

    for (const input of inputs) {
      try {
        minViablePrice(input);
        evaluateDeal(input, input.menuPriceCents);
        buildDealView(input, input.menuPriceCents);
      } catch (error) {
        expect(error).toBeInstanceOf(GuardrailError);
      }
    }
  });

  it('a complete input never throws at all', () => {
    const inputs = randomValidInputs(FUZZ_CASE_COUNT, 0xc0ffee);

    for (const input of inputs) {
      expect(() => minViablePrice(input)).not.toThrow();
      expect(() => evaluateDeal(input, input.menuPriceCents)).not.toThrow();
      expect(() => buildDealView(input, input.menuPriceCents)).not.toThrow();
    }
  });
});
