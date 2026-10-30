import { contributionAt, floorCentsOf, fullPriceContributionAt, platformFeeAt } from './fees';
import { scanMinViablePrice } from './minViablePrice';
import type { CompleteGuardrailInput, DealEvaluation, GuardrailInput } from './types';
import { assertCompleteCostData } from './validate';

/**
 * PRD-v1 §7.3, field for field. This is the object a stored
 * `Drop.guardrailSnapshot.result` is built from, so nothing here is rounded.
 *
 * `fullPriceContributionCents` deliberately **excludes** the platform fee: a
 * full-price sale is not a drop, so we charge nothing on it. `contributionCents`
 * **includes** it, because a deal price does attract the fee.
 *
 * The two figures answer different questions and must never be substituted for
 * one another (PRD-sprint1 §5.7.1):
 *   - `contributionCents` → "can any price clear the floor?" The scan compares
 *     every candidate price using it, because every candidate would be a drop.
 *   - `fullPriceContributionCents` → "what do I keep today at full price?" It is
 *     the figure the INFEASIBLE sentence quotes.
 * On vector D they are −$1.08 and −$0.36. Each is right for its own sentence.
 */
export function evaluateDeal(input: GuardrailInput, dealPriceCents: number): DealEvaluation {
  return evaluateCompleteDeal(assertCompleteCostData(input), dealPriceCents);
}

/** Same evaluation for callers that already hold a narrowed input. */
export function evaluateCompleteDeal(
  input: CompleteGuardrailInput,
  dealPriceCents: number,
): DealEvaluation {
  const floorCents = floorCentsOf(input);
  const contributionCents = contributionAt(input, dealPriceCents);
  const fullPriceContributionCents = fullPriceContributionAt(input);

  const menuPriceCents = input.menuPriceCents;
  // Guarded division: `validateItemCosts` rejects a non-positive menu price, but
  // this function must never emit `NaN` or `Infinity` (AC-6).
  const contributionPctOfMenu = menuPriceCents > 0 ? contributionCents / menuPriceCents : 0;

  // breakEvenIncrementality = fullPrice / (fullPrice + contribution) — PRD-v1 §7.3.
  // A zero denominator would be 0/0; report 0 rather than NaN.
  const breakEvenDenominator = fullPriceContributionCents + contributionCents;
  const breakEvenIncrementality =
    breakEvenDenominator === 0 ? 0 : fullPriceContributionCents / breakEvenDenominator;

  return {
    contributionCents,
    contributionPctOfMenu,
    fullPriceContributionCents,
    breakEvenIncrementality,
    platformFeeCents: platformFeeAt(dealPriceCents, input),
    isBelowFloor: contributionCents < floorCents,
    minViablePriceCents: scanMinViablePrice(input),
  };
}
