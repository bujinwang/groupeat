import { describe, expect, it } from 'vitest';

import { buildDealView, evaluateDeal, formatCents, minViablePrice, roundHalfUp } from '@/lib/guardrail';

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
          breakdown.netContributionCents +
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
        breakdown.netContributionCents +
        breakdown.platformFeeCents +
        breakdown.cardFeeCents +
        breakdown.ingredientsAndPackagingCents;

      expect(sum).toBe(price);
      expect(Number.isInteger(breakdown.netContributionCents)).toBe(true);
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
        breakdown.netContributionCents +
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

    expect(formatCents(view.breakdown.netContributionCents)).toBe('$4.01');
    expect(formatCents(view.breakdown.platformFeeCents)).toBe('$0.89');
    expect(formatCents(view.breakdown.cardFeeCents)).toBe('$0.62');
    expect(formatCents(view.breakdown.ingredientsAndPackagingCents)).toBe('$5.60');
    expect(formatCents(view.dealPriceCents)).toBe('$11.12');
    expect(formatCents(view.savingCents)).toBe('$4.88');
  });

  it('vector B: $1.63 keep · $0.60 fee', () => {
    const view = buildDealView(VECTOR_B, 410);

    expect(formatCents(view.breakdown.netContributionCents)).toBe('$1.63');
    expect(formatCents(view.breakdown.platformFeeCents)).toBe('$0.60');
    expect(formatCents(view.dealPriceCents)).toBe('$4.10');
  });

  it('vector C: $3.01 keep · $0.93 fee', () => {
    const view = buildDealView(VECTOR_C, 1168);

    expect(formatCents(view.breakdown.netContributionCents)).toBe('$3.01');
    expect(formatCents(view.breakdown.platformFeeCents)).toBe('$0.93');
    expect(formatCents(view.dealPriceCents)).toBe('$11.68');
  });

  it('vector D at full price: the fee-inclusive figure is -$1.08', () => {
    const view = buildDealView(VECTOR_D, VECTOR_D.menuPriceCents);

    expect(formatCents(view.breakdown.netContributionCents)).toBe('-$1.08');
    expect(view.breakdown.netContributionCents).toBe(view.walkInContributionCents - 72);
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
 * §7.2 rule 8 — one number, one source, and it must not depend on the deal price.
 *
 * `buildDealView` sets `walkInContributionCents` from an evaluation **at the
 * menu price**, so it may not vary with `dealPriceCents`. That is the contract
 * this block guards: a view built at $5.00 must still report the $9.00 figure.
 */
describe('the menu-price figures are independent of dealPriceCents', () => {
  it('walkInContributionCents always equals evaluateDeal at the menu price', () => {
    // The lead's contract check: buildDealView must not let the deal price
    // contaminate a menu-price figure.
    const inputs = randomValidInputs(FUZZ_CASE_COUNT, 0xf00d);

    for (const input of inputs) {
      const expected = roundHalfUp(evaluateDeal(input, input.menuPriceCents).walkInContributionCents);
      const windowStart = Math.ceil(input.menuPriceCents * 0.5);

      for (const price of [windowStart, input.menuPriceCents]) {
        const view = buildDealView(input, price);
        expect(view.walkInContributionCents).toBe(expected);
      }
    }
  });

  it('vector D: -$0.36 at the menu price', () => {
    const view = buildDealView(VECTOR_D, VECTOR_D.menuPriceCents);
    expect(formatCents(view.walkInContributionCents)).toBe('-$0.36');
  });
});
