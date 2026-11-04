import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /api/auth/me` and `POST /api/auth/change-password` (S1-019).
 *
 * ## Why the session is injected through the cookie rather than mocked
 *
 * Same reasoning as `impersonation/end/__tests__/route.test.ts`, and it is worth repeating
 * because it is the difference between a real test and a look-alike. Both routes call
 * `getSession()`, which reads `cookies()` and then `verifySession()`. Mocking `getSession`
 * would mean a **forged or expired token** is never refused, and "is a bad token enough to
 * be treated as signed in?" is the most important question either route has. So the tests
 * sign real tokens with the real secret, and stub only `next/headers` — the seam that
 * exists because there is no cookie jar under Vitest.
 *
 * The consequence is that an expired token, a token signed with another secret, and a
 * token past its absolute cap all reach the real `verifySession`. The tests below use the
 * first two.
 *
 * ## What only exists at this edge
 *
 *   - **`/me` is reachable with `mv: true`.** Middleware's allowlist includes it, because
 *     the change-password screen needs to know *why* it is being held. A route that
 *     refused `mustChangePassword` sessions would break that screen silently.
 *   - **`/change-password` re-signs and returns the cookie.** A 200 without a fresh
 *     `Set-Cookie` leaves the user holding the old `mv: true` token, so middleware sends
 *     them straight back to the form they just completed.
 *   - **Both map the service's `field` to `fieldErrors`.** The page renders the message
 *     under the input named by that key; a route that dropped it would put every error in
 *     the standalone alert.
 */

vi.mock('server-only', () => ({}));

/**
 * The cookie jar. `cookies()` is stubbed, not the session.
 *
 * `get` returns the token for `SESSION_COOKIE` and nothing otherwise; `set` is a no-op
 * because the route-handler path writes to the `NextResponse`, not to the store.
 */
let cookieJar: string | null = null;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'groupeat_session' && cookieJar ? { name, value: cookieJar } : undefined,
    set: () => undefined,
  }),
}));

const logLines = vi.hoisted(() => [] as { event: string; fields?: Record<string, unknown> }[]);

vi.mock('@/lib/logging/logger', () => ({
  logger: {
    info: (event: string, fields?: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    warn: (event: string, fields?: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    error: (event: string, fields?: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
  },
}));

const { prisma } = await import('@/lib/db/prisma');
const { SESSION_COOKIE, newSession, signSession, verifySession } = await import('@/lib/auth/jwt');
const { hashPassword, verifyPassword } = await import('@/lib/auth/password');

const { GET: me } = await import('../me/route');
const { POST: changePasswordRoute } = await import('../change-password/route');

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `authme${Date.now().toString(36).slice(-5)}`;

const GOOD_PASSWORD = 'session-password-42';
const NEW_PASSWORD = 'session-replaced-77';

const userIds: string[] = [];

let merchantId = '';
let mustChangeId = '';

async function makeUser(args: {
  tag: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  password?: string;
  mustChangePassword?: boolean;
}) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${args.tag}@example.test`,
      name: `Session ${args.tag}`,
      passwordHash: await hashPassword(args.password ?? GOOD_PASSWORD),
      role: args.role,
      mustChangePassword: args.mustChangePassword ?? false,
    },
    select: { id: true, email: true },
  });
  userIds.push(user.id);
  return user;
}

/** A real session for a user id, signed with the real secret. */
async function tokenFor(args: {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword?: boolean;
}): Promise<string> {
  return signSession(
    newSession({
      userId: args.userId,
      role: args.role,
      mustChangePassword: args.mustChangePassword ?? false,
    }),
  );
}

function request(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  const merchant = await makeUser({ tag: 'merchant', role: 'MERCHANT' });
  const mustChange = await makeUser({
    tag: 'mustchange',
    role: 'MERCHANT',
    password: 'temporary-pass-99',
    mustChangePassword: true,
  });

  merchantId = merchant.id;
  mustChangeId = mustChange.id;
});

