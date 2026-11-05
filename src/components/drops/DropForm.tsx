'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/Button';
import { Field, inputClass, inputErrorClass } from '@/components/ui/Field';
import { MoneyInput } from '@/components/ui/MoneyInput';

/**
 * The drop form (FR-201…FR-205 minus the AI, which degrades to this).
 *
 * ## What this form does *not* do
 *
 * It does not decide whether the price is acceptable. The server does, against
 * the database, at publish. What this form does is **show the floor while the
 * merchant types**, so the refusal they eventually hit is one they could see
 * coming — a `min` attribute on the price input plus a sentence naming the
 * number.
 *
 * The floor arrives as a prop from the server component, computed from the
 * merchant's own record. A tampered value here changes nothing: the publish path
 * rebuilds the input from the database.
 *
 * ## Why the dates are `<input type="datetime-local">`
 *
 * No date library, no picker component. The value is a local date-time string with
 * no offset, which `new Date()` interprets in the browser's timezone — correct
 * for a merchant in Edmonton picking a pickup time in Edmonton. The server
 * validates ordering and the five-day cap regardless.
 */

export type DropFormValues = {
  menuItemId: string;
  title: string;
  description: string;
  heroImageUrl: string;
  dealPriceCents: number;
  minQty: number;
  maxQty: number;
  windowStart: string;
  windowEnd: string;
  cutoffAt: string;
};

export type DishOption = {
  id: string;
  name: string;
  menuPriceCents: number;
  batchYield: number;
  /** Server-computed minimum for this dish. `null` when no price works. */
  minViablePriceCents: number | null;
};

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string; fieldErrors: Record<string, string> };

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time, not an ISO string. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The latest cutoff the server will accept, from the same five-day rule. */
const MAX_AUTH_WINDOW_DAYS = 5;

