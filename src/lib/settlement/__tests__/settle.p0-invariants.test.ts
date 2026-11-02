import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { fakeChargePort } from '../fake-charge-port';
import { runCutoffTick } from '../run-tick';
import { settle } from '../settle';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * The two P0 sentences, attacked rather than observed.
 *
 * > **Never charge before the cutoff.**
 * > **Never charge when the threshold is missed.**
 *
 * The engineer's `cutoff-decision.test.ts` and `settle.test.ts` assert the happy
 * shape of both. This file tries to find a way *around* them: a drop one
 * millisecond the wrong side of its cutoff, a below-threshold drop pushed at every
 * exported function in turn, a `FAILED` drop that still holds live authorisations,
 * and a tick configured to process everything at once.
 *
 * It also pins the one thing the design accepts rather than closes: `settle`'s
 * only precondition is `Drop.status = 'LOCKED'`, so a `LOCKED` row is chargeable
 * regardless of its cutoff. That is safe today because exactly one function writes
 * `LOCKED` and it is guarded; the last test in this file makes that assumption
 * executable so the day a second writer appears, the reader can see what breaks.
 */

const PREFIX = `qa-p0${Date.now()}`;
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

/**
 * A `PUBLISHED` drop with an explicit cutoff, plus one participant.
 *
 * The cutoff is passed in rather than derived from `Date.now()` inside the helper
 * so the tick's `now` can be placed exactly one millisecond before it — the
 * fixture's own DB round trips would otherwise consume the millisecond and the
 * boundary would be untestable.
 */
async function publishedDrop(args: {
  cutoffAt: Date;
  minQty?: number;
  joinedQty?: number;
}): Promise<string> {
  const minQty = args.minQty ?? 5;
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty,
    cutoffAt: args.cutoffAt,
  });
  await fx.participant({
    dropId,
    qty: args.joinedQty ?? minQty,
    platformFeeCents: (args.joinedQty ?? minQty) * FEE_PER_UNIT,
  });
  return dropId;
}

async function statusOf(dropId: string): Promise<string> {
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: { status: true },
  });
  return row.status;
}

describe('never charge before the cutoff', () => {
  it('does not touch a drop one millisecond before its cutoff, at any threshold', async () => {
    const cutoffAt = new Date(Date.now() + 60_000);
    const dropId = await publishedDrop({ cutoffAt });
    const port = fakeChargePort();

    // One millisecond the wrong side, on the tick's own clock.
    const result = await runCutoffTick({
      now: new Date(cutoffAt.getTime() - 1),
      port,
      maxDrops: 500,
      maxParticipants: 500,
    });

    // Not decided, not locked, not captured, not voided — and the port is untouched.
    expect(result.locked).toBe(0);
    expect(result.settled).toBe(0);
    expect(result.voided).toBe(0);
    expect(port.calls).toHaveLength(0);
    expect(await statusOf(dropId)).toBe('PUBLISHED');
    expect(await prisma.order.count({ where: { dropId } })).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { dropId } })).toBe(0);
    const lockedAt = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { lockedAt: true },
    });
    expect(lockedAt.lockedAt).toBeNull();
  });

  it('decides the same drop the instant its cutoff is reached', async () => {
    // The boundary is inclusive, and this is the pair to the test above: if both
    // passed with the same tick, the filter would be doing nothing.
    const cutoffAt = new Date(Date.now() + 60_000);
    const dropId = await publishedDrop({ cutoffAt });
    const port = fakeChargePort();

    await runCutoffTick({
      now: cutoffAt,
      port,
      maxDrops: 500,
      maxParticipants: 500,
    });

    expect(await statusOf(dropId)).toBe('CAPTURED');
    expect(
      port.calls.filter((call) => call.kind === 'capture' && call.request.dropId === dropId),
    ).toHaveLength(1);
  });

  it('lets no exported function of settle reach the port for a drop that is not LOCKED', async () => {
    // Every status a drop can be in on the wrong side of its cutoff. `settle` is
    // called with a real id and a real port, and the assertion is on the port: zero
    // calls, whatever the status.
    const published = await publishedDrop({ cutoffAt: new Date(Date.now() + 60_000) });
    const failed = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 20,
      status: 'FAILED',
    });
    await fx.participant({ dropId: failed, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });

    const port = fakeChargePort();
    expect(await settle({ dropId: published, now: new Date(), port })).toEqual({
      kind: 'NOT_LOCKED',
      dropId: published,
    });
    expect(await settle({ dropId: failed, now: new Date(), port })).toEqual({
      kind: 'NOT_LOCKED',
      dropId: failed,
    });
    expect(port.calls).toHaveLength(0);
  });
});

