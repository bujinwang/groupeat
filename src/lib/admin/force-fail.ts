import { prisma } from '@/lib/db/prisma';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logging/logger';

import { writeAuditEntry } from '@/lib/audit/log';
import { deliver, type NotifyIntent } from '@/lib/settlement/notify-port';
import { refundKey, type ChargePort } from '@/lib/settlement/charge-port';
import { refundEntries } from '@/lib/settlement/ledger';
import { SettlementIntegrityError } from '@/lib/settlement/settlement-error';
import { voidRemainingAuthorisations } from '@/lib/settlement/settle';
import type { NotifyPort } from '@/lib/settlement/notify-port';

/**
 * FR-902 — force-fail a drop and refund everyone.
 *
 * > `FR-902 | Force-fail a drop and refund all | Double confirmation, audit log entry`
 * > — PRD-v1.md:549
 *
 * ## The confirmation is not this function's job
 *
 * The PRD's acceptance criterion is "double confirmation, audit log entry". The
 * double confirmation is a **UI obligation** — two deliberate presses by a human —
 * and it cannot be enforced server-side, because any HTTP client can POST twice. What
 * the server can do, and what this file does, is make the consequence explicit: the
 * caller must pass the drop's `publicCode` back, so a request that arrives at the
 * wrong drop fails rather than refunding it. That is the server-side half of the
 * confirmation, and it is why `confirmPublicCode` is a required argument rather than
 * an optional one.
 *
 * The audit entry is written **before any money moves**. See the ordering note below.
 *
 * ## The order of operations, and why it is this order
 *
 * ```
 * 1. read the drop, its orders, and every participant          (one round trip)
 * 2. refuse what cannot be cancelled, with a sentence          (guards, no I/O)
 * 3. write the audit row                                       (BEFORE the money)
 * 4. refund every captured order, one at a time                (provider calls)
 * 5. one transaction: the drop's status, the ledger, per-participant CAS
 * 6. release the remaining authorisations                      (the existing sweep)
 * 7. notify every participant
 * ```
 *
 * Step 3 before step 4 is the inverse of the usual ordering and it is deliberate.
 * `lib/audit/log.ts` throws rather than swallowing, and its docblock states the
 * consequence: a caller must not refund every participant if the record of who
 * authorised it could not be written. Doing the audit write first makes that a
 * structural guarantee instead of a hope — if the insert fails, no provider call has
 * happened yet, and the operator gets an error with the drop untouched.
 *
 * The cost is a row that names an action which then failed partway. That is the
 * correct trade for an irreversible operation: a record of an attempted force-fail
 * is useful, and its absence is what FR-902 exists to prevent. The `detail` carries
 * the *intent* (the counts and amounts about to be refunded); step 5's completion is
 * recorded by a second row, so the trail distinguishes "asked" from "done".
 *
 * ## Why it refuses a drop that is not already terminal
 *
 * A `PUBLISHED` drop with live authorisations and no captures is a *cancellation*
 * (FR-208), not a force-fail: nothing has been charged, so "refund all" is a no-op
 * and the work is releasing holds. A `LOCKED` drop is mid-capture — refunding it
 * while the settlement job is live would race that job, and the ledger would be
 * written twice. So this function accepts exactly the statuses a *capture* can have
 * reached, plus `PUBLISHED`, and it refuses `LOCKED` and `DRAFT` with a sentence.
 *
 * ## Why it does not use the settlement tick
 *
 * `finaliseFailed` already refunds everyone and writes `FAILED`. Reusing it was the
 * first instinct and it is wrong twice: it requires a `LockedDrop` snapshot the admin
 * path has no way to build honestly, and it writes `FAILED` — which would tell every
 * diner and every report that the drop missed its minimum. The refund *mechanics*
 * are shared (`refundKey`, `refundEntries`, `assertLedgerReconciles`); the *outcome*
 * must not be.
 */