export function DropForm({
  dishes,
  initial,
  dropId,
  submitLabel,
}: {
  dishes: readonly DishOption[];
  initial?: Partial<DropFormValues>;
  /** `undefined` creates; an id edits an existing draft. */
  dropId?: string;
  submitLabel: string;
}) {
  const router = useRouter();

  const now = useMemo(() => new Date(), []);
  const latestCutoff = useMemo(
    () => new Date(now.getTime() + MAX_AUTH_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    [now],
  );

  const [values, setValues] = useState<DropFormValues>(() => ({
    menuItemId: initial?.menuItemId ?? dishes[0]?.id ?? '',
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    heroImageUrl: initial?.heroImageUrl ?? '',
    dealPriceCents: initial?.dealPriceCents ?? 0,
    minQty: initial?.minQty ?? 20,
    maxQty: initial?.maxQty ?? 30,
    // Default to a cutoff three days out and pickup two hours after it: a
    // plausible shape the merchant edits, rather than an empty form they have to
    // reason about from nothing.
    cutoffAt: initial?.cutoffAt ?? toLocalInput(new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)),
    windowStart:
      initial?.windowStart ??
      toLocalInput(new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000)),
    windowEnd:
      initial?.windowEnd ??
      toLocalInput(new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000)),
  }));
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  const selectedDish = dishes.find((dish) => dish.id === values.menuItemId) ?? null;
  const floorCents = selectedDish?.minViablePriceCents ?? null;
  const belowFloor = floorCents !== null && values.dealPriceCents > 0 && values.dealPriceCents < floorCents;

  function update<K extends keyof DropFormValues>(key: K, value: DropFormValues[K]): void {
    setValues((previous) => ({ ...previous, [key]: value }));
    if (state.kind === 'error') {
      setState({ kind: 'idle' });
    }
  }

  const fieldErrors = state.kind === 'error' ? state.fieldErrors : {};

  async function submit(): Promise<void> {
    setState({ kind: 'saving' });
    try {
      const response = await fetch(dropId ? `/api/merchant/drops/${dropId}` : '/api/merchant/drops', {
        method: dropId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menuItemId: values.menuItemId,
          title: values.title,
          description: values.description || null,
          heroImageUrl: values.heroImageUrl.trim() || null,
          dealPriceCents: values.dealPriceCents,
          minQty: values.minQty,
          maxQty: values.maxQty,
          maxPerCustomer: 4,
          windowStart: values.windowStart,
          windowEnd: values.windowEnd,
          cutoffAt: values.cutoffAt,
          aiRationale: null,
        }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const errors =
          body && typeof body === 'object' && 'fieldErrors' in body
            ? ((body as { fieldErrors?: Record<string, string> }).fieldErrors ?? {})
            : {};
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : 'That could not be saved. Try again.';
        setState({ kind: 'error', message, fieldErrors: errors });
        return;
      }

      const created =
        body && typeof body === 'object' && 'drop' in body
          ? (body as { drop: { id: string } }).drop
          : null;

      // Straight to the draft, where the merchant reviews and publishes.
      router.push(created ? `/merchant/drops/${created.id}` : '/merchant/drops');
      router.refresh();
    } catch {
      setState({
        kind: 'error',
        message: 'We could not reach the server. Check your connection and try again.',
        fieldErrors: {},
      });
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field
        id="menuItemId"
        label="Which dish?"
        helper="Only dishes you can make in batches appear here. Alcohol can never be a drop."
        error={fieldErrors.menuItemId}
      >
        <select
          id="menuItemId"
          value={values.menuItemId}
          onChange={(event) => update('menuItemId', event.target.value)}
          className={`${inputClass} ${fieldErrors.menuItemId ? inputErrorClass : ''}`}
        >
          {dishes.map((dish) => (
            <option key={dish.id} value={dish.id}>
              {dish.name}
            </option>
          ))}
        </select>
      </Field>

      {selectedDish && floorCents === null ? (
        <p className="rounded-lg border border-blocked/30 bg-blocked/5 p-3 text-sm text-blocked">
          This dish cannot be a deal at your minimum margin. No price clears it — the
          ingredients cost too much relative to what you charge. Pick a different dish.
        </p>
      ) : null}

      <Field
        id="title"
        label="What is the drop called?"
        helper="This is what people see in the group chat. Keep it short."
        error={fieldErrors.title}
      >
        <input
          id="title"
          type="text"
          value={values.title}
          onChange={(event) => update('title', event.target.value)}
          maxLength={60}
          placeholder="Beef Bowl Thursday"
          className={`${inputClass} ${fieldErrors.title ? inputErrorClass : ''}`}
        />
      </Field>

      <Field
        id="description"
        label="Anything else they should know?"
        helper="Optional. One or two sentences."
        error={fieldErrors.description}
      >
        <textarea
          id="description"
          rows={3}
          value={values.description}
          onChange={(event) => update('description', event.target.value)}
          maxLength={300}
          className={`${inputClass} ${fieldErrors.description ? inputErrorClass : ''}`}
        />
      </Field>

      <Field
        id="heroImageUrl"
        label="Hero image (optional)"
        helper="Paste a public image URL, or leave blank for a card the app composes from the dish and price."
        error={fieldErrors.heroImageUrl}
      >
        <input
          id="heroImageUrl"
          type="url"
          value={values.heroImageUrl}
          onChange={(event) => update('heroImageUrl', event.target.value)}
          maxLength={500}
          placeholder="https://…"
          className={`${inputClass} ${fieldErrors.heroImageUrl ? inputErrorClass : ''}`}
        />
      </Field>

      <Field
        id="dealPriceCents"
        label="Price per plate"
        helper={
          floorCents === null
            ? undefined
            : `Your minimum for this dish is $${(floorCents / 100).toFixed(2)}. You cannot publish below it.`
        }
        error={fieldErrors.dealPriceCents}
      >
        <MoneyInput
          id="dealPriceCents"
          valueCents={values.dealPriceCents}
          onChangeCents={(cents) => update('dealPriceCents', cents ?? 0)}
          invalid={Boolean(fieldErrors.dealPriceCents)}
        />
      </Field>

      {belowFloor ? (
        // A warning, not a block: the draft may be saved at any price, because a
        // merchant often works out the price by saving and looking. Publish is
        // where it hard-stops.
        <p className="rounded-lg border border-thin/30 bg-thin/5 p-3 text-sm text-thin">
          That is below your minimum of ${(floorCents! / 100).toFixed(2)}. You can save the draft,
          but it will not publish until the price is at least that.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Field id="minQty" label="Need at least" helper="People" error={fieldErrors.minQty}>
          <input
            id="minQty"
            type="number"
            min={1}
            value={values.minQty}
            onChange={(event) => update('minQty', Number(event.target.value))}
            className={`${inputClass} ${fieldErrors.minQty ? inputErrorClass : ''}`}
          />
        </Field>
        <Field
          id="maxQty"
          label="Willing to make"
          helper={selectedDish ? `Up to ${selectedDish.batchYield}` : 'People'}
          error={fieldErrors.maxQty}
        >
          <input
            id="maxQty"
            type="number"
            min={1}
            max={selectedDish?.batchYield ?? undefined}
            value={values.maxQty}
            onChange={(event) => update('maxQty', Number(event.target.value))}
            className={`${inputClass} ${fieldErrors.maxQty ? inputErrorClass : ''}`}
          />
        </Field>
      </div>

      <Field
        id="cutoffAt"
        label="Joining closes"
        helper={`Must be within ${MAX_AUTH_WINDOW_DAYS} days, and before pickup starts.`}
        error={fieldErrors.cutoffAt}
      >
        <input
          id="cutoffAt"
          type="datetime-local"
          value={values.cutoffAt}
          max={toLocalInput(latestCutoff)}
          onChange={(event) => update('cutoffAt', event.target.value)}
          className={`${inputClass} ${fieldErrors.cutoffAt ? inputErrorClass : ''}`}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          id="windowStart"
          label="Pickup from"
          error={fieldErrors.windowStart}
        >
          <input
            id="windowStart"
            type="datetime-local"
            value={values.windowStart}
            onChange={(event) => update('windowStart', event.target.value)}
            className={`${inputClass} ${fieldErrors.windowStart ? inputErrorClass : ''}`}
          />
        </Field>
        <Field id="windowEnd" label="Pickup until" error={fieldErrors.windowEnd}>
          <input
            id="windowEnd"
            type="datetime-local"
            value={values.windowEnd}
            onChange={(event) => update('windowEnd', event.target.value)}
            className={`${inputClass} ${fieldErrors.windowEnd ? inputErrorClass : ''}`}
          />
        </Field>
      </div>

      {state.kind === 'error' ? (
        <p role="alert" className="text-sm text-blocked">
          {state.message}
        </p>
      ) : null}

      <Button type="submit" disabled={state.kind === 'saving' || !values.menuItemId}>
        {state.kind === 'saving' ? 'Saving…' : submitLabel}
      </Button>
    </form>
  );
}
