'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Button, buttonClass } from '@/components/ui/Button';
import { ineligibleCopy, panelCopy } from '@/lib/copy/guardrail-copy';
import { PanelState } from '@/lib/guardrail';
import type { GuardrailEvaluation, IneligibilityReason } from '@/lib/guardrail';

import { BreakdownTable } from './BreakdownTable';
import { FloorEscapeHatch } from './FloorEscapeHatch';
import { PriceExplorer } from './PriceExplorer';

/**
 * PRD-sprint1 §6.4 — one component, seven states.
 *
 * The component **switches** on `evaluation.state`; it never derives one
 * (ARCHITECTURE-sprint1 P-3). Every word it renders comes from `panelCopy()` /
 * `ineligibleCopy()`, so there is no merchant-facing sentence in this file (§7.8).
 *
 * It performs no arithmetic on money: the breakdown rows are integers off the
 * view, the explorer reports a price the merchant picked, and everything else is a
 * formatted figure.
 */

const TONE_CLASS: Record<'green' | 'amber' | 'red', string> = {
  green: 'border-ok/30 bg-ok/5',
  amber: 'border-thin/30 bg-thin/5',
  red: 'border-blocked/30 bg-blocked/5',
};

const HEADLINE_CLASS: Record<'green' | 'amber' | 'red', string> = {
  green: 'text-ok',
  amber: 'text-thin',
  red: 'text-blocked',
};

export function GuardrailPanel({
  itemId,
  evaluation,
  ineligible,
  foodCostCents,
  onEvaluationChange,
}: {
  itemId: string;
  evaluation: GuardrailEvaluation | null;
  ineligible: IneligibilityReason | null;
  foodCostCents: number | null;
  onEvaluationChange: (evaluation: GuardrailEvaluation) => void;
}) {
  const view = evaluation?.view ?? null;
  const [price, setPrice] = useState<number>(view?.dealPriceCents ?? 0);

  // A save, a floor change or a fresh evaluation resets the handle to whatever the
  // server last said the price is.
  useEffect(() => {
    if (view) {
      setPrice(view.dealPriceCents);
    }
  }, [view?.dealPriceCents, view]);

  // ---- ineligible: no price is ever produced (PRD-sprint1 §5.5) -------------
  if (ineligible) {
    const copy = ineligibleCopy(ineligible);
    return (
      <section className={`rounded-xl border p-4 ${TONE_CLASS[copy.tone]}`} aria-live="polite">
        <h2 className={`text-sm font-semibold ${HEADLINE_CLASS[copy.tone]}`}>{copy.headline}</h2>
        {copy.body.map((line) => (
          <p key={line} className="mt-2 text-sm leading-relaxed text-ink">
            {line}
          </p>
        ))}
        <Link href="/merchant/items" className={buttonClass('secondary', 'mt-4 w-full')}>
          {copy.actionLabel}
        </Link>
      </section>
    );
  }

  if (!evaluation) {
    return (
      <p className="rounded-xl border border-slate-200 bg-surface p-4 text-sm text-ink-soft">
        Save the dish once and we&apos;ll tell you the lowest price that still works.
      </p>
    );
  }

  const copy = panelCopy(evaluation.state, view, { foodCostCents });
  const showBreakdown = view !== null && evaluation.state !== PanelState.INCOMPLETE_COST_DATA;
  const canExplore = view !== null && view.minViablePriceCents !== null;
  const isInfeasible = evaluation.state === PanelState.INFEASIBLE && view !== null;

  // The primary action, where it can do something today. "Use this price" has
  // nothing to act on until drop creation exists (M3), so it is shown disabled
  // rather than hidden: a panel with no action reads as broken.
  const isBlocked =
    evaluation.state === PanelState.THIN ||
    evaluation.state === PanelState.INFEASIBLE ||
    evaluation.state === PanelState.INVALID_COST_DATA;

  return (
    <section className={`rounded-xl border p-4 ${TONE_CLASS[copy.tone]}`} aria-live="polite">
      <h2 className={`text-sm font-semibold ${HEADLINE_CLASS[copy.tone]}`}>{copy.headline}</h2>

      {copy.body.map((line) => (
        <p key={line} className="mt-2 text-sm leading-relaxed text-ink">
          {line}
        </p>
      ))}

      {showBreakdown && view ? <BreakdownTable view={view} /> : null}

      {canExplore && view?.minViablePriceCents !== null && view ? (
        <PriceExplorer
          itemId={itemId}
          price={price}
          minViablePriceCents={view.minViablePriceCents}
          menuPriceCents={view.menuPriceCents}
          onPriceChange={setPrice}
          onEvaluationChange={onEvaluationChange}
        />
      ) : null}

      {isInfeasible && view ? (
        <FloorEscapeHatch
          itemId={itemId}
          currentFloorPct={view.floorPctOfMenu}
          currentFloorCents={view.floorCents}
        />
      ) : null}

      <div className="mt-4">
        {isBlocked ? (
          <Link href="/merchant/items" className={buttonClass('secondary', 'w-full')}>
            {copy.actionLabel}
          </Link>
        ) : (
          <>
            <Button disabled className="w-full">
              {copy.actionLabel}
            </Button>
            <p className="mt-1 text-center text-xs text-ink-soft">
              Saving a drop arrives in a later release.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
