'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/Button';
import { floorEscapeHatchCopy } from '@/lib/copy/guardrail-copy';
import { formatCents } from '@/lib/guardrail';

import { previewFloorAction, type FloorPreview } from './actions';

/**
 * The INFEASIBLE escape hatch (PRD-sprint1 §5.5 "Change my minimum margin", Q-6).
 *
 * This is the only place a merchant may move their own floor, and the lead's
 * instruction is that it must be hard to use: *"if it's too easy, the guardrail
 * degrades into a suggestion."*
 *
 * Two steps, both mandatory:
 *   1. **Choose, and read the consequence in money.** Every figure is computed by
 *      the server for the floor actually being considered — never a template
 *      placeholder, never a percentage on its own.
 *   2. **Confirm.** Only then is the value written, via the same
 *      `PATCH /api/merchant/settings` path the admin uses, which requires
 *      `acknowledgedConsequence` and emits `floor_changed`.
 *
 * There is no way to skip step 1: the confirm button does not exist until the
 * merchant has pressed Continue on a consequence they have seen.
 */
export function FloorEscapeHatch({
  itemId,
  currentFloorPct,
  currentFloorCents,
}: {
  itemId: string;
  /** Whole percent, as the panel displays it. */
  currentFloorPct: number;
  currentFloorCents: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'choose' | 'confirm'>('choose');
  const [candidatePct, setCandidatePct] = useState(() => Math.max(1, currentFloorPct - 5));
  const [preview, setPreview] = useState<FloorPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  // Recompute the consequence whenever the candidate changes. Debounced: dragging
  // a slider must not fire one evaluation per pixel.
  useEffect(() => {
    if (!open || step !== 'choose') {
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      setBusy(true);
      setError(null);
      void previewFloorAction({ itemId, candidatePct })
        .then(setPreview)
        .catch(() => setPreview({ ok: false, message: 'That could not be calculated.' }))
        .finally(() => setBusy(false));
    }, 250);

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, [open, step, itemId, candidatePct]);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/merchant/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          floorPctOfMenu: candidatePct / 100,
          acknowledgedConsequence: true,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        setError(payload.message ?? 'That could not be saved. Try again.');
        return;
      }

      setOpen(false);
      setStep('choose');
      setPreview(null);
      router.refresh();
    } catch {
      setError('That could not be saved. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    setStep('choose');
    setPreview(null);
    setError(null);
  }

  const copy =
    preview?.ok === true
      ? floorEscapeHatchCopy({
          candidatePct: preview.candidatePct,
          minViablePriceCents: preview.minViablePriceCents,
          keepCents: preview.keepCents,
          currentFloorCents,
        })
      : null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
      >
        Change my minimum margin
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="floor-escape-headline"
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-surface p-5 shadow-lg"
      >
        <h2 id="floor-escape-headline" className="text-base font-semibold text-ink">
          {copy?.headline ?? 'Lower your minimum margin?'}
        </h2>

        {step === 'choose' ? (
          <>
            <label htmlFor="candidate-floor" className="mt-4 block text-sm text-ink">
              New minimum: <span className="tabular-nums font-medium">{candidatePct}%</span>
            </label>
            <input
              id="candidate-floor"
              type="range"
              min={1}
              max={Math.max(1, currentFloorPct - 1)}
              step={1}
              value={candidatePct}
              onChange={(event) => setCandidatePct(Number(event.target.value))}
              className="mt-2 h-11 w-full accent-brand"
            />
            <p className="text-xs text-ink-soft">
              Now {currentFloorPct}%, which is {formatCents(currentFloorCents)} per plate at your menu
              price.
            </p>

            <div className="mt-4 min-h-16 rounded-lg bg-surface-muted p-3">
              {busy ? (
                <p className="text-sm text-ink-soft">Working out the numbers…</p>
              ) : preview?.ok === true && copy ? (
                <p className="text-sm leading-relaxed text-ink">{copy.consequence}</p>
              ) : (
                <p className="text-sm leading-relaxed text-ink-soft">
                  {preview?.ok === false ? preview.message : 'Choose a value.'}
                </p>
              )}
            </div>

            {error ? (
              <p role="alert" className="mt-3 text-sm text-blocked">
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-2">
              <Button
                type="button"
                onClick={() => setStep('confirm')}
                disabled={busy || preview?.ok !== true}
              >
                Continue
              </Button>
              <Button ref={cancelRef} type="button" variant="secondary" onClick={close}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm leading-relaxed text-ink">{copy?.consequence}</p>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              This changes your minimum for every dish on this account, not just this one.
            </p>

            {error ? (
              <p role="alert" className="mt-3 text-sm text-blocked">
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-2">
              <Button type="button" variant="danger" onClick={apply} disabled={busy}>
                {busy ? 'Saving…' : (copy?.confirmLabel ?? 'Lower my minimum')}
              </Button>
              <Button
                ref={cancelRef}
                type="button"
                variant="secondary"
                onClick={() => setStep('choose')}
                disabled={busy}
              >
                Back
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
