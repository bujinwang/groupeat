import type { GuardrailErrorCode } from './errors';
import type { PanelState } from './states';

/**
 * Fee constants. Injected into every function rather than imported from
 * `constants.ts` by the arithmetic, so a caller (a test, a what-if explorer, a
 * future pricing experiment) can vary them without touching the module.
 */
export type FeeConstants = {
  /** 0.08 — platform fee, proportional. */
  platformFeePct: number;
  /** 60 — platform fee floor, in cents. */
  platformFeeFloorCents: number;
  /** 200 — platform fee cap, in cents. */
  platformFeeCapCents: number;
  /** 0.029 — card processing percentage. */
  stripePct: number;
  /** 30 — card processing fixed component, in cents. */
  stripeFixedCents: number;
};

/**
 * Public input. `foodCostCents` is deliberately widened to `number | null |
 * undefined` so partial API / seed / future-AI input type-checks and then fails
 * loudly at `assertCompleteCostData()`, instead of silently computing `NaN`.
 */
export type GuardrailInput = FeeConstants & {
  menuPriceCents: number;
  foodCostCents: number | null | undefined;
  packagingCents: number;
  /** The merchant's minimum margin as a share of menu price: `0 < x <= 1`. */
  floorPctOfMenu: number;
};

/** Post-narrowing shape. Only this one reaches the arithmetic. */
export type CompleteGuardrailInput = FeeConstants & {
  menuPriceCents: number;
  foodCostCents: number;
  packagingCents: number;
  floorPctOfMenu: number;
};

/**
 * PRD-v1 §7.3, field for field. This object is what becomes
 * `Drop.guardrailSnapshot.result` (PRD-sprint1 §7.7), so the field names are
 * frozen.
 *
 * Money derived from a percentage (`contributionCents`, `platformFeeCents`) is
 * **unrounded** here. Rounding is a display concern and lives in `DealView`.
 */
export type DealEvaluation = {
  contributionCents: number;
  contributionPctOfMenu: number;
  fullPriceContributionCents: number;
  breakEvenIncrementality: number;
  platformFeeCents: number;
  isBelowFloor: boolean;
  minViablePriceCents: number | null;
};

export type GuidanceBucket = 'CHEAP' | 'MODERATE' | 'TIGHT' | 'SEVERE';

export type IneligibilityReason = 'NOT_BATCHABLE' | 'CONTAINS_ALCOHOL';

/** One row of the panel breakdown. Integer cents; the four rows sum to the price. */
export type Breakdown = {
  contributionCents: number;
  platformFeeCents: number;
  cardFeeCents: number;
  ingredientsAndPackagingCents: number;
};

/**
 * Display-ready view. Every integer here is safe to render as-is; every string
 * the merchant reads is derived from these integers by `src/lib/copy/`.
 *
 * `breakdown` reconciles by construction:
 * `contributionCents + platformFeeCents + cardFeeCents +
 * ingredientsAndPackagingCents === dealPriceCents`.
 */
export type DealView = {
  state: PanelState;
  menuPriceCents: number;
  dealPriceCents: number;
  savingCents: number;
  /** Whole percent, half up. `30.5%` → `31`. */
  discountPct: number;
  minViablePriceCents: number | null;
  isBelowFloor: boolean;
  breakdown: Breakdown;
  /** Unrounded, for storage only. Never rendered. */
  contributionCentsExact: number;
  /** Whole percent. */
  contributionPctOfMenu: number;
  /** Whole percent. */
  floorPctOfMenu: number;
  /** Rounded, for the INFEASIBLE sentence. */
  floorCents: number;
  /** Whole points; negative when below the floor. */
  pointsAboveFloor: number;
  /** Rounded, may be negative. */
  fullPriceContributionCents: number;
  /** 0…100, half up, clamped. */
  breakEvenCountOf100: number;
  guidanceBucket: GuidanceBucket;
};

/** Non-blocking advisories. None of these ever prevents a save. */
export type GuardrailWarning =
  | 'FOOD_COST_IMPLAUSIBLY_LOW'
  | 'FOOD_COST_IMPLAUSIBLY_HIGH'
  | 'FLOOR_BELOW_WARN_THRESHOLD'
  | 'COST_DATA_INCOMPLETE';

/** The API response. The only object the UI is allowed to trust. */
export type GuardrailEvaluation = {
  version: 1;
  /** ISO-8601 with offset, injected by the caller — the module never reads a clock. */
  computedAt: string;
  state: PanelState;
  ineligible: IneligibilityReason | null;
  /** Echoed from the database, never from the request body. */
  input: CompleteGuardrailInput | null;
  view: DealView | null;
  warnings: GuardrailWarning[];
  errorCode: GuardrailErrorCode | null;
};

export type ValidationIssue = {
  field:
    | 'menuPriceCents'
    | 'foodCostCents'
    | 'packagingCents'
    | 'batchYield'
    | 'prepMinutes'
    | 'floorPctOfMenu';
  code:
    | 'REQUIRED'
    | 'NOT_A_NUMBER'
    | 'NEGATIVE'
    | 'TOO_LARGE'
    | 'COST_EXCEEDS_PRICE'
    | 'OUT_OF_RANGE';
};
