import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { VOID_SWEEP_STATUSES } from '@/lib/settlement/drop-status';
import { fakeChargePort, type FakeChargePort } from '@/lib/settlement/fake-charge-port';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';
import type { NotifyIntent } from '@/lib/settlement/notify-port';

import { cancelDrop, cancelDropRefusal } from '../cancel';

/**
 * FR-208 — a merchant cancels a published drop, against real Postgres.
 *
 * ## What these tests protect, in descending order of cost-if-wrong
 *
 *   1. **The holds are actually released.** The whole point of the requirement. And
 *      the specific way it could silently fail is not obvious: the void sweep refuses
 *      any drop not in `VOID_SWEEP_STATUSES`, so if the status write came *after* the
 *      sweep, `PUBLISHED` would be refused and the sweep would return zero releases
 *      with no error. A test that only asserted "status is CANCELLED" would pass on a
 *      build where every diner's money stayed held.
 *   2. **The race with the cutoff resolves to exactly one outcome.** Cancel and the
 *      settlement tick both start from `PUBLISHED`. Either the drop is cancelled and
 *      never charged, or it is locked and the merchant is told the cutoff passed.
 *      There is no state where the merchant is told "cancelled" and cards are then
 *      charged — that is what the CAS in the `where` prevents.
 *   3. **A drop past the cutoff is refused, and refused with the right sentence.** A
 *      `LOCKED` drop is mid-capture; "try again in a moment" would be a lie.
 *   4. **The audit row records the reason, and is written before any provider call.**
 *      FR-208 says "reason required", which is only meaningful if it is stored.
 *   5. **Every diner is told, and told the no-charge sentence.** A cancellation before
 *      the cutoff never charged anyone, so a "refunded" message would send thirty
 *      people looking for a credit that does not exist.
 *
 * ## Why the drop is built by hand
 *
 * Same reason `force-fail.test.ts` does it: `publishDrop` needs Stripe and a frozen
 * snapshot, and these tests are about what happens *after* publish. The fixture writes
 * the drop in the state under test, with real `DropParticipant` rows whose
 * `paymentIntentId`s the fake port can recognise.
 */

const PREFIX = `cx${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

/** Every `User` made by `auditActor`, so teardown can remove them. See that function. */
const createdActorIds: string[] = [];

const DEAL_PRICE = 1250;

/** Collects intents so the copy half can be asserted without a sender. */
function recordingNotify(): { port: { notify(i: readonly NotifyIntent[]): Promise<void> }; intents: NotifyIntent[] } {
  const intents: NotifyIntent[] = [];
  return {
    intents,
    port: {
      async notify(batch) {
        intents.push(...batch);
      },
    },
  };
}

/**
 * A port that can void the drop's holds.
 *
 * No option is needed for the happy path: the fake answers `VOIDED` for any intent it
 * has not been told about, which is exactly what the real port does for a live
 * authorisation. The failure cases pass their own options.
 */
function livePort(): FakeChargePort {
  return fakeChargePort();
}

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { stripeAccountId: `acct_${PREFIX}` },
  });
});

afterAll(async () => {
  // Every step attempted, and the run still fails if any of them did. A throw in step
  // one must not skip the rest, or a *failing* run leaks more than a passing one.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // Actors **after** the fixtures. `AuditLog.actorUserId` is `SetNull`, so the drops can
  // go first; doing it in this order also means a failed `cleanup()` cannot leave the
  // actor delete skipped, which is how this file was leaking 14 accounts a run.
  await step(() => fx.cleanup());
  if (createdActorIds.length > 0) {
    await step(() => prisma.user.deleteMany({ where: { id: { in: createdActorIds } } }));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `teardown left the database dirty (${failures.length} step(s) failed)`);
  }
});

type Built = {
  dropId: string;
  publicCode: string;
  participantIds: string[];
};

/**
 * A drop with `holds` live authorisations, in the given status.
 *
 * `authStatus: 'AUTHORIZED'` with `chargeStatus: 'NONE'` is exactly the row the join
 * path writes after a successful hold, and exactly what the void sweep selects. A
 * `CAPTURED` participant would be invisible to it — which is why this fixture never
 * makes one: FR-208 cannot reach a captured drop at all.
 */
async function built(args: {
  holds?: number;
  status?: 'PUBLISHED' | 'LOCKED' | 'CAPTURED' | 'DRAFT' | 'CANCELLED' | 'COMPLETED' | 'FAILED';
  qty?: number;
  cutoffAt?: Date;
} = {}): Promise<Built> {
  const qty = args.qty ?? 2;
  const holdCount = args.holds ?? 3;

  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 5,
    maxQty: 40,
    status: args.status ?? 'PUBLISHED',
    // A real future cutoff by default, because a `PUBLISHED` drop whose cutoff has
    // passed is a drop the tick is about to lock — not a state to test cancellations
    // from by accident.
    cutoffAt: args.cutoffAt ?? new Date(Date.now() + 60 * 60 * 1000),
  });
  const drop = await prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: { publicCode: true },
  });

  const participantIds: string[] = [];
  for (let index = 0; index < holdCount; index += 1) {
    participantIds.push(
      await fx.participant({
        dropId,
        qty,
        chargeStatus: 'NONE',
        authStatus: 'AUTHORIZED',
        redemptionCode: null,
      }),
    );
  }

  return { dropId, publicCode: drop.publicCode, participantIds };
}

/**
 * A real `User` row, because `AuditLog.actorUserId` is a foreign key.
 *
 * Created per test so a failure cannot leave the rest pointing at a deleted actor,
 * where `onDelete: SetNull` would null it and the actor assertions would pass for the
 * wrong reason. `force-fail.test.ts` uses the same pattern for the same reason.
 *
 * **Tracked, because nothing else is going to delete it.** `fx.cleanup()` removes the
 * drop, the participants and the customers; it does not know about a `User` made here.
 * This file was leaving one account per test in the dev database — 14 per run, caught
 * by counting rows before and after, not by reading the teardown.
 */
async function auditActor(): Promise<{ userId: string; email: string }> {
  const email = `${PREFIX}-${Math.random().toString(36).slice(2, 8)}@groupeat.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: 'not-a-real-hash', role: 'MERCHANT' },
    select: { id: true },
  });
  createdActorIds.push(user.id);
  return { userId: user.id, email };
}

