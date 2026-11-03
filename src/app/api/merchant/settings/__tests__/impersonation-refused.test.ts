import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { newImpersonationSession } from '@/lib/auth/jwt';

import { PATCH } from '../route';

/**
 * FR-904 — a borrowed session is refused by a real merchant route, not just by a grep.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## Why one route, when `impersonation-readonly.test.ts` walks all of them
 *
 * The scan proves the gate is *called*. This proves the gate *works* — that the call
 * reaches `refuseIfImpersonating`, that the refusal is a 403 with the sentence a human
 * needs, and that nothing was written on the way to the refusal. A gate that is present
 * and inert is the failure mode a scan cannot see, because `requireMerchantWrite()` is a
 * single identifier and there is exactly one way to spell it.
 *
 * `settings` is the route chosen because it is the most consequential one currently
 * reachable: it moves the merchant's minimum margin, which is the number the whole
 * guardrail is built on. If one route had to be verified end to end, it is this one.
 *
 * ## Why the real `authorize.ts` is used
 *
 * The point is to exercise `refuseIfImpersonating`, so mocking the module would mock the
 * thing under test. Only `getSession` is replaced — which is the seam that already exists
 * in `session.ts` — and the rest of the chain (`requireSession` → `requireMerchantScope` →
 * `requireMerchant` → `refuseIfImpersonating`) runs for real against real rows.
 */

vi.mock('server-only', () => ({}));

let currentSession: {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword: boolean;
  absoluteExpiresAt: number;
  expiresAt: number;
  impersonation?: { actorUserId: string; auditId: string; expiresAt: number };
} | null = null;

/**
 * `getSession` is the only replacement.
 *
 * `authorize.ts` imports it from `./session`, so mocking the module it comes from
 * intercepts the call without touching any of the rules.
 */
vi.mock('@/lib/auth/session', async () => {
  const jwt = await import('@/lib/auth/jwt');
  return {
    getSession: async () => currentSession,
    // Re-exported because `authorize.ts` also uses `roleHome` reachability and the
    // barrel semantics must not change under it.
    roleHome: jwt.roleHome,
    newSession: jwt.newSession,
  };
});

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `imprw${Date.now().toString(36).slice(-5)}`;
const merchantIds: string[] = [];
const userIds: string[] = [];

let merchantId = '';
let ownerUserId = '';
let adminUserId = '';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/merchant/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const admin = await prisma.user.create({
    data: {
      email: `${PREFIX}-admin@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ADMIN',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  adminUserId = admin.id;
  userIds.push(admin.id);

  const owner = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  ownerUserId = owner.id;
  userIds.push(owner.id);

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} merchant`,
      slug: `${PREFIX}-${Date.now()}`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.3,
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantId = merchant.id;
  merchantIds.push(merchant.id);
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe('FR-904 · PATCH /api/merchant/settings under a borrowed session', () => {
  it('refuses with 403 and changes nothing', async () => {
    currentSession = newImpersonationSession({
      merchantUserId: ownerUserId,
      actorUserId: adminUserId,
      auditId: '44444444-4444-4444-4444-444444444444',
    });

    const before = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { floorPctOfMenu: true },
    });

    const response = await PATCH(request({ floorPctOfMenu: 0.1, acknowledgedConsequence: true }));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { message: string };
    // The sentence names the situation and what to do about it. A bare 403 would leave
    // the admin retrying, because the UI still shows the form.
    expect(body.message).toMatch(/viewing this account as an admin/i);
    expect(body.message).toMatch(/end the session/i);

    const after = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { floorPctOfMenu: true },
    });
    // The number the whole guardrail rests on did not move.
    expect(after.floorPctOfMenu.toString()).toBe(before.floorPctOfMenu.toString());
  });

  it('allows the same request for an ordinary merchant session', async () => {
    // The control. Without it, a route that refused *everything* would pass the test
    // above — and the product would be broken in a way the impersonation suite could
    // not see.
    currentSession = {
      userId: ownerUserId,
      role: 'MERCHANT',
      mustChangePassword: false,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const response = await PATCH(request({ floorPctOfMenu: 0.35, acknowledgedConsequence: true }));

    expect(response.status).toBe(200);

    const after = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { floorPctOfMenu: true },
    });
    expect(after.floorPctOfMenu.toString()).toBe('0.35');
  });

  it('refuses before the body is parsed, not after', async () => {
    // A borrowed session sending a *malformed* body must still get 403, not 422. If the
    // validation ran first, the status would tell the admin their input was the problem
    // when the actual problem is that they are not allowed to send one at all.
    currentSession = newImpersonationSession({
      merchantUserId: ownerUserId,
      actorUserId: adminUserId,
      auditId: '55555555-5555-5555-5555-555555555555',
    });

    const response = await PATCH(request({ floorPctOfMenu: 'not a number' }));

    expect(response.status).toBe(403);
  });
});
