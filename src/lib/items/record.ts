import { emit } from '@/lib/analytics/events';
import type { GuardrailEvaluation } from '@/lib/guardrail';

/**
 * Writes the analytics events for one evaluation (S1-017, and the lead's
 * non-blocking plausibility warning).
 *
 * Separate from `evaluate.ts` on purpose: that module is pure — a row and a floor
 * in, an evaluation out — and mixing a file append into it would make the one
 * piece of logic the sprint is judged on depend on the filesystem.
 *
 * `emit()` never throws, so a full disk cannot fail a merchant's save.
 */

export type RecordableItem = {
  id: string;
  merchantId: string;
  menuPriceCents: number;
  foodCostCents: number;
};

export function recordEvaluation(
  evaluation: GuardrailEvaluation,
  item: RecordableItem,
  actorUserId: string,
): void {
  emit('guardrail_evaluated', {
    itemId: item.id,
    merchantId: item.merchantId,
    actorUserId,
    state: evaluation.state,
    minViablePriceCents: evaluation.view?.minViablePriceCents ?? null,
    isBelowFloor: evaluation.view?.isBelowFloor ?? false,
  });

  // A submitted price below a floor we can name is the violation worth counting:
  // it is the case where the panel can tell the merchant what to charge instead.
  const view = evaluation.view;
  if (view && view.isBelowFloor && view.minViablePriceCents !== null) {
    emit('guardrail_violation', {
      itemId: item.id,
      merchantId: item.merchantId,
      submittedPriceCents: view.dealPriceCents,
      floorPriceCents: view.minViablePriceCents,
    });
  }

  // Lead's addition: non-blocking food-cost plausibility. One line per warning;
  // the save already succeeded by the time this runs.
  for (const warning of evaluation.warnings) {
    if (warning === 'FOOD_COST_IMPLAUSIBLY_LOW' || warning === 'FOOD_COST_IMPLAUSIBLY_HIGH') {
      emit('food_cost_implausible', {
        itemId: item.id,
        merchantId: item.merchantId,
        warning,
        foodCostCents: item.foodCostCents,
        menuPriceCents: item.menuPriceCents,
      });
    }
  }
}
