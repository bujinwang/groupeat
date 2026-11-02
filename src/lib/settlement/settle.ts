import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';

import {
  type CaptureOutcome,
  captureKey,
  type ChargePort,
  isPaymentProviderUnavailable,
  refundKey,
  voidKey,
} from './charge-port';
import {
  captureToleranceOf,
  type LockedDrop,
  type LockedParticipant,
  loadLockedDrop,
} from './cutoff-decision';
import {
  assertLedgerReconciles,
  captureEntries,
  type LedgerEntryShape,
  refundEntries,
} from './ledger';
import { isVoidSweepStatus } from './drop-status';
import { type NotifyIntent, noopNotifyPort, type NotifyPort } from './notify-port';
import { signRedemptionCode } from './redemption-code';
import { orderUrl } from '@/lib/participant/order-page';
import { SettlementIntegrityError } from './settlement-error';

export { SettlementIntegrityError, isSettlementIntegrityError } from './settlement-error';
export type { SettlementIntegrityCheck } from './settlement-error';

/**
 * Phases 2 and 3 — capture, void, refund, finalise. Design §3.3, §4.2, §4.5.
 *
 * ## The invariant this module DEPENDS ON and does not enforce
 *
 * > `DropParticipant.platformFeeCents = qty × roundHalfUp(platformFeeAt(dealPriceCents, fees-in-force-at-publish))`
 * > — rounded **per unit**, then multiplied. **Settlement reads this value
 * > verbatim and does not recompute it** (§11.1), so a join path that rounds the
 * > order total instead would silently under- or over-charge the platform fee on
 * > every multi-unit order, and **no test in this slice can catch it**, because
 * > the fixtures set the value directly.
 * >
 * > The join path (M4 slice 2) is the writer and must satisfy this. Counter-example:
 * > at `dealPriceCents = 500` and three units, per-unit rounding gives
 * > `3 × 60 = 180` while order-total rounding gives `60`.
 *
 * That is a statement about where the responsibility sits, not a task: settlement
 * cannot verify the rounding rule, because the fee table in force at join time is
 * not recorded on the row. What settlement *does* check is the one identity it can
 * (`amountCents === qty × dealPriceCents`), and a mismatch stops the drop rather
 * than charging a number the diner never saw.
 *
 * ## Never advance a status ahead of the money it asserts (§4.5)
 *
 *   - `CAPTURED` is written only after every participant's capture attempt is
 *     terminal.
 *   - `FAILED` from S2 is written only after **every refund has succeeded**. The
 *     public page says "everyone who paid has been refunded in full" for a
 *     `FAILED` drop that had captures (§7), so writing it early would make the page
 *     lie — permanently, if a refund then failed and nobody retried.
 *   - Therefore a refund that fails retryably leaves the drop `LOCKED`, and the
 *     next tick tries again. `LOCKED` is the only honest state for "money is in
 *     flight".
 *
 * ## The window that remains open (§4.2), stated plainly
 *
 * A worker captures successfully at Stripe and dies before the database write
 * commits. The row still says `chargeStatus = 'NONE'`. The next tick re-captures
 * with the same idempotency key and Stripe returns the original charge — for 24
 * hours. Beyond that, a re-capture would create a second charge. Mitigation: before
 * calling the port, look for an existing `Order` with that `participantId`
 * (`Order_participantId_key` is unique). If one exists the charge already happened,
 * so `chargeStatus` is repaired to `CAPTURED` and the port is not called. That
 * closes the window for **any** retry, not just one inside 24 hours.
 *
 * The case that is **not** closed, and that this design does not claim to close: a
 * charge created at Stripe, with no `Order` row, and no tick for 24 hours. That is
 * M8's reconciliation job's job.
 *
 * ## No `new Date()` in this file
 *
 * `now` is threaded in from the tick (§11.2). The only clocks used here are the
 * database's `default(now())` on `Order.createdAt` and `LedgerEntry.createdAt`,
 * which is deliberate: the ledger is ordered by Postgres's clock, not by a possibly
 * skewed app server.
 */

