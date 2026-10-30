'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';
import { formatCents, roundHalfUp } from '@/lib/guardrail';

import { updateMerchantAction, type AdminFormState } from '@/app/(admin)/admin/actions';

/**
 * US-A1 / US-A2 — the merchant's pickup details and minimum margin.
 *
 * The field is a **percent** (`25`), because that is what a human types; the
 * action divides by 100 once, at the boundary, before it reaches the database.
 *
 * The dollar example under the field is the point of this screen (PRD-sprint1
 * §5.1): a percentage on its own has no meaning, so it is always shown with a
 * figure attached at a real menu price.
 */

const INITIAL: AdminFormState = { error: null, fieldErrors: {}, notice: null };

export function FloorEditor({
  merchantId,
  floorPctOfMenu,
  pickupAddress,
  pickupInstructions,
  exampleMenuPriceCents,
}: {
  merchantId: string;
  /** Fraction, e.g. `0.25`. */
  floorPctOfMenu: number;
  pickupAddress: string | null;
  pickupInstructions: string | null;
  exampleMenuPriceCents: number;
}) {
  const [state, formAction, pending] = useActionState(updateMerchantAction, INITIAL);

  const floorCents = roundHalfUp(exampleMenuPriceCents * floorPctOfMenu);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="merchantId" value={merchantId} />

      <Field
        id="floorPctOfMenu"
        label="Minimum margin (%)"
        helper={`At ${roundHalfUp(floorPctOfMenu * 100)}%, a ${formatCents(exampleMenuPriceCents)} dish must leave the merchant at least ${formatCents(floorCents)} per plate.`}
        error={state.fieldErrors.floorPctOfMenu}
      >
        <input
          id="floorPctOfMenu"
          name="floorPctOfMenu"
          type="number"
          step="1"
          min="1"
          max="100"
          defaultValue={roundHalfUp(floorPctOfMenu * 100)}
          className={inputClass}
        />
      </Field>

      <Field id="pickupAddress" label="Pickup address" error={state.fieldErrors.pickupAddress}>
        <input
          id="pickupAddress"
          name="pickupAddress"
          type="text"
          defaultValue={pickupAddress ?? ''}
          className={inputClass}
        />
      </Field>

      <Field id="pickupInstructions" label="Pickup instructions">
        <input
          id="pickupInstructions"
          name="pickupInstructions"
          type="text"
          defaultValue={pickupInstructions ?? ''}
          className={inputClass}
        />
      </Field>

      {state.error ? (
        <p role="alert" className="text-sm text-blocked">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="text-sm text-ok">
          {state.notice}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save merchant'}
      </Button>
    </form>
  );
}
