import { describe, expect, it } from 'vitest';

import { buildDealView, evaluateDeal, formatCents, minViablePrice } from '@/lib/guardrail';

import {
  FUZZ_CASE_COUNT,
  PRICED_VECTORS,
  VECTOR_A,
  VECTOR_B,
  VECTOR_C,
  VECTOR_D,
  mulberry32,
  randomValidInputs,
} from './fixtures';

/**
 * PRD-sprint1 §6.4 rule 1 — the breakdown reconciles visibly.
 *
 * This is asserted structurally rather than arithmetically: `buildDealView`
 * derives the contribution row as the remainder, so the sum is guaranteed for
 * every input, not just the frozen vectors.
 */
describe('the four breakdown rows always sum to the deal price', () => {
  it('holds for every price in the search window of all four vectors', () => {
    for (const { name, input } of PRICED_VECTORS) {
      const windowStart = Math.ceil(input.menuPriceCents * 0.5);
      for (let price = windowStart; price <= input.menuPriceCents; price += 1) {
        const { breakdown } = buildDealView(input, price);
        const sum =
          breakdown.contributionCents +
          breakdown.platformFeeCents +
          breakdown.cardFeeCents +
          breakdown.ingredientsAndPackagingCents;
        expect(sum, `vector ${name} at ${price}`).toBe(price);
      }
    }
  });

  it('holds for 1,000 fuzz cases at a random price', () => {
    const inputs = randomValidInputs(FUZZ_CASE_COUNT);
    const rng = mulberry32(0x0ddba11);

    for (const input of inputs) {
      const windowStart = Math.ceil(input.menuPriceCents * 0.5);
      const price = windowStart + Math.floor(rng() * (input.menuPriceCents - windowStart + 1));
      const { breakdown } = buildDealView(input, price);
      const sum =
        breakdown.contributionCents +
        breakdown.platformFeeCents +
        breakdown.cardFeeCents +
        breakdown.ingredientsAndPackagingCents;

      expect(sum).toBe(price);
      expect(Number.isInteger(breakdown.contributionCents)).toBe(true);
      expect(Number.isInteger(breakdown.platformFeeCents)).toBe(true);
      expect(Number.isInteger(breakdown.cardFeeCents)).toBe(true);
      expect(Number.isInteger(breakdown.ingredientsAndPackagingCents)).toBe(true);
    }
  });

  it('holds at the lowest viable price of each vector', () => {
    for (const { name, input } of PRICED_VECTORS) {
      const minViable = minViablePrice(input);
      const price = minViable ?? input.menuPriceCents;
      const { breakdown } = buildDealView(input, price);
      const sum =
        breakdown.contributionCents +
        breakdown.platformFeeCents +
        breakdown.cardFeeCents +
        breakdown.ingredientsAndPackagingCents;
      expect(sum, `vector ${name}`).toBe(price);
    }
  });
});

describe('the frozen display figures are reproducible from the view', () => {
  it('vector A: $4.01 keep · $0.89 fee · $0.62 card · $5.60 ingredients', () => {
    const view = buildDealView(VECTOR_A, 1112);

    expect(formatCents(view.breakdown.contributionCents)).toBe('$4.01');
    expect(formatCents(view.breakdown.platformFeeCents)).toBe('$0.89');
    expect(formatCents(view.breakdown.cardFeeCents)).toBe('$0.62');
    expect(formatCents(view.breakdown.ingredientsAndPackagingCents)).toBe('$5.60');
    expect(formatCents(view.dealPriceCents)).toBe('$11.12');
    expect(formatCents(view.savingCents)).toBe('$4.88');
  });

  it('vector B: $1.63 keep · $0.60 fee', () => {
    const view = buildDealView(VECTOR_B, 410);

    expect(formatCents(view.breakdown.contributionCents)).toBe('$1.63');
    expect(formatCents(view.breakdown.platformFeeCents)).toBe('$0.60');
    expect(formatCents(view.dealPriceCents)).toBe('$4.10');
  });

  it('vector C: $3.01 keep · $0.93 fee', () => {
    const view = buildDealView(VECTOR_C, 1168);

    expect(formatCents(view.breakdown.contributionCents)).toBe('$3.01');
    expect(formatCents(view.breakdown.platformFeeCents)).toBe('$0.93');
    expect(formatCents(view.dealPriceCents)).toBe('$11.68');
  });

  it('vector D at full price: the fee-inclusive figure is -$1.08', () => {
    const view = buildDealView(VECTOR_D, VECTOR_D.menuPriceCents);

    expect(formatCents(view.breakdown.contributionCents)).toBe('-$1.08');
    expect(view.breakdown.contributionCents).toBe(view.fullPriceContributionCents - 72);
  });
});

describe('money formatting', () => {
  it('rounds half up and formats negatives with a leading minus', () => {
    expect(formatCents(1112)).toBe('$11.12');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(-108)).toBe('-$1.08');
    expect(formatCents(400.792)).toBe('$4.01');
  });
});

/**
 * §7.2 rule 8 — one number, one source.
 *
 * `contributionAtMenuPriceCents` is produced once inside `buildDealView`, at the
 * menu price, and is therefore identical to
 * `evaluateDeal(input, menuPriceCents).contributionCents` for every input — no
 * consumer may re-derive it, because two derivations would eventually make the
 * half-up rounding decision differently and disagree by a cent.
 */
describe('contributionAtMenuPriceCents · the INFEASIBLE figure', () => {
  it('equals the fee-inclusive contribution at the menu price for all four vectors', () => {
    for (const { name, input } of PRICED_VECTORS) {
      const view = buildDealView(input, input.menuPriceCents);
      const expected = evaluateDeal(input, input.menuPriceCents).contributionCents;

      expect(view.contributionAtMenuPriceCents, `vector ${name}`).toBeCloseTo(expected, 6);
    }
  });

  it('vector D: -$1.08 (fee-inclusive), not the -$0.36 that excludes the fee', () => {
    const view = buildDealView(VECTOR_D, VECTOR_D.menuPriceCents);

    expect(formatCents(view.contributionAtMenuPriceCents)).toBe('-$1.08');
    expect(formatCents(view.fullPriceContributionCents)).toBe('-$0.36');
  });

  it('is independent of the price the view was built at (1,000 fuzz cases)', () => {
    const inputs = randomValidInputs(FUZZ_CASE_COUNT);
    const rng = mulberry32(0x1eaf);

    for (const input of inputs) {
      const windowStart = Math.ceil(input.menuPriceCents * 0.5);
      const price = windowStart + Math.floor(rng() * (input.menuPriceCents - windowStart + 1));
      const view = buildDealView(input, price);
      const expected = evaluateDeal(input, input.menuPriceCents).contributionCents;

      expect(view.contributionAtMenuPriceCents).toBeCloseTo(expected, 6);
    }
  });
});
