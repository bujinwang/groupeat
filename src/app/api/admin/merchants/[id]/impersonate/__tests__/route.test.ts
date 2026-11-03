import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { IMPERSONATION_MAX_MINUTES, SESSION_COOKIE, verifySession } from '@/lib/auth/jwt';

import { POST } from '../route';

/**
 * `server-only` is neutralised for this file, and it is the honest thing to do here.
 *
 * The route imports `setSessionCookie` from `lib/auth/session`, which carries the marker
 * for a real reason: it reads `cookies()` from `next/headers` and must never be bundled
 * into a client component. Under Vitest there is no React Server Component graph, so the
 * marker throws at import and the route — a legitimate server module — becomes
 * unreachable from its own test.
 *
 * This is **not** the same as the mistake FR-902 fixed. There the marker was on
 * `audit/log.ts`, a service, and removing it was correct because nothing about that
 * module is client-safe to begin with. Here the marker is where it belongs, the mock
 * stands in for the bundler, and the cookie assertions below prove the real
 * `setSessionCookie` still runs — a mocked session module would have hidden exactly the
 * thing these tests are for.
 */
vi.mock('server-only', () => ({}));

/**
 * `POST /api/admin/merchants/:id/impersonate` — FR-904's endpoint.
 *
 * ## What the route owns, and therefore what these test
 *
 * The rules and the ordering are `startImpersonation`'s and are covered there. This file
 * covers the five things that only exist at the HTTP edge:
 *
 *   1. **Authorisation.** `requireAdmin` is the gate, and `mustChangePassword` must not
 *      be a way through it.
 *   2. **The cookie is actually set**, and it is the *borrowed* token — not the admin's.
 *      A route that returned 200 and left the old cookie in place would look like it
 *      worked and do nothing, which is the worst kind of bug here: the admin would press
 *      "Impersonate", get no error, and keep seeing the admin surface.
 *   3. **The token in that cookie is read-only.** Verified the way middleware does,
 *      through `verifySession`, because that is the only thing that will see it.
 *   4. **Validation.** A request with no reason is refused with a 422 rather than
 *      writing an audit row that says nothing.
 *   5. **The actor's email comes from the database**, not the token. `SessionClaims` has
 *      no email, and a first draft of the force-fail route read `session.email` — the
 *      row would have been written with `undefined`.
 *
 * ## Why the cookie is read off the response rather than through `cookies()`
 *
 * `setSessionCookie` writes to the `NextResponse`, which is what the browser will
 * receive. `cookies()` in a route handler reads the *request*, so asserting on it would
 * assert that nothing changed — and pass.
 */

const PREFIX = `impr${Date.now().toString(36).slice(-5)}`;

const merchantIds: string[] = [];
const userIds: string[] = [];

type MockSession = {
  userId: string;
  role: string;
  mustChangePassword: boolean;
  impersonation?: { actorUserId: string; auditId: string; expiresAt: number };
};
let currentSession: MockSession | null = null;
let adminUserId = '';

/**
 * `@/lib/auth/authorize` is replaced, not `@/lib/auth/session`.
 *
 * `authorize.ts` imports `server-only` and throws at module load, so mocking the getter
 * beneath it does not help. The real `AppError` is imported inside the factory so
 * `isAppError`'s `instanceof` still holds — a second copy of the class turns every
 * refusal into a 500, which is the failure the 401/403/409 assertions exist to catch.
 */
vi.mock('@/lib/auth/authorize', async () => {
  const { AppError } = await import('@/lib/errors');
  return {
    requireAdmin: async () => {
      if (!currentSession) throw AppError.unauthorized();
      if (currentSession.role !== 'ADMIN') throw AppError.forbidden();
      if (currentSession.mustChangePassword) throw AppError.forbidden();
      return currentSession;
    },
  };
});

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

function request(merchantId: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/admin/merchants/${merchantId}/impersonate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  });
}