export type SettleOutcome =
  | { readonly kind: 'NOT_LOCKED'; readonly dropId: string }
  | {
      readonly kind: 'IN_PROGRESS';
      readonly dropId: string;
      readonly capturedQty: number;
      readonly pendingParticipants: number;
    }
  | {
      readonly kind: 'CAPTURED';
      readonly dropId: string;
      readonly capturedQty: number;
      readonly declinedQty: number;
    }
  | {
      readonly kind: 'FAILED';
      readonly dropId: string;
      /**
       * `BELOW_THRESHOLD` is never emitted by `settle`: a drop whose threshold was
       * missed has no `LockedDrop`, so `settle` returns `NOT_LOCKED` and the
       * decision owns that path (§2.2). It stays in the union because callers
       * (M7's reporting, the tick's aggregate) reason about both failures with one
       * type.
       */
      readonly reason: 'BELOW_THRESHOLD' | 'BELOW_CAPTURE_TOLERANCE';
      readonly refundedCents: number;
    };

export type VoidSweepResult = {
  readonly voided: number;
  readonly alreadyExpired: number;
  readonly pending: number;
};

type ParticipantState = {
  authStatus: string;
  chargeStatus: string;
  redemptionCode: string | null;
};

const DEFAULT_MAX_PARTICIPANTS = 50;

async function readParticipantStates(dropId: string): Promise<Map<string, ParticipantState>> {
  const rows = await prisma.dropParticipant.findMany({
    where: { dropId },
    select: { id: true, authStatus: true, chargeStatus: true, redemptionCode: true },
  });
  const states = new Map<string, ParticipantState>();
  for (const row of rows) {
    states.set(row.id, {
      authStatus: row.authStatus,
      chargeStatus: row.chargeStatus,
      redemptionCode: row.redemptionCode,
    });
  }
  return states;
}

function sumQty(
  participants: readonly LockedParticipant[],
  states: ReadonlyMap<string, ParticipantState>,
  predicate: (state: ParticipantState) => boolean,
): number {
  return participants.reduce((total, participant) => {
    const state = states.get(participant.participantId);
    return state && predicate(state) ? total + participant.qty : total;
  }, 0);
}

function countPending(
  participants: readonly LockedParticipant[],
  states: ReadonlyMap<string, ParticipantState>,
): number {
  return participants.filter((participant) => {
    const state = states.get(participant.participantId);
    return state?.chargeStatus === 'NONE' && state.authStatus === 'AUTHORIZED';
  }).length;
}

/**
 * Capture, then finalise. Idempotent end to end: a second call on a settled drop
 * writes nothing and reaches no provider.
 */
