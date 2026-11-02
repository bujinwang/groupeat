import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { findDropsAwaitingVoid } from '../cutoff-decision';
import { fakeChargePort } from '../fake-charge-port';
import { runCutoffTick } from '../run-tick';
import { voidRemainingAuthorisations } from '../settle';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * The wiring — the tick, its bounds, and the route's three refusals.
 *
 * ## Why the route is exercised through `POST()` and not by hand
 *
 * The refusals are the security surface: a job that moves money must not be
 * reachable without a token, and must not run at all when there is no provider.
 * Both are one branch, and a branch that is never executed is a branch that is
 * never true in production either. `CRON_SECRET` is re-read per test by resetting
 * the module graph, because `config.ts` validates the environment at import — the
 * same fail-fast behaviour that makes the app refuse to boot half-configured.
 */

const PREFIX = `runtick${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

async function publishedDropWithParticipants(qty = 5): Promise<string> {
  const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: DEAL_PRICE, minQty: 5 });
  await fx.participant({ dropId, qty, platformFeeCents: qty * FEE_PER_UNIT });
  return dropId;
}

describe('runCutoffTick', () => {
  it('decides and settles every due drop, then finds nothing on the next tick', async () => {
    const dropIds = [
      await publishedDropWithParticipants(),
      await publishedDropWithParticipants(),
      await publishedDropWithParticipants(),
    ];

    const port = fakeChargePort();
    const first = await runCutoffTick({ now: new Date(), port });

    expect(first.due).toBeGreaterThanOrEqual(3);
    expect(first.locked).toBeGreaterThanOrEqual(3);
    expect(first.settled).toBeGreaterThanOrEqual(3);

    for (const dropId of dropIds) {
      const row = await prisma.drop.findUniqueOrThrow({
        where: { id: dropId },
        select: { status: true },
      });
      expect(row.status).toBe('CAPTURED');
    }

    const ordersAfterFirst = await prisma.order.count({ where: { dropId: { in: dropIds } } });
    const entriesAfterFirst = await prisma.ledgerEntry.count({ where: { dropId: { in: dropIds } } });

    // A second immediate tick: nothing is due, and nothing is written.
    const second = await runCutoffTick({ now: new Date(), port });
    expect(second.due).toBe(0);
    expect(second.settled).toBe(0);
    expect(await prisma.order.count({ where: { dropId: { in: dropIds } } })).toBe(ordersAfterFirst);
    expect(await prisma.ledgerEntry.count({ where: { dropId: { in: dropIds } } })).toBe(entriesAfterFirst);
  });

  it('settles a drop a previous tick locked, without deciding it again', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });

    const result = await runCutoffTick({ now: new Date(), port: fakeChargePort() });

    expect(result.settled).toBeGreaterThanOrEqual(1);
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('CAPTURED');
  });

  it('releases the authorisations of a drop that failed its threshold', async () => {
    // §2.1's V1 sweep. This is the transition the design lists but does not route:
    // `settle` only runs for LOCKED drops, so without a durable work queue these
    // authorisations would be held until the bank let them lapse.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 20,
      status: 'FAILED',
    });
    const firstId = await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    const secondId = await fx.participant({ dropId, qty: 4, platformFeeCents: 4 * FEE_PER_UNIT });

    const port = fakeChargePort();
    const result = await runCutoffTick({ now: new Date(), port });

    expect(result.voided).toBeGreaterThanOrEqual(2);
    const participants = await prisma.dropParticipant.findMany({
      where: { id: { in: [firstId, secondId] } },
      select: { authStatus: true },
    });
    expect(participants.map((row) => row.authStatus)).toEqual(['VOIDED', 'VOIDED']);
    // A sweep must never capture.
    expect(port.calls.filter((call) => call.kind === 'capture')).toHaveLength(0);
  });

  it('alerts on a drop that has been LOCKED for more than ten minutes', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });

    // One transient provider failure is enough to keep the drop LOCKED for this
    // tick, which is the state the alert is about.
    const port = fakeChargePort({ unavailableOnceFor: [participantId] });
    const warn = vi.spyOn(logger, 'warn');

    const result = await runCutoffTick({ now: new Date(), port });

    expect(result.inProgress).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledWith(
      'settlement.stalled',
      expect.objectContaining({ dropId, pendingParticipants: 1 }),
    );
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('LOCKED');

    warn.mockRestore();
  });
});

describe('the void queue, and the guard it feeds', () => {
  it('selects a CAPTURED drop whose void timed out, warns, and stops selecting it once released', async () => {
    // The defect QA found: `finaliseCaptured` sweeps after writing CAPTURED, so a
    // transient failure there left a declined diner's authorisation held, and the
    // queue listed only `FAILED` drops — so nothing ever retried it. The diner's
    // balance stayed held until the issuer expired it, and the discarded
    // `VoidSweepResult.pending` meant nothing said so.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'CAPTURED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const heldId = await fx.participant({
      dropId,
      qty: 1,
      platformFeeCents: FEE_PER_UNIT,
      chargeStatus: 'FAILED',
    });

    expect(await findDropsAwaitingVoid({ limit: 500 })).toContain(dropId);

    const warn = vi.spyOn(logger, 'warn');
    const broken = fakeChargePort({ voidUnavailableOnceFor: [heldId] });
    const pending = await voidRemainingAuthorisations({ dropId, port: broken });

    expect(pending).toEqual({ voided: 0, alreadyExpired: 0, pending: 1 });
    // The hold must be visible in the log, not silent. Logged inside the sweep so
    // that no caller can drop the result.
    expect(warn).toHaveBeenCalledWith('settlement.void_pending', {
      dropId,
      pendingParticipants: 1,
    });
    // Still queued: the retry has not happened yet.
    expect(await findDropsAwaitingVoid({ limit: 500 })).toContain(dropId);

    const released = await voidRemainingAuthorisations({ dropId, port: fakeChargePort() });
    expect(released).toEqual({ voided: 1, alreadyExpired: 0, pending: 0 });
    // Derived from the data, so the queue drains.
    expect(await findDropsAwaitingVoid({ limit: 500 })).not.toContain(dropId);

    warn.mockRestore();
  });

  it('does not select a drop whose participants are all settled', async () => {
    // A captured participant keeps `authStatus = 'AUTHORIZED'` for ever — the
    // capture consumed the authorisation, there is nothing to cancel. Keying the
    // queue on `authStatus` alone would select every successful drop on every tick,
    // never drain, and (ordered by `cutoffAt`) starve newer work out of `limit`.
    const capturedId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'CAPTURED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({
      dropId: capturedId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
      chargeStatus: 'CAPTURED',
    });

    const refundedId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 20,
      status: 'FAILED',
    });
    await fx.participant({
      dropId: refundedId,
      qty: 3,
      platformFeeCents: 3 * FEE_PER_UNIT,
      chargeStatus: 'REFUNDED',
    });

    const queue = await findDropsAwaitingVoid({ limit: 500 });
    expect(queue).not.toContain(capturedId);
    expect(queue).not.toContain(refundedId);
  });

  it('refuses a LOCKED drop even when the queue would have selected it', async () => {
    // The guard, not the queue, is what protects a locked drop's authorisations:
    // the queue is a filter over statuses, the guard re-reads the status.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });

    const port = fakeChargePort();
    expect(await voidRemainingAuthorisations({ dropId, port })).toEqual({
      voided: 0,
      alreadyExpired: 0,
      pending: 0,
    });
    expect(port.calls).toHaveLength(0);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true },
    });
    expect(row.authStatus).toBe('AUTHORIZED');
  });
});

describe('POST /api/jobs/cutoff', () => {
  const url = 'http://localhost/api/jobs/cutoff';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('refuses with 503 when CRON_SECRET is not configured', async () => {
    // The safe default: a job route with no auth is a public endpoint that moves
    // money. `.env` has no CRON_SECRET, so this is the state of a fresh checkout.
    vi.resetModules();
    const { POST } = await import('@/app/api/jobs/cutoff/route');

    const response = await POST(new NextRequest(url, { method: 'POST' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'NOT_CONFIGURED' });
  });

  it('refuses with 401 when the bearer token is missing or wrong', async () => {
    vi.resetModules();
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
    const { POST } = await import('@/app/api/jobs/cutoff/route');

    const missing = await POST(new NextRequest(url, { method: 'POST' }));
    expect(missing.status).toBe(401);

    const wrong = await POST(
      new NextRequest(url, { method: 'POST', headers: { authorization: 'Bearer not-the-secret' } }),
    );
    expect(wrong.status).toBe(401);

    // A token of a different length must not throw out of `timingSafeEqual`.
    const short = await POST(
      new NextRequest(url, { method: 'POST', headers: { authorization: 'Bearer x' } }),
    );
    expect(short.status).toBe(401);
  });

  it('refuses with 503 when the token is right but there is no payment provider', async () => {
    // This environment has no STRIPE_SECRET_KEY. Running the decision phase anyway
    // would write LOCKED and then be unable to charge — the one state with no
    // automated exit.
    vi.resetModules();
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
    const { POST } = await import('@/app/api/jobs/cutoff/route');

    const response = await POST(
      new NextRequest(url, { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'NOT_CONFIGURED' });
  });
});
