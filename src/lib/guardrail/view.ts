import { GUIDANCE_BUCKETS, THIN_DISCOUNT_THRESHOLD } from './constants';
import { evaluateCompleteDeal } from './evaluateDeal';
import { cardFeeAt, floorCentsOf, platformFeeAt } from './fees';
import { roundHalfUp } from './money';
import { resolvePanelState } from './states';
import type { Breakdown, DealView, GuardrailInput, GuidanceBucket } from './types';
import { assertCompleteCostData, hasInvalidCostData } from './validate';

/**
 * Builds the display-ready view.
 *
 * The one structural guarantee: `cardFee` and `platformFee` are rounded half-up
 * to whole cents, `food + packaging` is already integral, and
 * `contributionCents` is then **derived as the remainder**:
 *
 * ```
 * contribution = dealPrice − ingredientsAndPackaging − cardFee − platformFee
 * ```
 *
 * So the four rows reconcile to the deal price by construction rather than by
 * arithmetic luck (PRD-sprint1 §6.4 rule 1). This is why the panel's breakdown
 * "adds up" for every input, not just the frozen vectors.
 *
 * Throws `GuardrailError(INCOMPLETE_COST_DATA)` when `foodCostCents` is missing,
 * exactly like `minViablePrice` and `evaluateDeal`.
 */
export function buildDealView(input: GuardrailInput, dealPriceCents: number): DealView {
  const complete = assertCompleteCostData(input);
  const evaluation = evaluateCompleteDeal(complete, dealPriceCents);
  // `fullPriceContributionCents` and `contributionAtMenuPriceCents` are always
  // evaluated at the menu price, independent of `dealPriceCents` (§3.1).
  const evaluationAtMenuPrice = evaluateCompleteDeal(complete, complete.menuPriceCents);

  const cardFeeCents = roundHalfUp(cardFeeAt(dealPriceCents, complete));
  const platformFeeCents = roundHalfUp(platformFeeAt(dealPriceCents, complete));
  const ingredientsAndPackagingCents = complete.foodCostCents + complete.packagingCents;

  const breakdown: Breakdown = {
    contributionCents:
      dealPriceCents - ingredientsAndPackagingCents - cardFeeCents - platformFeeCents,
    platformFeeCents,
    cardFeeCents,
    ingredientsAndPackagingCents,
  };

  const savingCents = complete.menuPriceCents - dealPriceCents;
  const discountPctExact =
    complete.menuPriceCents > 0 ? savingCents / complete.menuPriceCents : 0;

  const state = resolvePanelState({
    validationFailed: hasInvalidCostData(complete),
    costDataIncomplete: false,
    minViablePriceCents: evaluation.minViablePriceCents,
    isBelowFloor: evaluation.isBelowFloor,
    discountPctExact,
    dealPriceCents,
    thinThreshold: THIN_DISCOUNT_THRESHOLD,
  });

  const contributionPctOfMenu = roundHalfUp(evaluation.contributionPctOfMenu * 100);
  const floorPctOfMenu = roundHalfUp(complete.floorPctOfMenu * 100);
  const breakEvenCountOf100 = clampInteger(
    roundHalfUp(clampUnit(evaluation.breakEvenIncrementality) * 100),
    0,
    100,
  );

  return {
    state,
    menuPriceCents: complete.menuPriceCents,
    dealPriceCents,
    savingCents,
    discountPct: roundHalfUp(discountPctExact * 100),
    minViablePriceCents: evaluation.minViablePriceCents,
    isBelowFloor: evaluation.isBelowFloor,
    breakdown,
    contributionCentsExact: evaluation.contributionCents,
    contributionPctOfMenu,
    floorPctOfMenu,
    floorCents: roundHalfUp(floorCentsOf(complete)),
    pointsAboveFloor: contributionPctOfMenu - floorPctOfMenu,
    // Fee-inclusive, at the menu price, unrounded — the figure the INFEASIBLE
    // sentence quotes (§7.2 rule 8: produced here, never re-derived elsewhere).
    contributionAtMenuPriceCents: evaluationAtMenuPrice.contributionCents,
    fullPriceContributionCents: roundHalfUp(evaluation.fullPriceContributionCents),
    breakEvenCountOf100,
    guidanceBucket: guidanceBucketOf(evaluation.breakEvenIncrementality),
  };
}

/**
 * PRD-sprint1 §5.3 guidance lookup. The bucket is a function of the number; the
 * sentence is a function of the bucket (`src/lib/copy/guidance.ts`).
 */
export function guidanceBucketOf(breakEvenIncrementality: number): GuidanceBucket {
  if (!Number.isFinite(breakEvenIncrementality)) {
    return 'CHEAP';
  }
  for (const entry of GUIDANCE_BUCKETS) {
    if (breakEvenIncrementality >= entry.minInclusive) {
      return entry.bucket;
    }
  }
  return 'CHEAP';
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function clampInteger(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