export async function settle(args: {
  dropId: string;
  now: Date;
  port: ChargePort;
  notify?: NotifyPort;
  /**
   * The public origin a diner's SMS links to, e.g. `https://groupeat.app`.
   *
   * Passed in rather than read from env because the job may run behind a proxy and
   * the origin that reaches a diner has to be the public one. When absent, intents
   * carry no `orderUrl` — deliberately visible rather than defaulting to
   * `localhost`, which is the classic way a link arrives pointing at a laptop.
   */
  baseUrl?: string;
  /** Bounded per tick. Default 50. The rest is picked up next tick. */
  maxParticipants?: number;
}): Promise<SettleOutcome> {
  const { dropId, port, notify = noopNotifyPort(), baseUrl } = args;
  const maxParticipants = args.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;

  const locked = await loadLockedDrop({ dropId });
  if (!locked) {
    // Not an error (§2.2): a racing tick asking about a drop another tick just
    // finished is the normal outcome of two overlapping invocations.
    return { kind: 'NOT_LOCKED', dropId };
  }

  assertAmountsMatchTheDeal(locked);

  const states = await readParticipantStates(dropId);

  // ---------------------------------------------------------------------
  // Phase 2 — the money. One port call per participant, no lock held, one
  // transaction per unit of movement (§11.3).
  // ---------------------------------------------------------------------
  let attempts = 0;
  let truncated = false;

  for (const participant of locked.participants) {
    const state = states.get(participant.participantId);
    if (!state) {
      continue;
    }
    if (state.chargeStatus !== 'NONE') {
      // Already captured, declined or refunded by an earlier tick or another
      // worker. The database is the authority on what happened.
      continue;
    }
    if (state.authStatus !== 'AUTHORIZED') {
      // A voided or expired authorisation cannot be captured. Counting it as
      // pending would keep the drop in LOCKED for ever.
      continue;
    }

    // §4.2 mitigation: an existing Order row means the charge already happened at
    // Stripe and we lost the write. Repair instead of re-charging.
    const repaired = await repairFromExistingOrder(locked, participant);
    if (repaired) {
      state.chargeStatus = 'CAPTURED';
      continue;
    }

    if (attempts >= maxParticipants) {
      truncated = true;
      break;
    }
    attempts += 1;

    let outcome: CaptureOutcome;
    try {
      outcome = await port.capture({
        participantId: participant.participantId,
        dropId,
        stripeAccountId: locked.stripeAccountId,
        paymentIntentId: participant.paymentIntentId,
        amountCents: participant.amountCents,
        platformFeeCents: participant.platformFeeCents,
        idempotencyKey: captureKey(participant.participantId),
      });
    } catch (error) {
      if (isPaymentProviderUnavailable(error)) {
        // UNKNOWN state. Leave `chargeStatus = 'NONE'` so the next tick retries
        // with the same idempotency key, which is what makes the retry safe.
        continue;
      }
      throw error;
    }

    if (outcome.status === 'DECLINED') {
      // A decline is data, not an error (§3.1). The authorisation is left
      // `AUTHORIZED` on purpose: it still has to be *cancelled* at Stripe, and
      // that is the void sweep's job once the drop reaches a terminal state.
      await prisma.dropParticipant.updateMany({
        where: { id: participant.participantId, chargeStatus: 'NONE' },
        data: { chargeStatus: 'FAILED' },
      });
      state.chargeStatus = 'FAILED';
      logger.info('settlement.participant_declined', {
        dropId,
        participantId: participant.participantId,
        declineCode: outcome.declineCode,
      });
      continue;
    }

    const redemptionCode =
      state.redemptionCode ?? signRedemptionCode({
        participantId: participant.participantId,
        dropId,
        qty: participant.qty,
      });

    const wrote = await recordCapture({
      locked,
      participant,
      chargeId: outcome.chargeId,
      redemptionCode,
    });
    if (wrote) {
      state.redemptionCode = redemptionCode;
      logger.info('settlement.participant_captured', {
        dropId,
        participantId: participant.participantId,
        amountCents: participant.amountCents,
        platformFeeCents: participant.platformFeeCents,
      });
    }
    // Whether we wrote or another worker did, the participant is now CAPTURED.
    state.chargeStatus = 'CAPTURED';
  }

  if (truncated) {
    logger.info('settlement.batch_truncated', {
      dropsProcessed: 1,
      participantsProcessed: attempts,
    });
  }

  // ---------------------------------------------------------------------
  // Phase 3 — finalise. Status follows the money.
  // ---------------------------------------------------------------------
  const capturedQty = sumQty(
    locked.participants,
    states,
    (state) => state.chargeStatus === 'CAPTURED' || state.chargeStatus === 'REFUNDED',
  );
  const declinedQty = sumQty(locked.participants, states, (state) => state.chargeStatus === 'FAILED');
  const pending = countPending(locked.participants, states);

  if (pending > 0) {
    return { kind: 'IN_PROGRESS', dropId, capturedQty, pendingParticipants: pending };
  }

  const tolerance = captureToleranceOf(locked.minQty);

  if (capturedQty >= tolerance) {
    return finaliseCaptured({ locked, states, port, capturedQty, declinedQty, notify, baseUrl });
  }

  return finaliseFailed({ locked, states, port, notify, capturedQty });
}

