import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDraft, markPublished } from '@/lib/db/drops';
import { createItem } from '@/lib/db/items';
import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, buildGuardrailSnapshot } from '@/lib/guardrail';
import { getPublicDrop } from '../public-drops';

/**
 * The diner's read path, against a real database.
 *
 * Four things here can only be proven with rows in Postgres:
 *
 *   1. **Only live authorisations count.** A `VOIDED` participant is not a claimed
 *      plate, and counting one would show the drop as fuller than it is.
 *   2. **`FAILED` stays visible.** A diner who joined a drop that did not run taps
 *      the same link they joined with. A 404 there reads as "you were charged and
 *      nobody will tell you".
 *   3. **`DRAFT` stays invisible.** A guessed code must not reveal an unpublished
 *      price.
 *   4. **The "was" price is frozen.** It comes from the snapshot, not from the dish
 *      as it is today.
 */

const PREFIX = `public-drops-${Date.now()}`;
const HOUR = 60 * 60 * 1000;

type Fixture = {
  merchantId: string;
  userId: string;
  itemId: string;
  publishedCode: string;
  failedCode: string;
  draftCode: string;
};

const fixtures: Fixture[] = [];
let fixture: Fixture;

function timing(): { cutoffAt: Date; windowStart: Date; windowEnd: Date } {
  const now = Date.now();
  return {
    cutoffAt: new Date(now + 24 * HOUR),
    windowStart: new Date(now + 26 * HOUR),
    windowEnd: new Date(now + 28 * HOUR),
  };
}

async function makeCustomer(suffix: string): Promise<string> {
  const customer = await prisma.customer.create({
    data: { phone: `+1403555${suffix}`, name: `Diner ${suffix}` },
    select: { id: true },
  });
  return customer.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: true,
    },
    select: { id: true },
  });

  const merchant = await prisma.merchant.create({
    data: {
      name: 'Golden Dragon',
      slug: PREFIX,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      pickupAddress: '2915 10 Ave NE, Calgary',
      pickupInstructions: 'Side door, ring the bell.',
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });

  const item = await createItem([merchant.id], {
    name: 'Beef Bowl',
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });

  const guardrailInput = {
    ...DEFAULT_FEES,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    floorPctOfMenu: 0.25,
  };
  const snapshot = buildGuardrailSnapshot(guardrailInput, 1310, new Date().toISOString());

  const published = await createDraft([merchant.id], {
    menuItemId: item.id,
    title: 'Beef Bowl Thursday',
    description: 'One batch.',
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });
  await markPublished({
    id: published.id,
    publishedAt: new Date(),
    guardrailSnapshot: snapshot,
  });

  // Two live authorisations, one voided, one still pending — and one participant
  // taking three plates, so the sum and the row count differ.
  const statuses: { suffix: string; qty: number; authStatus: 'AUTHORIZED' | 'VOIDED' | 'PENDING' }[] = [
    { suffix: '001', qty: 2, authStatus: 'AUTHORIZED' },
    { suffix: '002', qty: 3, authStatus: 'AUTHORIZED' },
    { suffix: '003', qty: 4, authStatus: 'VOIDED' },
    { suffix: '004', qty: 1, authStatus: 'PENDING' },
  ];

  for (const entry of statuses) {
    await prisma.dropParticipant.create({
      data: {
        dropId: published.id,
        customerId: await makeCustomer(entry.suffix),
        qty: entry.qty,
        amountCents: 1310 * entry.qty,
        platformFeeCents: 100,
        authStatus: entry.authStatus,
      },
    });
  }

  const failed = await createDraft([merchant.id], {
    menuItemId: item.id,
    title: 'Beef Bowl that did not run',
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });
  await markPublished({
    id: failed.id,
    publishedAt: new Date(),
    guardrailSnapshot: snapshot,
  });
  await prisma.drop.update({ where: { id: failed.id }, data: { status: 'FAILED' } });

  const draft = await createDraft([merchant.id], {
    menuItemId: item.id,
    title: 'Not published yet',
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });

  fixture = {
    merchantId: merchant.id,
    userId: user.id,
    itemId: item.id,
    publishedCode: published.publicCode,
    failedCode: failed.publicCode,
    draftCode: draft.publicCode,
  };
  fixtures.push(fixture);
});

afterAll(async () => {
  for (const entry of fixtures) {
    await prisma.drop.deleteMany({ where: { merchantId: entry.merchantId } }).catch(() => undefined);
    await prisma.customer.deleteMany({ where: { phone: { startsWith: '+1403555' } } }).catch(() => undefined);
    await prisma.merchant.delete({ where: { id: entry.merchantId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: entry.userId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('getPublicDrop', () => {
  it('counts only the units whose authorisation is live', async () => {
    const drop = await getPublicDrop(fixture.publishedCode);

    expect(drop).not.toBeNull();
    // 2 + 3 authorised. The 4 voided and the 1 pending are not claimed plates.
    expect(drop!.joinedQty).toBe(5);
  });

  it('carries the pickup details a diner needs', async () => {
    const drop = await getPublicDrop(fixture.publishedCode);

    expect(drop!.merchantName).toBe('Golden Dragon');
    expect(drop!.merchantAddress).toContain('10 Ave NE');
    expect(drop!.merchantInstructions).toContain('Side door');
    expect(drop!.itemName).toBe('Beef Bowl');
    expect(drop!.timeZone).toBe('America/Edmonton');
  });

  it('keeps a failed drop reachable, so the page can say nobody was charged', async () => {
    const drop = await getPublicDrop(fixture.failedCode);
    expect(drop).not.toBeNull();
    expect(drop!.status).toBe('FAILED');
  });

  it('hides a draft even from someone holding its code', async () => {
    expect(await getPublicDrop(fixture.draftCode)).toBeNull();
  });

  it('returns null for a code that does not exist', async () => {
    expect(await getPublicDrop('ZZZZZZZZ')).toBeNull();
  });

  it('reports the menu price frozen at publish, not the dish as it is today', async () => {
    // A merchant re-prices the dish after the drop was announced. The "was $16.00"
    // on a public page is a price representation (PRD-v1 §15.2), so it must not
    // move with the dish — FR-207 applied to the diner's screen.
    await prisma.menuItem.update({
      where: { id: fixture.itemId },
      data: { menuPriceCents: 1800 },
    });

    const drop = await getPublicDrop(fixture.publishedCode);
    expect(drop!.menuPriceCents).toBe(1600);

    await prisma.menuItem.update({
      where: { id: fixture.itemId },
      data: { menuPriceCents: 1600 },
    });
  });
});
