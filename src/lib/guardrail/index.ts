/**
 * Public surface of the guardrail module — the only entry point anything outside
 * this folder may import (ARCHITECTURE-sprint1 §2.3, §3.1).
 *
 * Nothing here imports anything but sibling files. That is the whole point of
 * the folder: the arithmetic can be lifted into another product unchanged, and
 * `__tests__/purity.test.ts` proves it.
 */

export { GuardrailError, GuardrailErrorCode, isGuardrailError } from './errors';

export { PanelState, resolvePanelState } from './states';
export type { ResolvePanelStateArgs } from './states';

export {
  COST_PLAUSIBILITY,
  DEFAULT_FEES,
  DEFAULT_FLOOR_PCT,
  FLOOR_WARN_THRESHOLD,
  GUIDANCE_BUCKETS,
  PRICE_BOUNDS,
  SEARCH_FLOOR_RATIO,
  THIN_DISCOUNT_THRESHOLD,
} from './constants';

export { formatCents, roundHalfUp } from './money';

export {
  cardFeeAt,
  contributionAt,
  floorCentsOf,
  fullPriceContributionAt,
  platformFeeAt,
} from './fees';

export { minViablePrice, scanMinViablePrice } from './minViablePrice';

export { evaluateCompleteDeal, evaluateDeal } from './evaluateDeal';

export { buildDealView, contributionAtMenuPriceFromView, guidanceBucketOf } from './view';

export { assertCompleteCostData, hasInvalidCostData, validateItemCosts } from './validate';

export { checkCostPlausibility } from './plausibility';

export type {
  Breakdown,
  CompleteGuardrailInput,
  DealEvaluation,
  DealView,
  FeeConstants,
  GuardrailEvaluation,
  GuardrailInput,
  GuardrailWarning,
  GuidanceBucket,
  IneligibilityReason,
  ValidationIssue,
} from './types';
