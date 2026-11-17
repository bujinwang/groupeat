import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeJoinPaymentPort } from '@/lib/join/fake-payment-port';
import {
  JoinProviderUnavailableError,
} from '@/lib/join/payment-port';
import type {
  JoinReconciliationOutcome,
  JoinReconciliationPort,
  JoinReconciliationRequest,
} from '@/lib/join/reconciliation-port';
import { joinDrop } from '@/lib/join/service';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

import { ORPHAN_GRACE_MS, resolveOrphanedPendingJoins } from '../orphan-sweep';
import type { NotifyIntent } from '../notify-port';
import { runCutoffTick } from '../run-tick';

/**
 * A `PENDING` join on a drop past its cutoff is resolved by nothing.
 *
 * ## The defect these tests were written against
 *
 * `joinDrop` writes a `PENDING` participant *before* it calls the provider, so a
 * crash or a timeout between the two leaves a row rather than a silently missing
 * join. Before cutoff that is intended: `PENDING` deliberately does not early-return
 * as "already joined", so the diner can retry, the same row is reused, and
 * `joinKey(participantId)` is unchanged — the provider replays whatever the lost
 * attempt created instead of creating a second hold.
 *
 * After cutoff that door closes, because the retry path requires
 * `view.joinBlockedReason === null` and a past-cutoff drop always has a reason. And
 * every other sweep is blind to the row, each for a correct reason of its own:
 *
 *   - `findDropsAwaitingVoid` selects `AUTHORIZED` rows only, and a void needs a
 *     `paymentIntentId` to cancel with;
 *   - `settle` reads `AUTHORIZED` only;
 *   - `paymentIntentId` is written in exactly one place — the `PENDING → AUTHORIZED`
 *     transition — so an orphan has `null` and there is genuinely nothing to void.
 *
 * Measured against real Postgres on 2026-11-16, in both outcomes: the orphan stayed
 * `PENDING/NONE` through two ticks while its neighbour went `VOIDED` (failed drop) or
 * `CAPTURED` (successful drop). In neither case did any tick pick it up.
 *
 * ## What the row costs while it sits there
 *
 * A plate. Capacity counts `PENDING` (see `drop-view.ts`), so an orphan holding 3 of
 * a 4-plate drop stops that drop ever selling out — measured: `held 3, remaining 1`,
 * and the diner who wanted the last plate got in while the fourth was still
 * unsellable. On a live drop that is lost revenue, not bookkeeping.
 *
 * ## Why `FAILED` and not `VOIDED` or `EXPIRED`
 *
 * `paymentIntentId` is never written for an orphan, so marking it `FAILED` destroys
 * no link that existed. `VOIDED` would claim a hold was released, which we cannot
 * substantiate; `EXPIRED` would claim the issuer expired it, which we have not
 * observed. `FAILED` records the true fact — we never confirmed a hold — and is
 * excluded from both the capacity sum and the threshold sum.
 *
 * Dated correction — 2026-11-17: the paragraph above describes the original
 * sweep. With the provider lookup added, a found live hold that this sweep
 * cancels is recorded as `VOIDED`, a hold the provider says already lapsed is
 * `EXPIRED`, and both carry the discovered intent id. `FAILED` is now the
 * no-matching-intent or unresolved outcome. Omitting the lookup port is
 * `UNRESOLVED`, never a silent "provider found nothing".
 *
 * ## Why the tests are shaped this way
 *
 * The grace-window cases (C and D below) are the ones that matter most and are the
 * easiest to get wrong in both directions. A sweep with no window races a join that
 * reserved one millisecond before cutoff and records its answer one millisecond
 * after, and the symptom would be a confirmed hold on a `FAILED` row — a diner
 * charged for a plate the system believes they never took. A sweep that only ever
 * *widens* is untested against the case it exists to protect.
 */

const PREFIX = `orphan-sweep-${Date.now()}`;

/**
 * This file's phone block, tracked at issue.
 *
 * `joinDrop` mints a `Customer` and a `ConsentRecord` from the phone it is handed,
 * and `fixtures.cleanup()` reaches neither: it deletes only the customers it created
 * itself, and `ConsentRecord` has no foreign key at all. `/^\+1780565/` is this
 * file's allocation. See `capacity-populations.test.ts` for the measured cost of
 * getting this wrong (12 leaked rows, gate red).
 */