describe('never charge when the threshold is missed', () => {
  it('fails a below-threshold drop on the tick and never calls capture', async () => {
    const dropId = await publishedDrop({
      cutoffAt: new Date(Date.now() - 60_000),
      minQty: 20,
      joinedQty: 19,
    });
    const port = fakeChargePort();

    const result = await runCutoffTick({ now: new Date(), port, maxDrops: 500, maxParticipants: 500 });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await statusOf(dropId)).toBe('FAILED');
    expect(
      port.calls.filter((call) => call.kind === 'capture' && call.request.dropId === dropId),
    ).toHaveLength(0);
    expect(await prisma.order.count({ where: { dropId } })).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { dropId } })).toBe(0);

    // The authorisations are released rather than left held, which is the
    // deviation the engineer added. A capture here would be the P0 breach.
    const participants = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: { authStatus: true, chargeStatus: true },
    });
    expect(participants.map((row) => row.authStatus)).toEqual(['VOIDED']);
    expect(participants.map((row) => row.chargeStatus)).toEqual(['NONE']);
  });

  it('cannot be handed a drop to charge through settle, whatever the shape', async () => {
    // The brand is compile-time only: `settle` re-reads the status from Postgres, so
    // a hand-built object with a `LockedDrop` shape and the right drop id is inert.
    // This is the runtime half of the §1.4 chain — the guard is the status read,
    // not the brand.
    const dropId = await publishedDrop({
      cutoffAt: new Date(Date.now() - 60_000),
      minQty: 20,
      joinedQty: 3,
    });
    const port = fakeChargePort();

    const forged = {
      dropId,
      merchantId,
      stripeAccountId: 'acct_forged',
      dealPriceCents: DEAL_PRICE,
      minQty: 20,
      maxQty: 40,
      cutoffAt: new Date(Date.now() - 60_000),
      decidedAt: new Date(),
      joinedQty: 3,
      participants: [],
      windowStart: new Date(),
      windowEnd: new Date(),
    };

    // `settle`'s signature is `{ dropId, now, port, ... }`, so the forged object can
    // only be smuggled in as the id — which is a string, and matches nothing.
    const outcome = await settle({
      dropId: forged.dropId,
      now: new Date(),
      port,
    });
    expect(outcome.kind).toBe('NOT_LOCKED');
    expect(port.calls).toHaveLength(0);
    expect(await statusOf(dropId)).toBe('PUBLISHED');
  });

  it('does not let a FAILED drop be captured by a resume tick', async () => {
    // A drop that failed its threshold but whose authorisations were never released
    // is exactly the state the void queue exists for. It must be swept, not settled.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 20,
      status: 'FAILED',
    });
    await fx.participant({ dropId, qty: 19, platformFeeCents: 19 * FEE_PER_UNIT });

    const port = fakeChargePort();
    const result = await runCutoffTick({ now: new Date(), port, maxDrops: 500, maxParticipants: 500 });

    expect(result.voided).toBeGreaterThanOrEqual(1);
    expect(port.calls.filter((call) => call.kind === 'capture')).toHaveLength(0);
    expect(await statusOf(dropId)).toBe('FAILED');
  });
});

describe('the accepted single point of failure', () => {
  it('settle charges a LOCKED row without re-checking its cutoff', async () => {
    // Recorded, not celebrated. `settle` -> `loadLockedDrop` gates on
    // `Drop.status = 'LOCKED'` and nothing else; `assertCutoffReached` lives in
    // `cutoff-decision.ts` and is called only from `decideFor`. So the P0 sentence
    // rests entirely on "exactly one function writes LOCKED, and its UPDATE is
    // guarded by `cutoffAt <= now`".
    //
    // Verified in this repo: `grep -rn "status: 'LOCKED'" src/` returns
    // `cutoff-decision.ts:296` and nothing else. If that ever becomes two places,
    // this test is the one that says what the second place buys you.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(),
      cutoffAt: new Date(Date.now() + 60_000), // one minute in the FUTURE
    });
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });

    const port = fakeChargePort();
    const outcome = await settle({ dropId, now: new Date(), port });

    expect(outcome.kind).toBe('CAPTURED');
    expect(port.calls.filter((call) => call.kind === 'capture')).toHaveLength(1);
  });
});
