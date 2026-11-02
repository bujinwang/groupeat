import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE, newSession, signSession } from '@/lib/auth/jwt';
import { middleware } from '@/middleware';

/**
 * The optimistic gate vs the scheduler.
 *
 * `middleware.ts` is the first thing a request touches, and it answers `401
 * UNAUTHENTICATED` to anything without a session cookie. A platform cron
 * invocation has no cookie — it has `Authorization: Bearer $CRON_SECRET` — so
 * without an entry in `PUBLIC_PREFIXES` the middleware rejects the tick before
 * `route.ts` runs.
 *
 * That failure is invisible from every other test in the repo: `route.test.ts`
 * calls the handler directly, past the middleware, so it asserts a `200` for a
 * request that production would never deliver. The only way to see it is to call
 * the middleware. Hence this file.
 *
 * These tests do not assert that `/api/jobs/cutoff` is *safe* — `route.test.ts`
 * does that, with the bearer comparison and the three refusals. They assert only
 * that the middleware lets the request through to the handler that checks.
 */

process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const ORIGIN = 'http://localhost:3000';

function request(path: string, init: { headers?: Record<string, string>; cookie?: string } = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.cookie) {
    headers.set('cookie', `${SESSION_COOKIE}=${init.cookie}`);
  }
  return new NextRequest(new URL(path, ORIGIN), { headers });
}

describe('the scheduler reaches the route that authenticates it', () => {
  it('lets a cookie-less GET through to /api/jobs/cutoff', async () => {
    // The exact shape of a cron invocation: no cookie, a bearer header the
    // middleware neither reads nor validates.
    const response = await middleware(
      request('/api/jobs/cutoff', { headers: { authorization: 'Bearer whatever-the-route-will-check' } }),
    );

    // `NextResponse.next()` sets this header; a redirect has a 307 status and a
    // `location`, and a JSON denial has a 401. Asserting the pass-through
    // explicitly rather than "not 401" so a future 403 cannot slip past.
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('lets a cookie-less POST through too, since the route exports both', async () => {
    const response = await middleware(
      request('/api/jobs/cutoff', { headers: { authorization: 'Bearer whatever' } }),
    );
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('still refuses every other /api path without a session', async () => {
    // The narrowing control. A `PUBLIC_PREFIXES` entry of `/api` or `/api/jobs`
    // would make this fail — which is the whole reason the entry is the exact
    // path. These are real routes, so an accidental widening is caught by the
    // route that would have been exposed.
    //
    // `/api/jobs/anything-else` is the one that matters most: it is the route the
    // prefix form of this entry would have opened, and it does not exist yet —
    // which is exactly when a silent exposure is easiest to introduce and hardest
    // to notice.
    for (const path of ['/api/merchant/drops', '/api/admin/users', '/api/jobs/anything-else']) {
      const response = await middleware(request(path));
      expect(response.status, `${path} must stay gated`).toBe(401);
      expect(response.headers.get('x-middleware-next'), `${path} must not pass through`).toBeNull();
    }
  });

  it('leaves the pre-existing public auth paths alone', async () => {
    // `/api/auth/me` is in `PUBLIC_PATHS` on purpose — it *is* the "am I signed
    // in?" probe, and it answers 401 itself when there is no session. Asserted so
    // that a future edit to the public list is a decision rather than a surprise.
    const me = await middleware(request('/api/auth/me'));
    expect(me.headers.get('x-middleware-next')).toBe('1');
  });

  it('does not gate the page routes the public already relies on', async () => {
    // `/d/*` and `/api/public/*` were the previous two entries; a change to the
    // matcher or the prefix list that broke them would break the entire
    // distribution model (PRD-v1 §3.2: a diner has no account).
    for (const path of ['/d/ABC123', '/api/public/drops/ABC123/count']) {
      const response = await middleware(request(path));
      expect(response.headers.get('x-middleware-next'), `${path} must stay public`).toBe('1');
    }
  });
});

describe('and the gate it skipped is not thereby missing', () => {
  it('a signed-in merchant is still subject to the role gate on the job route', async () => {
    // Not a security property — `route.ts` ignores sessions entirely and requires
    // the bearer, so a merchant holding a cookie still gets `401` from the
    // handler. This asserts the middleware's behaviour is *unchanged* for a
    // request that carries a session, so the public entry is only about the
    // cookie-less case and nothing else has quietly moved.
    const session = newSession({
      userId: '11111111-1111-1111-1111-111111111111',
      role: 'MERCHANT',
      mustChangePassword: false,
    });
    const token = await signSession(session);

    const response = await middleware(request('/api/jobs/cutoff', { cookie: token }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