const issuedPhones = new Set<string>();
let seq = 0;

function nextPhone(): string {
  seq += 1;
  const national = `780565${String(seq).padStart(4, '0')}`;
  issuedPhones.add(`+1${national}`);
  return national;
}

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant();
  itemId = await fixtures.item(merchantId);
});

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  await step(() =>
    prisma.consentRecord.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );
  // Before the customer delete: `DropParticipant.customer` is Restrict, so a
  // participant still referencing a customer raises `DropParticipant_customerId_fkey`.
  await step(() => fixtures.cleanup());
  await step(() =>
    prisma.customer.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `teardown left the database dirty (${failures.length} step(s) failed)`,
    );
  }
});

/** A port whose authorisation call never answers, which is what leaves `PENDING`. */
function unavailablePort() {
  return {
    async createJoinAuthorisation() {
      const { JoinProviderUnavailableError } = await import('@/lib/join/payment-port');
      throw new JoinProviderUnavailableError('timeout', 'orphan-sweep: test');
    },
  };
}

/** A charge port that captures everything it is given. */
function capturingPort() {
  return {
    async capture(request: { participantId: string }) {
      return {
        status: 'CAPTURED' as const,
        chargeId: `ch_${request.participantId}`,
        amountCents: 1112,
        platformFeeCents: 178,
        applicationFeeRefundCents: 0,
      };
    },
    async voidAuthorization() {
      return { status: 'VOIDED' as const };
    },
    async refund() {
      return { status: 'REFUNDED' as const, refundedCents: 0 };
    },
  };
}

/** A charge port that records every void, so a wrong key or wrong id is visible. */
function recordingChargePort(outcome: { status: 'VOIDED' | 'ALREADY_EXPIRED' } = {
  status: 'VOIDED',
}) {
  const voids: Array<{
    participantId: string;
    stripeAccountId: string;
    paymentIntentId: string;
    idempotencyKey: string;
  }> = [];
  return {
    voids,
    async capture() {
      return { status: 'CAPTURED' as const, chargeId: 'ch_not_used' };
    },
    async voidAuthorization(request: {
      participantId: string;
      stripeAccountId: string;
      paymentIntentId: string;
      idempotencyKey: string;
    }) {
      voids.push(request);
      return outcome;
    },
    async refund() {
      return { status: 'REFUNDED' as const, refundId: 're_not_used', applicationFeeRefundCents: 0 };
    },
  };
}

function lookupReturning(outcome: JoinReconciliationOutcome) {
  const requests: JoinReconciliationRequest[] = [];
  const port: JoinReconciliationPort = {
    async findJoinAuthorisation(request) {
      requests.push(request);
      return outcome;
    },
  };
  return { requests, port };
}

async function lookupThrowing(error: unknown): Promise<{ requests: JoinReconciliationRequest[]; port: JoinReconciliationPort }> {
  const requests: JoinReconciliationRequest[] = [];
  return {
    requests,
    port: {
      async findJoinAuthorisation(request) {
        requests.push(request);
        throw error;
      },
    },
  };
}

async function liveDrop(spec: {
  minQty: number;
  maxQty: number;
}): Promise<{ id: string; publicCode: string }> {
  const id = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1112,
    minQty: spec.minQty,
    maxQty: spec.maxQty,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 3_600_000),
  } as never);
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id },
    select: { publicCode: true },
  });
  return { id, publicCode: row.publicCode };
}

/** A join that reserves a plate and never hears back from the provider. */
async function orphan(
  drop: { publicCode: string },
  qty: number,
): Promise<{ phone: string; participantId: string }> {
  const phone = nextPhone();
  await joinDrop(
    { publicCode: drop.publicCode, phone, qty, consented: true },
    { paymentPort: unavailablePort() },
  );
  const row = await prisma.dropParticipant.findFirstOrThrow({
    where: { drop: { publicCode: drop.publicCode }, customer: { phone: `+1${phone}` } },
    select: { id: true },
  });
  return { phone, participantId: row.id };
}