/**
 * The statuses a force-fail may act on. `LOCKED` and `DRAFT` are absent on purpose.
 *
 * Exported because the admin drops list (FR-901) has to decide **per row** whether to
 * offer the control, and the answer must be this list rather than a second one that
 * agrees today. A UI that offers force-fail on a `LOCKED` drop teaches the operator
 * that the button exists and the server is broken; a UI that hides it on `PUBLISHED`
 * hides the one case the button is actually for.
 *
 * `PUBLISHED` is included deliberately, and it is not a mistake: an admin force-fail on
 * a published drop is legal (there may be captures from a partial settlement attempt,
 * and `forceFailDrop` handles zero-capture drops too). The *merchant's* cancellation is
 * the narrower operation — see `drops/cancel.ts`.
 */
export const FORCE_FAILABLE = [
  'PUBLISHED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'FAILED',
] as const;

export type ForceFailableStatus = (typeof FORCE_FAILABLE)[number];

/** True when the admin surface should offer a force-fail for this status. */
export function isForceFailable(status: string): status is ForceFailableStatus {
  return (FORCE_FAILABLE as readonly string[]).includes(status);
}

export type ForceFailOutcome = {
  readonly kind: 'CANCELLED';
  readonly dropId: string;
  /**
   * What **this call** refunded. Never a drop total.
   *
   * An earlier draft accumulated earlier manual refunds into this number, and the two
   * paths disagreed about whether that happened: a participant already marked
   * `REFUNDED` was filtered out before the counting loop, while one left `CAPTURED`
   * with a non-zero total was added to it. The same drop could report two different
   * figures depending on which half-finished state it happened to be in — and an
   * operator comparing the number against Stripe would have found the difference with
   * no way to explain it.
   *
   * So the two are separate fields and neither ever absorbs the other.
   */
  readonly refundedCents: number;
  readonly platformFeeReversedCents: number;
  readonly refundedParticipants: number;
  /**
   * Participants somebody had already refunded by hand (FR-903) before the drop was
   * called off. Reported rather than folded in, so the operator can tell "I returned
   * $50" from "$50 of it was already back".
   */
  readonly alreadyRefundedParticipants: number;
  readonly alreadyRefundedCents: number;
  /** Authorisations released by the sweep. Reported because it is the other half. */
  readonly voidedAuthorisations: number;
  /** True when the drop had already been cancelled; the call changed nothing. */
  readonly alreadyCancelled: boolean;
  readonly auditId: string;
};

export type ForceFailRefusal =
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_CANCELLABLE'; readonly status: string }
  | { readonly kind: 'CODE_MISMATCH' }
  | { readonly kind: 'LOCKED_MID_CAPTURE' };

/** Reads the drop and everything the decision needs. */
async function loadDrop(dropId: string) {
  return prisma.drop.findUnique({
    where: { id: dropId },
    select: {
      id: true,
      publicCode: true,
      status: true,
      merchant: { select: { stripeAccountId: true, timezone: true } },
      participants: {
        select: {
          id: true,
          qty: true,
          amountCents: true,
          chargeStatus: true,
          // The phone is on the customer, not the participant: a participant is a
          // join, and the number belongs to the person. Read through the relation
          // rather than denormalised onto the join, because a diner who changes
          // number must get the message at the new one.
          customer: { select: { phone: true } },
          order: {
            select: {
              id: true,
              subtotalCents: true,
              platformFeeCents: true,
              stripeChargeId: true,
              refundedCents: true,
            },
          },
        },
      },
    },
  });
}

/**
 * The refusals, as values, so they can be tested without HTTP or a provider.
 *
 * Separated for the same reason `refusalFor` in `participant-refund.ts` is: the
 * reason a destructive action was refused should be assertable in isolation, and an
 * early return buried in a function that also talks to Stripe cannot be.
 *
 * Takes the three facts it needs rather than the whole loaded drop, so a test does not
 * have to construct an order graph to ask "may I cancel a `LOCKED` drop".
 */
