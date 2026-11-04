import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PRD-sprint1 §6.1 / S1-019 — `POST /api/auth/login`, `POST /api/auth/logout`.
 *
 * ## What is left for the route to own
 *
 * `credentials.test.ts` covers `authenticate` end to end: the limit, the enumeration
 * guard, the redirect table, the cookies' contents. Everything below is the part that only
 * exists at the HTTP edge, and each item is a way a route can be wrong while the service
 * is right:
 *
 *   1. **The body is validated before the service is called.** A route that passed
 *      `undefined` through would reach `bcrypt.compare(undefined, hash)` and answer 500
 *      for a malformed request.
 *   2. **The failure codes are mapped, not forwarded.** 401 and 429 produce different
 *      `error` strings from one service shape.
 *   3. **`Retry-After` is set on a 429 and nowhere else.** It is what a client backs off
 *      on, and it existed in no test before this file.
 *   4. **`clientKey` reads the right header first.** This is the rate limiter's only
 *      input, so its precedence is a security property: `x-forwarded-for` first element,
 *      then `x-real-ip`, then `'local'`.
 *   5. **The cookie is set on success and cleared on logout.** The `Set-Cookie` on the
 *      response is the whole deliverable of a login; a 200 without it looks like success
 *      and leaves the caller anonymous.
 *
 * ## Why the real `authenticate` rather than a mock
 *
 * Mocking it would delete items 1–3 and 5 from the list above, which are the only reasons
 * to have a route test at all. The cost is a real bcrypt compare per success case (~54 ms)
 * and ten per rate-limit case (~540 ms); the file runs in about a second and a half.
 *
 * ## `clientKey` and the proxy it needs
 *
 * Both this route and the login server action read `x-forwarded-for` themselves, and both
 * carry the same warning: a client-supplied header is only trustworthy behind a proxy that
 * overwrites it. That is asserted as *precedence* rather than as trust — see the test that
 * sends two headers and checks which one the bucket used. Whether the header may be
 * believed is `rate-limit.ts`'s documented non-claim, not something a unit test can settle.
 */

vi.mock('server-only', () => ({}));

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
const { hashPassword } = await import('@/lib/auth/password');
const { clearAll, hit } = await import('@/lib/auth/rate-limit');
const { SESSION_COOKIE, verifySession } = await import('@/lib/auth/jwt');

const { POST: login } = await import('../login/route');
const { POST: logout } = await import('../logout/route');

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `authrt${Date.now().toString(36).slice(-5)}`;

const GOOD_PASSWORD = 'route-password-42';

const userIds: string[] = [];

let merchantId = '';
let merchantEmail = '';
let mustChangeId = '';
let mustChangeEmail = '';

/**
 * A unique client key per test, so no test can be pre-blocked by another's attempts.
 *
 * Formed from `PREFIX` plus the test's own label and used as the `x-forwarded-for` value,
 * which is how the route receives it. Asserting the limiter through the *header* rather
 * than by calling `hit()` directly is the point: it proves the value the route computed
 * reached the limiter.
 */
function ipFor(label: string): string {
  // A plausible IPv4 literal, so nothing in the request pipeline can object to it.
  return `10.${(label.length % 200) + 1}.${label.charCodeAt(0) % 200}.${label.length}`;
}

function request(args: {
  body?: unknown;
  ip?: string;
  headers?: Record<string, string>;
  url?: string;
}): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...args.headers };
  if (args.ip !== undefined) {
    headers['x-forwarded-for'] = args.ip;
  }

  return new NextRequest(args.url ?? 'http://localhost/api/auth/login', {
    method: 'POST',
    headers,
    ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
  });
}

beforeAll(async () => {
  const merchant = await prisma.user.create({
    data: {
      email: `${PREFIX}-merchant@example.test`,
      name: 'Route Merchant',
      passwordHash: await hashPassword(GOOD_PASSWORD),
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true, email: true },
  });
  const mustChange = await prisma.user.create({
    data: {
      email: `${PREFIX}-mustchange@example.test`,
      name: 'Route MustChange',
      passwordHash: await hashPassword('temporary-pass-99'),
      role: 'MERCHANT',
      mustChangePassword: true,
    },
    select: { id: true, email: true },
  });

  merchantId = merchant.id;
  merchantEmail = merchant.email;
  mustChangeId = mustChange.id;
  mustChangeEmail = mustChange.email;
  userIds.push(merchant.id, mustChange.id);
});