describe('cancelDropRefusal — the pure guards', () => {
  it('refuses a drop that does not exist, or is outside the caller’s scope', () => {
    expect(
      cancelDropRefusal({ drop: null, confirmPublicCode: 'X', reason: 'supplier' }),
    ).toEqual({ kind: 'NOT_FOUND' });
  });

  it('refuses a LOCKED drop, because the cutoff passed and settlement is capturing', () => {
    expect(
      cancelDropRefusal({
        drop: { status: 'LOCKED', publicCode: 'ABC123' },
        confirmPublicCode: 'ABC123',
        reason: 'supplier',
      }),
    ).toEqual({ kind: 'NOT_PUBLISHED', status: 'LOCKED' });
  });

  it('refuses a DRAFT, because there is nothing published to call off', () => {
    expect(
      cancelDropRefusal({
        drop: { status: 'DRAFT', publicCode: 'ABC123' },
        confirmPublicCode: 'ABC123',
        reason: 'supplier',
      }),
    ).toEqual({ kind: 'NOT_PUBLISHED', status: 'DRAFT' });
  });

  it('refuses a CAPTURED drop — that money has moved, so it is FR-902’s job', () => {
    expect(
      cancelDropRefusal({
        drop: { status: 'CAPTURED', publicCode: 'ABC123' },
        confirmPublicCode: 'ABC123',
        reason: 'supplier',
      }),
    ).toEqual({ kind: 'NOT_PUBLISHED', status: 'CAPTURED' });
  });

  it('requires a reason that is not just whitespace', () => {
    expect(
      cancelDropRefusal({
        drop: { status: 'PUBLISHED', publicCode: 'ABC123' },
        confirmPublicCode: 'ABC123',
        reason: '   ',
      }),
    ).toEqual({ kind: 'NO_REASON' });
  });

  it('requires the echoed public code to match', () => {
    expect(
      cancelDropRefusal({
        drop: { status: 'PUBLISHED', publicCode: 'ABC123' },
        confirmPublicCode: 'WRONG1',
        reason: 'supplier',
      }),
    ).toEqual({ kind: 'CODE_MISMATCH' });
  });

  it('allows a PUBLISHED drop with a reason and a matching code', () => {
    expect(
      cancelDropRefusal({
        drop: { status: 'PUBLISHED', publicCode: 'ABC123' },
        confirmPublicCode: 'ABC123',
        reason: 'supplier fell through',
      }),
    ).toBeNull();
  });

  /**
   * The reason the ordering in `cancelDrop` is what it is, asserted as a fact about
   * the guard rather than as a comment: `PUBLISHED` is **not** sweepable, so a void
   * attempted before the status flip would release nothing.
   *
   * If somebody ever adds `PUBLISHED` to that list, this test fails — and it should,
   * because it would mean a drop still taking joins could have its holds released.
   */
  it('PUBLISHED is not void-sweepable, which is why the status must be written first', () => {
    expect(VOID_SWEEP_STATUSES).not.toContain('PUBLISHED');
    expect(VOID_SWEEP_STATUSES).toContain('CANCELLED');
  });
});

