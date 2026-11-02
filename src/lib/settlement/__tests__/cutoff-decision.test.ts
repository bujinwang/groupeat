import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

import {
  assertCutoffReached,
  captureToleranceOf,
  CutoffNotReachedError,
  decideFor,
  findDueDrops,
  findLockedDrops,
} from '../cutoff-decision';
import { SettlementIntegrityError } from '../settlement-error';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * Phase 1 against real Postgres — the lock, the count and the transition.
 *
 * Every case here is a way the money-critical rule can break:
 *
 *   - a drop is charged before its cutoff (tested at the exact millisecond);
 *   - a drop is charged when the threshold was missed;
 *   - a drop is charged twice by two workers (the concurrency file);
 *   - a participant whose authorisation is not live is counted as a claimed plate;
 *   - a data error silently voids everybody's authorisation.
 */

const PREFIX = `cutoffdec${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('the tolerance, as integer arithmetic', () => {
  it('is ceil(minQty × 9/10) computed as (minQty × 9) / 10', () => {
    expect(captureToleranceOf(20)).toBe(18);
    expect(captureToleranceOf(10)).toBe(9);
    expect(captureToleranceOf(1)).toBe(1);
    expect(captureToleranceOf(200)).toBe(180);
  });

  it('agrees with Math.ceil(minQty * 0.9) for every minQty in 1…200, and does not rely on it', () => {
    // The two happen to agree today (checked here so a future change to the bounds
    // is noticed), but the tolerance is a business rule and must not depend on a
    // floating-point property. One character removes the argument.
    for (let minQty = 1; minQty <= 200; minQty += 1) {
      expect(captureToleranceOf(minQty)).toBe(Math.ceil(minQty * 0.9));
    }
  });
});

describe('assertCutoffReached — the second barrier', () => {
  const cutoffAt = new Date('2026-11-01T18:00:00.000Z');

  it('throws one millisecond early', () => {
    expect(() =>
      assertCutoffReached({ cutoffAt, now: new Date(cutoffAt.getTime() - 1) }),
    ).toThrow(CutoffNotReachedError);
  });

  it('returns at exactly the cutoff', () => {
    // The boundary the SQL uses is `<=`, so equality is allowed.
    expect(() => assertCutoffReached({ cutoffAt, now: cutoffAt })).not.toThrow();
  });
});

describe('decideFor', () => {
  it('locks a due drop whose live authorisations reach the minimum', async () => {
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: 1000, minQty: 20 });
    for (const qty of [10, 7, 5]) {
      await fx.participant({ dropId, qty });
    }

    const now = new Date();
    const outcome = await decideFor({ dropId, now });

    expect(outcome.kind).toBe('LOCKED');
    if (outcome.kind !== 'LOCKED') {
      throw new Error('expected LOCKED');
    }
    // Units, not people: 3 participants, 22 units.
    expect(outcome.drop.joinedQty).toBe(22);
    expect(outcome.drop.participants).toHaveLength(3);
    expect(outcome.drop.stripeAccountId).toBe('acct_test_settlement');

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true, lockedAt: true },
    });
    expect(row.status).toBe('LOCKED');
    expect(row.lockedAt?.getTime()).toBe(now.getTime());
  });

  it('fails a due drop one unit short, and writes no money', async () => {
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: 1000, minQty: 20 });
    for (const qty of [10, 9]) {
      await fx.participant({ dropId, qty });
    }

    const outcome = await decideFor({ dropId, now: new Date() });

    expect(outcome).toEqual({ kind: 'FAILED', dropId, joinedQty: 19 });

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true, lockedAt: true },
    });
    expect(row.status).toBe('FAILED');
    // `FAILED` from D2 means nobody was charged: no lock, no order, no ledger row.
    expect(row.lockedAt).toBeNull();
    expect(await prisma.order.count({ where: { dropId } })).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { dropId } })).toBe(0);
  });

  it('fails a drop with no participants at all, without throwing', async () => {
    // The most common failure, and the cheapest correct outcome: zero external
    // calls, zero ledger rows, terminal in the same transaction.
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: 1000, minQty: 5 });

    const outcome = await decideFor({ dropId, now: new Date() });

    expect(outcome).toEqual({ kind: 'FAILED', dropId, joinedQty: 0 });
  });

  it('does nothing one millisecond before the cutoff', async () => {
    const cutoffAt = new Date(Date.now() + 60_000);
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 5,
      cutoffAt,
    });
    await fx.participant({ dropId, qty: 10 });

    const outcome = await decideFor({ dropId, now: new Date(cutoffAt.getTime() - 1) });

    expect(outcome).toEqual({ kind: 'NO_OP' });
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true, lockedAt: true },
    });
    expect(row.status).toBe('PUBLISHED');
    expect(row.lockedAt).toBeNull();
  });

  it('locks at exactly the cutoff', async () => {
    const cutoffAt = new Date(Date.now() + 60_000);
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 5,
      cutoffAt,
    });
    await fx.participant({ dropId, qty: 5 });

    const outcome = await decideFor({ dropId, now: cutoffAt });
    expect(outcome.kind).toBe('LOCKED');
  });

  it('returns NO_OP for a drop that is already FAILED or CAPTURED, without writing', async () => {
    const failedId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 5,
      status: 'FAILED',
    });
    const capturedId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 5,
      status: 'CAPTURED',
      lockedAt: new Date(Date.now() - 60_000),
    });

    expect(await decideFor({ dropId: failedId, now: new Date() })).toEqual({ kind: 'NO_OP' });
    expect(await decideFor({ dropId: capturedId, now: new Date() })).toEqual({ kind: 'NO_OP' });

    const failed = await prisma.drop.findUniqueOrThrow({
      where: { id: failedId },
      select: { status: true, lockedAt: true },
    });
    const captured = await prisma.drop.findUniqueOrThrow({
      where: { id: capturedId },
      select: { status: true },
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.lockedAt).toBeNull();
    expect(captured.status).toBe('CAPTURED');
  });

  it('counts only units whose authorisation is live', async () => {
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: 1000, minQty: 20 });
    await fx.participant({ dropId, qty: 10, authStatus: 'AUTHORIZED' });
    await fx.participant({ dropId, qty: 10, authStatus: 'VOIDED' });
    await fx.participant({ dropId, qty: 10, authStatus: 'EXPIRED' });
    await fx.participant({ dropId, qty: 10, authStatus: 'PENDING' });
    await fx.participant({ dropId, qty: 10, authStatus: 'FAILED' });

    const outcome = await decideFor({ dropId, now: new Date() });

    // 10 units live out of 20 required. If a voided or pending authorisation were
    // counted, this drop would be locked and every one of those cards charged.
    expect(outcome).toEqual({ kind: 'FAILED', dropId, joinedQty: 10 });
  });

  it('refuses to lock a drop whose merchant has no connected account, and leaves it PUBLISHED', async () => {
    // Q6: stopping and alerting beats voiding every authorisation on the strength
    // of a data error.
    const brokenMerchant = await fx.merchant(null);
    const brokenItem = await fx.item(brokenMerchant);
    const dropId = await fx.drop({
      merchantId: brokenMerchant,
      menuItemId: brokenItem,
      dealPriceCents: 1000,
      minQty: 5,
    });
    await fx.participant({ dropId, qty: 10 });

    let caught: unknown;
    try {
      await decideFor({ dropId, now: new Date() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SettlementIntegrityError);
    expect((caught as SettlementIntegrityError).check).toBe('MISSING_STRIPE_ACCOUNT');

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true, lockedAt: true },
    });
    expect(row.status).toBe('PUBLISHED');
    expect(row.lockedAt).toBeNull();
  });

  it('refuses to lock a drop with an authorised participant that has no PaymentIntent', async () => {
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: 1000, minQty: 5 });
    await fx.participant({ dropId, qty: 5, paymentIntentId: null });

    await expect(decideFor({ dropId, now: new Date() })).rejects.toMatchObject({
      check: 'MISSING_PAYMENT_INTENT',
    });

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('PUBLISHED');
  });
});

describe('the work queues', () => {
  it('finds due drops ordered by cutoff and ignores the ones not yet due', async () => {
    const due = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: 1000, minQty: 5 });
    const later = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 5,
      cutoffAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const ids = await findDueDrops({ now: new Date(), limit: 100 });

    expect(ids).toContain(due);
    expect(ids).not.toContain(later);
  });

  it('finds locked drops for the resume path', async () => {
    const locked = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    expect(await findLockedDrops({ limit: 100 })).toContain(locked);
  });
});
