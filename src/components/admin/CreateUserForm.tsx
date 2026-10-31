'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { createUserAction, type AdminFormState } from '@/app/(admin)/admin/actions';

/**
 * US-A1 — create an account. Every account is bootstrapped with a temporary
 * password and `mustChangePassword = true` (there is no email delivery until M2).
 */

const INITIAL: AdminFormState = { error: null, fieldErrors: {}, notice: null };

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(createUserAction, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Field id="new-user-email" label="Email" error={state.fieldErrors.email}>
        <input id="new-user-email" name="email" type="email" required className={inputClass} />
      </Field>

      <Field id="new-user-name" label="Name (optional)">
        <input id="new-user-name" name="name" type="text" className={inputClass} />
      </Field>

      <Field id="new-user-role" label="Role" error={state.fieldErrors.role}>
        <select id="new-user-role" name="role" className={inputClass} defaultValue="MERCHANT">
          <option value="MERCHANT">Merchant</option>
          <option value="ORGANISER">Organiser</option>
          <option value="ADMIN">Admin</option>
        </select>
      </Field>

      <Field
        id="new-user-password"
        label="Temporary password"
        helper="At least 12 characters, with a letter and a number. They must change it on first sign-in."
        error={state.fieldErrors.password}
      >
        <input
          id="new-user-password"
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
        {pending ? 'Creating…' : 'Create user'}
      </Button>
    </form>
  );
}