describe('cancelDrop — against real Postgres', () => {
  it('cancels a published drop and releases every hold', async () => {
    const drop = await built({ holds: 3 });
    const actor = await auditActor();
    const notify = recordingNotify();

    const result = await cancelDrop({
      merchantIds: [merchantId],
      dropId: drop.dropId,
      confirmPublicCode: drop.publicCode,
      reason: 'Our supplier fell through for this week.',
      port: livePort(),
      notify: notify.port,
      actor,
    });

    expect(result.kind).toBe('CANCELLED');
    expect(result.voidedAuthorisations).toBe(3);
    expect(result.pendingVoids).toBe(0);

    const after = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.dropId },
      select: { status: true },
    });
    expect(after.status).toBe('CANCELLED');

    // Every participant's authorisation is released, and — the part that matters —
    // released through the real sweep, so the rows say what the provider was told.
    const participants = await prisma.dropParticipant.findMany({
      where: { dropId: drop.dropId },
      select: { authStatus: true, chargeStatus: true },
    });
    expect(participants).toHaveLength(3);
    for (const participant of participants) {
      expect(participant.authStatus).toBe('VOIDED');
      // Nothing was ever captured, so nothing is refunded. A `REFUNDED` here would
      // mean the cancel path issued refunds for money it never took.
      expect(participant.chargeStatus).toBe('NONE');
    }
  });

  it('tells every participant nobody was charged, never that they were refunded', async () => {
    const drop = await built({ holds: 2, qty: 3 });
    const actor = await auditActor();
    const notify = recordingNotify();

    await cancelDrop({
      merchantIds: [merchantId],
      dropId: drop.dropId,
      confirmPublicCode: drop.publicCode,
      reason: 'Kitchen closed for repairs.',
      port: livePort(),
      notify: notify.port,
      actor,
    });

    expect(notify.intents).toHaveLength(2);
    for (const intent of notify.intents) {
      // The sentence carries a monetary claim. Before the cutoff nothing was charged,
      // so `DROP_CANCELLED_REFUNDED` would be a false statement about a diner's money
      // — and the worst kind, because it sends them hunting for a credit.
      expect(intent.kind).toBe('DROP_CANCELLED_NO_CHARGE');
      expect(intent.qty).toBe(3);
    }
  });

  it('records the merchant’s reason on the audit row, twice — requested and completed', async () => {
    const drop = await built({ holds: 1 });
    const actor = await auditActor();
    const reason = 'Health inspector shut us down for two days.';

    const result = await cancelDrop({
      merchantIds: [merchantId],
      dropId: drop.dropId,
      confirmPublicCode: drop.publicCode,
      reason,
      port: livePort(),
      notify: recordingNotify().port,
      actor,
    });

    const rows = await prisma.auditLog.findMany({
      where: { targetId: drop.dropId, action: 'drop.cancel' },
      orderBy: { createdAt: 'asc' },
      select: { detail: true, actorEmail: true, actorUserId: true },
    });
    expect(rows).toHaveLength(2);

    const first = rows[0]?.detail as { stage?: string; reason?: string; previousStatus?: string };
    const second = rows[1]?.detail as { stage?: string; requestedAuditId?: string };

    // FR-208's "reason required" is only meaningful if it is stored. It goes here and
    // nowhere near the diners.
    expect(first.stage).toBe('REQUESTED');
    expect(first.reason).toBe(reason);
    expect(first.previousStatus).toBe('PUBLISHED');

    expect(second.stage).toBe('COMPLETED');
    expect(second.requestedAuditId).toBe(result.auditId);

    expect(rows[0]?.actorEmail).toBe(actor.email);
    expect(rows[0]?.actorUserId).toBe(actor.userId);
  });

  it('refuses a drop that another merchant owns, as a 404 rather than a 403', async () => {
    const drop = await built({ holds: 1 });
    const actor = await auditActor();
    const otherMerchant = await fx.merchant(`acct_other_${PREFIX}`);

    await expect(
      cancelDrop({
        merchantIds: [otherMerchant],
        dropId: drop.dropId,
        confirmPublicCode: drop.publicCode,
        reason: 'not mine',
        port: livePort(),
        notify: recordingNotify().port,
        actor,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // Nothing moved: a foreign id must not be a way to cancel somebody's drop.
    const after = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.dropId },
      select: { status: true },
    });
    expect(after.status).toBe('PUBLISHED');
  });

  it('refuses an empty merchant scope without touching the database', async () => {
    const drop = await built({ holds: 1 });
    const actor = await auditActor();

    await expect(
      cancelDrop({
        merchantIds: [],
        dropId: drop.dropId,
        confirmPublicCode: drop.publicCode,
        reason: 'no scope',
        port: livePort(),
        notify: recordingNotify().port,
        actor,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a second cancellation, and says so rather than pretending it just happened', async () => {
    const drop = await built({ holds: 1 });
    const actor = await auditActor();

    await cancelDrop({
      merchantIds: [merchantId],
      dropId: drop.dropId,
      confirmPublicCode: drop.publicCode,
      reason: 'first',
      port: livePort(),
      notify: recordingNotify().port,
      actor,
    });

    await expect(
      cancelDrop({
        merchantIds: [merchantId],
        dropId: drop.dropId,
        confirmPublicCode: drop.publicCode,
        reason: 'second',
        port: livePort(),
        notify: recordingNotify().port,
        actor,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // One cancellation, one pair of audit rows. A second pair would double the record
    // of a decision that was made once.
    const rows = await prisma.auditLog.findMany({
      where: { targetId: drop.dropId, action: 'drop.cancel' },
    });
    expect(rows).toHaveLength(2);
  });

  it('writes nothing when the confirmation code does not match', async () => {
    const drop = await built({ holds: 2 });
    const actor = await auditActor();
    const notify = recordingNotify();

    await expect(
      cancelDrop({
        merchantIds: [merchantId],
        dropId: drop.dropId,
        confirmPublicCode: 'NOTTHECODE',
        reason: 'supplier',
        port: livePort(),
        notify: notify.port,
        actor,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const after = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.dropId },
      select: { status: true },
    });
    expect(after.status).toBe('PUBLISHED');
    expect(notify.intents).toHaveLength(0);
    expect(
      await prisma.auditLog.count({ where: { targetId: drop.dropId, action: 'drop.cancel' } }),
    ).toBe(0);

    // And the holds are untouched — no provider call happened.
    const participants = await prisma.dropParticipant.findMany({
      where: { dropId: drop.dropId },
      select: { authStatus: true },
    });
    for (const participant of participants) {
      expect(participant.authStatus).toBe('AUTHORIZED');
    }
  });

  /**
   * ## The race, from the merchant's side
   *
   * The settlement tick selects `PUBLISHED` drops whose cutoff has passed and moves
   * them to `LOCKED`. This test models that write landing *first*, then asks the
   * cancel path to proceed. The CAS must lose, the merchant must be told the cutoff
   * passed, and — the assertion that matters — no hold may be released, because those
   * authorisations are about to be captured.
   */
  it('loses the race to the cutoff tick: refuses, releases nothing, charges nobody twice', async () => {
    const drop = await built({ holds: 2 });
    const actor = await auditActor();
    const notify = recordingNotify();

    // The tick's transition, exactly as `cutoff-decision.ts` writes it.
    await prisma.drop.updateMany({
      where: { id: drop.dropId, status: 'PUBLISHED' },
      data: { status: 'LOCKED' },
    });

    await expect(
      cancelDrop({
        merchantIds: [merchantId],
        dropId: drop.dropId,
        confirmPublicCode: drop.publicCode,
        reason: 'too late',
        port: livePort(),
        notify: notify.port,
        actor,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const after = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.dropId },
      select: { status: true },
    });
    // Settlement owns the drop now. Overwriting `LOCKED` with `CANCELLED` here is the
    // exact failure this test exists to prevent.
    expect(after.status).toBe('LOCKED');

    const participants = await prisma.dropParticipant.findMany({
      where: { dropId: drop.dropId },
      select: { authStatus: true },
    });
    for (const participant of participants) {
      // Still held, deliberately: they are about to be captured.
      expect(participant.authStatus).toBe('AUTHORIZED');
    }
    expect(notify.intents).toHaveLength(0);
  });

  /**
   * ## The race, from the merchant's side, winning
   *
   * The same race with the opposite winner. The cancellation lands first; the tick's
   * conditional write now matches nothing. Proven by performing the tick's `updateMany`
   * *after* the cancel and asserting it wrote zero rows — which is the property that
   * makes the pair safe, rather than an assumption about scheduling.
   */
  it('wins the race: the tick’s later conditional write matches nothing and cannot capture', async () => {
    const drop = await built({ holds: 2 });
    const actor = await auditActor();

    await cancelDrop({
      merchantIds: [merchantId],
      dropId: drop.dropId,
      confirmPublicCode: drop.publicCode,
      reason: 'cancelled just before the cutoff',
      port: livePort(),
      notify: recordingNotify().port,
      actor,
    });

    const tickWrite = await prisma.drop.updateMany({
      where: { id: drop.dropId, status: 'PUBLISHED' },
      data: { status: 'LOCKED' },
    });

    // Zero, not one. This is the whole safety story: the tick's `where` is what stops a
    // cancelled drop from being locked and charged.
    expect(tickWrite.count).toBe(0);

    const after = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.dropId },
      select: { status: true },
    });
    expect(after.status).toBe('CANCELLED');
  });

  it('reports pending voids instead of hiding a hold the provider could not release', async () => {
    const drop = await built({ holds: 2 });
    const actor = await auditActor();

    // A port whose void times out for both participants. `voidRemainingAuthorisations`
    // treats `PaymentProviderUnavailableError` as retryable and counts it as `pending`
    // rather than throwing — so the cancellation still succeeds and the merchant is
    // told the release is outstanding. Over-reporting here would be claiming a diner's
    // money was released when the provider never answered.
    const failingPort = fakeChargePort({ voidUnavailableOnceFor: drop.participantIds });

    const result = await cancelDrop({
      merchantIds: [merchantId],
      dropId: drop.dropId,
      confirmPublicCode: drop.publicCode,
      reason: 'supplier',
      port: failingPort,
      notify: recordingNotify().port,
      actor,
    });

    expect(result.voidedAuthorisations).toBe(0);
    expect(result.pendingVoids).toBe(2);

    // Still cancellation-succeeding: the status is what queues the retry, and
    // `CANCELLED` is in `VOID_SWEEP_STATUSES` so the tick's next pass finds it.
    const after = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.dropId },
      select: { status: true },
    });
    expect(after.status).toBe('CANCELLED');
  });

  it('counts an already-lapsed authorisation as released, not as a failure', async () => {
    const drop = await built({ holds: 1 });
    const actor = await auditActor();

    // The diner's issuer expired the hold before the merchant cancelled. The
    // authorisation is gone either way, so this must count as a release — a merchant
    // told "1 outstanding" about a hold that no longer exists would chase support for
    // nothing.
    const participants = await prisma.dropParticipant.findMany({
      where: { dropId: drop.dropId },
      select: { paymentIntentId: true },
    });
    const expired = participants
      .map((participant) => participant.paymentIntentId)
      .filter((id): id is string => id !== null);

    const result = await cancelDrop({
      merchantIds: [merchantId],
      dropId: drop.dropId,
      confirmPublicCode: drop.publicCode,
      reason: 'supplier',
      port: fakeChargePort({ expiredPaymentIntentIds: expired }),
      notify: recordingNotify().port,
      actor,
    });

    expect(result.voidedAuthorisations).toBe(1);
    expect(result.alreadyExpiredAuthorisations).toBe(1);
    expect(result.pendingVoids).toBe(0);
  });
});

