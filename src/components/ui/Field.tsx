import type { ReactNode } from 'react';

/**
 * A labelled form field with helper text and an optional error.
 *
 * The label is the merchant-facing wording from PRD-sprint1 §5.1 — the technical
 * field name must never appear on screen.
 */
export function Field({
  id,
  label,
  helper,
  error,
  children,
}: {
  id: string;
  label: string;
  helper?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-blocked">
          {error}
        </p>
      ) : null}
      {helper ? (
        <p id={`${id}-helper`} className="text-xs leading-relaxed text-ink-soft">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'block w-full rounded-lg border border-slate-300 bg-surface px-3 py-2.5 text-base text-ink ' +
  'placeholder:text-slate-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 ' +
  'disabled:bg-surface-muted disabled:text-ink-soft';

export const inputErrorClass = 'border-blocked focus:border-blocked focus:ring-blocked/20';
