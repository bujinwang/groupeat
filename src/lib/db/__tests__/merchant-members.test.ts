import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addMerchantMember, listMerchantMembers } from '@/lib/db/merchants';
import { prisma } from '@/lib/db/prisma';

/**
 * Attaching an existing MERCHANT account to a merchant.
 *
 * The two refusals are the product decisions: an account that is not a MERCHANT must
 * not gain a merchant surface, and a second attach must say "already a member" rather
 * than throw a unique-constraint error.
 */
const PREFIX = `mmem${Date.now().toString(36).slice(-6)}`;
let merchantId = '';
const userIds: string[] = [];

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: { name: `${PREFIX} Co`, slug: `${PREFIX}-co`, status: 'ACTIVE' },
    select: { id: true },
  });
  merchantId = merchant.id;
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

async function makeUser(tag: string, role: 'MERCHANT' | 'ADMIN' | 'ORGANISER'): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}@example.test`,
      passwordHash: 'not-a-real-hash',
      role,
      ...(role === 'ORGANISER'
        ? { organiser: { create: { displayName: 'Sam' } } }
        : {}),
    },
    select: { id: true },
  });
  userIds.push(user.id);
  return user.id;
}

describe('addMerchantMember', () => {
  it('adds a MERCHANT account with the requested role and lists it', async () => {
    await makeUser('staff', 'MERCHANT');
    const result = await addMerchantMember({
      merchantId,
      email: `${PREFIX}-staff@example.test`.toUpperCase(),
      role: 'STAFF',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the member to be added');

    const members = await listMerchantMembers(merchantId);
    expect(members).toEqual([
      expect.objectContaining({ email: `${PREFIX}-staff@example.test`, role: 'STAFF' }),
    ]);
  });

  it('refuses a second attach with a sentence the admin can act on', async () => {
    const result = await addMerchantMember({
      merchantId,
      email: `${PREFIX}-staff@example.test`,
      role: 'MANAGER',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_MEMBER' });
  });

  it('refuses an account whose role is not MERCHANT', async () => {
    await makeUser('admin', 'ADMIN');
    const result = await addMerchantMember({
      merchantId,
      email: `${PREFIX}-admin@example.test`,
      role: 'STAFF',
    });

    expect(result).toEqual({ ok: false, reason: 'NO_MERCHANT_ACCOUNT' });
  });

  it('refuses an email that does not exist', async () => {
    const result = await addMerchantMember({
      merchantId,
      email: `${PREFIX}-nobody@example.test`,
      role: 'STAFF',
    });
    expect(result).toEqual({ ok: false, reason: 'NO_MERCHANT_ACCOUNT' });
  });
});