/** A PENDING row made directly, so a lookup can be keyed to its known id. */
async function knownOrphan(
  drop: { id: string; publicCode: string },
  qty: number,
): Promise<{ phone: string; participantId: string }> {
  const participantId = await fixtures.participant({
    dropId: drop.id,
    qty,
    authStatus: 'PENDING',
    paymentIntentId: null,
  });
  const row = await prisma.dropParticipant.findUniqueOrThrow({
    where: { id: participantId },
    select: { customer: { select: { phone: true } } },
  });
  await agePastGrace(drop.id);
  await reachCutoff(drop.id);
  return { phone: row.customer.phone, participantId };
}

/** A real hold, so the drop is a legitimate candidate for the other sweeps. */
async function paidJoin(drop: { publicCode: string }, qty: number): Promise<void> {
  await joinDrop(
    { publicCode: drop.publicCode, phone: nextPhone(), qty, consented: true },
    { paymentPort: fakeJoinPaymentPort() },
  );
}

/** Move a drop's cutoff into the past, as a tick would find it. */
async function reachCutoff(dropId: string): Promise<void> {
  await prisma.drop.update({
    where: { id: dropId },
    data: { cutoffAt: new Date(Date.now() - 60_000) },
  });
}

/**
 * Age a `PENDING` row past the grace window.
 *
 * `createdAt` rather than a synthetic flag, because that is the field the sweep
 * reads: it is the age of the *reservation*, which is what the in-flight race is
 * about.
 */
async function agePastGrace(dropId: string): Promise<void> {
  await prisma.dropParticipant.updateMany({
    where: { dropId, authStatus: 'PENDING' },
    data: { createdAt: new Date(Date.now() - ORPHAN_GRACE_MS - 60_000) },
  });
}

describe('orphan sweep — a PENDING row past cutoff is resolved', () => {
  it('resolves the orphan when the drop fails its threshold', async () => {
    // The measured pre-fix state: the neighbour goes VOIDED, the orphan stays
    // PENDING forever. Asserting *that* is what fails on the old code.
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    await paidJoin(drop, 1);
    const { participantId } = await orphan(drop, 2);
    await agePastGrace(drop.id);
    await reachCutoff(drop.id);

    const tick = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      maxDrops: 5,
    });

    expect(tick.failed, 'the drop missed its threshold').toBe(1);
    expect(tick.orphanedPending, 'the orphan was resolved').toBe(1);

    const orphanRow = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true, chargeStatus: true },
    });
    expect(orphanRow).toEqual({ authStatus: 'FAILED', chargeStatus: 'NONE' });
  });

  it('resolves the orphan when the drop succeeds, without touching the captured rows', async () => {
    // The other outcome, and the one where a careless sweep could do damage: the
    // drop settles, so a sweep that keyed on "resolved nothing" rather than on
    // `PENDING` could clobber a captured participant.
    const drop = await liveDrop({ minQty: 2, maxQty: 10 });
    await paidJoin(drop, 2);
    const { participantId } = await orphan(drop, 1);
    await agePastGrace(drop.id);
    await reachCutoff(drop.id);

    const tick = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      maxDrops: 5,
    });

    expect(tick.settled, 'the drop captured').toBe(1);
    expect(tick.orphanedPending).toBe(1);

    const orphanRow = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true, chargeStatus: true },
    });
    expect(orphanRow).toEqual({ authStatus: 'FAILED', chargeStatus: 'NONE' });

    // The captured row is the one a mis-keyed sweep would damage.
    const captured = await prisma.dropParticipant.findMany({
      where: { dropId: drop.id, authStatus: 'AUTHORIZED' },
      select: { chargeStatus: true },
    });
    expect(captured.map((row) => row.chargeStatus)).toEqual(['CAPTURED']);
  });

  it('frees the plate, so the drop can still be sold out rather than blocked', async () => {
    // The cost of leaving it: capacity counts `PENDING`, so an orphan holding most
    // of a drop makes the remainder unsellable. Measured before the fix as
    // `held 3` on a 4-plate drop with the sweep absent.
    const drop = await liveDrop({ minQty: 2, maxQty: 4 });
    await orphan(drop, 3);
    await agePastGrace(drop.id);
    await reachCutoff(drop.id);

    const before = await prisma.dropParticipant.aggregate({
      where: { dropId: drop.id, authStatus: { in: ['PENDING', 'AUTHORIZED'] } },
      _sum: { qty: true },
    });
    expect(before._sum.qty, 'the orphan is holding the plates').toBe(3);

    await runCutoffTick({ now: new Date(), port: capturingPort() as never, maxDrops: 5 });

    const after = await prisma.dropParticipant.aggregate({
      where: { dropId: drop.id, authStatus: { in: ['PENDING', 'AUTHORIZED'] } },
      _sum: { qty: true },
    });
    expect(after._sum.qty ?? 0, 'the plates are free').toBe(0);
  });

  it('is idempotent: a second tick resolves nothing and changes nothing', async () => {
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    await paidJoin(drop, 1);
    const { participantId } = await orphan(drop, 2);
    await agePastGrace(drop.id);
    await reachCutoff(drop.id);

    const first = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      maxDrops: 5,
    });
    expect(first.orphanedPending).toBe(1);

    const second = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      maxDrops: 5,
    });
    expect(second.orphanedPending, 'nothing left to resolve').toBe(0);

    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true },
    });
    expect(row.authStatus).toBe('FAILED');
  });
});

