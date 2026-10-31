import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES, evaluateDeal, floorCentsOf, minViablePrice } from '@/lib/guardrail';

import { FUZZ_CASE_COUNT, VECTOR_A, randomValidInputs } from './fixtures';

/**
 * AC-7 — the invariant that makes the frozen algorithm checkable.
 *
 * `minViablePrice(input) === null` **iff** the fee-inclusive contribution at the
 * menu price is below the floor. Not `walkInContributionCents`: that figure
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
      const contributionAtMenu = evaluateDeal(input, input.menuPriceCents).netContributionCents;
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

  it('the predicate must use netContributionCents — the Q-1 counterexample', () => {
    // ARCHITECTURE-sprint1 Q-1. The two figures differ by exactly the platform
    // fee, and only one of them is the quantity the algorithm decides on.
    const input = {
      ...DEFAULT_FEES,
      menuPriceCents: 1000,
      foodCostCents: 715,
      packagingCents: 0,
      floorPctOfMenu: 0.15,
    };

    const evaluation = evaluateDeal(input, input.menuPriceCents);
    const floorCents = floorCentsOf(input);

    // Numeric anchors. `walkInContributionCents` is only ever asserted for
    // its value (PRD-v1 §7.7 shape), never used as a predicate.
    expect(floorCents).toBeCloseTo(150, 6);
    expect(evaluation.netContributionCents).toBeCloseTo(146, 6);
    expect(evaluation.walkInContributionCents).toBeCloseTo(226, 6);
    // The gap is exactly the platform fee: 8% × 1000 = 80.
    expect(evaluation.walkInContributionCents - evaluation.netContributionCents).toBeCloseTo(
      80,
      6,
    );

    // The predicate the algorithm actually uses…
    const belowFloorUsingCorrectFigure = evaluation.netContributionCents < floorCents;
    // …and the same test run on the wrong quantity. The two names say it: this
    // is a demonstration that picking the wrong field changes the answer, not an
    // assertion anyone may copy into a decision. 226 ≥ 150 would demand a viable
    // price that does not exist.
    const belowFloorUsingWrongFigure = evaluation.walkInContributionCents < floorCents;

    expect(belowFloorUsingCorrectFigure).toBe(true);
    expect(belowFloorUsingWrongFigure).toBe(false);
    // They disagree, therefore the choice of figure decides the outcome.
    expect(belowFloorUsingCorrectFigure).not.toBe(belowFloorUsingWrongFigure);

    // The algorithm follows netContributionCents, therefore null.
    expect(minViablePrice(input)).toBeNull();
  });

  it('anchors walkInContributionCents to the PRD-sprint1 §7.7 snapshot (vector A = 963.60)', () => {
    // Value-only assertion, per the PM's 2026-10-30 correction: this field has
    // exactly two legitimate uses — the break-even denominator and the frozen
    // snapshot. It is never compared against the floor.
    const evaluation = evaluateDeal(VECTOR_A, 1112);

    expect(evaluation.walkInContributionCents).toBeCloseTo(963.6, 6);
    expect(evaluation.netContributionCents).toBeCloseTo(400.792, 6);

    // The two figures only differ by the platform fee when the deal price *is*
    // the menu price (128 = 8% × 1600); at any lower deal price the discount
    // itself is part of the gap.
    const atMenuPrice = evaluateDeal(VECTOR_A, VECTOR_A.menuPriceCents);
    expect(
      atMenuPrice.walkInContributionCents - atMenuPrice.netContributionCents,
    ).toBeCloseTo(128, 6);
  });
});