/**
 * The interleaved race — the window the CAS actually guards.
 *
 * ## Why the test above this block was not enough
 *
 * The earlier "loses the race" test moves the drop to `LOCKED` **before** calling
 * `cancelDrop`. That exercises the *pre-check* in `cancelDropRefusal`, which refuses
 * anything that is not `PUBLISHED` — and it passes even with the CAS removed from the
 * `where` clause, because the function never reaches the write. Mutation-probing it
 * proved that: deleting `status: 'PUBLISHED'` from the `where` left all 19 tests
 * green, which meant the CAS was asserted by a comment rather than a test.
 *
 * The window that matters is between `loadDrop`'s read and the flip. That is a few
 * statements wide and no sequential test can open it, so this block opens it
 * deliberately: `prisma.drop.findFirst` is wrapped to let the *tick* write
 * `PUBLISHED → LOCKED` immediately after the read returns. The cancel path then holds
 * a stale `PUBLISHED` row in memory, which is exactly the state a real interleaving
 * produces.
 *
 * With the CAS: the flip matches nothing, the merchant gets a 409 naming the cutoff,
 * no hold is released, and the drop stays `LOCKED`. Without it: the flip overwrites
 * `LOCKED` with `CANCELLED` while settlement is capturing, and thirty diners are
 * charged for a drop their merchant was told was called off.
 */
