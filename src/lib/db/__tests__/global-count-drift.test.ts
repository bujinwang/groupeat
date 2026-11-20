/**
 * Pins the mechanism behind the `drops 3 → 9` / `participants 3 → 9` failure at `85d20f1`.
 *
 * ## The observation
 *
 * During a certification attempt at `85d20f1`, `/admin/commission — nothing writes` failed
 * because its two `writeCounts()` reads returned 3 and then 9 for both `drops` and
 * `participants`. It was unreproducible in twelve attempts (the file alone six times, three
 * full runs, then three more at a different HEAD). The shape of the test was identified at
 * `src/app/(admin)/admin/commission/__tests__/page.test.ts`:
 *
 * ```ts
 * const before = await writeCounts();   // unscoped prisma.drop.count(), etc.
 * await render({ month: MONTH });
 * await render({ month: 'nonsense' });
 * const after = await writeCounts();
 * expect(after).toEqual(before);
 * ```
 *
 * An unscoped count sees every row that exists at read time, whoever wrote it. Six rows
 * committed by a second process between the two reads therefore become this file's drift.
 * `AGENTS.md` and `docs/PROGRESS.md` explain the hazard; no test had ever made the +6
 * happen on purpose.
 *
 * ## What this reproduces, and what it does not
 *
 * It reproduces the **visibility arithmetic**: three probe drops, a before-read, six more
 * drops, an after-read, and the real `expect(after).toEqual(before)` assertion failing by
 * exactly +6 for drops and participants. A second arm repeats the same six rows against
 * *scoped* counts and measures them as invisible — the reason the 14-file scoped rewrite
 * was deferred: scoping buys immunity to a stranger's rows by giving up the ability to
 * notice them.
 *
 * It does **not** reproduce the cross-process scheduling of the original event. A genuinely
 * separate writer needs committed rows, and a probe that commits rows is an operator — the
 * exact thing that leaked five `repro-*` users at `fd15497`. Everything here lives inside
 * one Prisma interactive transaction that always throws a sentinel, so Postgres rolls it
 * back. The original one-off at `85d20f1` remains unreproduced in situ; its mechanism no
 * longer rests on prose alone.
 *
 * ## Why this file is not a fifteenth global-count hazard
 *
 * Every assertion is on a **difference** or on a row addressed **by id**. None asserts an
 * absolute global total, so a concurrent writer cannot turn this mechanism test into the
 * next flake. `restrict-fk.test.ts` made the same choice for the same reason.
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

const ROLLBACK = 'INTENTIONAL_ROLLBACK_global-count-drift.test.ts';
/** The `85d20f1` delta, for both `drops` and `participants`. */
const STRAY_BATCH = 6;
/** The `3` in `3 → 9`: the probe's own rows, present at the before-read. */
const INITIAL_BATCH = 3;

type Tx = Prisma.TransactionClient;
type Counts = { readonly drops: number; readonly participants: number };
type Arm = {
  readonly before: Counts;
  readonly after: Counts;
  /** Whether the page test's `expect(after).toEqual(before)` would have held. */
  readonly equalityHeld: boolean;
};
type Parents = {
  readonly merchantId: string;
  readonly menuItemId: string;
  readonly customerId: string;
};
type Batch = { readonly dropIds: string[]; readonly participantIds: string[] };
type Snapshot = {
  readonly unscoped: Arm;
  readonly scoped: Arm;
  readonly probe: {
    readonly merchantId: string;
    readonly customerId: string;
    readonly dropIds: string[];
    readonly participantIds: string[];
  };
};

/** Runs the real assertion and reports the outcome without failing this test. */
function equalityHolds(before: Counts, after: Counts): boolean {
  try {
    expect(after).toEqual(before);
    return true;
  } catch {
    return false;
  }
}

/** The shape in `page.test.ts`: five unscoped global counts, reduced to the two that drifted. */
async function globalCounts(tx: Tx): Promise<Counts> {
  const [drops, participants] = await Promise.all([
    tx.drop.count(),
    tx.dropParticipant.count(),
  ]);
  return { drops, participants };
}

/**
 * What a *naive* scoped count would read: only the fixture's own ids, via `id in [...]`.
 *
 * Deferred-rewrite note (dated 2026-11-06): this `id in [...]` shape is the one the 14-file
 * rewrite was deferred over, because a row the code under test *writes* has a new id, so it is
 * never in the list and the "nothing writes" assertion becomes vacuous. The shipped helper,
 * `src/lib/testing/scoped-counts.ts`, deliberately does **not** use this shape: it scopes by
 * *namespace* (the fixture's `merchantId` / `dropId` / `customerId` relations), so a newly
 * written fixture row still satisfies the predicate and the test still catches it. This
 * function is kept as the id-list illustration the table row "scoped (the deferred rewrite)"
 * measures — the price of *that* shape, not of scoping in general. The 14-file rewrite is
 * complete at this HEAD.
 */
async function scopedCounts(tx: Tx, dropIds: readonly string[]): Promise<Counts> {
  const [drops, participants] = await Promise.all([
    tx.drop.count({ where: { id: { in: [...dropIds] } } }),
    tx.dropParticipant.count({ where: { dropId: { in: [...dropIds] } } }),
  ]);
  return { drops, participants };
}

