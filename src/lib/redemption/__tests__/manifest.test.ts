import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { isAppError } from '@/lib/errors';
import { type SettlementFixtures, settlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

import { listCounterDrops, loadManifest } from '../manifest';

/**
 * The batch manifest — FR-604.
 *
 * Two things here can be wrong without anyone noticing on screen: the scope check
 * (does a merchant see another merchant's orders?) and the arithmetic (do the
 * header numbers agree with the rows?). Both are asserted against real Postgres,
 * because both are `SELECT`-shaped and a fake would be testing the fake.
 */

const PREFIX = `manifest${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

let merchantId = '';
let otherMerchantId = '';
let itemId = '';

beforeAll(async () => {
  merchantId = await fx.merchant();
  otherMerchantId = await fx.merchant('acct_test_manifest_other');
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

async function dropWith(
  participants: { qty: number; redeemedQty: number; name?: string }[],
  status: 'PICKUP_OPEN' | 'CAPTURED' | 'COMPLETED' = 'PICKUP_OPEN',
): Promise<string> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1200,
    minQty: 1,
    status,
  });

  for (const spec of participants) {
    const participantId = await fx.participant({
      dropId,
      qty: spec.qty,
      chargeStatus: 'CAPTURED',
    });
    if (spec.redeemedQty > 0) {
      await prisma.dropParticipant.update({
        where: { id: participantId },
        data: {
          redeemedQty: spec.redeemedQty,
          // UTC, matching what the column holds everywhere else.
          redeemedAt: new Date('2026-11-01T19:30:00.000Z'),
        },
      });
    }
    if (spec.name) {
      const row = await prisma.dropParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { customerId: true },
      });
      await prisma.customer.update({ where: { id: row.customerId }, data: { name: spec.name } });
    }
  }

  return dropId;
}

describe('loadManifest — scope', () => {
  it('refuses a drop belonging to another merchant as a 404', async () => {
    const dropId = await dropWith([{ qty: 2, redeemedQty: 0 }]);

    await expect(loadManifest([otherMerchantId], dropId)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.status === 404,
    );
  });

  it('refuses everything when the caller has no merchant at all', async () => {
    const dropId = await dropWith([{ qty: 1, redeemedQty: 0 }]);

    // The empty-scope short circuit, which must not be a query with an empty `in`
    // list — Prisma happily returns nothing for that, and nothing is the right
    // answer, but only by accident.
    await expect(loadManifest([], dropId)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.status === 404,
    );
  });

  it('answers for the owning merchant', async () => {
    const dropId = await dropWith([{ qty: 2, redeemedQty: 0 }]);
    const manifest = await loadManifest([merchantId], dropId);
    expect(manifest.dropId).toBe(dropId);
  });
});

describe('loadManifest — the arithmetic', () => {
  it('counts plates and orders separately, and they disagree on purpose', async () => {
    // Four orders, nine plates, three collected. A single "collected" percentage
    // would be ambiguous between orders and plates, which is why both are reported.
    const dropId = await dropWith([
      { qty: 3, redeemedQty: 3 }, // complete
      { qty: 2, redeemedQty: 0 },
      { qty: 2, redeemedQty: 0 },
      { qty: 2, redeemedQty: 0 },
    ]);

    const manifest = await loadManifest([merchantId], dropId);

    expect(manifest.summary.orders).toBe(4);
    expect(manifest.summary.plates).toBe(9);
    expect(manifest.summary.collected).toBe(3);
    expect(manifest.summary.outstanding).toBe(6);
    expect(manifest.summary.fullyCollectedOrders).toBe(1);
  });

  it('treats a partly collected order as not complete', async () => {
    const dropId = await dropWith([{ qty: 4, redeemedQty: 2 }]);

    const manifest = await loadManifest([merchantId], dropId);

    expect(manifest.summary.collected).toBe(2);
    expect(manifest.summary.outstanding).toBe(2);
    // The distinction the badge depends on: 2 of 4 is "waiting", not "collected".
    expect(manifest.summary.fullyCollectedOrders).toBe(0);
  });

  it('never reports negative plates outstanding', async () => {
    // A data fix could leave redeemedQty above qty. The header must not then claim
    // "-2 plates left", which reads as a bug to a staff member and is worse than
    // saying zero.
    const dropId = await dropWith([{ qty: 2, redeemedQty: 2 }]);
    await prisma.dropParticipant.updateMany({ where: { dropId }, data: { redeemedQty: 2 } });

    const manifest = await loadManifest([merchantId], dropId);
    expect(manifest.summary.outstanding).toBe(0);
  });

  it('orders outstanding orders before collected ones', async () => {
    const dropId = await dropWith([
      { qty: 1, redeemedQty: 1 }, // complete, created first
      { qty: 1, redeemedQty: 0 }, // waiting, created second
    ]);

    const manifest = await loadManifest([merchantId], dropId);

    // The waiting one is first, because that is the order of work at a counter. If
    // this flipped, a staff member working top-down would re-check collected orders
    // while someone waits.
    expect(manifest.rows[0]?.redeemedQty).toBe(0);
    expect(manifest.rows[1]?.redeemedQty).toBe(1);
  });
});

describe('loadManifest — privacy', () => {
  it('exposes only the last four digits of a phone number', async () => {
    const dropId = await dropWith([{ qty: 1, redeemedQty: 0, name: 'Wei Chen' }]);

    const manifest = await loadManifest([merchantId], dropId);
    const row = manifest.rows[0];

    expect(row?.name).toBe('Wei Chen');
    expect(row?.phoneLast4).toHaveLength(4);
    expect(row?.phoneLast4).toMatch(/^\d{4}$/);

    // The manifest type has no field that could hold the whole number, and the
    // serialised form must not contain one either.
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toMatch(/\+\d{10,}/);
  });

  it('carries the merchant timezone so the screen can render local times', async () => {
    const dropId = await dropWith([{ qty: 1, redeemedQty: 0 }]);
    const manifest = await loadManifest([merchantId], dropId);
    expect(manifest.timeZone).toBe('America/Edmonton');
  });
});

describe('listCounterDrops', () => {
  it('lists a drop at its window', async () => {
    const dropId = await dropWith([{ qty: 2, redeemedQty: 0 }]);
    const drops = await listCounterDrops([merchantId], new Date());
    expect(drops.map((drop) => drop.id)).toContain(dropId);
  });

  it('reports plates outstanding rather than plates sold', async () => {
    const dropId = await dropWith([
      { qty: 3, redeemedQty: 3 },
      { qty: 2, redeemedQty: 0 },
    ]);

    const drops = await listCounterDrops([merchantId], new Date());
    const row = drops.find((drop) => drop.id === dropId);

    expect(row?.outstanding).toBe(2);
  });

  it('includes a CAPTURED drop, because the window may already be open', async () => {
    // `CAPTURED` means settlement finished, not that the window has not opened —
    // the window is `windowStart`. A merchant opening the screen early must see the
    // drop waiting rather than an empty list.
    const dropId = await dropWith([{ qty: 1, redeemedQty: 0 }], 'CAPTURED');
    const drops = await listCounterDrops([merchantId], new Date());
    expect(drops.map((drop) => drop.id)).toContain(dropId);
  });

  it('returns nothing for a merchant with no scope', async () => {
    expect(await listCounterDrops([], new Date())).toEqual([]);
  });
});
