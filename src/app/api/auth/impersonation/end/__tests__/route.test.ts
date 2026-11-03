import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { SESSION_COOKIE, newImpersonationSession, signSession, verifySession } from '@/lib/auth/jwt';

import { POST } from '../route';

/**
 * `POST /api/auth/impersonation/end` — FR-904's way out.
 *
 * ## The failure this file mostly exists for
 *
 * An impersonation **replaces** the admin's cookie with a `MERCHANT` one. If the exit
 * route lived under `/api/admin`, `middleware.ts` would gate it on being an `ADMIN` — and
 * the admin would be locked inside the borrowed session, redirected to `/merchant/drops`
 * every time they tried to leave, until the token expired on its own. That is not a
 * hypothetical: it is the obvious placement, and it is wrong.
 *
 * So there are two things to prove here. That the exit works (the cookie comes back as an
 * admin's own, with no claim), and that it is authorised by the **signed claim** rather
 * than by a role — because a `MERCHANT` session is the only kind that can reach it.
 *
 * ## Why the session is injected through the cookie rather than mocked
 *
 * The route reads `getSession()`, which reads `cookies()` from `next/headers`. Mocking
 * that accessor would mean the real `verifySession` never runs, and the interesting
 * question — is a *forged* claim enough to get an admin session back? — would go
 * unasked. Instead the tests sign real tokens and stub `next/headers`, so a token with a
 * bad signature is refused by the same code production uses.
 */

vi.mock('server-only', () => ({}));

let cookieJar: string | null = null;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && cookieJar ? { name, value: cookieJar } : undefined,
    set: () => undefined,
  }),
}));

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `impe${Date.now().toString(36).slice(-5)}`;
const merchantIds: string[] = [];
const userIds: string[] = [];

let adminId = '';
let adminEmail = '';
let ownerUserId = '';
let merchantId = '';

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

/** A real borrowed token, signed with the real secret. */
async function borrowedToken(auditId = '55555555-5555-5555-5555-555555555555') {
  const claims = newImpersonationSession({
    merchantUserId: ownerUserId,
    actorUserId: adminId,
    auditId,
  });
  return signSession(claims);
}

function request(): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/impersonation/end', {
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' },
  });
}

beforeAll(async () => {
  const admin = await makeUser('ADMIN', 'admin');
  adminId = admin.id;
  adminEmail = admin.email;

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
  await prisma.merchantUser.create({
    data: { merchantId, userId: owner.id, role: 'OWNER' },
  });
});

afterAll(async () => {
  // Audit rows are deliberately not removed — see the note in
  // `lib/auth/__tests__/impersonation.test.ts`. `audit-append-only.test.ts` scans tests
  // too, and it is right to.
  await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe('POST /api/auth/impersonation/end', () => {
  it('restores the admin session and records the end', async () => {
    const startAuditId = '66666666-6666-6666-6666-666666666666';
    cookieJar = await borrowedToken(startAuditId);

    const response = await POST(request());

    expect(response.status).toBe(200);

    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);

    const claims = await verifySession(cookie?.value ?? '');
    expect(claims?.userId).toBe(adminId);
    expect(claims?.role).toBe('ADMIN');
    // The banner must go away: a restored session with a stray claim would render
    // "viewing X as an admin" on the admin's own account for the rest of the shift.
    expect(claims && 'impersonation' in claims).toBe(false);
    // A full session, not another thirty minutes.
    const daysLeft = ((claims?.absoluteExpiresAt ?? 0) - Math.floor(Date.now() / 1000)) / 86_400;
    expect(daysLeft).toBeGreaterThan(6);

    // The two halves of the record, one hop apart.
    const endRow = await prisma.auditLog.findFirst({
      where: { action: 'session.impersonate', targetId: ownerUserId, detail: { path: ['stage'], equals: 'ENDED' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(endRow?.detail).toMatchObject({ stage: 'ENDED', startAuditId });
    expect(endRow?.actorUserId).toBe(adminId);
    // The client address, first hop only — the second is the proxy.
    expect(endRow?.ipAddress).toBe('198.51.100.4');
  });

  it('refuses with 409 when the session is not impersonating', async () => {
    // An ordinary merchant session. The route is reachable by any role, so the refusal
    // has to come from the claim, and it does.
    cookieJar = await signSession({
      userId: ownerUserId,
      role: 'MERCHANT',
      mustChangePassword: false,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    // No cookie is issued. A refusal that handed back a session would be a privilege
    // escalation with a 409 attached.
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('refuses with 401 and clears the cookie when there is no session', async () => {
    cookieJar = null;

    const response = await POST(request());

    expect(response.status).toBe(401);
    const cleared = response.cookies.get(SESSION_COOKIE);
    expect(cleared?.value).toBe('');
    expect(cleared?.maxAge).toBe(0);
  });

  it('refuses a forged claim, because the signature is what authorises it', async () => {
    // The exit route's whole authorisation is "the claim says you are an admin". A token
    // signed with another secret must therefore be worthless here — this is the test that
    // distinguishes "reads a claim" from "trusts a claim".
    cookieJar = await signSession({
      userId: ownerUserId,
      role: 'MERCHANT',
      mustChangePassword: false,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }).then((token) => `${token.slice(0, -6)}AAAAAA`);

    const response = await POST(request());

    // A tampered token does not verify, so `getSession()` returns null: 401, cookie
    // cleared, nobody signed in. Not a 200 with an admin session.
    expect(response.status).toBe(401);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe('');
  });

  it('refuses with 401 and clears the cookie when the admin has been demoted', async () => {
    // The claim is signed but it can be stale. `endImpersonation` reads the *current*
    // row, so a demotion is honoured on the way out instead of being carried back in.
    const demoted = await makeUser('ADMIN', 'demoted');
    cookieJar = await signSession(
      newImpersonationSession({
        merchantUserId: ownerUserId,
        actorUserId: demoted.id,
        auditId: '77777777-7777-7777-7777-777777777777',
      }),
    );

    await prisma.user.update({ where: { id: demoted.id }, data: { role: 'ORGANISER' } });

    const response = await POST(request());

    expect(response.status).toBe(401);
    // Cleared, not left in place: an impersonation session whose owner no longer exists
    // must not stay in the browser with no way out.
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe('');

    await prisma.user.update({ where: { id: demoted.id }, data: { role: 'ADMIN' } });
  });

  it('does not name the admin email in the response body', async () => {
    // The audit row carries it; the response does not need to, and a body is easier to
    // leak into a client log than a database row.
    cookieJar = await borrowedToken('88888888-8888-8888-8888-888888888888');

    const response = await POST(request());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(adminEmail);
  });
});
