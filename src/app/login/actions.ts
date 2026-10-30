'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { authenticate } from '@/lib/auth/credentials';
import { applySessionCookie } from '@/lib/auth/session';

/**
 * The login server action.
 *
 * This is the *UI* entry point; `POST /api/auth/login` is the HTTP one. Both call
 * `lib/auth/credentials.ts`, so the sequence (rate limit → verify → sign → cookie)
 * exists once. Two copies is how one of them quietly loses the rate limit.
 */

export type LoginFormState = { error: string | null };

/**
 * The rate-limit key.
 *
 * ⚠️ `x-forwarded-for` is only trustworthy when a proxy sets it *and* strips a
 * client-supplied value. With no proxy in front it is attacker-controlled, which
 * is one more reason `rate-limit.ts` is explicitly not a security control.
 */
async function clientKey(): Promise<string> {
  const requestHeaders = await headers();
  const forwarded = requestHeaders.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return requestHeaders.get('x-real-ip') ?? 'local';
}

/** Only same-origin, absolute paths. `//evil.com` is not a path. */
function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return null;
  }
  return next;
}

export async function loginAction(
  _previous: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  if (email.trim().length === 0 || password.length === 0) {
    return { error: 'Email or password is incorrect.' };
  }

  const result = await authenticate(email, password, await clientKey());
  if (!result.ok) {
    return { error: result.message };
  }

  await applySessionCookie(result.session);

  // `redirect()` throws; it must not be inside a try/catch.
  const requested = safeNext(String(formData.get('next') ?? ''));
  redirect(requested ?? result.redirectTo);
}
