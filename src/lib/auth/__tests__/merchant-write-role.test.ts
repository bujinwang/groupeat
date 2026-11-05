import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const sessionState = vi.hoisted(() => ({
  session: null as { userId: string; role: string; mustChangePassword: boolean } | null,
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => sessionState.session,
}));

import { requireMerchantWrite } from '@/lib/auth/authorize';
import { prisma } from '@/lib/db/prisma';

/**
 * PRD-v1 §3.1: staff scan and redeem; they do not edit the merchant's drops, dishes,
 * pickup details or settings.
 *
 * The role is on `MerchantUser`, not the session, so this suite is the only place the
 * write gate can be checked against real membership rows. The redemption exception is
 * explicit, and a STAFF account still gets the merchant read scope.
 */

const PREFIX = `mwr${Date.now().toString(36).slice(-6)}`;
let merchantId = '';
let staffId = '';
let ownerId = '';
const userIds: string[] = [];

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: { name: `${PREFIX} Co`, slug: `${PREFIX}-co`, status: 'ACTIVE' },
    select: { id: true },
  });
  merchantId = merchant.id;

  for (const [tag, role] of [
    ['staff', 'STAFF'],
    ['owner', 'OWNER'],
  ] as const) {
    const user = await prisma.user.create({
      data: {
        email: `${PREFIX}-${tag}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
      },
      select: { id: true },
    });
    userIds.push(user.id);
    await prisma.merchantUser.create({ data: { merchantId, userId: user.id, role } });
    if (role === 'STAFF') staffId = user.id;
    if (role === 'OWNER') ownerId = user.id;
  }
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('requireMerchantWrite — staff', () => {
  it('refuses a STAFF account for an ordinary write', async () => {
    sessionState.session = { userId: staffId, role: 'MERCHANT', mustChangePassword: false };

    await expect(requireMerchantWrite()).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Staff accounts can scan and redeem'),
    });
  });

  it('allows the redemption route, which opts in explicitly', async () => {
    sessionState.session = { userId: staffId, role: 'MERCHANT', mustChangePassword: false };

    const scope = await requireMerchantWrite({ allowStaff: true });
    expect(scope.merchantIds).toEqual([merchantId]);
  });

  it('does not restrict an OWNER', async () => {
    sessionState.session = { userId: ownerId, role: 'MERCHANT', mustChangePassword: false };

    const scope = await requireMerchantWrite();
    expect(scope.merchantIds).toEqual([merchantId]);
  });
});
