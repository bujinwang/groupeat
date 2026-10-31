import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isAppError } from '@/lib/errors';
import { prisma } from '@/lib/db/prisma';
import {
  createItem,
  findItem,
  getItem,
  highestMenuPriceCents,
  listItems,
  updateItem,
} from '@/lib/db/items';
import type { ItemInput } from '@/lib/db/items';

/**
 * US-M1 — merchant scoping.
 *
 * The rule: every merchant-scoped query filters by the `merchantId` values
 * reachable from the caller's `MerchantUser` rows, and a foreign id is a **404**,
 * never a 403. A merchant must not be able to learn that another merchant's dish
 * exists, so the two cases have to be indistinguishable from outside.
 *
 * Runs against the database in `DATABASE_URL` (ARCHITECTURE-sprint1 §7.7 permits
 * exactly one such file). It creates its own two merchants and removes them.
 */

const PREFIX = `scope-test-${Date.now()}`;

type Fixture = { merchantId: string; userId: string; itemId: string };
const fixtures: Fixture[] = [];

const ITEM: ItemInput = {
  name: 'Scope Test Bowl',
  description: null,
  menuPriceCents: 1600,
  foodCostCents: 480,
  packagingCents: 80,
  batchYield: 30,
  prepMinutes: 6,
  isBatchable: true,
  containsAlcohol: false,
  category: 'Bowls',
};

async function createMerchantWithItem(suffix: string, menuPriceCents: number): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${suffix}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: true,
    },
    select: { id: true },
  });

  const merchant = await prisma.merchant.create({
    data: {
      name: `Scope Test ${suffix}`,
      slug: `${PREFIX}-${suffix}`,
      status: 'PENDING',
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });

  const item = await createItem([merchant.id], { ...ITEM, menuPriceCents });

  fixtures.push({ merchantId: merchant.id, userId: user.id, itemId: item.id });
  return { merchantId: merchant.id, userId: user.id, itemId: item.id };
}

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  a = await createMerchantWithItem('a', 1600);
  b = await createMerchantWithItem('b', 900);
});

afterAll(async () => {
  for (const fixture of fixtures) {
    await prisma.merchant.delete({ where: { id: fixture.merchantId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: fixture.userId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('US-M1 · a foreign id is a 404, never a 403', () => {
  it("returns merchant A's own item", async () => {
    const item = await getItem([a.merchantId], a.itemId);
    expect(item.id).toBe(a.itemId);
  });

  it("throws a 404 for merchant B's item when the scope is A", async () => {
    let caught: unknown;
    try {
      await getItem([a.merchantId], b.itemId);
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      expect(caught.status).toBe(404);
      // The message must not distinguish "exists but not yours" from "no such id".
      expect(caught.publicMessage).toBe('That dish could not be found.');
    }
  });

  it('returns null (not an error) for the page-level lookup', async () => {
    expect(await findItem([a.merchantId], b.itemId)).toBeNull();
    expect(await findItem([], a.itemId)).toBeNull();
  });

  it('refuses to write to a foreign item', async () => {
    await expect(
      updateItem([a.merchantId], b.itemId, { ...ITEM, name: 'Hijacked' }),
    ).rejects.toThrow();

    // And nothing changed.
    const untouched = await prisma.menuItem.findUniqueOrThrow({
      where: { id: b.itemId },
      select: { name: true },
    });
    expect(untouched.name).toBe(ITEM.name);
  });

  it('scopes the list to the caller', async () => {
    const items = await listItems([a.merchantId]);
    expect(items.map((item) => item.id)).toEqual([a.itemId]);

    expect(await listItems([])).toEqual([]);
  });
});

describe('US-M1 · the scope drives the queries, not the URL', () => {
  it('an empty scope sees nothing at all', async () => {
    expect(await listItems([])).toEqual([]);
    expect(await highestMenuPriceCents([])).toBeNull();
  });

  it('highestMenuPriceCents is the maximum within the scope', async () => {
    expect(await highestMenuPriceCents([a.merchantId])).toBe(1600);
    expect(await highestMenuPriceCents([b.merchantId])).toBe(900);
    expect(await highestMenuPriceCents([a.merchantId, b.merchantId])).toBe(1600);
  });

  it('createItem writes into the scope it was given', async () => {
    const created = await createItem([b.merchantId], { ...ITEM, name: 'Second B dish' });
    expect(created.merchantId).toBe(b.merchantId);
    await prisma.menuItem.delete({ where: { id: created.id } });
  });
});
