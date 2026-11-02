import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { findDropsAwaitingVoid, findDueDrops, findLockedDrops } from '../cutoff-decision';
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
 * ## Correction — the first version of this file blamed the fixture default, and that was wrong
 *
 * It argued that `settlement-fixtures.ts` defaulting `cutoffAt` to one hour ago was
 * the leak, and that future-dating a fixture would buy parallelism. The engineer
 * measured it: with the default changed to an inert future cutoff, five parallel
 * runs still produced **5, 4, 5, 4 and 6** failures across 8–9 files, moving
 * between runs. Changing the default bought nothing.
 *
 * The cause is structural, and no default can fix it:
 *
 *   1. Fixtures are created **inside test bodies**, not in `beforeAll`. A fixture
 *      is therefore in the global queues for that test's duration — long after any
 *      default was chosen — and `now` at tick time is the wall clock, which walks
 *      past a future cutoff as the suite runs.
 *   2. `findDropsAwaitingVoid` has **no time predicate at all**, by design: a
 *      diner's authorisation must be released however old the drop is. So any
 *      `FAILED` or `CAPTURED` fixture holding an authorisation is in every other
 *      file's void queue the instant it is created, whatever its `cutoffAt`. The
 *      test below pins exactly that.
 *
 * So serial execution is the current answer, and `fileParallelism: false` stays.
 * The way to get parallelism would be for every settlement fixture to be created
 * and torn down inside the test that uses it *and* for the tick to accept a scope
 * the tests could pass — i.e. bending production code to suit the harness, which
 * the config comment already rejects. Do not change the fixture default expecting
 * it to help.
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

describe('the future-cutoff trick hides a fixture from one queue and not the other', () => {
  it('keeps a PUBLISHED fixture out of findDueDrops, and therefore out of every wall-clock tick', async () => {
    // True, and narrower than it looks: `findDueDrops` is `cutoffAt <= now`, so a
    // future-dated PUBLISHED drop is invisible to a tick on the wall clock. That is
    // the only queue this buys anything for — see the next test.
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

  it('does not hide a FAILED fixture from findDropsAwaitingVoid, which has no time predicate', async () => {
    // This is why future-dating a fixture cannot buy parallelism, and why changing
    // `settlement-fixtures.ts`'s default changed nothing in the engineer's
    // measurement. The void queue is `status IN ('FAILED','CAPTURED')` plus a
    // participant predicate — there is no `cutoffAt` in it, deliberately, because a
    // diner's authorisation must be released however old the drop is. So this
    // fixture is in every other file's void queue from the moment it exists, and a
    // parallel tick would sweep it.
    const cutoffAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dropId = await dropFor({
      merchantId: merchantB,
      menuItemId: itemB,
      status: 'PUBLISHED',
      cutoffAt,
    });
    await prisma.drop.updateMany({ where: { id: dropId }, data: { status: 'FAILED' } });

    const queue = await findDropsAwaitingVoid({ limit: 5_000 });
    expect(queue).toContain(dropId);

    // And a wall-clock tick really does release it, from a drop dated tomorrow.
    const port = fakeChargePort();
    await runCutoffTick({ now: new Date(), port, maxDrops: 500, maxParticipants: 500 });

    const participants = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: { authStatus: true },
    });
    expect(participants.map((row) => row.authStatus)).toEqual(['VOIDED']);
  });
});
