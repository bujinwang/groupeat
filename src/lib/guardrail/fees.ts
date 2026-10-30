import type { CompleteGuardrailInput, FeeConstants, GuardrailInput } from './types';

/**
 * The four fee primitives. Every one of them is a literal transcription of
 * PRD-v1 §7.2. No rounding happens here — these are the exact figures that go
 * into a stored snapshot.
 */

/** The merchant's minimum margin, in cents. `floorPctOfMenu × menuPriceCents`. */
export function floorCentsOf(input: GuardrailInput): number {
  return input.floorPctOfMenu * input.menuPriceCents;
}

/** `clamp(platformFeePct × price, feeFloor, feeCap)` — PRD-v1 §7.2. */
export function platformFeeAt(priceCents: number, constants: FeeConstants): number {
  const proportional = constants.platformFeePct * priceCents;
  if (proportional < constants.platformFeeFloorCents) {
    return constants.platformFeeFloorCents;
  }
  if (proportional > constants.platformFeeCapCents) {
    return constants.platformFeeCapCents;
  }
  return proportional;
}

/** `stripePct × price + stripeFixedCents` — PRD-v1 §7.2, one number on screen. */
export function cardFeeAt(priceCents: number, constants: FeeConstants): number {
  return constants.stripePct * priceCents + constants.stripeFixedCents;
}

/**
 * `P − food − packaging − cardFee(P) − platformFee(P)` — PRD-v1 §7.2, the
 * quantity the scan compares against the floor and the merchant reads as
 * "you keep $X per plate".
 *
 * Note this is the **fee-inclusive** figure. It is the one used everywhere the
 * merchant is told what they keep, including the INFEASIBLE sentence.
 */
export function contributionAt(input: CompleteGuardrailInput, priceCents: number): number {
  return (
    priceCents -
    input.foodCostCents -
    input.packagingCents -
    cardFeeAt(priceCents, input) -
    platformFeeAt(priceCents, input)
  );
}

/**
 * `menuPrice − food − packaging − cardFee(menuPrice)` — PRD-v1 §7.3's
 * `fullPriceContributionCents`, which **excludes the platform fee** because at
 * full price no GroupEat fee is charged (verified: `1600 − 480 − 80 − 76.4 =
 * 963.60`, matching PRD-sprint1 §7.7).
 *
 * Kept separate from `contributionAt()` on purpose: conflating the two is the
 * single easiest way to break the AC-7 invariant (PRD-sprint1 §5.7).
 */
export function fullPriceContributionAt(input: CompleteGuardrailInput): number {
  return (
    input.menuPriceCents -
    input.foodCostCents -
    input.packagingCents -
    cardFeeAt(input.menuPriceCents, input)
  );
}
