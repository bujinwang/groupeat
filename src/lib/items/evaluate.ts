import {
  DEFAULT_FEES,
  GuardrailError,
  PanelState,
  buildDealView,
  checkCostPlausibility,
  isGuardrailError,
  minViablePrice,
} from '@/lib/guardrail';
import type {
  CompleteGuardrailInput,
  GuardrailEvaluation,
  GuardrailWarning,
  IneligibilityReason,
} from '@/lib/guardrail';

/**
 * The guardrail endpoint's body (ARCHITECTURE-sprint1 §3.4 `GuardrailEndpoint`).
 *
 * It lives in `lib/` rather than in the route file because **three** callers need
 * the identical sequence: `POST /api/merchant/items/:id/guardrail`, the item page
 * (server-rendered) and the save path in `POST /api/merchant/items`. Copy-pasting
 * the try/catch into each is how one of them ends up returning a 500 for a dish
 * that simply has no ingredient cost yet.
 *
 * The function is pure with respect to the database: it receives a row and a
 * floor, and never reads anything itself.
 */

export type EvaluableItem = {
  id: string;
  menuPriceCents: number;
  foodCostCents: number;
  packagingCents: number;
  isBatchable: boolean;
  containsAlcohol: boolean;
};

/** PRD-sprint1 §7.4 / §5.5: an item that can never be part of a deal. */
export function ineligibilityOf(item: EvaluableItem): IneligibilityReason | null {
  // AGLC first: alcohol is a regulatory block and outranks a product one.
  if (item.containsAlcohol) {
    return 'CONTAINS_ALCOHOL';
  }
  if (!item.isBatchable) {
    return 'NOT_BATCHABLE';
  }
  return null;
}

/**
 * Builds the pure module's input from a database row and an already-converted
 * floor. `floorPctOfMenu` must come from `MerchantRepo.toPct()` — a raw Prisma
 * `Decimal` here would make every comparison false (see `lib/db/merchants.ts`).
 */
export function toGuardrailInput(
  item: EvaluableItem,
  floorPctOfMenu: number,
): CompleteGuardrailInput {
  return {
    ...DEFAULT_FEES,
    menuPriceCents: item.menuPriceCents,
    foodCostCents: item.foodCostCents,
    packagingCents: item.packagingCents,
    floorPctOfMenu,
  };
}

export type EvaluateItemArgs = {
  item: EvaluableItem;
  /** From `toPct()`, never a `Decimal`. */
  floorPctOfMenu: number;
  /** A price the merchant is exploring. Defaults to the lowest viable price. */
  dealPriceCents?: number | null;
  /** Injected so the module never reads a clock. */
  computedAt?: string;
};

/**
 * Evaluates one dish.
 *
 * `dealPriceCents` defaults to `minViablePrice ?? menuPrice`, which is what the
 * save path and the first render both want. A **submitted** price is evaluated as
 * given, not clamped: flow 3 needs `BELOW_FLOOR` to be reachable so the panel can
 * say "that price loses you money" and offer the real floor.
 */
export function evaluateItem(args: EvaluateItemArgs): GuardrailEvaluation {
  const { item, floorPctOfMenu } = args;
  const computedAt = args.computedAt ?? new Date().toISOString();
  const input = toGuardrailInput(item, floorPctOfMenu);
  const ineligible = ineligibilityOf(item);

  if (ineligible !== null) {
    // No price is ever produced for an ineligible item. `state` is INFEASIBLE
    // because no viable price exists; the UI branches on `ineligible` first, so
    // that value is never rendered as copy.
    return {
      version: 1,
      computedAt,
      state: PanelState.INFEASIBLE,
      ineligible,
      input,
      view: null,
      warnings: [],
      errorCode: null,
    };
  }

  let minViable: number | null;
  let view;
  try {
    minViable = minViablePrice(input);
    const dealPriceCents = args.dealPriceCents ?? minViable ?? input.menuPriceCents;
    view = buildDealView(input, dealPriceCents);
  } catch (error) {
    if (isGuardrailError(error) && error instanceof GuardrailError) {
      // §7.3: a missing cost is a valid answer, not an HTTP error. 200 + a state.
      return {
        version: 1,
        computedAt,
        state: PanelState.INCOMPLETE_COST_DATA,
        ineligible: null,
        input: null,
        view: null,
        warnings: ['COST_DATA_INCOMPLETE'],
        errorCode: error.code,
      };
    }
    throw error;
  }

  const warnings: GuardrailWarning[] = checkCostPlausibility(input);

  return {
    version: 1,
    computedAt,
    state: view.state,
    ineligible: null,
    input,
    view,
    warnings,
    errorCode: null,
  };
}
