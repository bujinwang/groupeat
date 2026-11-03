import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE,
  newImpersonationSession,
  newSession,
  signSession,
} from '@/lib/auth/jwt';
import { middleware } from '@/middleware';

/**
 * FR-904 — the middle layer's half of the read-only guarantee.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## Two different questions, two different places
 *
 * `authorize.ts` answers "may this borrowed session *change* this merchant's data", and
 * `impersonation-readonly.test.ts` walks every mutating handler to prove they all ask.
 * That is the guarantee.
 *
 * This file answers a narrower one: "may a borrowed session *reach* the admin surface".
 * Today the role gate already says no — the session's role is `MERCHANT` — but that is a
 * consequence of the role being right, not a statement that reaching `/admin` while
 * impersonating is forbidden. If a token ever carried both `ADMIN` and `imp`, the role
 * gate would wave it through and the impersonating admin would hold full privileges from
 * inside somebody else's identity. So the intent is asserted here as well.
 *
 * ## Why these tests build a contradictory token on purpose
 *
 * `newImpersonationSession` always sets `role: 'MERCHANT'`, so the shape this rule guards
 * against cannot be produced by the app. That is the point: a test that could only build
 * reachable states would never exercise the branch, and a branch nothing exercises is a
 * branch that silently rots. The token below is signed with the real secret and declares
 * the combination the app will not mint.
 */

process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const ORIGIN = 'http://localhost:3000';

function request(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) {
    headers.set('cookie', `${SESSION_COOKIE}=${cookie}`);
  }
  return new NextRequest(new URL(path, ORIGIN), { headers });
}

/** A borrowed session that also claims `ADMIN` — the shape the app never mints. */
async function contradictoryToken() {
  const ordinary = newSession({
    userId: '99999999-9999-9999-9999-999999999999',
    role: 'ADMIN',
    mustChangePassword: false,
  });
  return signSession({
    ...ordinary,
    impersonation: {
      actorUserId: '99999999-9999-9999-9999-999999999999',
      auditId: '88888888-8888-8888-8888-888888888888',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    },
  });
}

describe('FR-904 · a borrowed session cannot reach the admin surface', () => {
  it('refuses the admin API with 403 IMPERSONATING', async () => {
    const token = await contradictoryToken();
    const response = await middleware(request('/api/admin/users', token));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('IMPERSONATING');
    // A sentence, not a code: the admin needs to know what to do, and what to do is end
    // the session.
    expect(body.message).toMatch(/end the impersonation/i);
  });

  it('sends an admin page request to the merchant surface, not to /change-password', async () => {
    // The bug this guards. `deny()` maps every non-API 403 to `/change-password`, which
    // is where a forced password change belongs — so reusing it here would tell an admin
    // mid-impersonation to change a password that is not the problem, and the borrowed
    // session would then be stuck on a form it must not submit.
    const token = await contradictoryToken();
    const response = await middleware(request('/admin/merchants/abc', token));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/merchant/drops`);
  });

  it('leaves the merchant surface reachable — that is what the session is for', async () => {
    // A *real* borrowed session, not the contradictory one: the role is `MERCHANT`, which
    // is what a genuine impersonation carries. The token above is deliberately `ADMIN`,
    // so the role gate would redirect it away from `/merchant` — correct behaviour, and
    // not what this test is about.
    const token = await signSession(
      newImpersonationSession({
        merchantUserId: '77777777-7777-7777-7777-777777777777',
        actorUserId: '99999999-9999-9999-9999-999999999999',
        auditId: '88888888-8888-8888-8888-888888888888',
      }),
    );

    for (const path of ['/merchant/drops', '/api/merchant/drops']) {
      const response = await middleware(request(path, token));
      expect(response.headers.get('x-middleware-next'), `${path} must stay reachable`).toBe('1');
    }
  });

  it('leaves the exit route reachable, which is the only way out', async () => {
    // The structural reason the exit lives under `/api/auth`: every path that could
    // refuse a borrowed session must not include the one that ends it. An admin locked
    // out of `/admin` and out of the exit would have to wait thirty minutes.
    const token = await contradictoryToken();
    const response = await middleware(request('/api/auth/impersonation/end', token));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('does not disturb ordinary admin or merchant sessions', async () => {
    // The narrowing control: the rule keys off the claim, not off the path.
    const admin = await signSession(
      newSession({
        userId: '99999999-9999-9999-9999-999999999999',
        role: 'ADMIN',
        mustChangePassword: false,
      }),
    );
    const merchant = await signSession(
      newSession({
        userId: '88888888-8888-8888-8888-888888888888',
        role: 'MERCHANT',
        mustChangePassword: false,
      }),
    );

    const adminOnAdmin = await middleware(request('/admin/users', admin));
    expect(adminOnAdmin.headers.get('x-middleware-next')).toBe('1');

    const merchantOnMerchant = await middleware(request('/merchant/drops', merchant));
    expect(merchantOnMerchant.headers.get('x-middleware-next')).toBe('1');

    // And a real merchant session still cannot reach `/admin` — by the role gate, which
    // is unchanged and is what a `MERCHANT` token gets.
    const merchantOnAdmin = await middleware(request('/admin/users', merchant));
    expect(merchantOnAdmin.status).toBe(307);
    expect(merchantOnAdmin.headers.get('location')).toBe(`${ORIGIN}/merchant/drops`);
  });
});

describe('FR-904 · the sliding refresh keeps the claim through middleware', () => {
  it('a borrowed token issued near expiry is refreshed with its claim intact', async () => {
    // The end-to-end version of `impersonation-jwt.test.ts`'s most important test:
    // middleware is the caller of `signSession` that matters, and it hands back whatever
    // `verifySession` returned. If the refresh dropped `imp`, this response's cookie
    // would be a plain merchant session — and the admin would keep browsing as somebody
    // else, with every write suddenly allowed and nothing logged.
    const claims = newImpersonationSession({
      merchantUserId: '77777777-7777-7777-7777-777777777777',
      actorUserId: '99999999-9999-9999-9999-999999999999',
      auditId: '66666666-6666-6666-6666-666666666666',
    });

    // What a token minted twenty-nine minutes ago looks like now: one minute of absolute
    // life left, which is well inside the 15-minute refresh threshold.
    //
    // The cap has to be shortened, not just `expiresAt`. `signSession` ignores the
    // `expiresAt` it is handed and recomputes it as `min(now + 60m, absoluteExpiresAt)`,
    // so a fixture that only shortened `expiresAt` would be issued a full thirty-minute
    // token and never take the refresh path at all — a test that asserts nothing while
    // looking like it asserts the important thing.
    const nearlyDone = {
      ...claims,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 60,
      impersonation: { ...claims.impersonation!, expiresAt: Math.floor(Date.now() / 1000) + 60 },
    };
    const token = await signSession(nearlyDone);

    const response = await middleware(request('/merchant/drops', token));
    expect(response.headers.get('x-middleware-next')).toBe('1');

    const refreshed = response.cookies.get(SESSION_COOKIE);
    expect(refreshed).toBeDefined();

    const { verifySession } = await import('@/lib/auth/jwt');
    const after = await verifySession(refreshed?.value ?? '');

    expect(after?.impersonation?.actorUserId).toBe('99999999-9999-9999-9999-999999999999');
    expect(after?.impersonation?.auditId).toBe('66666666-6666-6666-6666-666666666666');
    // Still no extension: the refresh cannot push the borrowed window out.
    expect(after?.absoluteExpiresAt).toBe(nearlyDone.absoluteExpiresAt);
  });
});
