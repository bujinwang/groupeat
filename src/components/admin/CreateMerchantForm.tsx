'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { createMerchantAction, type AdminFormState } from '@/app/(admin)/admin/actions';

/**
 * US-A1 — create a merchant and its owner in one transaction.
 *
 * The merchant starts `PENDING` on the default 25% minimum margin; the owner gets
 * a temporary password. The form does not ask for the floor: PRD-sprint1 Q-4 is
 * explicit that the floor is not put in front of a merchant (or an admin
 * mid-onboarding) before they have seen one honest result.
 */

const INITIAL: AdminFormState = { error: null, fieldErrors: {}, notice: null };

export function CreateMerchantForm() {
  const [state, formAction, pending] = useActionState(createMerchantAction, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Field id="merchant-name" label="Trading name" error={state.fieldErrors.name}>
        <input id="merchant-name" name="name" type="text" required className={inputClass} />
      </Field>

      <Field id="merchant-address" label="Pickup address" error={state.fieldErrors.pickupAddress}>
        <input id="merchant-address" name="pickupAddress" type="text" className={inputClass} />
      </Field>

      <Field id="merchant-instructions" label="Pickup instructions">
        <input
          id="merchant-instructions"
          name="pickupInstructions"
          type="text"
          className={inputClass}
        />
      </Field>

      <Field id="owner-email" label="Owner email" error={state.fieldErrors.ownerEmail}>
        <input id="owner-email" name="ownerEmail" type="email" required className={inputClass} />
      </Field>

      <Field id="owner-name" label="Owner name (optional)">
        <input id="owner-name" name="ownerName" type="text" className={inputClass} />
      </Field>

      <Field
        id="owner-password"
        label="Owner's temporary password"
        helper="They must change it on first sign-in."
        error={state.fieldErrors.password}
      >
        <input
          id="owner-password"
          name="password"
          type="text"
          required
          minLength={12}
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
        {pending ? 'Creating…' : 'Create merchant'}
      </Button>
    </form>
  );
}
