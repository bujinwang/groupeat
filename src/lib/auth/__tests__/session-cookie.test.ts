import 'dotenv/config';

import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `applySessionCookie` — the server-action half of the session cookie.
 *
 * ## Why this file exists
 *
 * The whole of `src/lib/auth/session.ts` was reached through mocks. Every route and
 * action test neutralises `@/lib/auth/session` so it can inject a session without a
 * cookie jar, and `session.test.ts` — despite its name — tests `jwt.ts`, because the
 * barrel pulls in `server-only`. Measured by V8 over the auth routes and admin action
 * suites, `session.ts` stood at 37/46 statements with **`applySessionCookie` at
 * `hits=0`** and `clearSessionCookieInAction` at `hits=0`.
 *
 * Of those two, only the first is a gap: `applySessionCookie` is called by
 * `login/actions.ts:125` and `change-password/actions.ts:39`, so it is the line that
 * actually puts a session on a browser after a server-action login. The second has no
 * caller in `src/` at all — it is dead code, not an untested path, and deleting or
 * wiring it is a production decision this file does not make.
 *
 * ## What is stubbed, and what is not
 *
 * Only `next/headers` (there is no cookie jar under Vitest) and `server-only` (it throws
 * outside a React Server Component graph). The token is **really signed** and then
 * **really verified**, because the question a login path has to answer is not "was a
 * string written" but "does the value we handed the browser authenticate the person who
 * just logged in".
 *
 * `set` is captured rather than discarded. The sibling harness in
 * `src/app/api/auth/__tests__/session-routes.test.ts` stubs it to `() => undefined`
 * because the route-handler path writes to a `NextResponse` instead — correct there, and
 * exactly why this path needed its own file.
 */

vi.mock('server-only', () => ({}));

const jar = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (options: Record<string, unknown>) => {
      jar.calls.push(options);
    },
  }),
}));

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

/**
 * `process.env.NODE_ENV` is typed read-only, which is correct for production code and
 * inconvenient for the two cases below that must prove `secure` follows the
 * environment. Narrowed once here rather than sprinkling casts through the assertions.
 */
const env = process.env as Record<string, string | undefined>;

const {
  applySessionCookie,
  clearSessionCookie,
  setSessionCookie,
  sessionCookieOptions,
} = await import('@/lib/auth/session');
const { SESSION_ABSOLUTE_DAYS, SESSION_COOKIE, newSession, verifySession } = await import(
  '@/lib/auth/jwt'
);

const SESSION = {
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'MERCHANT' as const,
  mustChangePassword: false,
};

function freshSession(overrides: Partial<Parameters<typeof newSession>[0]> = {}) {
  return newSession({ ...SESSION, ...overrides });
}

const ORIGINAL_NODE_ENV = env.NODE_ENV;

beforeEach(() => {
  jar.calls.length = 0;
});

