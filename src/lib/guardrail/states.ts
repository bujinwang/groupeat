/**
 * The seven panel states (PRD-sprint1 §5.4) and the one place the precedence
 * order is implemented (ARCHITECTURE-sprint1 §7.5).
 *
 * The state is decided on the server by `resolvePanelState()`. A component may
 * switch on it but may never derive it.
 */
export enum PanelState {
  /** Viable and the discount is at least the thin threshold. */
  OK = 'OK',
  /** Viable and the deal price is exactly the lowest price that still works. */
  FLOOR = 'FLOOR',
  /** Viable, but the discount is too shallow for anyone to act on it. */
  THIN = 'THIN',
  /** A price below the floor was submitted. */
  BELOW_FLOOR = 'BELOW_FLOOR',
  /** No price in the search window clears the floor. */
  INFEASIBLE = 'INFEASIBLE',
  /** `foodCostCents` is missing, so nothing can be computed. */
  INCOMPLETE_COST_DATA = 'INCOMPLETE_COST_DATA',
  /** The cost relationship is nonsense; the guardrail is never called. */
  INVALID_COST_DATA = 'INVALID_COST_DATA',
}

export type ResolvePanelStateArgs = {
  /** 1 — form validation failed, or `foodCost + packaging >= menuPrice`. */
  validationFailed: boolean;
  /** 2 — `foodCostCents` is null / undefined / NaN. */
  costDataIncomplete: boolean;
  /** 3 — `null` means no price clears the floor. */
  minViablePriceCents: number | null;
  /** 4 — the submitted price is below the floor. */
  isBelowFloor: boolean;
  /** 5 — exact (unrounded) discount fraction, e.g. 0.0267 for 2.7% off. */
  discountPctExact: number;
  /** 6 — the submitted price. */
  dealPriceCents: number;
  /** The thin-discount constant, injected so this module owns no policy value. */
  thinThreshold: number;
};

/**
 * PRD-sprint1 §5.4 precedence, first match wins:
 * `INVALID_COST_DATA → INCOMPLETE_COST_DATA → INFEASIBLE → BELOW_FLOOR → THIN
 * → FLOOR → OK`.
 *
 * Case C (at the floor *and* 2.7% off) therefore resolves to `THIN`, not
 * `FLOOR` — the "won't sell" property is the actionable one.
 */
export function resolvePanelState(args: ResolvePanelStateArgs): PanelState {
  if (args.validationFailed) {
    return PanelState.INVALID_COST_DATA;
  }
  if (args.costDataIncomplete) {
    return PanelState.INCOMPLETE_COST_DATA;
  }
  if (args.minViablePriceCents === null) {
    return PanelState.INFEASIBLE;
  }
  if (args.isBelowFloor) {
    return PanelState.BELOW_FLOOR;
  }
  if (args.discountPctExact < args.thinThreshold) {
    return PanelState.THIN;
  }
  if (args.dealPriceCents === args.minViablePriceCents) {
    return PanelState.FLOOR;
  }
  return PanelState.OK;
}