beforeEach(() => {
  clearAll();
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

  // The `User` row is the cascading parent, so one delete is complete. `authenticate`
  // inserts nothing — `touchLastLogin` is an update.
  await step(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));

  if (failures.length > 0) {
    throw new AggregateError(failures, 'auth route teardown failed');
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

describe('§6.1 · POST /api/auth/login — success', () => {
  it('returns 200, a redirect target and a signed cookie', async () => {
    const response = await login(
      request({ body: { email: merchantEmail, password: GOOD_PASSWORD }, ip: ipFor('ok') }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/merchant/drops' });

    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie).toBeDefined();

    // The token in that cookie is verified the way middleware verifies it. A cookie
    // carrying garbage would satisfy "a cookie was set" and leave the user signed out.
    const claims = await verifySession(cookie?.value ?? '');
    expect(claims?.userId).toBe(merchantId);
    expect(claims?.role).toBe('MERCHANT');
  });

  it('sets httpOnly, SameSite=Lax, path=/ and a 7-day maxAge', async () => {
    // S1-005's cookie attributes. `httpOnly` is the one that matters most — without it a
    // single XSS reads the session — and it is also the one nothing else in the suite
    // checks, because `httponly` only exists in the serialised header.
    const response = await login(
      request({ body: { email: merchantEmail, password: GOOD_PASSWORD }, ip: ipFor('attributes') }),
    );

    const raw = response.headers.get('set-cookie') ?? '';

    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(raw.toLowerCase()).toContain('httponly');
    expect(raw.toLowerCase()).toContain('samesite=lax');
    expect(raw.toLowerCase()).toContain('path=/');
    expect(raw).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    // `Secure` is production-only, and the suite runs under NODE_ENV=test, so it must be
    // absent here *and* present under production. The absence is asserted because a
    // hardcoded `secure: true` would break local HTTP development in a way no test in this
    // file would otherwise notice.
    expect(raw.toLowerCase()).not.toContain('secure');
  });

  it('sends a mustChangePassword user to /change-password with mv: true in the token', async () => {
    const response = await login(
      request({
        body: { email: mustChangeEmail, password: 'temporary-pass-99' },
        ip: ipFor('mustchange'),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/change-password' });

    const claims = await verifySession(response.cookies.get(SESSION_COOKIE)?.value ?? '');
    expect(claims?.mustChangePassword).toBe(true);
    expect(claims?.userId).toBe(mustChangeId);
  });

  it('accepts an email that differs in case and whitespace', async () => {
    // `normalizeEmail` lives in `users.ts` and is reached through `authenticate`. Asserted
    // at the route because the *route's* zod schema is `z.string().min(1)` with no
    // transform — so this proves the normalisation happens where it is claimed to, below
    // the edge, rather than being silently absent at both.
    const response = await login(
      request({
        body: { email: `  ${merchantEmail.toUpperCase()} `, password: GOOD_PASSWORD },
        ip: ipFor('case'),
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe('§6.1 · POST /api/auth/login — refusals', () => {
  it('returns 401 with INVALID_CREDENTIALS for a wrong password', async () => {
    const response = await login(
      request({ body: { email: merchantEmail, password: 'not-the-password-1' }, ip: ipFor('wrong') }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'INVALID_CREDENTIALS',
      message: 'Email or password is incorrect.',
    });
  });

  it('returns the identical 401 body for an unknown email', async () => {
    const unknown = await login(
      request({
        body: { email: `${PREFIX}-nobody@example.test`, password: 'not-the-password-1' },
        ip: ipFor('unknown'),
      }),
    );

    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({
      error: 'INVALID_CREDENTIALS',
      message: 'Email or password is incorrect.',
    });
  });

  it('sets no cookie on a 401', async () => {
    // The failure mode this prevents: a route that calls `setSessionCookie` before checking
    // the result would hand the caller a session for a failed login. Asserting the status
    // alone would not see it.
    const response = await login(
      request({ body: { email: merchantEmail, password: 'not-the-password-1' }, ip: ipFor('nocookie') }),
    );

    expect(response.status).toBe(401);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('returns 429 with RATE_LIMITED and a Retry-After header on the eleventh attempt', async () => {
    const ip = ipFor('limit');

    for (let i = 0; i < 10; i += 1) {
      const priming = await login(
        request({ body: { email: merchantEmail, password: 'not-the-password-1' }, ip }),
      );
      expect(priming.status).toBe(401);
    }

    const blocked = await login(
      request({ body: { email: merchantEmail, password: GOOD_PASSWORD }, ip }),
    );

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many attempts. Try again in a few minutes.',
    });

    // The header is the part a client acts on. `Retry-After` is seconds, and it must be a
    // positive integer — the service guarantees `>= 1`, and the route stringifies it.
    const retryAfter = blocked.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    expect(blocked.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('does not set Retry-After on a 401', async () => {
    // The mapping is `error: result.status === 429 ? … : …`, and the header is set only
    // `if (result.retryAfterSeconds !== undefined)`. A 401 result carries no
    // `retryAfterSeconds`, so no header — asserted because a client that saw `Retry-After:
    // 0` on a wrong password would retry immediately in a loop.
    const response = await login(
      request({ body: { email: merchantEmail, password: 'not-the-password-1' }, ip: ipFor('noretry') }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Retry-After')).toBeNull();
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['a missing password', { email: merchantEmail }],
    ['a missing email', { password: GOOD_PASSWORD }],
    ['an empty password', { email: merchantEmail, password: '' }],
    ['an empty email', { email: '', password: GOOD_PASSWORD }],
    ['a non-string email', { email: 12345, password: GOOD_PASSWORD }],
    ['a non-string password', { email: merchantEmail, password: null }],
    ['an array body', [merchantEmail, GOOD_PASSWORD]],
    ['a bare string body', 'email=someone'],
  ])('returns 400 INVALID_REQUEST for %s', async (_label, body) => {
    const response = await login(request({ body, ip: ipFor(`bad-${String(_label).slice(0, 6)}`) }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'INVALID_REQUEST',
      message: 'Email and password are required.',
    });
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('returns 400 rather than 500 for a body that is not JSON at all', async () => {
    // `request.json()` throws on malformed JSON; the route catches it with `.catch(() =>
    // null)` and then fails the schema. Without that catch the throw would escape the
    // handler and become a 500 — which is what an unparseable request from a scanner
    // looks like in the logs.
    const response = await login(
      new NextRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ipFor('notjson') },
        body: '{not json',
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('INVALID_REQUEST');
  });

  it('does not count a malformed request against the rate limit', async () => {
    // The schema check runs before `authenticate`, so a scanner throwing rubbish at the
    // endpoint does not exhaust a real user's budget from the same address. This is a
    // design consequence worth pinning: the alternative ordering (limit inside the route,
    // before validation) would let garbage lock out a shared NAT.
    const ip = ipFor('nomallimit');

    for (let i = 0; i < 15; i += 1) {
      const bad = await login(request({ body: {}, ip }));
      expect(bad.status).toBe(400);
    }

    const good = await login(request({ body: { email: merchantEmail, password: GOOD_PASSWORD }, ip }));
    expect(good.status).toBe(200);
  });
});

describe('§6.1 · POST /api/auth/login — clientKey precedence', () => {
  it('uses the first entry of x-forwarded-for, not the last', async () => {
    // The precedence that matters. `x-forwarded-for` is a comma-separated chain appended
    // to by each proxy, so the *first* entry is the original client and the rest are
    // infrastructure. Taking the last would key every request on the nearest proxy, i.e.
    // one shared bucket for the whole world — a limiter that throttles everybody at once.
    //
    // Asserted through the limiter's own state: fill the bucket that `first` names, then
    // check that a request whose header *starts* with a different address is unaffected
    // while one that starts with the exhausted address is blocked.
    const exhausted = ipFor('chain-first');

    for (let i = 0; i < 10; i += 1) {
      await login(
        request({
          body: { email: merchantEmail, password: 'not-the-password-1' },
          headers: { 'x-forwarded-for': `${exhausted}, 203.0.113.9, 198.51.100.7` },
        }),
      );
    }

    // Same header, same first element → blocked.
    const blocked = await login(
      request({
        body: { email: merchantEmail, password: GOOD_PASSWORD },
        headers: { 'x-forwarded-for': `${exhausted}, 203.0.113.9` },
      }),
    );
    expect(blocked.status).toBe(429);

    // A different first element, same tail → allowed. If the route keyed on the last
    // entry, both of these would be the same bucket and this would be 429.
    const other = await login(
      request({
        body: { email: merchantEmail, password: GOOD_PASSWORD },
        headers: { 'x-forwarded-for': `203.0.113.9, ${exhausted}` },
      }),
    );
    expect(other.status).toBe(200);
  });

  it('trims whitespace around the forwarded address', async () => {
    // `forwarded.split(',')[0]?.trim()`.
    //
    // **The header must have the space INSIDE the first element, not around the whole
    // value.** The first version of this test sent `'   ${ip}   '` and passed with the
    // `.trim()` deleted — probed, and the reason is that the HTTP layer already strips
    // surrounding whitespace from a header value before the route ever sees it, so the
    // round trip is `'  10.0.0.1  '` → `'10.0.0.1'` and there is nothing left to trim.
    //
    // `'10.0.0.1 , 10.0.0.2'` is the shape that reaches the `.trim()`: the space sits
    // between the address and the comma, so `split(',')[0]` is `'10.0.0.1 '` with a
    // trailing space and the untrimmed key is a *different bucket* from the trimmed one.
    // A proxy that joins its chain with `', '` while itself appending `' , '` produces
    // exactly this, and the bypass is one character wide.
    const ip = ipFor('trim');

    for (let i = 0; i < 10; i += 1) {
      await login(
        request({
          body: { email: merchantEmail, password: 'not-the-password-1' },
          headers: { 'x-forwarded-for': `${ip} , 203.0.113.9` },
        }),
      );
    }

    const blocked = await login(
      request({
        body: { email: merchantEmail, password: GOOD_PASSWORD },
        headers: { 'x-forwarded-for': ip },
      }),
    );
    expect(blocked.status).toBe(429);
  });

  it('falls back to x-real-ip when there is no x-forwarded-for', async () => {
    const ip = ipFor('realip');

    for (let i = 0; i < 10; i += 1) {
      await login(
        request({
          body: { email: merchantEmail, password: 'not-the-password-1' },
          headers: { 'x-real-ip': ip },
        }),
      );
    }

    const blocked = await login(
      request({
        body: { email: merchantEmail, password: GOOD_PASSWORD },
        headers: { 'x-real-ip': ip },
      }),
    );
    expect(blocked.status).toBe(429);
  });

  it('prefers x-forwarded-for over x-real-ip when both are present', async () => {
    const forwarded = ipFor('pref-fwd');
    const realIp = ipFor('pref-real');

    for (let i = 0; i < 10; i += 1) {
      await login(
        request({
          body: { email: merchantEmail, password: 'not-the-password-1' },
          headers: { 'x-forwarded-for': forwarded, 'x-real-ip': realIp },
        }),
      );
    }

    // Blocked on the forwarded key…
    const blocked = await login(
      request({
        body: { email: merchantEmail, password: GOOD_PASSWORD },
        headers: { 'x-forwarded-for': forwarded, 'x-real-ip': realIp },
      }),
    );
    expect(blocked.status).toBe(429);

    // …and the real-ip bucket was never touched, which is what "prefers" means. A route
    // that concatenated or used the second header would leave this one exhausted instead.
    //
    // One `hit` call, then two assertions on the result: `hit` records an attempt, so
    // reading `.allowed` and `.remaining` from two separate calls counts two.
    const realIpBucket = hit(realIp);
    expect(realIpBucket.allowed).toBe(true);
    expect(realIpBucket.remaining).toBe(9);
  });

  it('shares one bucket for every caller with no headers at all', async () => {
    // The `'local'` fallback. It is a single global bucket, which is the correct choice for
    // a deployment with no proxy in front (and the documented limit of this module). The
    // consequence to pin is that it is *reached*: ten anonymous attempts exhaust the
    // fallback and the eleventh is refused.
    for (let i = 0; i < 10; i += 1) {
      await login(request({ body: { email: merchantEmail, password: 'not-the-password-1' } }));
    }

    const blocked = await login(request({ body: { email: merchantEmail, password: GOOD_PASSWORD } }));
    expect(blocked.status).toBe(429);
  });

  it('treats an empty x-forwarded-for as absent rather than as a bucket named ""', async () => {
    // `if (first)` guards the empty string, so the route falls through to `x-real-ip` and
    // then to `'local'`. Two separate guards are involved and both are asserted here:
    // `if (forwarded)` handles a missing header, and `if (first)` handles a present-but-empty
    // first element (which is what a proxy sending `', 10.0.0.2'` produces).
    //
    // The second case is the one with a bypass in it: with `??` instead of the `if (first)`
    // guard, `''` would be a bucket any caller could select for themselves.
    const realIp = ipFor('emptyfwd');

    // A *comma-leading* header: present, but the first element is empty.
    const commaLeading = await login(
      request({
        body: { email: merchantEmail, password: GOOD_PASSWORD },
        headers: { 'x-forwarded-for': ', 203.0.113.9', 'x-real-ip': realIp },
      }),
    );

    expect(commaLeading.status).toBe(200);

    // The success was counted against `x-real-ip`, because the empty first element was
    // skipped. Two `hit` calls would count two attempts, so capture once.
    const realIpBucket = hit(realIp);
    expect(realIpBucket.remaining).toBe(9);

    // …and the empty-string bucket was never created at all.
    const emptyBucket = hit('');
    expect(emptyBucket.remaining).toBe(9);
  });

  it('falls back to the single "local" bucket when no address header is present', async () => {
    // The `'local'` fallback, asserted directly rather than inferred. Ten credential
    // failures with no headers exhaust it, and the eleventh attempt is refused — which is
    // also the documented weakness of a deployment with no proxy: every caller shares one
    // bucket.
    //
    // Nothing earlier in this file reached the fallback: a *fresh* bucket reports
    // `maxAttempts - 1` = 9 remaining on its first attempt, because `hit` records the
    // attempt and then answers. A bucket that had already been used would read lower here,
    // which is what makes this read — rather than only the assertion after the loop — the
    // one that proves the fallback is reached when, and only when, it should be.
    //
    // (Two drafts of this line were wrong: 8, on the assumption that the first attempt
    // leaves 8. It leaves 9. Both were caught by running it.)
    expect(hit('local').remaining).toBe(9);

    for (let i = 0; i < 10; i += 1) {
      await login(request({ body: { email: merchantEmail, password: 'not-the-password-1' } }));
    }

    const blocked = await login(request({ body: { email: merchantEmail, password: GOOD_PASSWORD } }));
    expect(blocked.status).toBe(429);
  });
});

describe('§6.1 · POST /api/auth/logout', () => {
  it('returns 204 with no body, and clears the cookie', async () => {
    const response = await logout();

    expect(response.status).toBe(204);
    // 204 means no content. `await response.text()` on a real 204 is `''`.
    expect(await response.text()).toBe('');

    const raw = response.headers.get('set-cookie') ?? '';
    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(raw).toContain('Max-Age=0');
  });

  it('clears the cookie with the same attributes it was set with', async () => {
    // A cookie is matched on (name, domain, path) when a browser decides whether to delete
    // it. A clear written as `Set-Cookie: groupeat_session=; Max-Age=0` with no `Path`
    // defaults to the *current* directory, so logging out from `/merchant/drops` would
    // leave the `/` cookie in place and the user would still be signed in.
    //
    // Both surfaces call `sessionCookieOptions()`, which is what makes that impossible —
    // and this asserts the shared attributes actually reached the header.
    const response = await logout();
    const raw = (response.headers.get('set-cookie') ?? '').toLowerCase();

    expect(raw).toContain('path=/');
    expect(raw).toContain('httponly');
    expect(raw).toContain('samesite=lax');
  });

  it('is idempotent — logging out twice, or with no session, is not an error', async () => {
    // The route takes no arguments and reads no session, so there is no state to be wrong
    // about. Asserted because "clears the cookie" is a claim about a *stateless* operation:
    // if a future version looked the session up and 401'd when absent, signing out from a
    // stale tab would show an error page instead of the login screen.
    const first = await logout();
    const second = await logout();

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(second.headers.get('set-cookie')).toBe(first.headers.get('set-cookie'));
  });

  it('does NOT revoke the token, and the docblock says so', async () => {
    // The honest half of the logout contract, asserted so it cannot be discovered later as
    // a surprise. A JWT is stateless: clearing the cookie stops *this browser* sending it,
    // and a copied token remains valid until `exp`. There is no session store in this
    // app, so there is nothing to revoke against.
    //
    // This test therefore proves the opposite of a security property, and that is the
    // point: the token signed before logout still verifies after it.
    const loginResponse = await login(
      request({ body: { email: merchantEmail, password: GOOD_PASSWORD }, ip: ipFor('logout-revoke') }),
    );
    const token = loginResponse.cookies.get(SESSION_COOKIE)?.value ?? '';
    expect(await verifySession(token)).not.toBeNull();

    await logout();

    // Still valid. `logout/route.ts`'s docblock: "Do not describe logout as revocation."
    expect(await verifySession(token)).not.toBeNull();
  });
});
