'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { changePasswordAction, type ChangePasswordFormState } from './actions';

/**
 * The one screen a temporary-password user can reach (S1-019). The wording works
 * for both the forced case and a voluntary change, so the page needs no state
 * from the server.
 */

const INITIAL_STATE: ChangePasswordFormState = { error: null, field: null };

export default function ChangePasswordPage() {
  const [state, formAction, pending] = useActionState(changePasswordAction, INITIAL_STATE);

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-6">
      <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">
        If an administrator set your account up with a temporary password, you need to replace it
        before you can use the rest of GroupEat.
      </p>

      <form action={formAction} className="mt-6 space-y-4" noValidate>
        <Field
          id="currentPassword"
          label="Current password"
          error={state.field === 'currentPassword' ? state.error : null}
        >
          <input
            id="currentPassword"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            className={inputClass}
          />
        </Field>

        <Field
          id="newPassword"
          label="New password"
          helper="At least 12 characters, with at least one letter and one number."
          error={state.field === 'newPassword' ? state.error : null}
        >
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            className={inputClass}
          />
        </Field>

        {state.error && state.field === null ? (
          <p role="alert" className="text-sm text-blocked">
            ⚠ {state.error}
          </p>
        ) : null}

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </div>
  );
}