function context(merchantId: string) {
  return { params: Promise.resolve({ id: merchantId }) };
}

async function makeUser(role: 'ADMIN' | 'MERCHANT', tag: string) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}-${userIds.length}@example.test`,
      passwordHash: 'not-a-real-hash',
      role,
      mustChangePassword: false,
    },
    select: { id: true, email: true },
  });
  userIds.push(user.id);
  return user;
}

let merchantId = '';
let ownerLinkId = '';
let ownerUserId = '';

beforeAll(async () => {
  const admin = await makeUser('ADMIN', 'admin');
  adminUserId = admin.id;
  currentSession = { userId: admin.id, role: 'ADMIN', mustChangePassword: false };

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} merchant`,
      slug: `${PREFIX}-${Date.now()}`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
    },
    select: { id: true },
  });
  merchantId = merchant.id;
  merchantIds.push(merchant.id);

  const owner = await makeUser('MERCHANT', 'owner');
  ownerUserId = owner.id;
  const link = await prisma.merchantUser.create({
    data: { merchantId, userId: owner.id, role: 'OWNER' },
    select: { id: true },
  });
  ownerLinkId = link.id;
});

afterAll(async () => {
  // Audit rows are deliberately not removed. `audit-append-only.test.ts` scans `src/`
  // including tests for anything that deletes an audit row, and it is right to: the rule
  // is that nothing removes one. `AuditLog.actorUserId` is `onDelete: SetNull` so the
  // rows survive their actor, which is the same reason `actorEmail` is denormalised onto
  // them. See `lib/auth/__tests__/impersonation.test.ts` for the fuller note.
  await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe('POST /api/admin/merchants/:id/impersonate', () => {
  it('returns 200 with a Set-Cookie carrying a read-only session', async () => {
    const response = await POST(
      request(merchantId, {
        merchantUserId: ownerLinkId,
        reason: 'Merchant called about a drop that will not publish.',
      }),
      context(merchantId),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      redirectTo: string;
      expiresAt: string;
      auditId: string;
      target: { userEmail: string; merchantId: string };
    };
    expect(body.redirectTo).toBe('/merchant/drops');
    expect(body.target.merchantId).toBe(merchantId);
    expect(body.auditId).toEqual(expect.any(String));

    // --- the cookie ---
    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBeTruthy();
    // HttpOnly is not optional: a readable token is a token any injected script can
    // exfiltrate, and this one carries an admin's borrowed access.
    expect(cookie?.httpOnly).toBe(true);

    // --- what the cookie actually contains ---
    const claims = await verifySession(cookie?.value ?? '');
    expect(claims?.userId).toBe(ownerUserId);
    expect(claims?.role).toBe('MERCHANT');
    expect(claims?.impersonation?.actorUserId).toBe(adminUserId);
    expect(claims?.impersonation?.auditId).toBe(body.auditId);
    // Not the admin's own id: the point of the exchange is that the admin's privileges
    // are no longer in the browser.
    expect(claims?.userId).not.toBe(adminUserId);
  });

  it('caps the cookie at the impersonation window, not the seven-day session', async () => {
    const response = await POST(
      request(merchantId, { merchantUserId: ownerLinkId, reason: 'Checking the window.' }),
      context(merchantId),
    );

    const claims = await verifySession(response.cookies.get(SESSION_COOKIE)?.value ?? '');
    const secondsLeft = (claims?.absoluteExpiresAt ?? 0) - Math.floor(Date.now() / 1000);

    expect(secondsLeft).toBeGreaterThan(IMPERSONATION_MAX_MINUTES * 60 - 10);
    expect(secondsLeft).toBeLessThanOrEqual(IMPERSONATION_MAX_MINUTES * 60);
  });

  it('refuses with 401 when there is no session', async () => {
    const saved = currentSession;
    currentSession = null;

    const response = await POST(
      request(merchantId, { merchantUserId: ownerLinkId, reason: 'No session.' }),
      context(merchantId),
    );
    expect(response.status).toBe(401);
    // No cookie is set on a refusal. A `Set-Cookie` on a 401 would hand the caller a
    // session they did not earn.
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();

    currentSession = saved;
  });

  it('refuses with 403 when the caller is not an admin', async () => {
    const saved = currentSession;
    currentSession = { userId: ownerUserId, role: 'MERCHANT', mustChangePassword: false };

    const response = await POST(
      request(merchantId, { merchantUserId: ownerLinkId, reason: 'Not an admin.' }),
      context(merchantId),
    );
    expect(response.status).toBe(403);

    currentSession = saved;
  });

  it('refuses with 403 while a password change is required', async () => {
    // A temporary password is the same privilege question wherever it is presented.
    const saved = currentSession;
    currentSession = { userId: adminUserId, role: 'ADMIN', mustChangePassword: true };

    const response = await POST(
      request(merchantId, { merchantUserId: ownerLinkId, reason: 'Before changing it.' }),
      context(merchantId),
    );
    expect(response.status).toBe(403);

    currentSession = saved;
  });

  it('refuses with 422 and no audit row when the reason is blank', async () => {
    const before = await prisma.auditLog.count({
      where: { action: 'session.impersonate', targetId: ownerUserId },
    });

    const response = await POST(
      request(merchantId, { merchantUserId: ownerLinkId, reason: '   ' }),
      context(merchantId),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.reason).toBeDefined();

    const after = await prisma.auditLog.count({
      where: { action: 'session.impersonate', targetId: ownerUserId },
    });
    // Validation runs before the service, so a bad body cannot leave a record behind.
    expect(after).toBe(before);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('refuses with 422 when the merchant-user id is not a uuid', async () => {
    const response = await POST(
      request(merchantId, { merchantUserId: 'not-a-uuid', reason: 'A typo.' }),
      context(merchantId),
    );

    expect(response.status).toBe(422);
  });

  it('refuses with 409 when the target belongs to another merchant', async () => {
    const otherMerchant = await prisma.merchant.create({
      data: {
        name: `${PREFIX} other`,
        slug: `${PREFIX}-other-${Date.now()}`,
        status: 'ACTIVE',
        floorPctOfMenu: 0.25,
      },
      select: { id: true },
    });
    merchantIds.push(otherMerchant.id);

    const response = await POST(
      request(merchantId, { merchantUserId: ownerLinkId, reason: 'Stale tab.' }),
      context(otherMerchant.id),
    );

    expect(response.status).toBe(409);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('refuses with 409 when the session is already impersonating', async () => {
    // A hand-rolled request against a token carrying both ADMIN and `imp`. Starting a
    // second impersonation would replace the claim of the first and orphan its audit row.
    const saved = currentSession;
    currentSession = {
      userId: adminUserId,
      role: 'ADMIN',
      mustChangePassword: false,
      impersonation: {
        actorUserId: adminUserId,
        auditId: '99999999-9999-9999-9999-999999999999',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      },
    };

    const response = await POST(
      request(merchantId, { merchantUserId: ownerLinkId, reason: 'A second one.' }),
      context(merchantId),
    );

    expect(response.status).toBe(409);
    currentSession = saved;
  });

  it('writes the actor email and the client address onto the audit row', async () => {
    const response = await POST(
      request(merchantId, { merchantUserId: ownerLinkId, reason: 'Checking the row.' }),
      context(merchantId),
    );
    const body = (await response.json()) as { auditId: string };

    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: body.auditId } });

    expect(row.actorUserId).toBe(adminUserId);
    // From the `User` row, because `SessionClaims` has no email — and denormalised onto
    // the audit row so it survives a rename.
    expect(row.actorEmail).toMatch(new RegExp(`^${PREFIX}-admin-`));
    // The first hop of `x-forwarded-for`, not the whole header.
    expect(row.ipAddress).toBe('203.0.113.9');
  });
});
