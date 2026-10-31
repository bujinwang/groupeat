'use client';

import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/Button';
import { alcoholFlagConfirmationCopy } from '@/lib/copy/guardrail-copy';

/**
 * PRD-sprint1 §5.5a / S1-025 — the confirmation shown when a merchant flips
 * `containsAlcohol` from `true` to `false`.
 *
 * Four rules, all from the PRD, all easy to get subtly wrong:
 *
 * 1. **Ask about the fact, not the intention.** "Confirm this dish contains no
 *    alcohol" asks the merchant to assert something true or false about the dish,
 *    which is what the AGLC cares about. "Are you sure?" asks them to confirm a
 *    decision and gets a reflex click.
 * 2. **Default focus is Cancel.** The confirm button is the only way through, so
 *    it must not be what a double-tap hits.
 * 3. **One dialog, two buttons.** No checkbox-plus-button double gate; two gates
 *    on a correction teaches the merchant to click through both.
 * 4. **`false → true` never shows this.** Adding the flag only makes the dish
 *    safer to exclude; friction belongs on the dangerous direction.
 *
 * The strings come from `alcoholFlagConfirmationCopy()` — never typed inline
 * (§7.8).
 */
export function AlcoholFlagDialog({
  open,
  onConfirm,
  onCancel,
  busy = false,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const copy = alcoholFlagConfirmationCopy();

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCancel();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="alcohol-confirm-headline"
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-surface p-5 shadow-lg"
      >
        <h2 id="alcohol-confirm-headline" className="text-base font-semibold text-ink">
          {copy.headline}
        </h2>
        {copy.body.map((line) => (
          <p key={line} className="mt-2 text-sm leading-relaxed text-ink-soft">
            {line}
          </p>
        ))}

        <div className="mt-5 flex flex-col gap-2">
          <Button type="button" variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Saving…' : copy.confirmLabel}
          </Button>
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            {copy.cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