export function forceFailRefusal(args: {
  /** `null` when no such drop exists. */
  drop: { status: string; publicCode: string } | null;
  /** What the operator echoed back from the confirmation dialog. */
  confirmPublicCode: string;
}): ForceFailRefusal | null {
  const { drop, confirmPublicCode } = args;

  if (!drop) return { kind: 'NOT_FOUND' };
  if (drop.status === 'CANCELLED') {
    // Idempotent by design: calling force-fail twice must not refund twice. The
    // caller treats this as success with `alreadyCancelled: true`.
    return null;
  }
  if (drop.status === 'LOCKED') {
    // Mid-capture. The settlement job holds the lock and is about to capture; a
    // refund now would race it and write the ledger twice.
    return { kind: 'LOCKED_MID_CAPTURE' };
  }
  if (!(FORCE_FAILABLE as readonly string[]).includes(drop.status)) {
    return { kind: 'NOT_CANCELLABLE', status: drop.status };
  }
  if (drop.publicCode !== confirmPublicCode) {
    // The server-side half of the double confirmation: the caller has to name the
    // drop it means. A mistyped id refunds nothing.
    return { kind: 'CODE_MISMATCH' };
  }
  return null;
}

function refusalToError(refusal: ForceFailRefusal, dropId: string): AppError {
  switch (refusal.kind) {
    case 'NOT_FOUND':
      // 404 and not 403 — a foreign drop id must not be distinguishable from a
      // missing one. `authorize.ts`'s rule, applied to a resource id from a URL.
      return AppError.notFound('That drop does not exist.');
    case 'LOCKED_MID_CAPTURE':
      return AppError.conflict(
        'That drop is being settled right now, so it cannot be force-failed. Wait for settlement to finish, then try again.',
      );
    case 'NOT_CANCELLABLE':
      return AppError.conflict(
        refusal.status === 'DRAFT'
          ? 'That drop is still a draft. Delete it instead of force-failing it.'
          : 'That drop cannot be force-failed in its current state.',
      );
    case 'CODE_MISMATCH':
      return AppError.validation({
        confirmPublicCode: `The code you typed does not match this drop (${dropId}).`,
      });
  }
}

/**
 * Cancels a drop and returns everybody's money.
 *
 * ## Why the ledger is written per order rather than in one batch
 *
 * Each order's refund is its own `$transaction`, exactly as `recordRefund` in
 * `participant-refund.ts` does it, and for the same reason: the CAS on
 * `chargeStatus = 'CAPTURED'` is the guard that stops a second worker writing a
 * second ledger entry. A single transaction around the whole drop would hold row
 * locks across every provider call, which is the deadlock this codebase already
 * avoids elsewhere.
 *
 * The consequence is that a crash mid-loop leaves the drop in its **original**
 * status — because the status write is last — with some participants refunded. That
 * is recoverable: the provider remembers `refundKey(participantId)`, so the retry
 * gets the original refund back rather than making a second one, and the CAS skips
 * whatever already landed. It is the same §4.2 window the rest of settlement accepts.
 *
 * `assertLedgerReconciles` runs after the status write, so L1–L4 are checked against
 * the stored state of the whole drop, not against this function's arithmetic.
 */