/**
 * `amountCents === qty × dealPriceCents`, checked before anything is charged.
 *
 * The one thing settlement verifies about money (§11.1). It does **not** verify
 * the platform fee, because the fee table in force at join time is not recorded on
 * the row — see the module docblock.
 */
function assertAmountsMatchTheDeal(locked: LockedDrop): void {
  for (const participant of locked.participants) {
    const expected = participant.qty * locked.dealPriceCents;
    if (participant.amountCents !== expected) {
      throw new SettlementIntegrityError({
        dropId: locked.dropId,
        participantId: participant.participantId,
        check: 'AMOUNT_MISMATCH',
        detail: `amountCents is ${participant.amountCents} but ${participant.qty} × ${locked.dealPriceCents} = ${expected}. The diner was shown ${participant.amountCents}, so nothing is charged.`,
      });
    }
  }
}

/** The `Order`-row repair path described in the module docblock. */
async function repairFromExistingOrder(
  locked: LockedDrop,
  participant: LockedParticipant,
): Promise<boolean> {
  const existing = await prisma.order.findUnique({
    where: { participantId: participant.participantId },
    select: { id: true, stripeChargeId: true, subtotalCents: true, platformFeeCents: true },
  });
  if (!existing) {
    return false;
  }

  await prisma.$transaction(async (tx) => {
    await tx.dropParticipant.updateMany({
      where: { id: participant.participantId, chargeStatus: 'NONE' },
      data: { chargeStatus: 'CAPTURED' },
    });

    // The `Order` and its two ledger rows are written in one transaction, so an
    // existing `Order` implies an existing ledger — but the repair does not rest
    // on that inference. `skipDuplicates` against `@@unique([orderId, type])`
    // makes the backfill a no-op when the rows are there and a repair when they
    // are not, and either way the drop's L1–L4 identities hold afterwards.
    const entries = captureEntries({
      dropId: locked.dropId,
      order: existing,
      stripeRef: existing.stripeChargeId ?? '',
    });
    await tx.ledgerEntry.createMany({ data: [...entries], skipDuplicates: true });
  });

  logger.info('settlement.participant_captured', {
    // The same event as a capture, deliberately: from the ledger's point of view
    // this *is* a capture — the `Order` row is the evidence that it happened. A
    // separate event would double the log volume of an incident for no extra
    // information.
    dropId: locked.dropId,
    participantId: participant.participantId,
    amountCents: participant.amountCents,
    platformFeeCents: participant.platformFeeCents,
  });

  return true;
}

/**
 * One unit of money movement, one transaction (§11.3): the participant CAS, the
 * `Order`, and two ledger rows.
 *
 * The CAS is first and is the guard: a second worker that also captured writes 0
 * rows here and therefore writes no `Order` and no ledger entry. The unique index
 * on `(orderId, type)` is the third, independent barrier (§4.2).
 */
async function recordCapture(args: {
  locked: LockedDrop;
  participant: LockedParticipant;
  chargeId: string;
  redemptionCode: string;
}): Promise<boolean> {
  const { locked, participant, chargeId, redemptionCode } = args;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.dropParticipant.updateMany({
      where: { id: participant.participantId, chargeStatus: 'NONE' },
      data: { chargeStatus: 'CAPTURED', redemptionCode },
    });
    if (claimed.count !== 1) {
      return false;
    }

    const order = await tx.order.create({
      data: {
        dropId: locked.dropId,
        participantId: participant.participantId,
        qty: participant.qty,
        unitPriceCents: locked.dealPriceCents,
        subtotalCents: participant.amountCents,
        platformFeeCents: participant.platformFeeCents,
        stripeChargeId: chargeId,
      },
      select: { id: true, subtotalCents: true, platformFeeCents: true },
    });

    const entries: readonly LedgerEntryShape[] = captureEntries({
      dropId: locked.dropId,
      order,
      stripeRef: chargeId,
    });
    await tx.ledgerEntry.createMany({ data: [...entries] });

    return true;
  });
}

