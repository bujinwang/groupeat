import { SEARCH_FLOOR_RATIO } from './constants';
import { contributionAt, floorCentsOf } from './fees';
import type { CompleteGuardrailInput, GuardrailInput } from './types';
import { assertCompleteCostData } from './validate';

/**
 * The lowest deal price at which the merchant still clears their floor —
 * PRD-v1 §7.2, transcribed literally.
 *
 * ```
 * floorCents = floorPctOfMenu * menuPriceCents
 * for P = ceil(menuPriceCents * 0.5) .. menuPriceCents:
 *     fee     = clamp(platformFeePct * P, platformFeeFloorCents, platformFeeCapCents)
 *     stripe  = stripePct * P + stripeFixedCents
 *     contrib = P - foodCostCents - packagingCents - stripe - fee
 *     if contrib >= floorCents: return P
 * return null
 * ```
 *
 * **Do not optimise this into a binary search.** The ascending scan is the
 * frozen specification; it costs ~1 ms for 1,000 worst-case (500-cent-unit)
 * scans, and the test vectors were produced by exactly this loop. IEEE-754
 * double arithmetic is used verbatim, with no epsilon and no intermediate
 * rounding.
 *
 * Throws `GuardrailError(INCOMPLETE_COST_DATA)` iff `foodCostCents` is
 * `null` / `undefined` / `NaN` / non-finite. A bad cost *relationship* is not an
 * error: it simply finds no qualifying price and returns `null` (PRD-v1 §7.4).
 */
export function minViablePrice(input: GuardrailInput): number | null {
  return scanMinViablePrice(assertCompleteCostData(input));
}

/**
 * The scan itself, for callers that already hold a `CompleteGuardrailInput`
 * (`evaluateDeal` reuses it rather than re-asserting completeness).
 */
export function scanMinViablePrice(input: CompleteGuardrailInput): number | null {
  const floorCents = floorCentsOf(input);
  const firstCandidate = Math.ceil(input.menuPriceCents * SEARCH_FLOOR_RATIO);

  for (let price = firstCandidate; price <= input.menuPriceCents; price += 1) {
    if (contributionAt(input, price) >= floorCents) {
      return price;
    }
  }
  return null;
}