export async function forceFailDrop(args: {
  dropId: string;
  /** Echoed back by the caller. The server-side half of the double confirmation. */
  confirmPublicCode: string;
  /** The admin's own words. Stored on the audit row and logged. */
  reason: string;
  ipAddress?: string | null;
  port: ChargePort;
  notify: NotifyPort;
  /** The session's actor. Never trusted for authorisation — `requireAdmin` did that. */
  actor: { userId: string; email: string };
}): Promise<ForceFailOutcome> {
  const drop = await loadDrop(args.dropId);

  const refusal = forceFailRefusal({ drop, confirmPublicCode: args.confirmPublicCode });
  if (refusal) {
    logger.info('admin.force_fail_refused', {
      actorId: args.actor.userId,
      dropId: args.dropId,
      reason: refusal.kind,
    });
    throw refusalToError(refusal, args.dropId);
  }

  // `drop` is non-null: `forceFailRefusal` returned null, which requires a row.
  if (!drop) {
    throw AppError.notFound('That drop does not exist.');
  }

  if (drop.status === 'CANCELLED') {
    // Nothing to do, and nothing to record: the first call already wrote the trail.
    // Returning success rather than a conflict makes a retried request safe, which
    // matters because the caller's first attempt may have timed out after the money
    // moved.
    logger.info('admin.force_fail_noop', { actorId: args.actor.userId, dropId: drop.id });
    return {
      kind: 'CANCELLED',
      dropId: drop.id,
      refundedParticipants: 0,
      refundedCents: 0,
      platformFeeReversedCents: 0,
      alreadyRefundedParticipants: 0,
      alreadyRefundedCents: 0,
      voidedAuthorisations: 0,
      alreadyCancelled: true,
      auditId: '',
    };
  }

  // What is still owed, and what was already returned by hand. Two disjoint groups,
  // so neither figure can absorb the other.
  //
  // `REFUNDED` is excluded from `refundable` but counted as already-refunded: the
  // FR-903 path sets that status, and its money is already back. `CAPTURED` with a
  // non-zero `refundedCents` is the half-finished case — a refund whose participant
  // row did not move — and it must be counted the same way rather than attempted
  // again, because `@@unique([orderId, type])` would reject the second entry.
  const refundable = drop.participants.filter(
    (participant) => participant.chargeStatus === 'CAPTURED' && participant.order !== null,
  );
  const alreadyRefunded = drop.participants.filter(
    (participant) =>
      participant.order !== null &&
      (participant.chargeStatus === 'REFUNDED' || (participant.order?.refundedCents ?? 0) > 0),
  );
  const intendedRefundCents = refundable
    // A `CAPTURED` row that already carries a total is in `alreadyRefunded`, not
    // here; subtracting keeps the intended figure from double-counting it.
    .filter((participant) => (participant.order?.refundedCents ?? 0) === 0)
    .reduce((total, participant) => total + (participant.order?.subtotalCents ?? 0), 0);

  // ---- Step 3. The record, before the money.
  const auditId = await writeAuditEntry({
    actorUserId: args.actor.userId,
    actorEmail: args.actor.email,
    action: 'drop.force_fail',
    targetType: 'drop',
    targetId: drop.id,
    detail: {
      stage: 'REQUESTED',
      reason: args.reason,
      previousStatus: drop.status,
      publicCode: drop.publicCode,
      participantsToRefund: refundable.length,
      intendedRefundCents,
    },
    ipAddress: args.ipAddress ?? null,
  });

  if (!drop.merchant.stripeAccountId && refundable.length > 0) {
    // There is money to return and no connected account to return it through. This
    // is a data defect and it must not be half-done: the audit row records the
    // attempt and the operator gets a sentence naming the real problem.
    throw new SettlementIntegrityError({
      dropId: drop.id,
      check: 'MISSING_STRIPE_ACCOUNT',
      detail: 'force-fail found captured orders but the merchant has no connected account',
    });
  }

  // ---- Step 4. The money.
  let refundedCents = 0;
  let platformFeeReversedCents = 0;
  let refundedParticipants = 0;

  for (const participant of refundable) {
    const order = participant.order;
    if (!order || !order.stripeChargeId) {
      // A captured order with no charge id cannot be refunded. Loud, because the
      // alternative — skipping it — leaves a diner charged on a dead drop with no
      // record beyond the audit row's count.
      throw new SettlementIntegrityError({
        dropId: drop.id,
        participantId: participant.id,
        check: 'LEDGER_MISMATCH',
        detail: 'a captured order has no stripeChargeId, so force-fail cannot refund it',
      });
    }
    if (order.refundedCents > 0) {
      // Somebody refunded this participant by hand (FR-903) before the drop was
      // called off, and their participant row never moved. Their ledger rows are the
      // truth; a second refund would hit `@@unique([orderId, type])`. Counted on the
      // already-refunded side and not attempted.
      logger.info('admin.force_fail_skipped_refunded', {
        actorId: args.actor.userId,
        dropId: drop.id,
        participantId: participant.id,
        refundedCents: order.refundedCents,
      });
      continue;
    }

    const outcome = await args.port.refund({
      participantId: participant.id,
      // Non-null asserted above; the guard is what keeps the compiler honest.
      stripeAccountId: drop.merchant.stripeAccountId ?? '',
      chargeId: order.stripeChargeId,
      amountCents: order.subtotalCents,
      platformFeeCents: order.platformFeeCents,
      // Not configurable: a direct charge reverses the application fee only when
      // asked explicitly (ADR-001 §3.2). The literal type refuses `false`.
      reverseApplicationFee: true,
      idempotencyKey: refundKey(participant.id),
    });

    const reversalCents = outcome.applicationFeeRefundCents;
    if (reversalCents !== order.platformFeeCents) {
      // A full refund should reverse this order's whole fee. A different number means
      // Stripe's proportional model and our assumption disagree, and the ledger
      // records what Stripe said — inventing a nicer figure is how a reconciliation
      // gap becomes unfindable. Same warning as `finaliseFailed`'s.
      logger.warn('settlement.application_fee_reversal_unexpected', {
        dropId: drop.id,
        participantId: participant.id,
        orderPlatformFeeCents: order.platformFeeCents,
        reversedCents: reversalCents,
        outcome: outcome.status,
      });
    }

    await claimRefund({
      dropId: drop.id,
      participantId: participant.id,
      order,
      refundedCents: order.subtotalCents,
      platformFeeReversedCents: reversalCents,
      stripeRef: outcome.status === 'REFUNDED' ? outcome.refundId : order.stripeChargeId,
    });

    refundedCents += order.subtotalCents;
    platformFeeReversedCents += reversalCents;
    refundedParticipants += 1;
  }

  // ---- Step 5. The status, and the reader that proves the ledger still balances.
  //
  // `updateMany` with the old status in the `where` is the CAS: if the settlement job
  // moved the drop between our read and here, this writes nothing and we report it
  // rather than pretending. The 90 %-tolerance path is the realistic way that happens.
  const updated = await prisma.drop.updateMany({
    where: { id: drop.id, status: drop.status },
    data: { status: 'CANCELLED' },
  });
  if (updated.count !== 1) {
    throw AppError.conflict(
      'That drop changed state while it was being cancelled. Check its status before trying again — some refunds may already have been made.',
    );
  }

  // Imported lazily to keep the settlement ↔ refunds dependency one-directional at
  // module load; `assertLedgerReconciles` itself is pure.
  const { assertLedgerReconciles } = await import('@/lib/settlement/ledger');
  const [entryRows, orderRows] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { dropId: drop.id },
      select: { orderId: true, dropId: true, type: true, amountCents: true, stripeRef: true, note: true },
    }),
    prisma.order.findMany({
      where: { dropId: drop.id },
      select: {
        id: true,
        subtotalCents: true,
        platformFeeCents: true,
        refundedCents: true,
        platformFeeReversedCents: true,
      },
    }),
  ]);
  assertLedgerReconciles({
    dropId: drop.id,
    entries: entryRows.map((row) => ({
      orderId: row.orderId,
      dropId: row.dropId ?? drop.id,
      type: row.type,
      amountCents: row.amountCents,
      stripeRef: row.stripeRef,
      note: row.note,
    })),
    orders: orderRows,
  });

  // A second row, so the trail distinguishes "asked" from "done". Written before the
  // void sweep and the notifications because those two are recoverable and this
  // record is not: a sweep failure leaves holds held (the queue retries), and a
  // notification failure leaves diners uninformed (the intent is logged).
  await writeAuditEntry({
    actorUserId: args.actor.userId,
    actorEmail: args.actor.email,
    action: 'drop.force_fail',
    targetType: 'drop',
    targetId: drop.id,
    detail: {
      stage: 'COMPLETED',
      requestedAuditId: auditId,
      previousStatus: drop.status,
      refundedParticipants,
      refundedCents,
      platformFeeReversedCents,
      // The two groups are recorded separately so a later reader can tell what this
      // call returned from what was already back. `refundedCents` never includes the
      // latter.
      alreadyRefundedParticipants: alreadyRefunded.length,
      alreadyRefundedCents: alreadyRefunded.reduce(
        (total, participant) => total + (participant.order?.refundedCents ?? 0),
        0,
      ),
    },
    ipAddress: args.ipAddress ?? null,
  });

  // ---- Step 6. The holds. `CANCELLED` is in `VOID_SWEEP_STATUSES`, so the existing
  // sweep already queues this drop; calling it here is what releases the holds now
  // rather than on the next cron pass. The release path is not duplicated — this is
  // the same function the queue calls, with the same guard.
  const voidResult = await voidRemainingAuthorisations({ dropId: drop.id, port: args.port });

  // ---- Step 7. The words.
  const intents: NotifyIntent[] = drop.participants
    .filter((participant) => participant.qty > 0)
    .map((participant) => {
      if (participant.chargeStatus === 'CAPTURED' || participant.chargeStatus === 'REFUNDED') {
        return {
          kind: 'DROP_CANCELLED_REFUNDED' as const,
          dropId: drop.id,
          participantId: participant.id,
          phone: participant.customer.phone,
          chargedCents: participant.order?.subtotalCents ?? participant.amountCents,
          qty: participant.qty,
        };
      }
      // Declined, pending, or never authorised: no money moved, so the sentence must
      // talk about a released hold rather than a refund. Saying "refunded" to a diner
      // whose statement never showed a debit sends them looking for a credit.
      return {
        kind: 'DROP_CANCELLED_NO_CHARGE' as const,
        dropId: drop.id,
        participantId: participant.id,
        phone: participant.customer.phone,
        qty: participant.qty,
      };
    });

  // Notification must never fail the cancellation (§3.5). The money is back and the
  // status is written; a diner not being told is bad and is not a reason to report the
  // cancellation as failed. `deliver` keeps that rule and adds the record: before it
  // was used here, a force-failed drop sent its diners a message and logged no
  // `notification.intent` line at all on the shipped port (measured: `delivered=1`,
  // lines `0`).
  await deliver(args.notify, intents, drop.merchant.timezone);

  logger.info('admin.drop_force_failed', {
    actorId: args.actor.userId,
    dropId: drop.id,
    previousStatus: drop.status,
    refundedParticipants,
    refundedCents,
    alreadyRefundedParticipants: alreadyRefunded.length,
    voidedAuthorisations: voidResult.voided + voidResult.alreadyExpired,
    pendingVoids: voidResult.pending,
  });

  return {
    kind: 'CANCELLED',
    dropId: drop.id,
    refundedParticipants,
    refundedCents,
    platformFeeReversedCents,
    alreadyRefundedParticipants: alreadyRefunded.length,
    alreadyRefundedCents: alreadyRefunded.reduce(
      (total, participant) => total + (participant.order?.refundedCents ?? 0),
      0,
    ),
    voidedAuthorisations: voidResult.voided + voidResult.alreadyExpired,
    alreadyCancelled: false,
    auditId,
  };
}