async function finaliseCaptured(args: {
  locked: LockedDrop;
  states: ReadonlyMap<string, ParticipantState>;
  port: ChargePort;
  capturedQty: number;
  declinedQty: number;
  notify: NotifyPort;
  baseUrl?: string;
}): Promise<SettleOutcome> {
  const { locked, states, port, capturedQty, declinedQty, notify, baseUrl } = args;

  const updated = await prisma.drop.updateMany({
    where: { id: locked.dropId, status: 'LOCKED' },
    data: { status: 'CAPTURED' },
  });
  if (updated.count !== 1) {
    // Another worker finalised it between our state read and this write. It did
    // the same work; report what the database says rather than throwing.
    return { kind: 'NOT_LOCKED', dropId: locked.dropId };
  }

  const orders = await prisma.order.findMany({
    where: { dropId: locked.dropId },
    select: { id: true, participantId: true, subtotalCents: true, platformFeeCents: true },
  });
  const chargedCents = orders.reduce((total, order) => total + order.subtotalCents, 0);

  await assertDropReconciles(locked.dropId, states);

  // After the status write, so the sweep's own guard (it refuses to touch a
  // non-terminal drop) can never void an authorisation that is still needed.
  await voidRemainingAuthorisations({ dropId: locked.dropId, port });

  logger.info('settlement.drop_settled', {
    dropId: locked.dropId,
    capturedQty,
    declinedQty,
    chargedCents,
  });

  await deliver(notify, buildCapturedIntents({ locked, states, orders, baseUrl }));

  return { kind: 'CAPTURED', dropId: locked.dropId, capturedQty, declinedQty };
}

async function finaliseFailed(args: {
  locked: LockedDrop;
  states: ReadonlyMap<string, ParticipantState>;
  port: ChargePort;
  notify: NotifyPort;
  capturedQty: number;
}): Promise<SettleOutcome> {
  const { locked, states, port, notify, capturedQty } = args;

  const orders = await prisma.order.findMany({
    where: { dropId: locked.dropId },
    select: { id: true, participantId: true, subtotalCents: true, platformFeeCents: true, stripeChargeId: true },
  });

  let refundedCents = 0;
  let refundsPending = 0;

  for (const participant of locked.participants) {
    const state = states.get(participant.participantId);
    if (!state || state.chargeStatus !== 'CAPTURED') {
      continue;
    }
    const order = orders.find((candidate) => candidate.participantId === participant.participantId);
    if (!order) {
      throw new SettlementIntegrityError({
        dropId: locked.dropId,
        participantId: participant.participantId,
        check: 'LEDGER_MISMATCH',
        detail: 'a captured participant has no Order row, so there is nothing to refund against',
      });
    }
    if (!order.stripeChargeId) {
      throw new SettlementIntegrityError({
        dropId: locked.dropId,
        participantId: participant.participantId,
        check: 'LEDGER_MISMATCH',
        detail: 'a captured Order has no stripeChargeId, so it cannot be refunded',
      });
    }

    try {
      const outcome = await port.refund({
        participantId: participant.participantId,
        stripeAccountId: locked.stripeAccountId,
        chargeId: order.stripeChargeId,
        amountCents: order.subtotalCents,
        platformFeeCents: order.platformFeeCents,
        // Not configurable: under a direct charge the application fee is only
        // reversed when asked for explicitly (ADR-001 §3.2).
        reverseApplicationFee: true,
        idempotencyKey: refundKey(participant.participantId),
      });

      await recordRefund({ dropId: locked.dropId, participantId: participant.participantId, order, stripeRef: outcome.status === 'REFUNDED' ? outcome.refundId : order.stripeChargeId });
      state.chargeStatus = 'REFUNDED';
      refundedCents += order.subtotalCents;
    } catch (error) {
      if (!isPaymentProviderUnavailable(error)) {
        throw error;
      }
      refundsPending += 1;
    }
  }

  if (refundsPending > 0) {
    // §4.5: `FAILED` asserts "everyone who paid has been refunded in full". Until
    // that is true the drop stays LOCKED and the next tick retries.
    return {
      kind: 'IN_PROGRESS',
      dropId: locked.dropId,
      capturedQty,
      pendingParticipants: refundsPending,
    };
  }

  const updated = await prisma.drop.updateMany({
    where: { id: locked.dropId, status: 'LOCKED' },
    data: { status: 'FAILED' },
  });
  if (updated.count !== 1) {
    return { kind: 'NOT_LOCKED', dropId: locked.dropId };
  }

  await assertDropReconciles(locked.dropId, states);

  logger.info('settlement.drop_failed', {
    dropId: locked.dropId,
    reason: 'BELOW_CAPTURE_TOLERANCE',
    refundedCents,
  });

  await deliver(notify, buildFailedIntents({ locked, states, orders }));
  await voidRemainingAuthorisations({ dropId: locked.dropId, port });

  return {
    kind: 'FAILED',
    dropId: locked.dropId,
    reason: 'BELOW_CAPTURE_TOLERANCE',
    refundedCents,
  };
}

