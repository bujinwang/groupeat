import 'dotenv/config';

import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { addMerchantMember } from '@/lib/db/merchants';
import { prisma } from '@/lib/db/prisma';

/**
 * P2002 attribution at the merchant-membership insert.
 *
 * `MerchantUser` has `id @id` and `@@unique([merchantId, userId])`. Only the
 * latter means "already a member". The old catch answered `ALREADY_MEMBER` for
 * every `instanceof PrismaClientKnownRequestError` with `code === 'P2002'`, so a
 * collision on `id`, a half-reported compound key, or an untargeted violation
 * all produced a confident sentence about committed data that was not there.
 *
 * The probe keeps the user lookup and every assertion against real Postgres;
 * only the one failing `merchantUser.create` is substituted. That is the same
 * seam used by the redemption and refund attribution gates.
 */
const PREFIX = 'mmp2' + Date.now().toString(36).slice(-7);
let merchantId = '';
const userIds: string[] = [];

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: { name: `${PREFIX} Co`, slug: `${PREFIX}-co`, status: 'ACTIVE' },
    select: { id: true },
  });
  merchantId = merchant.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

async function makeMerchantUser(tag: string): Promise<string> {
  const email = `${PREFIX}-${tag}@example.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: 'not-a-real-hash', role: 'MERCHANT' },
    select: { id: true },
  });
  userIds.push(user.id);
  return email;
}

function knownP2002(target?: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'reproduction',
    ...(target === undefined ? {} : { meta: { target } }),
  });
}

function plainP2002(target: unknown): Error & { code: string; meta?: unknown } {
  const error = new Error('Unique constraint failed') as Error & {
    code: string;
    meta?: unknown;
  };
  error.code = 'P2002';
  error.meta = { target };
  return error;
}

function injectCreateFailure(error: unknown): void {
  vi.spyOn(prisma.merchantUser, 'create').mockRejectedValueOnce(error as never);
}

async function expectNoMembership(email: string): Promise<void> {
  const rows = await prisma.merchantUser.findMany({
    where: { merchantId, user: { email } },
    select: { id: true },
  });
  expect(rows).toEqual([]);
}

describe('addMerchantMember P2002 attribution', () => {
  it('propagates a collision on a different unique constraint instead of claiming an already-member', async () => {
    const email = await makeMerchantUser('foreign');
    const error = knownP2002(['id']);
    injectCreateFailure(error);

    await expect(
      addMerchantMember({ merchantId, email, role: 'STAFF' }),
    ).rejects.toBe(error);
    await expectNoMembership(email);
  });

  it('does not mistake half the membership key for an already-member', async () => {
    const email = await makeMerchantUser('half-key');
    const error = knownP2002(['merchantId']);
    injectCreateFailure(error);

    await expect(
      addMerchantMember({ merchantId, email, role: 'STAFF' }),
    ).rejects.toBe(error);
    await expectNoMembership(email);
  });

  it('does not mistake the other half of the membership key for an already-member', async () => {
    const email = await makeMerchantUser('half-key-user');
    const error = knownP2002(['userId']);
    injectCreateFailure(error);

    await expect(
      addMerchantMember({ merchantId, email, role: 'STAFF' }),
    ).rejects.toBe(error);
    await expectNoMembership(email);
  });

  it('does not claim an already-member when Prisma reports no target', async () => {
    const email = await makeMerchantUser('untargeted');
    const error = knownP2002();
    injectCreateFailure(error);

    await expect(
      addMerchantMember({ merchantId, email, role: 'STAFF' }),
    ).rejects.toBe(error);
    await expectNoMembership(email);
  });

  it('recognises a plain-object P2002 naming both membership fields', async () => {
    const email = await makeMerchantUser('plain-full-key');
    const error = plainP2002(['merchantId', 'userId']);
    injectCreateFailure(error);

    await expect(
      addMerchantMember({ merchantId, email, role: 'STAFF' }),
    ).resolves.toEqual({ ok: false, reason: 'ALREADY_MEMBER' });
    await expectNoMembership(email);
  });

  it('recognises a plain-object string target naming both membership fields', async () => {
    const email = await makeMerchantUser('plain-string-full-key');
    const error = plainP2002('merchantId_userId');
    injectCreateFailure(error);

    await expect(
      addMerchantMember({ merchantId, email, role: 'STAFF' }),
    ).resolves.toEqual({ ok: false, reason: 'ALREADY_MEMBER' });
    await expectNoMembership(email);
  });
});
