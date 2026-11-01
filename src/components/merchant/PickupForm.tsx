'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass, inputErrorClass } from '@/components/ui/Field';

/**
 * FR-103 — the merchant sets their own pickup details.
 *
 * A plain `fetch` to `PATCH /api/merchant/pickup` rather than a server action,
 * because this is a **client-editable resource** and the response carries the
 * normalised values back: the server trims and nulls empty strings, so the form
 * has to show what was actually stored, not what was typed.
 *
 * Not a server action for a second reason: `FloorEscapeHatch` already
 * established the fetch-to-route pattern for merchant-writable fields, and one
 * pattern for one class of write is worth more than the smaller LOC of two.
 */

type PickupValues = {
  pickupAddress: string;
  pickupInstructions: string;
};

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string; fieldErrors: Record<string, string> };

export function PickupForm({
  initialAddress,
  initialInstructions,
}: {
  initialAddress: string | null;
  initialInstructions: string | null;
}) {
  const [values, setValues] = useState<PickupValues>({
    pickupAddress: initialAddress ?? '',
    pickupInstructions: initialInstructions ?? '',
  });
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  const dirty =
    values.pickupAddress !== (initialAddress ?? '') ||
    values.pickupInstructions !== (initialInstructions ?? '');

  function update(key: keyof PickupValues, value: string): void {
    setValues((previous) => ({ ...previous, [key]: value }));
    // A stale error under a field the merchant has since edited is a lie.
    if (state.kind === 'error') {
      setState({ kind: 'idle' });
    }
  }

  async function save(): Promise<void> {
    setState({ kind: 'saving' });
    try {
      const response = await fetch('/api/merchant/pickup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickupAddress: values.pickupAddress,
          pickupInstructions: values.pickupInstructions,
        }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const fieldErrors =
          body && typeof body === 'object' && 'fieldErrors' in body
            ? ((body as { fieldErrors?: Record<string, string> }).fieldErrors ?? {})
            : {};
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : 'That could not be saved. Try again.';
        setState({ kind: 'error', message, fieldErrors });
        return;
      }

      // Show what the server actually stored (trimmed, empty → null).
      if (body && typeof body === 'object') {
        const stored = body as { pickupAddress: string | null; pickupInstructions: string | null };
        setValues({
          pickupAddress: stored.pickupAddress ?? '',
          pickupInstructions: stored.pickupInstructions ?? '',
        });
      }
      setState({ kind: 'saved' });
    } catch {
      setState({
        kind: 'error',
        message: 'We could not reach the server. Check your connection and try again.',
        fieldErrors: {},
      });
    }
  }

  const fieldErrors = state.kind === 'error' ? state.fieldErrors : {};

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field
        id="pickupAddress"
        label="Pickup address"
        helper="Where diners collect. This appears on every deal page, so use the address they will search for."
        error={fieldErrors.pickupAddress}
      >
        <input
          id="pickupAddress"
          name="pickupAddress"
          type="text"
          value={values.pickupAddress}
          onChange={(event) => update('pickupAddress', event.target.value)}
          maxLength={300}
          placeholder="123 10 Ave NE, Calgary"
          className={`${inputClass} ${fieldErrors.pickupAddress ? inputErrorClass : ''}`}
        />
      </Field>

      <Field
        id="pickupInstructions"
        label="Pickup instructions"
        helper="The thing diners always get wrong: which door, which counter, who to ask for."
        error={fieldErrors.pickupInstructions}
      >
        <textarea
          id="pickupInstructions"
          name="pickupInstructions"
          rows={3}
          value={values.pickupInstructions}
          onChange={(event) => update('pickupInstructions', event.target.value)}
          maxLength={300}
          placeholder="Side door on the left, ring the bell and ask for the pickup order."
          className={`${inputClass} ${fieldErrors.pickupInstructions ? inputErrorClass : ''}`}
        />
      </Field>

      {state.kind === 'error' ? (
        <p role="alert" className="text-sm text-blocked">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'saved' ? (
        <p role="status" className="text-sm text-ok">
          Saved.
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={state.kind === 'saving' || !dirty}>
          {state.kind === 'saving' ? 'Saving…' : 'Save pickup details'}
        </Button>
        {!dirty && state.kind === 'idle' ? (
          <span className="text-xs text-ink-soft">No changes yet.</span>
        ) : null}
      </div>
    </form>
  );
}