async function recordRefund(args: {
  dropId: string;
  participantId: string;
  order: { id: string; subtotalCents: number; platformFeeCents: number };
  stripeRef: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.dropParticipant.updateMany({
      where: { id: args.participantId, chargeStatus: 'CAPTURED' },
      data: { chargeStatus: 'REFUNDED' },
    });
    if (claimed.count !== 1) {
      return;
    }
    const entries = refundEntries({
      dropId: args.dropId,
      order: args.order,
      refundedCents: args.order.subtotalCents,
      stripeRef: args.stripeRef,
    });
    await tx.ledgerEntry.createMany({ data: [...entries] });
  });
}

/**
 * L1–L4, asserted at every terminal transition.
 *
 * Reading the entries back from the database rather than summing the shapes we
 * just wrote is the point: the assertion is about what is stored, which is what
 * M8 will reconcile against.
 */
async function assertDropReconciles(
  dropId: string,
  states: ReadonlyMap<string, ParticipantState>,
): Promise<void> {
  const [entryRows, orderRows] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { dropId },
      select: { orderId: true, dropId: true, type: true, amountCents: true, stripeRef: true, note: true },
    }),
    prisma.order.findMany({
      where: { dropId },
      select: { id: true, participantId: true, subtotalCents: true, platformFeeCents: true },
    }),
  ]);

  const entries: LedgerEntryShape[] = entryRows.map((row) => ({
    orderId: row.orderId,
    dropId: row.dropId ?? dropId,
    type: row.type,
    amountCents: row.amountCents,
    stripeRef: row.stripeRef,
    note: row.note,
  }));

  const orders = orderRows.map((order) => ({
    id: order.id,
    subtotalCents: order.subtotalCents,
    platformFeeCents: order.platformFeeCents,
    refunded: states.get(order.participantId)?.chargeStatus === 'REFUNDED',
  }));

  assertLedgerReconciles({ dropId, entries, orders });
}

