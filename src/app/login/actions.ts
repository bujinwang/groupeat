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

/**
 * Only same-origin, absolute paths. `//evil.com` is not a path.
 *
 * ## `startsWith('//')` alone is an open redirect, and that is how this was found
 *
 * The first version of this function rejected `//` and forwarded everything else that began
 * with a slash. A diner-facing login link like
 *
 *     /login?next=/\evil.example
 *
 * passes that check — one slash, so it is "a path" — and a browser does **not** read the
 * second character as part of a path: the URL spec normalises `\` to `/`, so the value
 * resolves to `https://evil.example/`. Probed in Node's WHATWG parser, which is the same
 * algorithm the browser uses:
 *
 *     new URL('/\\evil.example', 'https://groupeat.example').origin  // 'https://evil.example'
 *
 * So the guard let an attacker send a merchant to a convincing copy of this login screen with
 * the real domain in the query string that got them there. This had no test anywhere in the
 * repo until `__tests__/page.test.ts` was written, which is the more important half of the
 * finding: the guard existed, looked right, and had never been executed against a hostile
 * input.
 *
 * ## Why the authority is a URL parse rather than more string tests
 *
 * Patching the string checks would be a list of the tricks I happened to think of. The URL
 * parser is the thing the browser will actually use, so asking it what this value resolves to
 * settles every variant at once — backslashes, `/\/`, a tab or newline before the path, an
 * encoded scheme. A value is forwarded only if it resolves to the same origin as a dummy base,
 * which is exactly the property `redirect()` needs.
 *
 * `LOCAL_BASE` is `.invalid`, reserved by RFC 2606 precisely so it can never resolve.
 *
 * ## Two guards, and one of them is unreachable
 *
 * A probe sweep deleted `next.startsWith('//')` and **nothing failed**: `new URL('//evil.example',
 * LOCAL_BASE)` resolves to origin `https://evil.example`, so the origin check below refuses it
 * regardless. The string test is therefore belt-and-braces, kept for two reasons — it is the
 * cheap rejection for the commonest attack shape, and it documents the intent at the point a
 * reader looks first. Recorded here because "no test kills it" is otherwise indistinguishable
 * from "nobody tested it".
 *
 * The reverse ordering would be a bug, not a redundancy: if the URL parse were the *only* check
 * and the string tests came after a `return next`, everything would pass. Order matters, and
 * this comment is the record of which order is safe.
 */
const LOCAL_BASE = 'https://local.invalid';

function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(next, LOCAL_BASE);
  } catch {
    // Not a URL the parser will accept at all. Nothing to forward to.
    return null;
  }

  // The authoritative check: what the browser would do with this. Anything that escapes the
  // base origin — via `\`, `//`, an embedded scheme, or a character the parser treats
  // specially — is refused here rather than by a list of remembered tricks.
  if (resolved.origin !== new URL(LOCAL_BASE).origin) {
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
