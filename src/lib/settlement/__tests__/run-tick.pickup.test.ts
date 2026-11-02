import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { fakeChargePort } from '../fake-charge-port';
import { runCutoffTick } from '../run-tick';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * The pickup phase is *called* by the tick, and in the right order.
 *
 * ## The gap this closes
 *
 * `pickup-window.redeem.test.ts` calls `applyPickupTransition` directly. That proves
 * the write works; it cannot prove anything calls it. The transition could be
 * implemented perfectly and never invoked — which is the same end state as the bug
 * this whole slice fixes, and it is invisible to every unit test.
 *
 * So these tests run the real `runCutoffTick` and read the drop rows afterwards.
 *
 * ## The ordering claim, which is why there are two tests
 *
 * Phase 5 runs **after** phase 4 (settlement). A drop captured by this tick is
 * therefore already `CAPTURED` when the pickup query runs, so a drop whose window
 * opened while the tick was settling transitions in the **same** tick. Reversing the
 * phases would add up to a full tick of delay between "your card was charged" and
 * "you can collect" — the exact interval a diner spends standing at a counter.
 *
 * The second test is the one that proves the order: it needs a single invocation to
 * both settle and open.
 */

const PREFIX = `pktick${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));
const MINUTE = 60 * 1000;

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant('acct_test_pickup_tick');
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

async function statusOf(dropId: string) {
  return prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: { status: true, completedAt: true, windowStart: true, windowEnd: true },
  });
}

describe('the tick moves the pickup clock', () => {
  it('opens a CAPTURED drop whose window has begun', async () => {
    // `CAPTURED` and inside the window: the state every successful drop used to be
    // stranded in. No settlement work is due here (the cutoff is well past and the
    // drop is not `LOCKED`), so this isolates the pickup phase.
    const now = Date.now();
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'CAPTURED',
      cutoffAt: new Date(now - 4 * 60 * MINUTE),
      windowStart: new Date(now - 30 * MINUTE),
      windowEnd: new Date(now + 90 * MINUTE),
      lockedAt: new Date(now - 4 * 60 * MINUTE),
    });
    await fx.participant({
      dropId,
      qty: 2,
      chargeStatus: 'CAPTURED',
      platformFeeCents: 2 * FEE_PER_UNIT,
    });

    const result = await runCutoffTick({ now: new Date(now), port: fakeChargePort() });

    expect(result.pickupOpened).toBeGreaterThanOrEqual(1);
    expect((await statusOf(dropId)).status).toBe('PICKUP_OPEN');
  });

  it('completes a PICKUP_OPEN drop whose window has ended', async () => {
    const now = Date.now();
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'PICKUP_OPEN',
      cutoffAt: new Date(now - 30 * 60 * MINUTE),
      windowStart: new Date(now - 3 * 60 * MINUTE),
      windowEnd: new Date(now - 60 * MINUTE),
      lockedAt: new Date(now - 30 * 60 * MINUTE),
    });
    await fx.participant({
      dropId,
      qty: 2,
      chargeStatus: 'CAPTURED',
      platformFeeCents: 2 * FEE_PER_UNIT,
    });

    const result = await runCutoffTick({ now: new Date(now), port: fakeChargePort() });

    expect(result.pickupCompleted).toBeGreaterThanOrEqual(1);
    const row = await statusOf(dropId);
    expect(row.status).toBe('COMPLETED');
    expect(row.completedAt).not.toBeNull();
  });

  it('settles and opens in the same tick — the phase order that matters', async () => {
    // A LOCKED drop past its cutoff whose window opens *now*. One tick must charge
    // it and make it collectable. If phase 5 ran before phase 4, this drop would
    // still be `LOCKED` when the pickup query ran, the query would skip it, and the
    // diner would wait a full extra tick for no reason.
    const now = Date.now();
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'LOCKED',
      cutoffAt: new Date(now - 5 * MINUTE),
      windowStart: new Date(now - 1 * MINUTE),
      windowEnd: new Date(now + 120 * MINUTE),
      lockedAt: new Date(now - 5 * MINUTE),
    });
    await fx.participant({
      dropId,
      qty: 2,
      chargeStatus: 'NONE',
      platformFeeCents: 2 * FEE_PER_UNIT,
    });

    const result = await runCutoffTick({ now: new Date(now), port: fakeChargePort() });

    expect(result.settled).toBeGreaterThanOrEqual(1);
    // Both phases reported work, and the row is in the later state.
    expect(result.pickupOpened).toBeGreaterThanOrEqual(1);
    expect((await statusOf(dropId)).status).toBe('PICKUP_OPEN');
  });

  it('leaves a drop whose window has not opened alone', async () => {
    const now = Date.now();
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'CAPTURED',
      cutoffAt: new Date(now - 4 * 60 * MINUTE),
      windowStart: new Date(now + 60 * MINUTE),
      windowEnd: new Date(now + 180 * MINUTE),
      lockedAt: new Date(now - 4 * 60 * MINUTE),
    });
    await fx.participant({
      dropId,
      qty: 2,
      chargeStatus: 'CAPTURED',
      platformFeeCents: 2 * FEE_PER_UNIT,
    });

    await runCutoffTick({ now: new Date(now), port: fakeChargePort() });

    expect((await statusOf(dropId)).status).toBe('CAPTURED');
  });

  it('does not open a FAILED drop sitting inside its window', async () => {
    // The money-losing mistake: a failed drop has real dates, so a query filtered
    // only on the clock would make unpaid orders collectable.
    const now = Date.now();
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'FAILED',
      cutoffAt: new Date(now - 4 * 60 * MINUTE),
      windowStart: new Date(now - 30 * MINUTE),
      windowEnd: new Date(now + 90 * MINUTE),
    });

    await runCutoffTick({ now: new Date(now), port: fakeChargePort() });

    expect((await statusOf(dropId)).status).toBe('FAILED');
  });

  it('is idempotent across ticks: a second tick moves nothing', async () => {
    const now = Date.now();
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'CAPTURED',
      cutoffAt: new Date(now - 4 * 60 * MINUTE),
      windowStart: new Date(now - 30 * MINUTE),
      windowEnd: new Date(now + 90 * MINUTE),
      lockedAt: new Date(now - 4 * 60 * MINUTE),
    });
    await fx.participant({
      dropId,
      qty: 2,
      chargeStatus: 'CAPTURED',
      platformFeeCents: 2 * FEE_PER_UNIT,
    });

    const first = await runCutoffTick({ now: new Date(now), port: fakeChargePort() });
    expect(first.pickupOpened).toBeGreaterThanOrEqual(1);

    const second = await runCutoffTick({ now: new Date(now + 60 * 1000), port: fakeChargePort() });
    expect(second.pickupOpened).toBe(0);
    expect((await statusOf(dropId)).status).toBe('PICKUP_OPEN');
  });
});