describe('orphan sweep — what it must NOT touch', () => {
  it('leaves a PENDING row alone before cutoff, because the diner can still retry', async () => {
    // The retry path is the reconciliation this whole design leans on. Sweeping a
    // pre-cutoff row would kill it: the diner's next attempt would find a `FAILED`
    // row and start a fresh authorisation under a *new* id instead of replaying.
    const drop = await liveDrop({ minQty: 2, maxQty: 10 });
    const { participantId } = await orphan(drop, 1);
    await agePastGrace(drop.id);
    // Cutoff deliberately left in the future.

    const tick = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      maxDrops: 5,
    });

    expect(tick.orphanedPending, 'nothing swept pre-cutoff').toBe(0);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true },
    });
    expect(row.authStatus, 'still retryable').toBe('PENDING');
  });

  it('leaves a row inside the grace window alone, even past cutoff', async () => {
    // The race this window exists for: a join reserved a millisecond before cutoff
    // and records its answer a millisecond after. Sweeping it would leave a
    // confirmed hold on a `FAILED` row — a diner charged for a plate the system
    // believes they never took.
    const drop = await liveDrop({ minQty: 2, maxQty: 10 });
    const { participantId } = await orphan(drop, 1);
    await reachCutoff(drop.id);
    // `createdAt` is now — inside the window.

    const tick = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      maxDrops: 5,
    });

    expect(tick.orphanedPending, 'nothing swept inside the window').toBe(0);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true },
    });
    expect(row.authStatus).toBe('PENDING');
  });

  it('never touches AUTHORIZED rows, which have a real hold to account for', async () => {
    // An `AUTHORIZED` row is the void sweep's business, not this one's. If this
    // sweep widened to it, a declined diner's hold would be marked `FAILED` instead
    // of `VOIDED` — the hold would stay live while the row said it was dealt with.
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    await paidJoin(drop, 2);
    await agePastGrace(drop.id);
    await reachCutoff(drop.id);

    const result = await resolveOrphanedPendingJoins({ now: new Date(), limit: 50 });
    expect(result.resolved, 'no PENDING rows to resolve').toBe(0);

    const rows = await prisma.dropParticipant.findMany({
      where: { dropId: drop.id },
      select: { authStatus: true },
    });
    expect(rows.every((row) => row.authStatus === 'AUTHORIZED')).toBe(true);
  });

  it('does not resolve a PENDING row on a drop that is still DRAFT', async () => {
    // A `DRAFT` has never been joinable, so a `PENDING` row on one cannot be a
    // diner waiting on a provider — it is a data error of another kind, and
    // silently marking it `FAILED` would hide it.
    const id = await fixtures.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1112,
      minQty: 2,
      maxQty: 10,
      status: 'DRAFT',
      cutoffAt: new Date(Date.now() + 3_600_000),
    } as never);
    const drop = { id, publicCode: 'draft-not-joinable' };
    // `participant()` mints its own customer; there is no separate `customer()`
    // helper, and passing one would have been a signature error rather than a test.
    const participantId = await fixtures.participant({
      dropId: id,
      qty: 1,
      authStatus: 'PENDING',
    });
    await prisma.dropParticipant.updateMany({
      where: { id: participantId },
      data: { createdAt: new Date(Date.now() - ORPHAN_GRACE_MS - 60_000) },
    });
    await reachCutoff(drop.id);

    const result = await resolveOrphanedPendingJoins({ now: new Date(), limit: 50 });
    expect(result.resolved).toBe(0);

    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true },
    });
    expect(row.authStatus).toBe('PENDING');
  });

  it('loses the write to a join that resolved the row between the read and the update', async () => {
    // The lost-update guard, made causally exercised rather than assumed.
    //
    // `resolveOrphanedPendingJoins` is read-then-write: it selects `PENDING` rows,
    // then issues one `updateMany`. Between those two statements a diner can retry —
    // `service.ts` flips the row `PENDING → AUTHORIZED` under the drop lock — and the
    // sweep must not then clobber a row that now records a real hold. Without the
    // `authStatus: 'PENDING'` guard on the write it does exactly that, and the result
    // is an `AUTHORIZED` participant with a live hold at the provider marked `FAILED`
    // in our database: a diner charged for a plate the system believes they never
    // took, and no void sweep will ever look at that row again because the void queue
    // keys on `AUTHORIZED`.
    //
    // Measured: deleting that one predicate left **all eight** other tests green. A
    // guard nothing exercises is a comment with syntax, so this test forces the
    // interleave with a held row lock rather than hoping for a scheduling accident.
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    const { participantId } = await orphan(drop, 2);
    await agePastGrace(drop.id);
    await reachCutoff(drop.id);

    let announceLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      announceLock = resolve;
    });
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // The competing writer: takes the row lock, flips the row to `AUTHORIZED` with a
    // real intent id, then holds the lock so the sweep blocks on its own write until
    // the flip is visible to everyone else.
    const competitor = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "DropParticipant" WHERE id = ${participantId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE "DropParticipant" SET "authStatus" = 'AUTHORIZED', "paymentIntentId" = ${`pi_race_${Date.now()}`} WHERE id = ${participantId}`;
      announceLock();
      await released;
    });

    await lockHeld;

    let sweepSettled = false;
    const sweep = resolveOrphanedPendingJoins({ now: new Date(), limit: 50 }).then((result) => {
      sweepSettled = true;
      return result;
    });

    // If the sweep completed rather than blocking, this test is measuring nothing
    // and must say so instead of passing on a race it never created.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sweepSettled, 'the sweep must block on the row lock, not finish').toBe(false);

    releaseLock();
    const [result] = await Promise.all([sweep, competitor]);

    // The guard is what makes this `0`: by the time the write runs the row is no
    // longer `PENDING`, so the guarded `updateMany` matches nothing. Without the
    // guard it reports 1 and the assertions below fail.
    expect(result.resolved, 'the guard refuses the stale candidate').toBe(0);
    expect(result.resolvedRows, 'no row was won, so no diner may be messaged').toEqual([]);

    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true, paymentIntentId: true },
    });
    expect(row.authStatus, 'the concurrent resolve wins').toBe('AUTHORIZED');
    expect(row.paymentIntentId, 'and its hold is still recorded').not.toBeNull();
  });
});

/**
 * FR-506 for the orphaned diner.
 *
 * ## What changed
 *
 * The sweep used to resolve the row and stop. `decideFor` builds
 * `failedParticipants` from `readParticipants`, which selects `AUTHORIZED` only,
 * so a `PENDING/NONE` orphan was absent from phase 8 and heard nothing. The sweep
 * now returns the rows whose guarded write won, and the tick routes one of three
 * kinds by what the provider lookup established: released hold, no matching
 * intent, or unresolved.
 *
 * ## Why a sibling kind, not `DROP_FAILED_NO_CHARGE`
 *
 * That intent's copy ends "the hold on your card is released". On a `PENDING/NONE`
 * orphan no `paymentIntentId` has been written — it appears only on the
 * `PENDING → AUTHORIZED` transition — so a release was never observed by that
 * row. The sibling's copy names only the money outcome (no charge confirmed, no
 * money captured) and points a diner who sees a pending amount to the restaurant,
 * without claiming anything about a release. The copy and its obligations are
 * pinned in `src/lib/notify/__tests__/copy.test.ts`.
 *
 * Dated correction — 2026-11-17: the sibling is not the fallback for every
 * orphan. This case supplies a real lookup that answers `NOT_FOUND`, which is
 * the one fact that earns the no-confirmed-hold sentence. With no seam at all,
 * or with an ambiguous answer, the unresolved kind is sent instead; the test
 * below keeps the earlier coverage honest by asking the provider first.
 *
 * ## The two controls
 *
 * The paid diner's `DROP_FAILED_NO_CHARGE` is the positive control: the seam did
 * fire, so an orphan's message is a message rather than an artefact of a dead
 * port. The lost-write case is the negative control: a row whose guard lost to a
 * concurrent resolve must produce no intent at all, because its diner's hold is
 * real and this sweep did nothing to it.
 */
describe('orphan sweep — FR-506 tells the orphaned diner', () => {
  it('sends the resolved orphan a truthful intent, while the paid diner still gets theirs', async () => {
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    await paidJoin(drop, 1);
    const { phone: orphanPhone, participantId } = await orphan(drop, 2);
    await agePastGrace(drop.id);
    await reachCutoff(drop.id);
    // Ask the provider, so the no-confirmed-hold sentence below is earned by a
    // real empty search rather than by an omitted seam.
    const lookup = lookupReturning({ status: 'NOT_FOUND' });

    const sent: NotifyIntent[] = [];
    const recordingPort = {
      async notify(intents: readonly NotifyIntent[]) {
        sent.push(...intents);
      },
    };

    const tick = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      joinReconciliation: lookup.port,
      notify: recordingPort,
      maxDrops: 5,
    });

    // Setup sanity, asserted on *this* drop: earlier cases in the file leave
    // PUBLISHED-past-cutoff drops behind, so a bare `tick.failed === 1` would be
    // a claim about test order rather than about this orphan.
    const dropRow = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.id },
      select: { status: true },
    });
    expect(dropRow.status, 'the drop missed its threshold').toBe('FAILED');
    expect(tick.orphanedPending, 'a row was resolved').toBeGreaterThanOrEqual(1);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true },
    });
    expect(row.authStatus, 'this orphan is the one resolved').toBe('FAILED');

    // Positive control: the diner with a real hold is told through the existing
    // kind, so the recording port was genuinely wired into the tick.
    const paidIntents = sent.filter(
      (intent) =>
        intent.kind === 'DROP_FAILED_NO_CHARGE' && intent.participantId !== participantId,
    );
    expect(paidIntents.length, 'the paid diner is told').toBeGreaterThanOrEqual(1);

    // The orphan gets the sibling kind, addressed to them and carrying their
    // own drop and plate count — not a copy of the paid diner's intent.
    const orphanIntents = sent.filter(
      (intent): intent is Extract<NotifyIntent, { kind: 'DROP_FAILED_NO_CONFIRMED_HOLD' }> =>
        intent.kind === 'DROP_FAILED_NO_CONFIRMED_HOLD' &&
        intent.participantId === participantId,
    );
    expect(orphanIntents).toHaveLength(1);
    expect(orphanIntents[0]).toEqual({
      kind: 'DROP_FAILED_NO_CONFIRMED_HOLD',
      dropId: drop.id,
      participantId,
      phone: `+1${orphanPhone}`,
      qty: 2,
    });

    // No released-hold claim can reach this diner from the failure kinds.
    expect(
      sent.filter(
        (intent) => intent.kind === 'DROP_FAILED_NO_CHARGE' && intent.participantId === participantId,
      ),
      'the orphan is never sent the released-hold sentence',
    ).toEqual([]);
  });

  it('does not message a row whose guarded write lost to a concurrent join', async () => {
    // The negative control. The competitor flips the row to `AUTHORIZED` while
    // holding its row lock, exactly as a concurrent resolve would; the sweep
    // reads `PENDING`, blocks on its guarded write, and must then neither clobber
    // the row nor message the diner. No `paymentIntentId` is set deliberately:
    // the void sweep would otherwise see an AUTHORIZED row, try to cancel its
    // hold, and block on the same lock before the orphan sweep ever runs.
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    const { phone: orphanPhone, participantId } = await orphan(drop, 2);
    await agePastGrace(drop.id);
    await reachCutoff(drop.id);

    let announceLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      announceLock = resolve;
    });
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const competitor = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "DropParticipant" WHERE id = ${participantId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE "DropParticipant" SET "authStatus" = 'AUTHORIZED' WHERE id = ${participantId}`;
      announceLock();
      await released;
    });

    await lockHeld;

    const sent: NotifyIntent[] = [];
    const recordingPort = {
      async notify(intents: readonly NotifyIntent[]) {
        sent.push(...intents);
      },
    };
    const tickPromise = runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      notify: recordingPort,
      maxDrops: 5,
    });
    let tickSettled = false;
    const tick = tickPromise.then((result) => {
      tickSettled = true;
      return result;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(tickSettled, 'the tick must still be waiting on the row lock').toBe(false);

      releaseLock();
      const [result] = await Promise.all([tick, competitor]);

      expect(result.orphanedPending, 'the guard refused the stale candidate').toBe(0);
      expect(
        sent.filter((intent) => intent.participantId === participantId),
        'a row this sweep did not resolve produces no intent',
      ).toEqual([]);
      expect(
        sent.filter((intent) => intent.phone === `+1${orphanPhone}`),
        'and no message reaches that phone',
      ).toEqual([]);

      const row = await prisma.dropParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { authStatus: true, paymentIntentId: true },
      });
      expect(row.authStatus, 'the concurrent resolve wins').toBe('AUTHORIZED');
      expect(row.paymentIntentId).toBeNull();
    } finally {
      // An assertion above must never leave the competitor holding a row lock
      // into teardown.
      releaseLock();
      await competitor;
    }
  });
});