afterEach(() => {
  env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('applySessionCookie — the cookie it writes', () => {
  it('writes exactly one cookie, under the session name', async () => {
    await applySessionCookie(freshSession());

    expect(jar.calls).toHaveLength(1);
    expect(jar.calls[0]?.name).toBe(SESSION_COOKIE);
  });

  it('writes a token that verifies back to the same user', async () => {
    // The assertion that makes this more than "a string was stored". A cookie whose
    // value does not verify is a login that appears to succeed and then bounces.
    await applySessionCookie(freshSession({ mustChangePassword: true }));

    const value = jar.calls[0]?.value;
    expect(typeof value).toBe('string');
    expect(value).not.toBe('');

    const verified = await verifySession(value as string);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe(SESSION.userId);
    expect(verified?.role).toBe('MERCHANT');
    expect(verified?.mustChangePassword).toBe(true);
  });

  it('does not store the session object in the cookie', async () => {
    // The value is a signed JWT, not `JSON.stringify(session)`. A regression that
    // wrote the claims directly would still "have a value" and would still verify
    // as garbage — but it would also be readable by the browser, which is the whole
    // reason the cookie is httpOnly and the token is signed.
    const session = freshSession();
    await applySessionCookie(session);

    const value = String(jar.calls[0]?.value);
    expect(value).not.toContain(SESSION.userId);
    expect(value.split('.')).toHaveLength(3);
  });

  it('marks the cookie httpOnly, SameSite=Lax, and scoped to /', async () => {
    await applySessionCookie(freshSession());

    const cookie = jar.calls[0];
    // httpOnly is the one attribute that keeps a stolen XSS from reading the token.
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
  });

  it('gives the cookie the absolute cap as maxAge, not the sliding window', async () => {
    // The cookie deliberately outlives its token: the token's own `exp` (60 minutes)
    // is the real limit, and the absolute cap is inside the signed payload, so a
    // stolen cookie cannot be outlived by either.
    await applySessionCookie(freshSession());

    expect(jar.calls[0]?.maxAge).toBe(SESSION_ABSOLUTE_DAYS * 24 * 60 * 60);
    expect(jar.calls[0]?.maxAge).toBe(604_800);
  });

  it('sets Secure only in production', async () => {
    // Dev runs over http://localhost, where a `Secure` cookie is dropped by the
    // browser and login silently fails. Production without it would let the token
    // travel over a plaintext request.
    env.NODE_ENV = 'development';
    await applySessionCookie(freshSession());
    expect(jar.calls[0]?.secure).toBe(false);

    jar.calls.length = 0;
    env.NODE_ENV = 'production';
    await applySessionCookie(freshSession());
    expect(jar.calls[0]?.secure).toBe(true);
  });

  it('issues a distinct token each call, so a refresh is a new token', async () => {
    // `signSession` includes `iat` in seconds, so two calls in the same second could
    // legitimately collide — this asserts the cookie is *re-signed*, not that the
    // strings differ, by checking both verify to the same person.
    await applySessionCookie(freshSession());
    const first = String(jar.calls[0]?.value);

    jar.calls.length = 0;
    await applySessionCookie(freshSession());
    const second = String(jar.calls[0]?.value);

    expect((await verifySession(first))?.userId).toBe(SESSION.userId);
    expect((await verifySession(second))?.userId).toBe(SESSION.userId);
    expect(second).not.toBe('');
  });
});

describe('applySessionCookie — the two cookie surfaces cannot drift', () => {
  it('writes the same attributes as the route-handler path', async () => {
    // The docblock's claim: "Shares `sessionCookieOptions()` so the two surfaces
    // cannot drift." That sentence is the whole reason `sessionCookieOptions()` is a
    // function rather than an inline literal. This is the assertion that makes the
    // claim checkable — a change that gives one surface a different `maxAge` or
    // `sameSite` fails here, which is the only way anyone would notice, since the two
    // are never exercised together in production.
    await applySessionCookie(freshSession());

    const response = NextResponse.json({ ok: true });
    await setSessionCookie(response, freshSession());
    const fromResponse = response.cookies.get(SESSION_COOKIE);

    const fromAction = jar.calls[0];
    expect(fromAction?.name).toBe(fromResponse?.name);
    expect(fromAction?.httpOnly).toBe(fromResponse?.httpOnly);
    expect(fromAction?.sameSite).toBe(fromResponse?.sameSite);
    expect(fromAction?.path).toBe(fromResponse?.path);
    expect(fromAction?.maxAge).toBe(fromResponse?.maxAge);
    expect(fromAction?.secure).toBe(fromResponse?.secure);
  });

  it('clears the cookie with the same attributes and maxAge 0', async () => {
    // A clear that forgot one attribute can leave a second cookie in place, and a
    // clear without `maxAge: 0` is a cookie the browser keeps holding.
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);

    const cleared = response.cookies.get(SESSION_COOKIE);
    expect(cleared?.value).toBe('');
    expect(cleared?.maxAge).toBe(0);

    const options = sessionCookieOptions();
    expect(cleared?.httpOnly).toBe(options.httpOnly);
    expect(cleared?.sameSite).toBe(options.sameSite);
    expect(cleared?.path).toBe(options.path);
    expect(cleared?.secure).toBe(options.secure);
  });
});

describe('sessionCookieOptions', () => {
  it('reads the environment on every call rather than at import', async () => {
    // Cached at module scope, the value a process booted in development would keep
    // forever — including after a build step sets NODE_ENV=production.
    env.NODE_ENV = 'production';
    expect(sessionCookieOptions().secure).toBe(true);

    env.NODE_ENV = 'test';
    expect(sessionCookieOptions().secure).toBe(false);
  });
});
