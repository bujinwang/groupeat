import { COST_PLAUSIBILITY } from './constants';
import type { CompleteGuardrailInput, GuardrailWarning } from './types';

/**
 * Food-cost plausibility bands (PRD-sprint1 §7.4, lead's addition).
 *
 * These are **advisories**. Nothing here blocks a save: a merchant may genuinely
 * sell a $16.00 dish with $0.50 of ingredients, and the guardrail already tells
 * them the truth about the price. The warning exists so that an obvious typo
 * (a missing digit, cents entered as dollars) is visible before a drop runs.
 *
 * The caller is responsible for appending a `food_cost_implausible` analytics
 * event; this function is pure and performs no I/O.
 */
export function checkCostPlausibility(input: CompleteGuardrailInput): GuardrailWarning[] {
  const warnings: GuardrailWarning[] = [];
  const menuPrice = input.menuPriceCents;

  // Without a positive menu price there is no ratio to judge.
  if (!Number.isFinite(menuPrice) || menuPrice <= 0) {
    return warnings;
  }

  const foodCost = input.foodCostCents;
  if (!Number.isFinite(foodCost) || foodCost < 0) {
    return warnings;
  }

  const ratio = foodCost / menuPrice;
  if (ratio < COST_PLAUSIBILITY.lowRatio) {
    warnings.push('FOOD_COST_IMPLAUSIBLY_LOW');
  }
  if (ratio > COST_PLAUSIBILITY.highRatio) {
    warnings.push('FOOD_COST_IMPLAUSIBLY_HIGH');
  }
  return warnings;
}