/**
 * The V1 sweep (§2.1). Voids every authorisation still held on a **terminal**
 * drop.
 *
 * Guarded by the drop's status, and that guard is the whole safety story: a
 * `LOCKED` drop has authorisations that are about to be captured, and voiding one
 * would turn a diner's confirmed order into a silent failure. So this function
 * reads the status and refuses anything that is not in `VOID_SWEEP_STATUSES`.
 *
 * **The list lives in `drop-status.ts` and `findDropsAwaitingVoid` imports the same
 * one.** It used to be two literals in two files, and they disagreed: the queue
 * said `FAILED`, this guard said `FAILED | CAPTURED`, and a declined diner's hold
 * on a successful drop was never retried. A comment saying the two must match could
 * not prevent that; a shared constant can, because there is now only one list to
 * edit.
 *
 * The guard stays even though the queue filters, because a drop can reach this
 * function by other paths — `finaliseCaptured` calls it directly, and so does the
 * tick's loop — and only one of them is the queue.
 *
 * ## Why the retry warning is logged here and not at the call site
 *
 * A void that the provider could not answer leaves a diner's authorisation held —
 * about seven days, until the issuer expires it — and the only trace is a log
 * line. It used to be `finaliseCaptured`'s job to log it, and `finaliseCaptured`
 * discarded the result, so it was logged nowhere and the hold was silent (QA,
 * `settle.void-sweep.test.ts`). Logging inside the sweep means no caller can
 * discard it: the tick's loop and both finalise paths get the warning for free.
 *
 * It is a warning and not a throw. The drop's own status is already correct — the
 * money has moved, or was never taken — and the release is a cleanup that the
 * queue will retry. Turning it into an error would fail a tick that did its job.
 *
 * Idempotent: it only touches `authStatus = 'AUTHORIZED'` with a charge that is
 * still `NONE` or `FAILED`, so a second pass over the same drop costs one query
 * and changes nothing.
 */
export async function voidRemainingAuthorisations(args: {
  dropId: string;
  port: ChargePort;
  maxParticipants?: number;
}): Promise<VoidSweepResult> {
  const maxParticipants = args.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;

  const drop = await prisma.drop.findUnique({
    where: { id: args.dropId },
    select: { status: true, merchant: { select: { stripeAccountId: true } } },
  });

  if (!drop || !isVoidSweepStatus(drop.status)) {
    return { voided: 0, alreadyExpired: 0, pending: 0 };
  }
  if (!drop.merchant.stripeAccountId) {
    throw new SettlementIntegrityError({
      dropId: args.dropId,
      check: 'MISSING_STRIPE_ACCOUNT',
      detail: 'cannot void an authorisation without the connected account',
    });
  }

  const participants = await prisma.dropParticipant.findMany({
    where: {
      dropId: args.dropId,
      authStatus: 'AUTHORIZED',
      // A captured participant keeps a live-looking authStatus; its authorisation
      // was consumed by the capture and there is nothing to cancel.
      chargeStatus: { in: ['NONE', 'FAILED'] },
    },
    select: { id: true, paymentIntentId: true },
    take: maxParticipants,
    orderBy: { createdAt: 'asc' },
  });

  let voided = 0;
  let alreadyExpired = 0;
  let pending = 0;

  for (const participant of participants) {
    if (!participant.paymentIntentId) {
      // Nothing to void, and nothing that can be captured either. Leave it.
      continue;
    }
    try {
      const outcome = await args.port.voidAuthorization({
        participantId: participant.id,
        stripeAccountId: drop.merchant.stripeAccountId,
        paymentIntentId: participant.paymentIntentId,
        idempotencyKey: voidKey(participant.id),
      });

      // Both outcomes mean the hold is gone. `ALREADY_EXPIRED` is terminal and is
      // not a failure: the diner's money is released either way.
      await prisma.dropParticipant.updateMany({
        where: { id: participant.id, authStatus: 'AUTHORIZED' },
        data: { authStatus: 'VOIDED' },
      });

      if (outcome.status === 'VOIDED') {
        voided += 1;
      } else {
        alreadyExpired += 1;
      }
      logger.info('settlement.participant_voided', { dropId: args.dropId, participantId: participant.id });
    } catch (error) {
      if (!isPaymentProviderUnavailable(error)) {
        throw error;
      }
      pending += 1;
    }
  }

  if (pending > 0) {
    // A diner's authorisation is still held and nothing else will say so. See the
    // docblock: this warning lives here so that no caller can drop it.
    logger.warn('settlement.void_pending', { dropId: args.dropId, pendingParticipants: pending });
  }

  return { voided, alreadyExpired, pending };
}