beforeEach(() => {
  cookieJar = null;
  logLines.length = 0;
});

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // The `User` row is the cascading parent; `changePassword` updates, never inserts.
  await step(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));

  if (failures.length > 0) {
    throw new AggregateError(failures, 'auth session route teardown failed');
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

describe('§6.1 · GET /api/auth/me', () => {
  it('returns 401 UNAUTHENTICATED with no cookie', async () => {
    const response = await me();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'UNAUTHENTICATED',
      message: 'Please sign in to continue.',
    });
  });

  it('returns the caller identity, role and absolute expiry from the token', async () => {
    const token = await tokenFor({ userId: merchantId, role: 'MERCHANT' });
    cookieJar = token;

    const response = await me();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.userId).toBe(merchantId);
    expect(body.role).toBe('MERCHANT');
    expect(body.mustChangePassword).toBe(false);

    // `absoluteExpiresAt` is converted from epoch **seconds** to an ISO string. The
    // conversion is the one thing here a type cannot check: a missing `* 1000` would
    // produce a date in 1970 and still be a valid ISO string.
    const claims = await verifySession(token);
    expect(body.absoluteExpiresAt).toBe(
      new Date((claims?.absoluteExpiresAt ?? 0) * 1000).toISOString(),
    );

    // And it is a real future instant, not epoch zero — the assertion the multiplication
    // above cannot make on its own, because both sides would be wrong together.
    expect(new Date(body.absoluteExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('answers with exactly four keys, so no token claim leaks by default', async () => {
    // `SessionClaims` carries `expiresAt` and, for a borrowed session, `impersonation`.
    // The route projects four fields; `toEqual` on the key set is what stops a future
    // `...session` spread from publishing the impersonation claim — which names the admin's
    // user id and the audit row — to any script that can reach this endpoint.
    cookieJar = await tokenFor({ userId: merchantId, role: 'MERCHANT' });

    const body = await (await me()).json();

    expect(Object.keys(body).sort()).toEqual([
      'absoluteExpiresAt',
      'mustChangePassword',
      'role',
      'userId',
    ]);
  });

  it('is reachable with mustChangePassword still set, and says so', async () => {
    // Middleware's `ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED` lists this route for a reason:
    // the change-password screen needs to explain why it is the only screen. Refusing here
    // would make that screen's own question unanswerable.
    const token = await tokenFor({
      userId: mustChangeId,
      role: 'MERCHANT',
      mustChangePassword: true,
    });
    cookieJar = token;

    const response = await me();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userId: mustChangeId,
      mustChangePassword: true,
    });
  });

  it('refuses a token signed with a different secret', async () => {
    // `verifySession` returns `null` for a bad signature, and `getSession` passes that
    // through, so the route's `if (!session)` branch answers 401. A route that trusted the
    // cookie's presence would answer 200 here — which is the whole reason this endpoint is
    // tested through a real cookie rather than a mocked `getSession`.
    const { SignJWT } = await import('jose');
    const bad = await new SignJWT({ role: 'ADMIN', mv: false, absAt: 9_999_999_999 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(merchantId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode('a-different-secret-at-least-32-characters'));

    // A sanity check that the forged token is well formed *and* that it would be accepted
    // under its own secret — so the 401 below is caused by the signature check and not by
    // a malformed token being rejected for some other reason.
    const { jwtVerify } = await import('jose');
    await expect(
      jwtVerify(bad, new TextEncoder().encode('a-different-secret-at-least-32-characters')),
    ).resolves.toBeDefined();

    cookieJar = bad;

    const response = await me();
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('UNAUTHENTICATED');
  });

  it('refuses an expired token', async () => {
    const { SignJWT } = await import('jose');
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ role: 'MERCHANT', mv: false, absAt: now + 86_400 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(merchantId)
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    cookieJar = expired;

    const response = await me();
    expect(response.status).toBe(401);
  });

  it('refuses a token whose absolute cap has passed even though its own expiry has not', async () => {
    // The refresh-forever case, at the route level: `verifySession` checks `absAt`
    // separately from `exp`, and this proves the route goes through it.
    const { SignJWT } = await import('jose');
    const now = Math.floor(Date.now() / 1000);
    const pastCap = await new SignJWT({ role: 'MERCHANT', mv: false, absAt: now - 60 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(merchantId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    cookieJar = pastCap;

    const response = await me();
    expect(response.status).toBe(401);
  });

  it('does not hit the database — the answer comes from the token alone', async () => {
    // Deliberate, and worth recording: `/me` answers from the signed claim, so a deleted
    // user still gets 200 until their token expires. That is the same trade-off logout's
    // docblock names (no session store), and it is why every *data* route re-reads scope
    // from the database rather than trusting the token. Asserted by pointing the session at
    // a user id that does not exist.
    cookieJar = await tokenFor({
      userId: '00000000-0000-4000-8000-000000000000',
      role: 'ADMIN',
    });

    const response = await me();

    expect(response.status).toBe(200);
    expect((await response.json()).userId).toBe('00000000-0000-4000-8000-000000000000');
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/change-password
// ---------------------------------------------------------------------------

describe('S1-019 · POST /api/auth/change-password', () => {
  it('returns 401 with no session', async () => {
    const response = await changePasswordRoute(request({ currentPassword: 'a', newPassword: 'b' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'UNAUTHENTICATED',
      message: 'Please sign in again.',
    });
  });

  it('checks the session before the body, so an anonymous caller learns nothing about the schema', async () => {
    // Ordering. With no session, even a *malformed* body is a 401 rather than a 400 — so an
    // unauthenticated scanner cannot use the error code to discover the body shape.
    const response = await changePasswordRoute(request({}));

    expect(response.status).toBe(401);
  });

  it('returns 400 INVALID_REQUEST for a malformed body', async () => {
    cookieJar = await tokenFor({ userId: merchantId, role: 'MERCHANT' });

    const response = await changePasswordRoute(request({ currentPassword: GOOD_PASSWORD }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'INVALID_REQUEST',
      message: 'Both the current and the new password are required.',
    });
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['an empty current password', { currentPassword: '', newPassword: NEW_PASSWORD }],
    ['an empty new password', { currentPassword: GOOD_PASSWORD, newPassword: '' }],
    ['a numeric field', { currentPassword: 1, newPassword: NEW_PASSWORD }],
    ['a bare string body', 'nope'],
  ])('returns 400 for %s', async (_label, body) => {
    cookieJar = await tokenFor({ userId: merchantId, role: 'MERCHANT' });

    const response = await changePasswordRoute(request(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('INVALID_REQUEST');
  });

  it('returns 422 with fieldErrors naming currentPassword for a wrong current password', async () => {
    // The field name is the contractual part: `change-password/page.tsx` renders
    // `state.field === 'currentPassword' ? state.error : null` under that input, and the
    // route translates `result.field` into a `fieldErrors` key. A rename in either place
    // silently moves every message to the standalone alert.
    const user = await makeUser({ tag: 'wrong', role: 'MERCHANT', password: GOOD_PASSWORD });
    cookieJar = await tokenFor({ userId: user.id, role: 'MERCHANT' });

    const response = await changePasswordRoute(
      request({ currentPassword: 'not-the-current-1', newPassword: NEW_PASSWORD }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'VALIDATION',
      message: 'That is not your current password.',
      fieldErrors: { currentPassword: 'That is not your current password.' },
    });
  });

  it('returns 422 with fieldErrors naming newPassword for a policy failure', async () => {
    const user = await makeUser({ tag: 'policy', role: 'MERCHANT', password: GOOD_PASSWORD });
    cookieJar = await tokenFor({ userId: user.id, role: 'MERCHANT' });

    const response = await changePasswordRoute(
      request({ currentPassword: GOOD_PASSWORD, newPassword: 'short1' }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'VALIDATION',
      message: 'Use at least 12 characters.',
      fieldErrors: { newPassword: 'Use at least 12 characters.' },
    });
  });

  it('returns an empty fieldErrors object for a 401 from the service', async () => {
    // A session whose user has been deleted. `changePassword` answers 401 with no `field`,
    // and the route's `result.field ? { [result.field]: … } : {}` produces `{}`. Pinned
    // because the page branches on `field === null` for the standalone alert — and `{}`
    // is what lets the route's shape stay constant across every failure.
    cookieJar = await tokenFor({
      userId: '00000000-0000-4000-8000-000000000000',
      role: 'MERCHANT',
    });

    const response = await changePasswordRoute(
      request({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'VALIDATION',
      message: 'Please sign in again.',
      fieldErrors: {},
    });
  });

  it('returns 200, a redirect target and a refreshed cookie on success', async () => {
    const user = await makeUser({
      tag: 'success',
      role: 'ORGANISER',
      password: 'temporary-pass-99',
      mustChangePassword: true,
    });
    cookieJar = await tokenFor({
      userId: user.id,
      role: 'ORGANISER',
      mustChangePassword: true,
    });

    const response = await changePasswordRoute(
      request({ currentPassword: 'temporary-pass-99', newPassword: NEW_PASSWORD }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/organiser' });

    // The cookie must be *new*, and its `mv` claim must be false. This is the assertion the
    // whole route exists for: without it the user completes the form and middleware sends
    // them back to it.
    const issued = response.cookies.get(SESSION_COOKIE)?.value ?? '';
    expect(issued).not.toBe(cookieJar);

    const claims = await verifySession(issued);
    expect(claims?.mustChangePassword).toBe(false);
    expect(claims?.userId).toBe(user.id);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true, mustChangePassword: true },
    });
    expect(stored.mustChangePassword).toBe(false);
    expect(await verifyPassword(NEW_PASSWORD, stored.passwordHash)).toBe(true);
  });

  it('sets a cookie with the same protected attributes as login', async () => {
    const user = await makeUser({
      tag: 'cookie',
      role: 'MERCHANT',
      password: 'temporary-pass-99',
      mustChangePassword: true,
    });
    cookieJar = await tokenFor({ userId: user.id, role: 'MERCHANT', mustChangePassword: true });

    const response = await changePasswordRoute(
      request({ currentPassword: 'temporary-pass-99', newPassword: NEW_PASSWORD }),
    );

    const raw = (response.headers.get('set-cookie') ?? '').toLowerCase();

    // Both surfaces call `sessionCookieOptions()`, so this is a shared-constant assertion
    // as much as a route assertion — if the refresh wrote the cookie with different
    // attributes from login, the two would diverge in a way only a browser would notice.
    expect(raw).toContain('path=/');
    expect(raw).toContain('httponly');
    expect(raw).toContain('samesite=lax');
    expect(raw).toContain(`max-age=${7 * 24 * 60 * 60}`);
  });

  it('sets no cookie on a 422', async () => {
    // A failure that still wrote a cookie would hand the caller a fresh session for a
    // rejected request — the same defect the login route's no-cookie-on-401 test covers.
    const user = await makeUser({ tag: 'nocookie', role: 'MERCHANT', password: GOOD_PASSWORD });
    cookieJar = await tokenFor({ userId: user.id, role: 'MERCHANT' });

    const response = await changePasswordRoute(
      request({ currentPassword: 'not-the-current-1', newPassword: NEW_PASSWORD }),
    );

    expect(response.status).toBe(422);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not change the password of a different user, only the session holder', async () => {
    // `changePassword(session.userId, …)`. The route takes no user id from the body, so
    // this is a structural guarantee rather than a check — but it is the one an
    // "admin edits a user's password" feature would break by adding a body field, and the
    // assertion is cheap.
    const victim = await makeUser({ tag: 'victim', role: 'MERCHANT', password: GOOD_PASSWORD });
    const actor = await makeUser({ tag: 'actor', role: 'ADMIN', password: GOOD_PASSWORD });

    cookieJar = await tokenFor({ userId: actor.id, role: 'ADMIN' });

    const response = await changePasswordRoute(
      request({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).redirectTo).toBe('/admin/users');

    // The actor's password moved…
    const actorRow = await prisma.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(NEW_PASSWORD, actorRow.passwordHash)).toBe(true);

    // …and the other user's did not.
    const victimRow = await prisma.user.findUniqueOrThrow({
      where: { id: victim.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(GOOD_PASSWORD, victimRow.passwordHash)).toBe(true);
    expect(await verifyPassword(NEW_PASSWORD, victimRow.passwordHash)).toBe(false);
  });

  it('does not require the impersonation guard, and a borrowed session can change the merchant password', async () => {
    // A reachability finding, asserted rather than assumed.
    //
    // `change-password/route.ts` calls `getSession()` directly and never calls
    // `refuseIfImpersonating` — it does not import `authorize.ts` at all. Middleware's
    // impersonation rule covers `/admin` and `/api/admin`, and the allowlist for
    // `mustChangePassword` covers this path, but nothing refuses a borrowed session. So an
    // impersonating admin **can** set the merchant's password.
    //
    // Severity: real but narrow. It is a write, and FR-904 says read-only. It requires the
    // admin to already hold a valid borrowed token, and the audit trail records the
    // impersonation start but not this change — `changePassword` logs `auth.password_changed`
    // with the *merchant's* user id and no actor, so the admin would not be attributed.
    //
    // Not fixed here: this slice writes tests, and the fix is a product decision (should a
    // read-only session be able to complete a forced password change, given the merchant
    // cannot? — arguably the change should be *refused* and the admin told to end the
    // session). Recorded in `docs/PROGRESS.md` as an open defect with this test as its
    // reproduction.
    const { newImpersonationSession } = await import('@/lib/auth/jwt');
    const merchant = await makeUser({ tag: 'imp-target', role: 'MERCHANT', password: GOOD_PASSWORD });
    const admin = await makeUser({ tag: 'imp-admin', role: 'ADMIN' });

    cookieJar = await signSession(
      newImpersonationSession({
        merchantUserId: merchant.id,
        actorUserId: admin.id,
        auditId: '55555555-5555-5555-5555-555555555555',
      }),
    );

    const response = await changePasswordRoute(
      request({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD }),
    );

    expect(response.status).toBe(200);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: merchant.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(NEW_PASSWORD, stored.passwordHash)).toBe(true);

    // And the log does not name the admin, which is the second half of the finding.
    const changed = logLines.filter((line) => line.event === 'auth.password_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.fields).toEqual({ userId: merchant.id });
  });
});
