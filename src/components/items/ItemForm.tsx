'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { formatCents, validateItemCosts } from '@/lib/guardrail';
import type { GuardrailEvaluation, IneligibilityReason, ValidationIssue } from '@/lib/guardrail';
import { ineligibleCopy, panelCopy } from '@/lib/copy/guardrail-copy';
import { AlcoholFlagDialog } from './AlcoholFlagDialog';

/**
 * The dish form (PRD-sprint1 §6.3).
 *
 * Three rules from the PRD that shape this file:
 *
 *   1. **Validation fires on blur, not on every keystroke.** Keystroke validation
 *      is how you get a red field while the merchant is still typing. The
 *      predicate itself is `validateItemCosts()` — the *same function* the route
 *      handler runs (assumption A-1), so the browser and the server cannot
 *      disagree about what is valid.
 *   2. **The server computes, the browser formats.** This component never does
 *      arithmetic on money: it parses input to cents, posts it, and renders the
 *      `GuardrailEvaluation` that comes back.
 *   3. **The panel evaluates on save and on a cost change, debounced 600 ms.**
 *      Only after the dish exists, because an unsaved dish has no id.
 */

const DEBOUNCE_MS = 600;

export type ItemFormValues = {
  id?: string;
  name: string;
  menuPriceCents: number | null;
  foodCostCents: number | null;
  packagingCents: number | null;
  batchYield: string;
  prepMinutes: string;
  isBatchable: boolean;
  containsAlcohol: boolean;
  category: string;
};

const EMPTY_VALUES: ItemFormValues = {
  name: '',
  menuPriceCents: null,
  foodCostCents: null,
  packagingCents: null,
  batchYield: '',
  prepMinutes: '',
  isBatchable: true,
  containsAlcohol: false,
  category: '',
};

/** The same predicate the server runs, with the merchant-facing message. */
const ISSUE_MESSAGES: Record<ValidationIssue['code'], string> = {
  REQUIRED: "We need this. Without it we can't tell you whether a deal makes money.",
  NOT_A_NUMBER: 'Enter a number.',
  NEGATIVE: "This can't be negative.",
  TOO_LARGE: 'That number is too large.',
  COST_EXCEEDS_PRICE:
    "Ingredients and container cost more than the dish sells for. A discount can't fix that.",
  OUT_OF_RANGE: 'That number is outside the range we can use.',
};

type FieldName =
  | 'name'
  | 'menuPriceCents'
  | 'foodCostCents'
  | 'packagingCents'
  | 'batchYield'
  | 'prepMinutes';

