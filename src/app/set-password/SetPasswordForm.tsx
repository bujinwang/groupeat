'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { setPasswordAction, type SetPasswordState } from './actions';

/**
 * FR-101's accept form.
 *
 * The token is a hidden field as well as the URL, because a server action posts to the
 * page and does not parse the query string. It is not a secret from the person holding
 * the link — it is the credential they were sent — and the page is `no-referrer` so it
 * cannot leak through an outbound request.
 *
 * On success the form is replaced by a sign-in link rather than a redirect. The action
 * has just consumed the token, and a redirect would leave the user on a page that now
 * 404s if they press Back. The link is a deliberate next step, not a dead end.
 */
export function SetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(setPasswordAction, {
    error: null,
    fieldErrors: {},
    done: false,
  } satisfies SetPasswordState);

  if (state.done) {
    return (
      <div className="space-y-3">
        <p role="status" className="text-sm leading-relaxed text-ok">
          Your password is set. Sign in to continue.
        </p>
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-white"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <Field
        id="password"
        label="New password"
        helper="At least 12 characters, with a letter and a number."
        error={state.fieldErrors.password}
      >
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className={inputClass}
        />
      </Field>

      <Field
        id="confirmPassword"
        label="Confirm password"
        error={state.fieldErrors.confirmPassword}
      >
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
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

      <Button type="submit" disabled={pending}>
        {pending ? 'Setting…' : 'Set password'}
      </Button>
    </form>
  );
}
