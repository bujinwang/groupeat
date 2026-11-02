import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { findDueDrops, findLockedDrops } from '../cutoff-decision';
import { fakeChargePort } from '../fake-charge-port';
import { runCutoffTick } from '../run-tick';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * Is `fileParallelism: false` an honest accommodation or a hidden defect?
 *
 * The claim under test: *`runCutoffTick` scans global work queues, so a tick in one
 * test file settles another file's fixtures.*
 *
 * That claim is **true and by design** — this file proves the queues are global and
 * carry no merchant or drop scope, which is what production needs (a tick that only
 * settled the drops of one merchant would be a tick that never settles most of
 * them). The bounded-work question is answered separately: `maxDrops` and
 * `maxParticipants` cap the loop, and everything is resumable.
 *
 * What the file also shows is that the *serialisation* is not required to get
 * isolation. Every function in `src/lib/settlement/**` takes `now` as a parameter
 * (§11.2), and `findDueDrops` is `cutoffAt <= now`. So a fixture whose `cutoffAt`
 * is in the future is invisible to any tick running on the wall clock — including
 * another file's. `settlement-fixtures.ts` defaults `cutoffAt` to **one hour ago**,
 * and that default is the leak: it puts every drop in every file into the global
 * due queue at the moment it is created. The tick is not the problem; the fixture
 * default is, and it is fixable without changing production code.
 */

const PREFIX = `qa-par${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantA = '';
let merchantB = '';
let itemA = '';
let itemB = '';

const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

beforeAll(async () => {
  merchantA = await fx.merchant('acct_qa_parallel_a');
  merchantB = await fx.merchant('acct_qa_parallel_b');
  itemA = await fx.item(merchantA);
  itemB = await fx.item(merchantB);
});

afterAll(async () => {
  await fx.cleanup();
});

async function dropFor(args: {
  merchantId: string;
  menuItemId: string;
  status: 'PUBLISHED' | 'LOCKED';
  cutoffAt: Date;
}): Promise<string> {
  const dropId = await fx.drop({
    merchantId: args.merchantId,
    menuItemId: args.menuItemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 5,
    status: args.status,
    cutoffAt: args.cutoffAt,
    lockedAt: args.status === 'LOCKED' ? new Date(Date.now() - 60_000) : null,
  });
  await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });
  return dropId;
}

describe('the work queues are global, on purpose', () => {
  it('returns due and locked drops from two different merchants in one query', async () => {
    // Two merchants stand in for two test files: nothing in the query can tell them
    // apart. That is correct in production — a merchant-scoped cutoff job would be a
    // job that never settles anybody.
    const dueA = await dropFor({
      merchantId: merchantA,
      menuItemId: itemA,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() - 60_000),
    });
    const dueB = await dropFor({
      merchantId: merchantB,
      menuItemId: itemB,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() - 60_000),
    });
    const lockedA = await dropFor({
      merchantId: merchantA,
      menuItemId: itemA,
      status: 'LOCKED',
      cutoffAt: new Date(Date.now() - 60_000),
    });

    const due = await findDueDrops({ now: new Date(), limit: 500 });
    const locked = await findLockedDrops({ limit: 500 });

    expect(due).toContain(dueA);
    expect(due).toContain(dueB);
    expect(locked).toContain(lockedA);

    // And one tick settles both merchants' drops, which is the whole reason a
    // parallel test file would be corrupted by it.
    const port = fakeChargePort();
    await runCutoffTick({ now: new Date(), port, maxDrops: 500, maxParticipants: 500 });
    const statuses = await prisma.drop.findMany({
      where: { id: { in: [dueA, dueB, lockedA] } },
      select: { status: true },
    });
    expect(statuses.map((row) => row.status)).toEqual(['CAPTURED', 'CAPTURED', 'CAPTURED']);
  });

  it('bounds its own work, so "global" is not "unbounded"', async () => {
    // The second half of the smell test: if the tick could not bound itself, the
    // serialisation would be hiding a production defect. It can, and does.
    const dropIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      dropIds.push(
        await dropFor({
          merchantId: merchantA,
          menuItemId: itemA,
          status: 'PUBLISHED',
          cutoffAt: new Date(Date.now() - 60_000),
        }),
      );
    }

    const port = fakeChargePort();
    const result = await runCutoffTick({ now: new Date(), port, maxDrops: 2, maxParticipants: 50 });

    expect(result.due).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);

    const settled = await prisma.drop.count({
      where: { id: { in: dropIds }, status: 'CAPTURED' },
    });
    expect(settled).toBeLessThanOrEqual(2);

    // The next tick continues where this one stopped — progress, not loss.
    const second = await runCutoffTick({ now: new Date(), port, maxDrops: 50, maxParticipants: 50 });
    expect(second.settled).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.drop.count({ where: { id: { in: dropIds }, status: 'CAPTURED' } }),
    ).toBe(4);
  });
});

describe('isolation is available without touching production', () => {
  it('hides a fixture from every wall-clock tick by putting its cutoff in the future', async () => {
    // The leak is `settlement-fixtures.ts`'s `cutoffAt: now - 1h` default, not the
    // tick. A fixture with a future cutoff is invisible to `findDueDrops` for any
    // `now` before it, so no other file's tick can see it.
    const cutoffAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dropId = await dropFor({
      merchantId: merchantB,
      menuItemId: itemB,
      status: 'PUBLISHED',
      cutoffAt,
    });

    const port = fakeChargePort();
    const wallClockTick = await runCutoffTick({ now: new Date(), port, maxDrops: 500, maxParticipants: 500 });

    expect(await findDueDrops({ now: new Date(), limit: 500 })).not.toContain(dropId);
    expect(wallClockTick.locked).toBe(0);
    expect(port.calls).toHaveLength(0);
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('PUBLISHED');

    // ...and the same fixture is fully testable, deterministically, by passing the
    // tick the instant its own test cares about.
    const ownTick = await runCutoffTick({ now: cutoffAt, port, maxDrops: 500, maxParticipants: 500 });
    expect(ownTick.settled).toBeGreaterThanOrEqual(1);
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('CAPTURED');
  });
});