/**
 * One order's refund, in its own transaction.
 *
 * The CAS on `chargeStatus = 'CAPTURED'` is the guard, not a formality: a second
 * worker that also got past the unlocked read writes zero rows, and therefore writes
 * no ledger entry. `@@unique([orderId, type])` is the independent second barrier.
 *
 * Deliberately the same shape as `participant-refund.ts`'s `recordRefund` rather than
 * a shared helper: the two paths differ in what they do when the CAS loses (that one
 * refuses the operator, this one records a skip), and a helper with a flag for which
 * to do would be harder to read than the ten duplicated lines.
 */
async function claimRefund(args: {
  dropId: string;
  participantId: string;
  order: { id: string; subtotalCents: number; platformFeeCents: number };
  refundedCents: number;
  platformFeeReversedCents: number;
  stripeRef: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.dropParticipant.updateMany({
      where: { id: args.participantId, chargeStatus: 'CAPTURED' },
      data: { chargeStatus: 'REFUNDED' },
    });
    if (claimed.count !== 1) {
      // Somebody else got there first. Their ledger rows are the truth.
      return;
    }

    await tx.order.update({
      where: { id: args.order.id },
      data: {
        refundedCents: { increment: args.refundedCents },
        platformFeeReversedCents: { increment: args.platformFeeReversedCents },
      },
    });

    const entries = refundEntries({
      dropId: args.dropId,
      orderId: args.order.id,
      refundedCents: args.refundedCents,
      platformFeeReversedCents: args.platformFeeReversedCents,
      stripeRef: args.stripeRef,
    });
    await tx.ledgerEntry.createMany({ data: [...entries] });
  });
}
