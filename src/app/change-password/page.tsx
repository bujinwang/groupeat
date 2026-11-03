'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { changePasswordAction, type ChangePasswordFormState } from './actions';

/**
 * The one screen a temporary-password user can reach (S1-019). The wording works
 * for both the forced case and a voluntary change, so the page needs no state
 * from the server.
 *
 * ## `state.error && state.field === null` — a branch nothing can reach, kept anyway
 *
 * `changePasswordAction` returns `field: result.field ?? null`, and every failing result from
 * `lib/auth/credentials.changePassword` either names a field (`'currentPassword'` for a wrong
 * current password, `'newPassword'` for policy and reuse) or returns `status: 401` with *no*
 * field, for "Please sign in again." So the standalone alert renders for exactly one message.
 *
 * A probe made this condition unconditional — `{state.error ? …}` — and **no test failed**,
 * because the only no-field message is unreachable through the page: a vanished user means
 * `getSession()` returned a session for a row that no longer exists, and `change-password` the
 * route would have redirected at the middleware gate. That is what makes it an equivalent
 * mutant rather than a coverage gap, and it is worth keeping the narrower condition: if a future
 * `changePassword` failure ever names a field, the sentence stays under its input instead of
 * appearing twice.
 *
 * Recorded because a survivor looks identical to an untested line, and the next reader should
 * not spend the sweep again.
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