function buildCapturedIntents(args: {
  locked: LockedDrop;
  states: ReadonlyMap<string, ParticipantState>;
  orders: readonly { participantId: string; subtotalCents: number }[];
  baseUrl?: string;
}): NotifyIntent[] {
  const { locked, states, orders, baseUrl } = args;
  const intents: NotifyIntent[] = [];

  for (const participant of locked.participants) {
    const state = states.get(participant.participantId);
    if (!state) {
      continue;
    }
    if (state.chargeStatus === 'CAPTURED' || state.chargeStatus === 'REFUNDED') {
      const order = orders.find((candidate) => candidate.participantId === participant.participantId);
      if (!order || !state.redemptionCode) {
        continue;
      }
      intents.push({
        kind: 'DROP_CONFIRMED_CHARGED',
        dropId: locked.dropId,
        participantId: participant.participantId,
        phone: participant.phone,
        // Gross: what the diner's card was debited (§11.1, CONTRIBUTING's
        // fee-inclusive rule — the sentence names no fee, but the number the diner
        // reads on their statement is the charge, not the charge minus our fee).
        chargedCents: order.subtotalCents,
        qty: participant.qty,
        redemptionCode: state.redemptionCode,
        // A 200-character code cannot be typed at a counter, so the message's job
        // is to carry a link to `/d/:publicCode/mine`, where the diner sees it and
        // the counter can scan it. Absent when no public origin was supplied —
        // better no link than one pointing at localhost.
        ...(baseUrl
          ? {
              orderUrl: orderUrl({
                baseUrl,
                publicCode: locked.publicCode,
                participantId: participant.participantId,
                dropId: locked.dropId,
              }),
            }
          : {}),
        windowStart: locked.windowStart,
        windowEnd: locked.windowEnd,
      });
    } else if (state.chargeStatus === 'FAILED') {
      intents.push({
        kind: 'DROP_CONFIRMED_CARD_DECLINED',
        dropId: locked.dropId,
        participantId: participant.participantId,
        phone: participant.phone,
        qty: participant.qty,
      });
    }
  }

  return intents;
}

function buildFailedIntents(args: {
  locked: LockedDrop;
  states: ReadonlyMap<string, ParticipantState>;
  orders: readonly { participantId: string; subtotalCents: number }[];
}): NotifyIntent[] {
  const { locked, states, orders } = args;
  const intents: NotifyIntent[] = [];

  for (const participant of locked.participants) {
    const state = states.get(participant.participantId);
    if (!state) {
      continue;
    }
    if (state.chargeStatus === 'REFUNDED') {
      const order = orders.find((candidate) => candidate.participantId === participant.participantId);
      intents.push({
        kind: 'DROP_FAILED_REFUNDED',
        dropId: locked.dropId,
        participantId: participant.participantId,
        phone: participant.phone,
        chargedCents: order?.subtotalCents ?? participant.amountCents,
        qty: participant.qty,
      });
    } else {
      intents.push({
        kind: 'DROP_FAILED_NO_CHARGE',
        dropId: locked.dropId,
        participantId: participant.participantId,
        phone: participant.phone,
        qty: participant.qty,
      });
    }
  }

  return intents;
}

/**
 * Notification must never fail settlement (§3.5). The port's contract says it
 * cannot throw; this catch is the belt to that braces, because the consequence of
 * being wrong is a settled drop stranded in `LOCKED`.
 */
async function deliver(notify: NotifyPort, intents: readonly NotifyIntent[]): Promise<void> {
  if (intents.length === 0) {
    return;
  }
  try {
    await notify.notify(intents);
  } catch (error) {
    logger.warn('notification.failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}


