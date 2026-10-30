import 'server-only';

import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';

import { SESSION_ABSOLUTE_DAYS, SESSION_COOKIE, signSession, verifySession } from './jwt';
import type { SessionClaims } from './jwt';

/**
 * Cookie plumbing. One place decides the cookie's attributes (S1-005):
 * `httpOnly`, `SameSite=Lax`, `Secure` in production, 60-minute sliding window,
 * 7-day absolute cap.
 *
 * `newSession()` and `roleHome()` are pure and live in `jwt.ts`, so the Edge
 * middleware and the tests can reach them without this module's `server-only`.
 */
export { newSession, roleHome } from './jwt';

export type Session = SessionClaims;

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
};

export function sessionCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // The cookie outlives the token on purpose: the token's own `exp` is the real
    // limit, and the absolute cap is inside the payload, so neither can be
    // outlived by a stolen cookie.
    maxAge: SESSION_ABSOLUTE_DAYS * 24 * 60 * 60,
  };
}

/**
 * Route-handler path: sets the cookie on an outgoing `NextResponse`
 * (ARCHITECTURE-sprint1 §3.4 `setSessionCookie(response, session)`).
 */
export async function setSessionCookie(
  response: NextResponse,
  session: Session,
): Promise<void> {
  const token = await signSession(session);
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    ...sessionCookieOptions(),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    ...sessionCookieOptions(),
    maxAge: 0,
  });
}

/**
 * Server-action path: the same cookie, applied through the writable cookie store
 * rather than a response object. Shares `sessionCookieOptions()` so the two
 * surfaces cannot drift.
 */
export async function applySessionCookie(session: Session): Promise<void> {
  const token = await signSession(session);
  const store = await cookies();
  store.set({ name: SESSION_COOKIE, value: token, ...sessionCookieOptions() });
}

export async function clearSessionCookieInAction(): Promise<void> {
  const store = await cookies();
  store.set({ name: SESSION_COOKIE, value: '', ...sessionCookieOptions(), maxAge: 0 });
}

/**
 * Reads and verifies the session cookie. Returns `null` when absent, expired,
 * tampered or past the absolute cap — callers treat all of those identically.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }
  return verifySession(token);
}
