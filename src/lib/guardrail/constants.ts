import type { FeeConstants, GuidanceBucket } from './types';

/**
 * The single home for every guardrail number (ARCHITECTURE-sprint1 §7.6).
 *
 * Nothing else in the codebase may declare these values. `src/lib/config.ts`
 * re-exports this object for server-side convenience rather than duplicating it,
 * so there is exactly one place to look.
 */

/** PRD-v1 §7.1 defaults. Frozen: the test vectors were computed with these. */
export const DEFAULT_FEES: FeeConstants = {
  platformFeePct: 0.08,
  platformFeeFloorCents: 60,
  platformFeeCapCents: 200,
  stripePct: 0.029,
  stripeFixedCents: 30,
};

/** PRD-sprint1 §5.4 / lead Q-2: below this discount depth a viable deal is `THIN`. */
export const THIN_DISCOUNT_THRESHOLD = 0.1;

/** PRD-sprint1 §5.1: a merchant floor below this share is worth a warning. */
export const FLOOR_WARN_THRESHOLD = 0.15;

/** Default minimum margin for a new merchant (PRD-sprint1 §7.2, D-1). */
export const DEFAULT_FLOOR_PCT = 0.25;

/**
 * PRD-sprint1 §7.4 food-cost plausibility bands. A warning, never a block.
 * A dish whose ingredients cost less than 15% of its menu price is usually a
 * typo; above 70% it usually cannot support a deal at all.
 */
export const COST_PLAUSIBILITY = {
  lowRatio: 0.15,
  highRatio: 0.7,
} as const;

/** PRD-sprint1 §7.1 / §7.4 field bounds. */
export const PRICE_BOUNDS = {
  menuPriceCents: { min: 1, max: 50000 },
  batchYield: { min: 1, max: 200 },
  prepMinutes: { min: 1, max: 240 },
  /** Floor is exclusive of 0 and inclusive of 1. */
  floorPctOfMenu: { minExclusive: 0, max: 1 },
} as const;

/** The search window for `minViablePrice` (PRD-v1 §7.2): `ceil(menu × 0.5) … menu`. */
export const SEARCH_FLOOR_RATIO = 0.5;

/**
 * PRD-sprint1 §5.3 guidance buckets, expressed as a descending lookup so that
 * "first match wins" reads the same as the product table.
 *
 * | break-even | bucket   |
 * | < 0.50     | CHEAP    |
 * | 0.50–0.649 | MODERATE |
 * | 0.65–0.799 | TIGHT    |
 * | ≥ 0.80     | SEVERE   |
 */
export const GUIDANCE_BUCKETS: readonly {
  bucket: GuidanceBucket;
  minInclusive: number;
}[] = [
  { bucket: 'SEVERE', minInclusive: 0.8 },
  { bucket: 'TIGHT', minInclusive: 0.65 },
  { bucket: 'MODERATE', minInclusive: 0.5 },
  { bucket: 'CHEAP', minInclusive: 0 },
];
