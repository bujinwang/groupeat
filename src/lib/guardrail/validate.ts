import { GuardrailError, GuardrailErrorCode } from './errors';
import { PRICE_BOUNDS } from './constants';
import type { CompleteGuardrailInput, GuardrailInput, ValidationIssue } from './types';

/**
 * Completeness guard. Narrows `foodCostCents` from `number | null | undefined`
 * to `number`, or throws `INCOMPLETE_COST_DATA` (PRD-v1 §7.4 vector E).
 *
 * This is a guard, not a data state: `MenuItem.foodCostCents` is non-nullable in
 * the database. The function still defends, because it also receives partial
 * input from the API, from seeds and (in M3) from AI proposals.
 */
export function assertCompleteCostData(input: GuardrailInput): CompleteGuardrailInput {
  const foodCost = input.foodCostCents;
  if (foodCost === null || foodCost === undefined || !Number.isFinite(foodCost)) {
    throw new GuardrailError(GuardrailErrorCode.INCOMPLETE_COST_DATA);
  }
  return {
    platformFeePct: input.platformFeePct,
    platformFeeFloorCents: input.platformFeeFloorCents,
    platformFeeCapCents: input.platformFeeCapCents,
    stripePct: input.stripePct,
    stripeFixedCents: input.stripeFixedCents,
    menuPriceCents: input.menuPriceCents,
    foodCostCents: foodCost,
    packagingCents: input.packagingCents,
    floorPctOfMenu: input.floorPctOfMenu,
  };
}

/**
 * The single source of the cost invariant `foodCost + packaging < menuPrice`
 * (PRD-sprint1 §7.4). Imported by the client form, the route handler and the
 * seed, so AC-9 cannot drift between the two enforcement points.
 *
 * Returns `[]` when the input is valid. Never throws: a validation failure is a
 * 422 with field errors, not an exception.
 */
export function validateItemCosts(input: {
  menuPriceCents: number;
  foodCostCents: number | null | undefined;
  packagingCents: number;
  batchYield: number;
  prepMinutes?: number | null;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ---- menu price -----------------------------------------------------------
  if (typeof input.menuPriceCents !== 'number' || Number.isNaN(input.menuPriceCents)) {
    issues.push({ field: 'menuPriceCents', code: 'NOT_A_NUMBER' });
  } else if (!Number.isFinite(input.menuPriceCents)) {
    issues.push({ field: 'menuPriceCents', code: 'NOT_A_NUMBER' });
  } else if (input.menuPriceCents < PRICE_BOUNDS.menuPriceCents.min) {
    issues.push({ field: 'menuPriceCents', code: 'OUT_OF_RANGE' });
  } else if (input.menuPriceCents > PRICE_BOUNDS.menuPriceCents.max) {
    issues.push({ field: 'menuPriceCents', code: 'TOO_LARGE' });
  }

  // ---- ingredient cost ------------------------------------------------------
  const foodCost = input.foodCostCents;
  const foodCostIsPresent = foodCost !== null && foodCost !== undefined;
  if (!foodCostIsPresent) {
    issues.push({ field: 'foodCostCents', code: 'REQUIRED' });
  } else if (typeof foodCost !== 'number' || !Number.isFinite(foodCost)) {
    issues.push({ field: 'foodCostCents', code: 'NOT_A_NUMBER' });
  } else if (foodCost < 0) {
    issues.push({ field: 'foodCostCents', code: 'NEGATIVE' });
  }

  // ---- container cost -------------------------------------------------------
  if (typeof input.packagingCents !== 'number' || !Number.isFinite(input.packagingCents)) {
    issues.push({ field: 'packagingCents', code: 'NOT_A_NUMBER' });
  } else if (input.packagingCents < 0) {
    issues.push({ field: 'packagingCents', code: 'NEGATIVE' });
  }

  // ---- the invariant itself -------------------------------------------------
  if (
    foodCostIsPresent &&
    typeof foodCost === 'number' &&
    Number.isFinite(foodCost) &&
    foodCost >= 0 &&
    Number.isFinite(input.packagingCents) &&
    input.packagingCents >= 0 &&
    Number.isFinite(input.menuPriceCents) &&
    input.menuPriceCents > 0 &&
    foodCost + input.packagingCents >= input.menuPriceCents
  ) {
    issues.push({ field: 'foodCostCents', code: 'COST_EXCEEDS_PRICE' });
  }

  // ---- batch yield ----------------------------------------------------------
  if (!Number.isFinite(input.batchYield) || !Number.isInteger(input.batchYield)) {
    issues.push({ field: 'batchYield', code: 'OUT_OF_RANGE' });
  } else if (input.batchYield < PRICE_BOUNDS.batchYield.min) {
    issues.push({ field: 'batchYield', code: 'OUT_OF_RANGE' });
  } else if (input.batchYield > PRICE_BOUNDS.batchYield.max) {
    issues.push({ field: 'batchYield', code: 'TOO_LARGE' });
  }

  // ---- prep minutes (optional) ---------------------------------------------
  const prepMinutes = input.prepMinutes;
  if (prepMinutes !== null && prepMinutes !== undefined) {
    if (!Number.isFinite(prepMinutes) || !Number.isInteger(prepMinutes)) {
      issues.push({ field: 'prepMinutes', code: 'OUT_OF_RANGE' });
    } else if (
      prepMinutes < PRICE_BOUNDS.prepMinutes.min ||
      prepMinutes > PRICE_BOUNDS.prepMinutes.max
    ) {
      issues.push({ field: 'prepMinutes', code: 'OUT_OF_RANGE' });
    }
  }

  return issues;
}

/**
 * True when the cost *relationship* makes the guardrail meaningless
 * (`menuPrice <= 0`, a negative cost, or `foodCost + packaging >= menuPrice`).
 *
 * Used by `buildDealView()` to reach `PanelState.INVALID_COST_DATA` without the
 * caller having to pre-validate, and by the route handler to decide between a
 * 422 and an evaluation.
 */
export function hasInvalidCostData(input: {
  menuPriceCents: number;
  foodCostCents: number | null | undefined;
  packagingCents: number;
}): boolean {
  const { menuPriceCents, foodCostCents, packagingCents } = input;
  if (!Number.isFinite(menuPriceCents) || menuPriceCents <= 0) {
    return true;
  }
  if (!Number.isFinite(packagingCents) || packagingCents < 0) {
    return true;
  }
  if (foodCostCents === null || foodCostCents === undefined) {
    // Missing is `INCOMPLETE_COST_DATA`, a different state with its own copy.
    return false;
  }
  if (!Number.isFinite(foodCostCents) || foodCostCents < 0) {
    return true;
  }
  return foodCostCents + packagingCents >= menuPriceCents;
}
