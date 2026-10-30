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
  //
  // **Deliberate:** when `minViablePriceCents` is null (INFEASIBLE) *any* price is
  // "below the floor", but there is no floor price to report, so emitting a
  // violation would mean inventing one. A fabricated `floorPriceCents` in the
  // counter that M3's 1% alert is baselined on is worse than a missing row.
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

/**
 * S1-025 / S1-017 — every `containsAlcohol` **transition**.
 *
 * Both directions are recorded. Liquor licence liability sits with the merchant,
 * not with us, so when an AGLC question arrives we have to be able to say who
 * cleared the flag and when. That trail has to exist before the first edit, not
 * after the first incident. Append-only; no table.
 *
 * Creating a dish is not a transition and is not recorded here — there is no
 * `from` value to name.
 */
export function recordAlcoholFlagChange(args: {
  itemId: string;
  merchantId: string;
  actorUserId: string;
  from: boolean;
  to: boolean;
}): void {
  if (args.from === args.to) {
    return;
  }
  emit('item_alcohol_flag_changed', {
    itemId: args.itemId,
    merchantId: args.merchantId,
    actorUserId: args.actorUserId,
    from: args.from,
    to: args.to,
    changedAt: new Date().toISOString(),
  });
}