describe('cancelDrop — interleaved against the cutoff tick', () => {
  /** Runs once, immediately after the next `drop.findFirst` resolves. */
  let interleaveAfterLoad: (() => Promise<void>) | null = null;

  beforeAll(() => {
    const real = prisma.drop.findFirst.bind(prisma.drop);
    vi.spyOn(prisma.drop, 'findFirst').mockImplementation(
      (async (...args: Parameters<typeof real>) => {
        const row = await real(...args);
        const pending = interleaveAfterLoad;
        if (pending) {
          // Cleared first, so a nested read from inside the tick cannot recurse.
          interleaveAfterLoad = null;
          await pending();
        }
        return row;
      }) as typeof real,
    );
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('refuses when the tick locks the drop between the read and the flip', async () => {
    const drop = await built({ holds: 2 });
    const actor = await auditActor();
    const notify = recordingNotify();

    // The tick's transition, deferred until the cancel path has read the drop and is
    // holding `PUBLISHED` in memory.
    interleaveAfterLoad = async () => {
      await prisma.drop.updateMany({
        where: { id: drop.dropId, status: 'PUBLISHED' },
        data: { status: 'LOCKED' },
      });
    };

    await expect(
      cancelDrop({
        merchantIds: [merchantId],
        dropId: drop.dropId,
        confirmPublicCode: drop.publicCode,
        reason: 'raced',
        port: livePort(),
        notify: notify.port,
        actor,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Without the CAS in the `where`, this reads `CANCELLED` — a drop the settlement
    // job is about to capture, marked as called off.
    const after = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.dropId },
      select: { status: true },
    });
    expect(after.status).toBe('LOCKED');

    const participants = await prisma.dropParticipant.findMany({
      where: { dropId: drop.dropId },
      select: { authStatus: true },
    });
    for (const participant of participants) {
      expect(participant.authStatus).toBe('AUTHORIZED');
    }

    // No audit row either: the cancellation never happened, so there is nothing to
    // record. A `REQUESTED` row here would describe an action that was refused.
    expect(
      await prisma.auditLog.count({ where: { targetId: drop.dropId, action: 'drop.cancel' } }),
    ).toBe(0);
    expect(notify.intents).toHaveLength(0);
  });

  it('still cancels when the interleaved write is a no-op, so the fixture proves a real race', async () => {
    // The control. Same instrumentation, an interleaved write that matches nothing —
    // the cancellation must succeed, which shows the refusal above came from the
    // status change and not from the spy being installed.
    const drop = await built({ holds: 1 });
    const actor = await auditActor();

    interleaveAfterLoad = async () => {
      await prisma.drop.updateMany({
        where: { id: drop.dropId, status: 'DRAFT' },
        data: { status: 'LOCKED' },
      });
    };

    const result = await cancelDrop({
      merchantIds: [merchantId],
      dropId: drop.dropId,
      confirmPublicCode: drop.publicCode,
      reason: 'control',
      port: livePort(),
      notify: recordingNotify().port,
      actor,
    });

    expect(result.kind).toBe('CANCELLED');
    expect(result.voidedAuthorisations).toBe(1);
  });
});