export function ItemForm({
  initialValues,
  initialEvaluation,
  ineligible,
}: {
  initialValues?: ItemFormValues;
  initialEvaluation?: GuardrailEvaluation | null;
  ineligible?: IneligibilityReason | null;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ItemFormValues>(initialValues ?? EMPTY_VALUES);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [evaluation, setEvaluation] = useState<GuardrailEvaluation | null>(
    initialEvaluation ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** S1-025: `true → false` waits for the confirmation dialog. */
  const [pendingAlcoholOff, setPendingAlcoholOff] = useState(false);

  const itemId = values.id;

  // ---- client-side validation, via the shared predicate --------------------
  const issues = useMemo(
    () =>
      validateItemCosts({
        menuPriceCents: values.menuPriceCents ?? Number.NaN,
        foodCostCents: values.foodCostCents,
        packagingCents: values.packagingCents ?? Number.NaN,
        batchYield: Number(values.batchYield),
        prepMinutes: values.prepMinutes === '' ? null : Number(values.prepMinutes),
      }),
    [values],
  );

  const fieldError = useCallback(
    (field: FieldName): string | null => {
      const serverMessage = serverErrors[field];
      if (serverMessage) {
        return serverMessage;
      }
      if (!touched[field]) {
        return null;
      }
      const issue = issues.find((candidate) => candidate.field === field);
      return issue ? ISSUE_MESSAGES[issue.code] : null;
    },
    [issues, serverErrors, touched],
  );

  function update<K extends keyof ItemFormValues>(key: K, value: ItemFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function markTouched(field: FieldName) {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  // ---- debounced re-evaluation on a cost change ----------------------------
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!itemId || issues.length > 0) {
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      void fetch(`/api/merchant/items/${itemId}/guardrail`, { method: 'POST' })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: GuardrailEvaluation | null) => {
          if (payload) {
            setEvaluation(payload);
          }
        })
        .catch(() => {
          // A failed re-evaluation must never block the form; the last good
          // evaluation stays on screen.
        });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [itemId, issues.length, values.menuPriceCents, values.foodCostCents, values.packagingCents]);

  // ---- submit --------------------------------------------------------------
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setServerErrors({});
    setTouched({
      name: true,
      menuPriceCents: true,
      foodCostCents: true,
      packagingCents: true,
      batchYield: true,
      prepMinutes: true,
    });

    if (values.name.trim().length === 0) {
      setServerErrors({ name: 'Give the dish a name.' });
      return;
    }
    if (issues.length > 0) {
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: values.name.trim(),
        menuPriceCents: values.menuPriceCents,
        foodCostCents: values.foodCostCents,
        packagingCents: values.packagingCents,
        batchYield: Number(values.batchYield),
        prepMinutes: values.prepMinutes === '' ? null : Number(values.prepMinutes),
        isBatchable: values.isBatchable,
        containsAlcohol: values.containsAlcohol,
        category: values.category.trim() === '' ? null : values.category.trim(),
      };

      const response = await fetch(
        itemId ? `/api/merchant/items/${itemId}` : '/api/merchant/items',
        {
          method: itemId ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        fieldErrors?: Record<string, string>;
        item?: { id: string };
        evaluation?: GuardrailEvaluation;
      };

      if (response.status === 422) {
        setServerErrors(payload.fieldErrors ?? {});
        setFormError(payload.message ?? 'Check the values you entered.');
        return;
      }
      if (!response.ok) {
        setFormError(payload.message ?? 'That could not be saved. Try again.');
        return;
      }

      if (payload.evaluation) {
        setEvaluation(payload.evaluation);
      }

      if (!itemId && payload.item) {
        router.push(`/merchant/items/${payload.item.id}`);
        router.refresh();
        return;
      }
      router.refresh();
    } catch {
      setFormError('That could not be saved. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <Field id="name" label="Dish name" error={fieldError('name')}>
          <input
            id="name"
            name="name"
            type="text"
            required
            maxLength={80}
            value={values.name}
            onChange={(event) => update('name', event.target.value)}
            onBlur={() => markTouched('name')}
            className={inputClass}
          />
        </Field>

        <Field
          id="menuPriceCents"
          label="What you normally charge"
          helper='The price on your menu today. This is the "was" price customers will compare against, so it has to be your real price.'
          error={fieldError('menuPriceCents')}
        >
          <MoneyInput
            id="menuPriceCents"
            valueCents={values.menuPriceCents}
            onChangeCents={(cents) => update('menuPriceCents', cents)}
            onBlur={() => markTouched('menuPriceCents')}
            invalid={fieldError('menuPriceCents') !== null}
          />
        </Field>

        <Field
          id="foodCostCents"
          label="Ingredient cost per plate"
          helper="Just the food. Not labour, not rent, not the gas bill. A rough number is fine — you can fix it later."
          error={fieldError('foodCostCents')}
        >
          <MoneyInput
            id="foodCostCents"
            valueCents={values.foodCostCents}
            onChangeCents={(cents) => update('foodCostCents', cents)}
            onBlur={() => markTouched('foodCostCents')}
            invalid={fieldError('foodCostCents') !== null}
          />
        </Field>

        <Field
          id="packagingCents"
          label="Container cost per order"
          helper="Box, lid, bag, cutlery. Put 0 if it leaves the counter on a tray."
          error={fieldError('packagingCents')}
        >
          <MoneyInput
            id="packagingCents"
            valueCents={values.packagingCents}
            onChangeCents={(cents) => update('packagingCents', cents)}
            onBlur={() => markTouched('packagingCents')}
            invalid={fieldError('packagingCents') !== null}
          />
        </Field>

        <Field
          id="batchYield"
          label="How many can you make in one batch"
          helper="Without slowing down normal service. This caps the batch size, so be honest — 20 is a good batch, 60 is a different kitchen."
          error={fieldError('batchYield')}
        >
          <input
            id="batchYield"
            name="batchYield"
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={values.batchYield}
            onChange={(event) => update('batchYield', event.target.value)}
            onBlur={() => markTouched('batchYield')}
            className={inputClass}
          />
        </Field>

        <Field
          id="prepMinutes"
          label="Minutes to make one plate (optional)"
          helper="Helps us sanity-check the batch size."
          error={fieldError('prepMinutes')}
        >
          <input
            id="prepMinutes"
            name="prepMinutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={240}
            value={values.prepMinutes}
            onChange={(event) => update('prepMinutes', event.target.value)}
            onBlur={() => markTouched('prepMinutes')}
            className={inputClass}
          />
        </Field>

        <div className="space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="isBatchable"
              checked={values.isBatchable}
              onChange={(event) => update('isBatchable', event.target.checked)}
              className="mt-0.5 h-5 w-5"
            />
            <span>
              <span className="font-medium text-ink">Can this dish be batched?</span>
              <span className="block text-xs text-ink-soft">
                Turn this off for anything you can&apos;t make 20 of at once — steaks, fried-to-order,
                anything plated by hand.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="containsAlcohol"
              checked={values.containsAlcohol}
              onChange={(event) => {
                const next = event.target.checked;
                // S1-025 / PRD-sprint1 §5.5a: clearing the flag needs a
                // confirmation, because clearing it is what makes the dish
                // deal-eligible again. Setting it needs none — that direction only
                // makes the dish safer to exclude, and friction there would
                // discourage correct labelling.
                if (!next && values.containsAlcohol) {
                  setPendingAlcoholOff(true);
                  return;
                }
                update('containsAlcohol', next);
              }}
              className="mt-0.5 h-5 w-5"
            />
            <span>
              <span className="font-medium text-ink">Does this dish contain alcohol?</span>
              <span className="block text-xs text-ink-soft">
                Alcohol can&apos;t be sold through a drop under Alberta&apos;s AGLC rules. You can
                still record the dish; it just can&apos;t be part of a deal.
              </span>
            </span>
          </label>
        </div>

        {formError ? (
          <p role="alert" className="text-sm text-blocked">
            {formError}
          </p>
        ) : null}

        <Button type="submit" disabled={saving} className="w-full">
          {saving ? 'Saving…' : 'Save dish'}
        </Button>
      </form>

      <EvaluationPreview evaluation={evaluation} ineligible={ineligible ?? null} />

      <AlcoholFlagDialog
        open={pendingAlcoholOff}
        onCancel={() => setPendingAlcoholOff(false)}
        onConfirm={() => {
          update('containsAlcohol', false);
          setPendingAlcoholOff(false);
        }}
      />
    </div>
  );
}

/**
 * A plain rendering of the evaluation, driven entirely by `panelCopy()`.
 *
 * T05 replaces this block with the styled `<GuardrailPanel>` (which also owns the
 * breakdown table and the price explorer). Keeping it here in the meantime means
 * the copy pipeline is exercised end-to-end by the form, and no frozen string is
 * typed inline in a `.tsx` (§7.8).
 */
function EvaluationPreview({
  evaluation,
  ineligible,
}: {
  evaluation: GuardrailEvaluation | null;
  ineligible: IneligibilityReason | null;
}) {
  if (ineligible) {
    const copy = ineligibleCopy(ineligible);
    return (
      <section className="rounded-xl border border-blocked/30 bg-surface p-4">
        <h2 className="text-sm font-semibold text-blocked">{copy.headline}</h2>
        {copy.body.map((line) => (
          <p key={line} className="mt-1 text-sm text-ink-soft">
            {line}
          </p>
        ))}
      </section>
    );
  }

  if (!evaluation) {
    return (
      <p className="text-sm text-ink-soft">
        Save the dish once and we&apos;ll tell you the lowest price that still works.
      </p>
    );
  }

  const copy = panelCopy(evaluation.state, evaluation.view, {
    foodCostCents: evaluation.input?.foodCostCents ?? null,
  });

  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">{copy.headline}</h2>
      {copy.body.map((line) => (
        <p key={line} className="mt-1 text-sm leading-relaxed text-ink-soft">
          {line}
        </p>
      ))}
      {evaluation.warnings.length > 0 ? (
        <p className="mt-3 text-xs text-thin">
          {evaluation.warnings
            .map((warning) =>
              warning === 'FOOD_COST_IMPLAUSIBLY_LOW'
                ? 'That ingredient cost looks low for this price. Double-check it.'
                : warning === 'FOOD_COST_IMPLAUSIBLY_HIGH'
                  ? 'That ingredient cost is most of the price. A deal may not be possible.'
                  : warning,
            )
            .join(' ')}
        </p>
      ) : null}
      {evaluation.view?.minViablePriceCents !== null &&
      evaluation.view?.minViablePriceCents !== undefined ? (
        <p className="mt-2 text-xs text-ink-soft">
          Lowest price that still works: {formatCents(evaluation.view.minViablePriceCents)}
        </p>
      ) : null}
    </section>
  );
}
