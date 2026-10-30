'use client';

import { useState } from 'react';

import { formatCents } from '@/lib/guardrail';

/**
 * The money boundary (§7.2 rule 1): a string becomes integer cents here, once.
 * Nothing downstream parses a money string, and no float arithmetic happens on the
 * way in — `parseMoneyToCents` works on the digits, not on `Number(text) * 100`.
 *
 * Accepts what a person types: `16`, `16.0`, `16.00`, `$16.00`, `1,600`.
 */

export function parseMoneyToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (cleaned === '') {
    return null;
  }
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) {
    return null;
  }

  const [wholePart = '0', fractionPart = ''] = cleaned.split('.');
  const whole = Number(wholePart);
  if (!Number.isFinite(whole)) {
    return null;
  }
  const cents = whole * 100 + Number(fractionPart.padEnd(2, '0'));
  return Number.isFinite(cents) ? cents : null;
}

export function MoneyInput({
  id,
  valueCents,
  onChangeCents,
  onBlur,
  invalid = false,
  describedBy,
  disabled = false,
}: {
  id: string;
  valueCents: number | null;
  onChangeCents: (cents: number | null) => void;
  onBlur?: () => void;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  // The raw text is local state: re-formatting on every keystroke would fight the
  // person typing. It is normalised to `$16.00` on blur.
  const [text, setText] = useState(valueCents === null ? '' : formatCents(valueCents));

  function handleChange(next: string) {
    setText(next);
    onChangeCents(parseMoneyToCents(next));
  }

  function handleBlur() {
    const cents = parseMoneyToCents(text);
    if (cents !== null) {
      setText(formatCents(cents));
    }
    onBlur?.();
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">
        $
      </span>
      <input
        id={id}
        name={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        value={text}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={handleBlur}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className={[
          'block w-full rounded-lg border bg-surface py-2.5 pl-7 pr-3 text-base text-ink',
          'placeholder:text-slate-400 focus:outline-none focus:ring-2',
          invalid
            ? 'border-blocked focus:border-blocked focus:ring-blocked/20'
            : 'border-slate-300 focus:border-brand focus:ring-brand/20',
          disabled ? 'bg-surface-muted text-ink-soft' : '',
        ].join(' ')}
      />
    </div>
  );
}