describe('orphan sweep — provider reconciliation', () => {
  async function accountId(): Promise<string> {
    const row = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { stripeAccountId: true },
    });
    if (!row.stripeAccountId) {
      throw new Error('the shared merchant has no connected account');
    }
    return row.stripeAccountId;
  }

  it('cancels a live hold found by metadata and says its release was observed', async () => {
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    const { participantId } = await knownOrphan(drop, 2);
    const lookup = lookupReturning({
      status: 'AUTHORIZED',
      paymentIntentId: 'pi_lost_live',
    });
    const charge = recordingChargePort();
    const sent: NotifyIntent[] = [];
    const notify = { async notify(intents: readonly NotifyIntent[]) { sent.push(...intents); } };

    const tick = await runCutoffTick({
      now: new Date(),
      port: charge as never,
      joinReconciliation: lookup.port,
      notify,
      maxDrops: 5,
    });

    expect(tick.orphanHoldsReleased, 'a hold was found and cancelled').toBe(1);
    expect(lookup.requests).toEqual([
      {
        participantId,
        dropId: drop.id,
        stripeAccountId: await accountId(),
      },
    ]);
    expect(charge.voids).toEqual([
      {
        participantId,
        stripeAccountId: await accountId(),
        paymentIntentId: 'pi_lost_live',
        idempotencyKey: `void:${participantId}`,
      },
    ]);

    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true, paymentIntentId: true },
    });
    expect(row).toEqual({ authStatus: 'VOIDED', paymentIntentId: 'pi_lost_live' });

    expect(
      sent.filter(
        (intent) =>
          intent.kind === 'DROP_FAILED_NO_CHARGE' && intent.participantId === participantId,
      ),
      'this diner may be told the hold was released',
    ).toHaveLength(1);
    expect(
      sent.filter((intent) => intent.participantId === participantId && intent.kind !== 'DROP_FAILED_NO_CHARGE'),
      'and must not hear the no-confirmed-hold or unresolved sentence',
    ).toEqual([]);
  });

  it('records EXPIRED when the provider says the hold already lapsed', async () => {
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    const { participantId } = await knownOrphan(drop, 1);
    const lookup = lookupReturning({
      status: 'EXPIRED',
      paymentIntentId: 'pi_lost_lapsed',
    });
    const charge = recordingChargePort();
    const sent: NotifyIntent[] = [];

    const tick = await runCutoffTick({
      now: new Date(),
      port: charge as never,
      joinReconciliation: lookup.port,
      notify: { async notify(intents) { sent.push(...intents); } },
      maxDrops: 5,
    });

    expect(tick.orphanHoldsExpired).toBe(1);
    expect(charge.voids, 'an already-lapsed hold must not be cancelled again').toEqual([]);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true, paymentIntentId: true },
    });
    expect(row).toEqual({ authStatus: 'EXPIRED', paymentIntentId: 'pi_lost_lapsed' });
    expect(
      sent.filter((intent) => intent.participantId === participantId).map((intent) => intent.kind),
    ).toEqual(['DROP_FAILED_NO_CHARGE']);
  });

  it('keeps the no-confirmed-hold sentence when the provider has no matching intent', async () => {
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    const { participantId } = await knownOrphan(drop, 2);
    const lookup = lookupReturning({ status: 'NOT_FOUND' });
    const sent: NotifyIntent[] = [];

    const tick = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      joinReconciliation: lookup.port,
      notify: { async notify(intents) { sent.push(...intents); } },
      maxDrops: 5,
    });

    expect(tick.orphanHoldsUnresolved).toBe(0);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true, paymentIntentId: true },
    });
    expect(row).toEqual({ authStatus: 'FAILED', paymentIntentId: null });
    expect(
      sent.filter((intent) => intent.participantId === participantId).map((intent) => intent.kind),
    ).toEqual(['DROP_FAILED_NO_CONFIRMED_HOLD']);
  });

  it('never claims no money was captured when the lookup could not answer', async () => {
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    const { participantId } = await knownOrphan(drop, 2);
    const lookup = await lookupThrowing(
      new JoinProviderUnavailableError('timeout', 'reconciliation: test timeout'),
    );
    const sent: NotifyIntent[] = [];

    const tick = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      joinReconciliation: lookup.port,
      notify: { async notify(intents) { sent.push(...intents); } },
      maxDrops: 5,
    });

    expect(tick.orphanHoldsUnresolved, 'the row is terminal but the answer is not').toBe(1);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true },
    });
    expect(row.authStatus).toBe('FAILED');
    const mine = sent.filter((intent) => intent.participantId === participantId);
    expect(mine.map((intent) => intent.kind)).toEqual(['DROP_FAILED_PROVIDER_UNRESOLVED']);
    expect(lookup.requests).toHaveLength(1);
  });

  it('does not claim a provider answer when no lookup port was supplied', async () => {
    // The default is not a hidden "provider said no match". A caller that omits
    // the seam has not checked Stripe at all, so the only honest outcome is the
    // unresolved one: terminal row, no money claim, and a message that sends the
    // diner to the restaurant. The old default returned NOT_FOUND and reached
    // the reassuring no-confirmed-hold copy without ever asking the provider.
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    const { participantId } = await knownOrphan(drop, 2);
    const sent: NotifyIntent[] = [];

    const tick = await runCutoffTick({
      now: new Date(),
      port: capturingPort() as never,
      notify: { async notify(intents) { sent.push(...intents); } },
      maxDrops: 5,
    });

    expect(tick.orphanHoldsUnresolved, 'no port means no provider answer').toBeGreaterThanOrEqual(1);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true },
    });
    expect(row.authStatus).toBe('FAILED');
    expect(
      sent.filter((intent) => intent.participantId === participantId).map((intent) => intent.kind),
    ).toEqual(['DROP_FAILED_PROVIDER_UNRESOLVED']);
  });

  it('does not cancel a hold when a concurrent join won the row after the lookup', async () => {
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    const { participantId } = await knownOrphan(drop, 2);
    let announceLookup!: () => void;
    const lookupCalled = new Promise<void>((resolve) => { announceLookup = resolve; });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookup: JoinReconciliationPort = {
      async findJoinAuthorisation() {
        announceLookup();
        await lookupGate;
        return { status: 'AUTHORIZED', paymentIntentId: 'pi_lost_race' };
      },
    };
    const charge = recordingChargePort();
    const sent: NotifyIntent[] = [];

    const tickPromise = runCutoffTick({
      now: new Date(),
      port: charge as never,
      joinReconciliation: lookup,
      notify: { async notify(intents) { sent.push(...intents); } },
      maxDrops: 5,
    });

    // The sweep has read the row and is waiting inside the read-only lookup. Let
    // a real join win the guarded write before the sweep can reach its own guard.
    await lookupCalled;
    await prisma.dropParticipant.update({
      where: { id: participantId },
      data: { authStatus: 'AUTHORIZED', paymentIntentId: 'pi_race_winner' },
    });
    releaseLookup();
    await tickPromise;

    expect(charge.voids, 'a hold this sweep did not own is never cancelled').toEqual([]);
    expect(
      sent.filter((intent) => intent.participantId === participantId),
      'and its diner is not messaged by this sweep',
    ).toEqual([]);
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { authStatus: true, paymentIntentId: true },
    });
    expect(row).toEqual({ authStatus: 'AUTHORIZED', paymentIntentId: 'pi_race_winner' });
  });
});