async function seedParents(tx: Tx, tag: string): Promise<Parents> {
  const merchantId = randomUUID();
  const menuItemId = randomUUID();
  const customerId = randomUUID();
  await tx.merchant.create({
    data: { id: merchantId, name: 'drift-probe', slug: `drift-${tag}` },
  });
  await tx.menuItem.create({
    data: {
      id: menuItemId,
      merchantId,
      name: 'probe dish',
      menuPriceCents: 1000,
      foodCostCents: 400,
      batchYield: 10,
    },
  });
  // A full UUID, not the 8-char tag: `phone` is unique and the two `it`s each run a
  // transaction, so a short tag could repeat and fail on the customer instead of the drift.
  const phoneDigits = randomUUID().replace(/\D/g, '').padEnd(10, '0').slice(0, 10);
  await tx.customer.create({
    data: { id: customerId, phone: `+1555${phoneDigits}` },
  });
  return { merchantId, menuItemId, customerId };
}

/** `count` drops, each with one participant — so both counts move together. */
async function seedBatch(
  tx: Tx,
  count: number,
  start: number,
  tag: string,
  parents: Parents,
): Promise<Batch> {
  const dropIds: string[] = [];
  const participantIds: string[] = [];
  const drops: Prisma.DropCreateManyInput[] = [];
  const participants: Prisma.DropParticipantCreateManyInput[] = [];

  for (let i = 0; i < count; i += 1) {
    const dropId = randomUUID();
    const participantId = randomUUID();
    const n = start + i;
    dropIds.push(dropId);
    participantIds.push(participantId);
    drops.push({
      id: dropId,
      merchantId: parents.merchantId,
      menuItemId: parents.menuItemId,
      publicCode: `gcd-${tag}-${n}`,
      title: `drift probe ${n}`,
      dealPriceCents: 800,
      minQty: 1,
      maxQty: 10,
      windowStart: new Date('2026-11-01T00:00:00Z'),
      windowEnd: new Date('2026-11-02T00:00:00Z'),
      cutoffAt: new Date('2026-10-31T00:00:00Z'),
      guardrailSnapshot: {},
    });
    participants.push({
      id: participantId,
      dropId,
      customerId: parents.customerId,
      qty: 1,
      amountCents: 800,
      platformFeeCents: 100,
    });
  }

  await tx.drop.createMany({ data: drops });
  await tx.dropParticipant.createMany({ data: participants });
  return { dropIds, participantIds };
}

/** Runs `fn` in a transaction that is *always* rolled back. */
async function inRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const box: { value?: T } = {};
  try {
    await prisma.$transaction(
      async (tx) => {
        box.value = await fn(tx);
        throw new Error(ROLLBACK);
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  if (!('value' in box)) {
    throw new Error('rollback-only transaction produced no result');
  }
  return box.value as T;
}

/** Three rows, two before-reads, six stranger rows, two after-reads, one rollback. */
async function measure(): Promise<Snapshot> {
  return inRollback(async (tx) => {
    const tag = randomUUID().slice(0, 8);
    const parents = await seedParents(tx, tag);
    const initial = await seedBatch(tx, INITIAL_BATCH, 0, tag, parents);

    const unscopedBefore = await globalCounts(tx);
    const scopedBefore = await scopedCounts(tx, initial.dropIds);

    const stray = await seedBatch(tx, STRAY_BATCH, INITIAL_BATCH, tag, parents);

    const unscopedAfter = await globalCounts(tx);
    const scopedAfter = await scopedCounts(tx, initial.dropIds);

    return {
      unscoped: {
        before: unscopedBefore,
        after: unscopedAfter,
        equalityHeld: equalityHolds(unscopedBefore, unscopedAfter),
      },
      scoped: {
        before: scopedBefore,
        after: scopedAfter,
        equalityHeld: equalityHolds(scopedBefore, scopedAfter),
      },
      probe: {
        merchantId: parents.merchantId,
        customerId: parents.customerId,
        dropIds: [...initial.dropIds, ...stray.dropIds],
        participantIds: [...initial.participantIds, ...stray.participantIds],
      },
    };
  });
}

/** Addresses the probe rows by id, never with a global count. */
async function expectNoRows(snapshot: Snapshot): Promise<void> {
  const { merchantId, customerId, dropIds, participantIds } = snapshot.probe;
  const [merchant, customer, drop, participant] = await Promise.all([
    prisma.merchant.findUnique({ where: { id: merchantId } }),
    prisma.customer.findUnique({ where: { id: customerId } }),
    prisma.drop.findFirst({ where: { id: { in: dropIds } } }),
    prisma.dropParticipant.findFirst({ where: { id: { in: participantIds } } }),
  ]);
  expect(merchant).toBeNull();
  expect(customer).toBeNull();
  expect(drop).toBeNull();
  expect(participant).toBeNull();
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('global-count drift (the 3 → 9 mechanism)', () => {
  it('six rows between two unscoped reads break the equality assertion by exactly +6', async () => {
    const snapshot = await measure();
    const { before, after, equalityHeld } = snapshot.unscoped;

    expect(after.drops - before.drops).toBe(STRAY_BATCH);
    expect(after.participants - before.participants).toBe(STRAY_BATCH);
    expect(equalityHeld).toBe(false);
    await expectNoRows(snapshot);
  });

  it('scoping the same count hides those six rows — the measured cost of the deferral', async () => {
    const snapshot = await measure();
    const { before, after, equalityHeld } = snapshot.scoped;

    expect(before.drops).toBe(INITIAL_BATCH);
    expect(before.participants).toBe(INITIAL_BATCH);
    expect(after.drops - before.drops).toBe(0);
    expect(after.participants - before.participants).toBe(0);
    expect(equalityHeld).toBe(true);
    // The unscoped arm saw the same six rows in the very same transaction.
    expect(snapshot.unscoped.after.drops - snapshot.unscoped.before.drops).toBe(STRAY_BATCH);
    await expectNoRows(snapshot);
  });
});
