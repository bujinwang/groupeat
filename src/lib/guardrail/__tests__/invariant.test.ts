import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES, evaluateDeal, floorCentsOf, minViablePrice } from '@/lib/guardrail';

import { FUZZ_CASE_COUNT, randomValidInputs } from './fixtures';

/**
 * AC-7 — the invariant that makes the frozen algorithm checkable.
 *
 * `minViablePrice(input) === null` **iff** the fee-inclusive contribution at the
 * menu price is below the floor. Not `fullPriceContributionCents`: that figure
 * excludes the platform fee (PRD-v1 §7.7), so comparing it against the floor
 * tests a different quantity and produces false failures (PRD-sprint1 §5.7,
 * ARCHITECTURE-sprint1 Q-1).
 */
describe('AC-7 · null-iff invariant on 1,000 cases', () => {
  it('is null exactly when the contribution at the menu price is below the floor', () => {
    const inputs = randomValidInputs(FUZZ_CASE_COUNT);
    expect(inputs).toHaveLength(FUZZ_CASE_COUNT);

    const violations: {
      menuPriceCents: number;
      foodCostCents: number;
      packagingCents: number;
      floorPctOfMenu: number;
      minViablePriceCents: number | null;
      contributionAtMenuCents: number;
      floorCents: number;
    }[] = [];

    for (const input of inputs) {
      const minViable = minViablePrice(input);
      const contributionAtMenu = evaluateDeal(input, input.menuPriceCents).contributionCents;
      const floorCents = floorCentsOf(input);

      if ((minViable === null) !== contributionAtMenu < floorCents) {
        violations.push({
          menuPriceCents: input.menuPriceCents,
          foodCostCents: input.foodCostCents as number,
          packagingCents: input.packagingCents,
          floorPctOfMenu: input.floorPctOfMenu,
          minViablePriceCents: minViable,
          contributionAtMenuCents: contributionAtMenu,
          floorCents,
        });
      }
    }

    expect(violations).toEqual([]);
  });

  it('a returned price is always inside the search window and does clear the floor', () => {
    const inputs = randomValidInputs(FUZZ_CASE_COUNT, 0x1234abcd);

    for (const input of inputs) {
      const minViable = minViablePrice(input);
      if (minViable === null) {
        continue;
      }
      expect(Number.isInteger(minViable)).toBe(true);
      expect(minViable).toBeGreaterThanOrEqual(Math.ceil(input.menuPriceCents * 0.5));
      expect(minViable).toBeLessThanOrEqual(input.menuPriceCents);

      // The returned price clears the floor…
      expect(evaluateDeal(input, minViable).isBelowFloor).toBe(false);
      // …and, because contribution is strictly increasing in price, its
      // predecessor does not (unless the window starts there).
      if (minViable > Math.ceil(input.menuPriceCents * 0.5)) {
        expect(evaluateDeal(input, minViable - 1).isBelowFloor).toBe(true);
      }
    }
  });

  it('the predicate must use contributionCents — the Q-1 counterexample', () => {
    // ARCHITECTURE-sprint1 Q-1: full-price contribution 226 ≥ floor 150, yet the
    // fee-inclusive contribution at the menu price (146) is below it, so the
    // algorithm correctly returns null.
    const input = {
      ...DEFAULT_FEES,
      menuPriceCents: 1000,
      foodCostCents: 715,
      packagingCents: 0,
      floorPctOfMenu: 0.15,
    };

    const evaluation = evaluateDeal(input, input.menuPriceCents);
    const floorCents = floorCentsOf(input);

    expect(floorCents).toBeCloseTo(150, 6);
    expect(evaluation.fullPriceContributionCents).toBeCloseTo(226, 6);
    expect(evaluation.contributionCents).toBeCloseTo(146, 6);

    expect(evaluation.contributionCents < floorCents).toBe(true);
    expect(evaluation.fullPriceContributionCents < floorCents).toBe(false);

    // The algorithm follows contributionCents, therefore null.
    expect(minViablePrice(input)).toBeNull();
  });
});
