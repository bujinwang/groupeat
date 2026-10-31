'use client';

import { Suspense, useActionState } from 'react';
import { useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { loginAction, type LoginFormState } from './actions';

/**
 * PRD-sprint1 §6.1.
 *
 * One error message for both a wrong email and a wrong password — the server
 * never says which, and neither does this screen. Submit is disabled while the
 * action is in flight and reads "Signing in…".
 *
 * The page is a client component so the form can use `useActionState`; the
 * "already signed in" redirect is middleware's job, not this page's.
 */

const INITIAL_STATE: LoginFormState = { error: null };

function LoginForm() {
  const searchParams = useSearchParams();
  const [state, formAction, pending] = useActionState(loginAction, INITIAL_STATE);

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-6">
      <h1 className="text-xl font-semibold tracking-tight">GroupEat</h1>
      <p className="mt-1 text-sm text-ink-soft">Sign in to your account.</p>

      <form action={formAction} className="mt-6 space-y-4" noValidate>
        <input type="hidden" name="next" value={searchParams.get('next') ?? ''} />

        <Field id="email" label="Email">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            className={inputClass}
            aria-describedby={state.error ? 'login-error' : undefined}
          />
        </Field>

        <Field id="password" label="Password">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={inputClass}
            aria-describedby={state.error ? 'login-error' : undefined}
          />
        </Field>

        {state.error ? (
          <p id="login-error" role="alert" className="text-sm text-blocked">
            ⚠ {state.error}
          </p>
        ) : null}

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="rounded-xl border border-slate-200 bg-surface p-6">Loading…</div>}>
      <LoginForm />
    </Suspense>
  );
}
