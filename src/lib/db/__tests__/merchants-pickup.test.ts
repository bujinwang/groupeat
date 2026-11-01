import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { getFloor, getMerchant, updateOwnPickup } from '@/lib/db/merchants';
import { DEFAULT_FLOOR_PCT } from '@/lib/guardrail';

/**
 * FR-103 — scoped write for the merchant's own pickup details.
 *
 * Two things are asserted that a route test would not catch cheaply:
 *
 *   1. **A merchant id outside the caller's scope is not written**, and the
 *      function says so (`false`) rather than throwing a Prisma error. The route
 *      turns that `false` into a 404 — never a 403, because a 403 would confirm
 *      that someone else's merchant exists (US-M1).
 *   2. **The floor is never touched.** The whole reason this function exists
 *      next to `updateFloor` is that pickup editing must not be able to move the
 *      number the guardrail is built on.
 */

const SLUG_PREFIX = 'pickup-scope-test-';
let inScopeId: string;
let outOfScopeId: string;

beforeAll(async () => {
  const stamp = Date.now();
  const [a, b] = await Promise.all([
    prisma.merchant.create({
      data: {
        name: 'Pickup In Scope',
        slug: `${SLUG_PREFIX}in-${stamp}`,
        status: 'PENDING',
        floorPctOfMenu: DEFAULT_FLOOR_PCT,
      },
      select: { id: true },
    }),
    prisma.merchant.create({
      data: {
        name: 'Pickup Out Of Scope',
        slug: `${SLUG_PREFIX}out-${stamp}`,
        status: 'PENDING',
        floorPctOfMenu: DEFAULT_FLOOR_PCT,
      },
      select: { id: true },
    }),
  ]);
  inScopeId = a.id;
  outOfScopeId = b.id;
});

afterAll(async () => {
  await prisma.merchant.deleteMany({
    where: { id: { in: [inScopeId, outOfScopeId].filter(Boolean) } },
  });
  await prisma.$disconnect();
});

describe('updateOwnPickup', () => {
  it('writes both fields for a merchant in scope', async () => {
    const wrote = await updateOwnPickup({
      merchantIds: [inScopeId],
      merchantId: inScopeId,
      pickupAddress: '123 10 Ave NE, Calgary',
      pickupInstructions: 'Side door, ring the bell.',
    });

    expect(wrote).toBe(true);

    const merchant = await getMerchant(inScopeId);
    expect(merchant?.pickupAddress).toBe('123 10 Ave NE, Calgary');
    expect(merchant?.pickupInstructions).toBe('Side door, ring the bell.');
  });

  it('clears a field back to null', async () => {
    await updateOwnPickup({
      merchantIds: [inScopeId],
      merchantId: inScopeId,
      pickupAddress: null,
      pickupInstructions: 'Still here.',
    });

    const merchant = await getMerchant(inScopeId);
    expect(merchant?.pickupAddress).toBeNull();
    expect(merchant?.pickupInstructions).toBe('Still here.');
  });

  it('refuses a merchant outside the caller scope, and writes nothing', async () => {
    const wrote = await updateOwnPickup({
      merchantIds: [inScopeId],
      merchantId: outOfScopeId,
      pickupAddress: 'Hijacked address',
      pickupInstructions: 'Hijacked instructions',
    });

    expect(wrote).toBe(false);

    const victim = await getMerchant(outOfScopeId);
    expect(victim?.pickupAddress).toBeNull();
    expect(victim?.pickupInstructions).toBeNull();
  });

  it('refuses when the caller has no merchants at all', async () => {
    const wrote = await updateOwnPickup({
      merchantIds: [],
      merchantId: inScopeId,
      pickupAddress: 'x',
      pickupInstructions: 'y',
    });
    expect(wrote).toBe(false);
  });

  it('never changes the floor, even when a stray floor value rides along', async () => {
    // The floor has its own governed write path. If this function ever gained a
    // floor parameter, a pickup edit could quietly lower a merchant's margin.
    const before = await getFloor(inScopeId);

    await updateOwnPickup({
      merchantIds: [inScopeId],
      merchantId: inScopeId,
      pickupAddress: '42 New Address',
      pickupInstructions: null,
    });

    expect(await getFloor(inScopeId)).toBe(before);
  });

  it('leaves status untouched — a pickup edit is not an activation', async () => {
    const merchant = await getMerchant(inScopeId);
    expect(merchant?.status).toBe('PENDING');
  });
});
