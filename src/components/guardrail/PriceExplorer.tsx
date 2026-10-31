'use client';

import { useEffect, useRef, useState } from 'react';

import { formatCents } from '@/lib/guardrail';
import type { GuardrailEvaluation } from '@/lib/guardrail';

/**
 * S1-015 — the read-only price explorer.
 *
 * The left end **is** `minViablePriceCents`. It is not a suggestion and it is not
 * validated after the fact: the control cannot produce a lower value. That is
 * FR-203's promise — the guardrail blocks at configuration time, not by rejecting
 * a submission — and it is why there is no text input on this row.
 *
 * Controlled by `GuardrailPanel`, so a state's primary action ("Use $11.12
 * instead") can move the handle.
 *
 * No money arithmetic: the slider reports a price the merchant picked, the server
 * evaluates it, and the panel renders whatever comes back. Nothing persists.
 */

const DEBOUNCE_MS = 250;

export function PriceExplorer({
  itemId,
  price,
  minViablePriceCents,
  menuPriceCents,
  onPriceChange,
  onEvaluationChange,
}: {
  itemId: string;
  price: number;
  minViablePriceCents: number;
  menuPriceCents: number;
  onPriceChange: (cents: number) => void;
  onEvaluationChange: (evaluation: GuardrailEvaluation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
      inFlight.current?.abort();
    };
  }, []);

  function handleChange(raw: number) {
    // Hard clamp, twice: the input's own min/max, and here, so a programmatic
    // value cannot slip below the floor either.
    const next = Math.min(Math.max(raw, minViablePriceCents), menuPriceCents);
    onPriceChange(next);

    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setBusy(true);

      void fetch(`/api/merchant/items/${itemId}/guardrail`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dealPriceCents: next }),
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: GuardrailEvaluation | null) => {
          if (payload) {
            onEvaluationChange(payload);
          }
        })
        .catch(() => {
          // Aborted or offline: keep the last good evaluation on screen. A failed
          // drag must not blank the panel.
        })
        .finally(() => setBusy(false));
    }, DEBOUNCE_MS);
  }

  return (
    <div className="mt-4 border-t border-slate-200 pt-3">
      <div className="flex items-baseline justify-between">
        <label htmlFor="deal-price" className="block text-xs font-medium text-ink-soft">
          Try a different price
        </label>
        <span className="text-sm tabular-nums text-ink" aria-live="polite">
          {formatCents(price)}
          {busy ? <span className="ml-1 text-xs text-ink-soft">…</span> : null}
        </span>
      </div>

      <input
        id="deal-price"
        type="range"
        min={minViablePriceCents}
        max={menuPriceCents}
        step={1}
        value={price}
        onChange={(event) => handleChange(Number(event.target.value))}
        className="mt-1 h-11 w-full accent-brand"
      />

      <div className="flex justify-between text-xs tabular-nums text-ink-soft">
        <span>{formatCents(minViablePriceCents)}</span>
        <span>{formatCents(menuPriceCents)}</span>
      </div>

      <p className="mt-1 text-xs text-ink-soft">▲ cannot go lower</p>
    </div>
  );
}
