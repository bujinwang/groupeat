import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { primaryMerchantFloor, getFloor, toPct, updateFloor } from '@/lib/db/merchants';
import { DEFAULT_FLOOR_PCT, minViablePrice } from '@/lib/guardrail';
import type { GuardrailInput } from '@/lib/guardrail';

/**
 * The `Decimal` boundary — the single largest technical risk in the sprint
 * (ARCHITECTURE-sprint1 §3.5, and the lead's call-out).
 *
 * `Merchant.floorPctOfMenu` is `@db.Decimal(5,2)`, so Prisma returns a `Decimal`
 * **object**. Fed straight into the guardrail, every `>=` comparison is `false`,
 * `minViablePrice()` returns `null` for every dish, and every item silently
 * renders INFEASIBLE — which looks like a product judgement rather than a bug.
 *
 * These tests pin the two things that prevent it: the conversion is exact, and a
 * floor that went through the database still reproduces vector A.
 */

const SLUG_PREFIX = 'test-decimal-';
let merchantId: string;

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: {
      name: 'Decimal Boundary Test',
      slug: `${SLUG_PREFIX}${Date.now()}`,
      status: 'PENDING',
      floorPctOfMenu: DEFAULT_FLOOR_PCT,
    },
    select: { id: true },
  });
  merchantId = merchant.id;
});

afterAll(async () => {
  if (merchantId) {
    await prisma.merchant.delete({ where: { id: merchantId } });
  }
  await prisma.$disconnect();
});

describe('toPct · the Decimal → number boundary', () => {
  it('round-trips 0.25 exactly, with no floating-point drift', async () => {
    await updateFloor(merchantId, 0.25);
    const floor = await getFloor(merchantId);

    // Strict equality: 0.25000000000000006 would fail here, and that is the point.
    expect(floor).toBe(0.25);
    expect(Object.is(floor, 0.25)).toBe(true);
    expect(typeof floor).toBe('number');
  });

  it('reads back what the database stores, not what Prisma hands over', async () => {
    const row = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { floorPctOfMenu: true },
    });

    // The raw value is a Decimal object, and comparing it to a number is the bug.
    expect(typeof row.floorPctOfMenu).toBe('object');
    expect(toPct(row.floorPctOfMenu)).toBe(0.25);
  });

  it('accepts every value the column can hold', async () => {
    for (const pct of [0.15, 0.2, 0.25, 0.3, 0.33, 0.5, 1]) {
      await updateFloor(merchantId, pct);
      expect(await getFloor(merchantId)).toBe(pct);
    }
    await updateFloor(merchantId, 0.25);
  });

  it('rejects a value outside (0, 1] loudly rather than silently', () => {
    expect(() => toPct(0)).toThrow();
    expect(() => toPct(1.5)).toThrow();
    expect(() => toPct(-0.25)).toThrow();
    expect(() => toPct(Number.NaN)).toThrow();
  });

  it('refuses to write an out-of-range floor', async () => {
    await expect(updateFloor(merchantId, 0)).rejects.toThrow();
    await expect(updateFloor(merchantId, 1.2)).rejects.toThrow();
  });
});

describe('the floor that came out of the database still produces vector A', () => {
  it('minViablePrice === 1112 for a $16.00 / $4.80 / $0.80 dish at 25%', async () => {
    await updateFloor(merchantId, 0.25);
    const floorPctOfMenu = await getFloor(merchantId);

    const input: GuardrailInput = {
      platformFeePct: 0.08,
      platformFeeFloorCents: 60,
      platformFeeCapCents: 200,
      stripePct: 0.029,
      stripeFixedCents: 30,
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      floorPctOfMenu,
    };

    expect(minViablePrice(input)).toBe(1112);
  });

  it('primaryMerchantFloor returns a number, not a Decimal', async () => {
    const result = await primaryMerchantFloor([merchantId]);

    expect(result.merchantId).toBe(merchantId);
    expect(typeof result.floorPctOfMenu).toBe('number');
    expect(result.floorPctOfMenu).toBe(0.25);
  });
});
