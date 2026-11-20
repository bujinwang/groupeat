import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { runL5Reconciliation } from '../l5-run';
import { fakeL5Port } from '../l5-port';

/**
 * The nightly job's selection and failure handling, against real Postgres.
 *
 * L5's arithmetic is tested purely. What can only fail here is the choosing: a refund
 * today on a drop settled last month must enter the run, a drop with no connected
 * account must be reported rather than skipped, and one provider timeout must not stop
 * the other drops.
 */

const PREFIX = `l5${Date.now().toString(36).slice(-6)}`;
const H = 60 * 60 * 1000;
/**
 * A numeric prefix per run, then a counter. The first version used the run prefix and
 * `fixtures.length`; a previous failed run had left a customer with the same phone, and
 * the unique constraint failed in `beforeAll`, which skipped `afterAll` and leaked the
 * merchant and drop as well. A counter plus a run-unique numeric suffix has no
 * collision probability, and the cleanup prefix is the same value.
 */
const PHONE_PREFIX = `+1780${String(Date.now()).slice(-7)}`;
let phoneSeq = 0;

function nextPhone(): string {
  phoneSeq += 1;
  return `${PHONE_PREFIX}${String(phoneSeq).padStart(2, '0')}`;
}

type Fixture = {
  merchantId: string;
  dropId: string;
  chargeId: string;
  netCents: number;
  feeCents: number;
  platformFeeCents: number;
};

const fixtures: Fixture[] = [];

async function makeDrop(args: {
  slug: string;
  stripeAccountId: string | null;
  platformFeeCents?: number;
}): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} ${args.slug}`,
      slug: `${PREFIX}-${args.slug}`,
      status: 'ACTIVE',
      ...(args.stripeAccountId ? { stripeAccountId: args.stripeAccountId } : {}),
    },
    select: { id: true },
  });

  const item = await prisma.menuItem.create({
    data: {
      merchantId: merchant.id,
      name: 'Bowl',
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      batchYield: 20,
    },
    select: { id: true },
  });

  const drop = await prisma.drop.create({
    data: {
      merchantId: merchant.id,
      menuItemId: item.id,
      publicCode: `${PREFIX}${args.slug}`.slice(0, 20).toUpperCase(),
      title: 'L5 drop',
      dealPriceCents: 1112,
      minQty: 1,
      maxQty: 10,
      cutoffAt: new Date(Date.now() - 2 * H),
      windowStart: new Date(Date.now() - H),
      windowEnd: new Date(Date.now() + H),
      status: 'CAPTURED',
      guardrailSnapshot: {},
    },
    select: { id: true },
  });

  const customer = await prisma.customer.create({
    data: { phone: nextPhone() },
    select: { id: true },
  });
  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: drop.id,
      customerId: customer.id,
      qty: 1,
      amountCents: 1112,
      platformFeeCents: args.platformFeeCents ?? 89,
      authStatus: 'AUTHORIZED',
      chargeStatus: 'CAPTURED',
      paymentIntentId: `pi_${PREFIX}_${fixtures.length}`,
    },
    select: { id: true },
  });

  const chargeId = `ch_${PREFIX}_${fixtures.length}`;
  await prisma.order.create({
    data: {
      dropId: drop.id,
      participantId: participant.id,
      qty: 1,
      unitPriceCents: 1112,
      subtotalCents: 1112,
      platformFeeCents: args.platformFeeCents ?? 89,
      stripeChargeId: chargeId,
    },
  });
  await prisma.ledgerEntry.createMany({
    data: [
      { orderId: null, dropId: drop.id, type: 'CHARGE', amountCents: 1112, stripeRef: chargeId },
      { orderId: null, dropId: drop.id, type: 'PLATFORM_FEE', amountCents: args.platformFeeCents ?? 89, stripeRef: chargeId },
    ],
  });

  const fixture = {
    merchantId: merchant.id,
    dropId: drop.id,
    chargeId,
    netCents: 1112 - 62,
    feeCents: -62,
    platformFeeCents: args.platformFeeCents ?? 89,
  };
  fixtures.push(fixture);
  return fixture;
}

beforeAll(async () => {
  await makeDrop({ slug: 'good', stripeAccountId: `acct_${PREFIX}good` });
  await makeDrop({ slug: 'bad', stripeAccountId: `acct_${PREFIX}bad` });
  await makeDrop({ slug: 'orphan', stripeAccountId: null });
});

afterAll(async () => {
  const merchantIds = fixtures.map((fixture) => fixture.merchantId);
  const drops = await prisma.drop.findMany({
    where: { merchantId: { in: merchantIds } },
    select: { id: true },
  });
  await prisma.ledgerEntry.deleteMany({ where: { dropId: { in: drops.map((drop) => drop.id) } } });
  await prisma.drop.deleteMany({ where: { id: { in: drops.map((drop) => drop.id) } } });
  await prisma.menuItem.deleteMany({ where: { merchantId: { in: merchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } });
  await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE_PREFIX } } });
});

describe('runL5Reconciliation', () => {
  it('reconciles a good drop, reports a mismatch, and survives a provider error', async () => {
    // Insertion order is the fixture's order: good, bad, orphan.
    const good = fixtures[0]!;
    const bad = fixtures[1]!;
    const orphan = fixtures[2]!;

    const port = fakeL5Port(async ({ stripeAccountId, chargeIds, refundIds }) => {
      if (stripeAccountId.includes('bad')) throw new Error('socket hang up');
      expect(chargeIds).toHaveLength(1);
      expect(refundIds).toEqual([]);
      return {
        connected: [{ id: 'txn', kind: 'charge', amountCents: 1112, feeCents: -62 }],
        platform: [{ id: 'txn_fee', kind: 'application_fee', amountCents: 89 }],
      };
    });

    const result = await runL5Reconciliation({
      now: new Date(),
      since: new Date(Date.now() - H),
      port,
    });

    expect(result.ok).toBe(false);
    expect(result.dropsChecked).toBe(2);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dropId: bad.dropId, reason: 'PROVIDER_ERROR' }),
        expect.objectContaining({ dropId: orphan.dropId, reason: 'MISSING_STRIPE_ACCOUNT' }),
      ]),
    );
    expect(result.mismatches.some((mismatch) => mismatch.dropId === good.dropId)).toBe(false);
  });
});
