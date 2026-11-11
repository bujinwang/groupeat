import { dropCancelled } from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';
import { prisma } from '@/lib/db/prisma';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logging/logger';

import { writeAuditEntry } from '@/lib/audit/log';
import { deliver, type NotifyIntent, type NotifyPort } from '@/lib/settlement/notify-port';
import type { ChargePort } from '@/lib/settlement/charge-port';
import { voidRemainingAuthorisations } from '@/lib/settlement/settle';

/**
 * FR-208 — a merchant calls off a published drop before its cutoff.
 *
 * > `FR-208 | Merchant can cancel a PUBLISHED drop | All auths voided; participants
 * > notified. Reason required` — PRD-v1.md:461
 * > `POST   /api/merchant/drops/:id/cancel` — PRD-v1.md:863
 *
 * ## What this is, and what it is deliberately not
 *
 * The PRD has two cancellation-shaped requirements and they are not the same
 * operation. **FR-902** is an *admin* force-fail: an override that refunds money
 * that was already captured. **FR-208** is a *merchant* cancellation of a drop that
 * has not been captured at all — every participant's card is merely authorised, so
 * "refund everyone" is a no-op and the whole job is releasing holds.
 *
 * `force-fail.ts` anticipated this in its own docblock: *"A `PUBLISHED` drop with
 * live authorisations and no captures is a cancellation (FR-208), not a
 * force-fail."* That is exactly the boundary drawn here. This function refuses
 * anything past `PUBLISHED`, because a `CAPTURED` drop has money to return and that
 * is FR-902's job — with FR-902's refund loop, its `refundKey`, and its audit
 * vocabulary. Merging the two would mean one function whose behaviour depends on a
 * status, which is how a cancellation quietly starts issuing refunds.
 *
 * ## Why the status is written BEFORE the holds are voided (the inverse of FR-902)
 *
 * This is the only ordering decision in the file that could not be made by copying
 * `forceFailDrop`, and getting it backwards fails silently.
 *
 * `voidRemainingAuthorisations` is guarded by `isVoidSweepStatus(drop.status)`, and
 * it re-reads the status from the database on every call. `PUBLISHED` is **not** in
 * `VOID_SWEEP_STATUSES` — deliberately, and listed as `DRAFT`/`PUBLISHED` absent
 * "for the obvious reason: they are before the cutoff, and nothing may be voided
 * before the decision." So a call to release holds on a still-`PUBLISHED` drop
 * returns `{voided: 0}` and does nothing at all. No error, no log line, and every
 * diner's money still held.
 *
 * FR-902 could void *after* its status write because it also had to refund first
 * (money out before the claim that money went out). Here there is no money to move,
 * so the status write is free to come first — and it must, or the guard refuses the
 * sweep. The order is therefore:
 *
 * ```
 * 1. read the drop, scoped to the caller's merchants        (one round trip)
 * 2. refuse what cannot be cancelled, with a sentence        (pure guards)
 * 3. CAS PUBLISHED -> CANCELLED, asserting the count         (the flip)
 * 4. write the audit row, stage REQUESTED                    (before any provider call)
 * 5. release the holds                                       (the same sweep FR-902 uses)
 * 6. write the audit row, stage COMPLETED                    (what actually moved)
 * 7. notify every participant
 * ```
 *
 * Steps 3 and 4 are also inverted relative to FR-902, and for a reason that is
 * specific to cancellation: the audit row's `detail` reports the **prior** status and
 * the number of holds it intends to release, both of which are facts captured before
 * the flip, so nothing is lost by writing the row after it. What is gained is that
 * the CAS cannot fail after the audit row exists — a `LOCKED` drop that raced the
 * settlement job would otherwise leave a `REQUESTED` row describing a cancellation
 * that never happened, with no `COMPLETED` row to distinguish it. Step 3 failing now
 * writes nothing at all, which is the honest outcome: the drop was not cancelled.
 *
 * The remaining window is steps 3→5: a crash between them leaves the drop
 * `CANCELLED` with holds still live. That is recoverable rather than lost, because
 * `CANCELLED` is in `VOID_SWEEP_STATUSES` and `findDropsAwaitingVoid` queues it every
 * pass — the tick's phase 6 releases them without anyone asking. So the failure mode
 * is "released late", not "held forever", and that is why the flip is allowed to
 * precede the sweep.
 *
 * ## The CAS is the whole race story
 *
 * `updateMany({where: {id, status: 'PUBLISHED'}})` is what makes this safe against
 * the cutoff tick, which selects `PUBLISHED` drops whose `cutoffAt` has passed and
 * moves them to `LOCKED`. Both paths read `PUBLISHED` and both write conditionally,
 * so exactly one of them wins:
 *
 *   - cancel wins → status is `CANCELLED`, the tick's `updateMany` matches nothing,
 *     and settlement never captures. (The tick re-reads and reports `SKIPPED`.)
 *   - tick wins → status is `LOCKED`, this `updateMany` matches nothing, `count !== 1`,
 *     and the merchant gets a 409 saying settlement already started. Nothing is
 *     voided, which is the correct outcome: those holds are about to be captured.
 *
 * A read-then-write without the status in the `where` would let both succeed — the
 * merchant told "cancelled", the diners charged. That is the defect this CAS exists
 * to prevent, and `cancel-race.test.ts` drives it from both directions.
 */

/** Only a `PUBLISHED` drop can be cancelled by a merchant. */
export type CancelRefusal =
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_PUBLISHED'; readonly status: string }
  | { readonly kind: 'CODE_MISMATCH' }
  | { readonly kind: 'NO_REASON' };

export type CancelOutcome = {
  readonly kind: 'CANCELLED';
  readonly dropId: string;
  readonly publicCode: string;
  /** Holds released by this call. `pending` ones are retried by the void queue. */
  readonly voidedAuthorisations: number;
  readonly alreadyExpiredAuthorisations: number;
  readonly pendingVoids: number;
  /** Participants the SMS was composed for. Zero is a legitimate value. */
  readonly notifiedParticipants: number;
  readonly auditId: string;
};

/**
 * The refusals, as values over facts, so the rules are testable without HTTP,
 * Postgres or a provider.
 *
 * Same shape as `forceFailRefusal` and `refusalFor` in `refunds/participant-refund.ts`
 * for the same reason: the reason a destructive action was refused should be
 * assertable on its own, and an early return buried in a function that also talks to
 * Stripe cannot be.
 */
export function cancelDropRefusal(args: {
  /** `null` when no such drop exists **within the caller's scope**. */
  drop: { status: string; publicCode: string } | null;
  /** What the merchant echoed back from the confirmation. */
  confirmPublicCode: string;
  /** The merchant's own words. FR-208 requires one. */
  reason: string;
}): CancelRefusal | null {
  const { drop } = args;

  if (!drop) {
    // A foreign drop id is indistinguishable from a missing one (ARCHITECTURE §3.4):
    // the scope filter in `loadDrop` is what produces `null` for both.
    return { kind: 'NOT_FOUND' };
  }
  if (drop.status !== 'PUBLISHED') {
    // Covers `LOCKED` (settlement is capturing — the money is about to move),
    // `CAPTURED`/`PICKUP_OPEN`/`COMPLETED` (money already moved; that is FR-902),
    // `DRAFT` (never published, so there is nothing to call off), and `CANCELLED`
    // (already done; the caller sees a conflict rather than a second audit trail).
    return { kind: 'NOT_PUBLISHED', status: drop.status };
  }
  if (args.reason.trim().length === 0) {
    // Checked here as well as in the route's schema, because this function is the
    // authority and the route is only one caller. An empty reason would produce an
    // audit row that records a decision without recording why it was made.
    return { kind: 'NO_REASON' };
  }
  if (drop.publicCode !== args.confirmPublicCode) {
    // The server-side half of the confirmation. The UI's dialog is the other half
    // and cannot be enforced here — any client can POST twice — but this is the
    // difference between a request that names its target and one that acts on
    // whatever id a stale tab happened to hold.
    return { kind: 'CODE_MISMATCH' };
  }
  return null;
}

function refusalToError(refusal: CancelRefusal, dropId: string): AppError {
  switch (refusal.kind) {
    case 'NOT_FOUND':
      // 404, not 403: a foreign drop id must not be distinguishable from a missing
      // one, which is `db/items.ts`'s rule applied to a URL parameter.
      return AppError.notFound('That drop does not exist.');
    case 'NOT_PUBLISHED':
      switch (refusal.status) {
        case 'LOCKED':
          // The one that must not be softened into "try again in a moment": the
          // cutoff has passed and settlement holds the lock. Retrying will not work;
          // the drop is running.
          return AppError.conflict(
            'The cutoff has passed and we are charging cards now, so this drop can no longer be cancelled.',
          );
        case 'CANCELLED':
          return AppError.conflict('This drop has already been cancelled.');
        case 'DRAFT':
          return AppError.conflict(
            'This drop has not been published yet. Edit it, or delete the draft.',
          );
        default:
          // CAPTURED / PICKUP_OPEN / COMPLETED / FAILED. Named honestly rather than
          // implying the merchant might still be able to do this themselves.
          return AppError.conflict(
            'This drop has already run, so it cannot be cancelled. Contact support if a refund is needed.',
          );
      }
    case 'NO_REASON':
      return AppError.validation({
        reason: 'Say why this drop is being called off. Diners will not see this, but we record it.',
      });
    case 'CODE_MISMATCH':
      return AppError.validation({
        confirmPublicCode: `Type the drop code to confirm. It does not match this drop (${dropId}).`,
      });
  }
}

/**
 * Reads a drop, scoped. `merchantIds` empty ⇒ no row ⇒ `NOT_FOUND`.
 *
 * The scope filter is here rather than in the route for the reason every
 * `db/drops.ts` function gives: a scoped read that a caller can forget to scope is a
 * cross-tenant read waiting to happen, so the only read this service has is scoped.
 */
async function loadDrop(args: { merchantIds: readonly string[]; dropId: string }) {
  if (args.merchantIds.length === 0) {
    return null;
  }
  return prisma.drop.findFirst({
    where: { id: args.dropId, merchantId: { in: [...args.merchantIds] } },
    select: {
      id: true,
      publicCode: true,
      status: true,
      minQty: true,
      maxQty: true,
      merchantId: true,
      merchant: { select: { timezone: true } },
      // Only what the notification needs. No `Order` rows are read at all: a
      // cancellable drop is one where nothing was captured, so there is no money to
      // look at and reading it would invite the refund loop that belongs to FR-902.
      participants: {
        select: {
          id: true,
          qty: true,
          chargeStatus: true,
          customer: { select: { phone: true } },
        },
      },
    },
  });
}

/**
 * Cancels a published drop: writes `CANCELLED`, releases every hold, tells everyone.
 *
 * Idempotent in the sense that matters — a second call cannot cancel twice, because
 * the CAS requires `PUBLISHED` and the second call finds `CANCELLED`. It reports
 * that as a conflict rather than as success: unlike a force-fail retry (where the
 * caller may have timed out *after* the money moved and deserves a success), a
 * cancellation that already happened carries no risk of a half-done retry, and
 * telling the merchant "cancelled" when they did not just do it would misdate their
 * own action.
 */
export async function cancelDrop(args: {
  merchantIds: readonly string[];
  dropId: string;
  /** Echoed back by the caller. The server-side half of the confirmation. */
  confirmPublicCode: string;
  /** The merchant's own words. Stored on the audit row and logged. Never sent to diners. */
  reason: string;
  ipAddress?: string | null;
  port: ChargePort;
  notify: NotifyPort;
  actor: { userId: string; email: string };
}): Promise<CancelOutcome> {
  const drop = await loadDrop({ merchantIds: args.merchantIds, dropId: args.dropId });

  const refusal = cancelDropRefusal({
    drop,
    confirmPublicCode: args.confirmPublicCode,
    reason: args.reason,
  });
  if (refusal) {
    logger.info('drops.cancel_refused', {
      actorId: args.actor.userId,
      dropId: args.dropId,
      reason: refusal.kind,
    });
    throw refusalToError(refusal, args.dropId);
  }

  // Non-null: `cancelDropRefusal` returned null, which requires a row.
  if (!drop) {
    throw AppError.notFound('That drop does not exist.');
  }

  const heldParticipants = drop.participants.filter((participant) => participant.qty > 0);

  // ---- Step 3. The flip, and the CAS that decides the race.
  //
  // `status: 'PUBLISHED'` in the `where` is load-bearing. Without it this is a
  // read-then-write, and a cutoff tick that moved the drop to `LOCKED` in between
  // would be overwritten — the merchant told "cancelled" while settlement captured
  // every card. With it, exactly one writer wins and the loser is told so.
  const flipped = await prisma.drop.updateMany({
    where: { id: drop.id, status: 'PUBLISHED' },
    data: { status: 'CANCELLED' },
  });
  if (flipped.count !== 1) {
    // Lost the race to the cutoff tick (or to another cancel request). Re-read so the
    // sentence can name the real current state instead of guessing.
    const now = await prisma.drop.findUnique({ where: { id: drop.id }, select: { status: true } });
    logger.info('drops.cancel_lost_race', {
      actorId: args.actor.userId,
      dropId: drop.id,
      expected: 'PUBLISHED',
      actual: now?.status ?? 'GONE',
    });
    throw refusalToError(
      { kind: 'NOT_PUBLISHED', status: now?.status ?? 'PUBLISHED' },
      drop.id,
    );
  }

  // ---- Step 4. The record, before any provider call.
  //
  // `writeAuditEntry` throws rather than swallowing, which is what makes the ordering
  // mean something: if this insert fails, no hold has been touched and the merchant
  // gets an error with the drop already `CANCELLED` and its holds due to be released
  // by the queue. Recorded after the flip on purpose — see the ordering note above.
  const auditId = await writeAuditEntry({
    actorUserId: args.actor.userId,
    actorEmail: args.actor.email,
    action: 'drop.cancel',
    targetType: 'drop',
    targetId: drop.id,
    detail: {
      stage: 'REQUESTED',
      reason: args.reason,
      previousStatus: 'PUBLISHED',
      publicCode: drop.publicCode,
      merchantId: drop.merchantId,
      // What we are about to release. A count, not an amount: no money moved, and
      // reporting a figure here would imply a refund that never happened.
      participantsWithHolds: heldParticipants.length,
    },
    ipAddress: args.ipAddress ?? null,
  });

  // ---- Step 5. The holds.
  //
  // The same function the tick's void phase calls, with the same guard — not a
  // reimplementation. It works now only because step 3 moved the status into
  // `VOID_SWEEP_STATUSES`; before the flip it would have returned zero and voided
  // nothing, silently. `voided + alreadyExpired` is the number of releases; `pending`
  // is what the queue will retry, and it is reported rather than hidden.
  const voidResult = await voidRemainingAuthorisations({ dropId: drop.id, port: args.port });

  // ---- Step 6. What actually happened.
  await writeAuditEntry({
    actorUserId: args.actor.userId,
    actorEmail: args.actor.email,
    action: 'drop.cancel',
    targetType: 'drop',
    targetId: drop.id,
    detail: {
      stage: 'COMPLETED',
      requestedAuditId: auditId,
      voidedAuthorisations: voidResult.voided,
      alreadyExpiredAuthorisations: voidResult.alreadyExpired,
      pendingVoids: voidResult.pending,
      notifiedParticipants: heldParticipants.length,
    },
    ipAddress: args.ipAddress ?? null,
  });

  // ---- Step 7. The words.
  //
  // Every participant gets `DROP_CANCELLED_NO_CHARGE`, and that is a claim this file
  // can make honestly *because it refused every drop where it would be false*: a
  // merchant-cancellable drop is `PUBLISHED`, so nothing was captured. A participant
  // whose `chargeStatus` is `CAPTURED` cannot appear here. If one ever did, the
  // sentence "nobody was charged" would be a lie told next to a true one about their
  // money — so the guard is the copy's type signature, not a nicety.
  const intents: NotifyIntent[] = heldParticipants.map((participant) => ({
    kind: 'DROP_CANCELLED_NO_CHARGE' as const,
    dropId: drop.id,
    participantId: participant.id,
    phone: participant.customer.phone,
    qty: participant.qty,
  }));

  // Notification must never fail the cancellation (§3.5). The holds are released and
  // the status is written; a diner not being told is bad and is not a reason to report
  // the cancellation as failed — the merchant would then cancel again. `deliver` keeps
  // that rule and adds the record: before it was used here, a cancelled drop sent its
  // diners a message and logged no `notification.intent` line at all on the shipped
  // port (measured: `delivered=1`, lines `0`).
  await deliver(args.notify, intents, drop.merchant.timezone);

  logger.info('drops.cancelled', {
    actorId: args.actor.userId,
    dropId: drop.id,
    merchantId: drop.merchantId,
    participants: heldParticipants.length,
    voidedAuthorisations: voidResult.voided + voidResult.alreadyExpired,
    pendingVoids: voidResult.pending,
  });

  // The cancellation is committed and complete: the CAS won, both audit rows are
  // written, the holds are released (or queued for the sweep), and notification
  // was attempted. A lost race threw above, so this cannot claim a drop that is
  // still PUBLISHED. Counts only — the free-text reason, the actor's email and
  // the request IP stay on the audit row, where PII belongs.
  record(
    dropCancelled({
      dropId: drop.id,
      merchantId: drop.merchantId,
      participants: heldParticipants.length,
      voidedAuthorisations: voidResult.voided + voidResult.alreadyExpired,
      pendingVoids: voidResult.pending,
    }),
  );

  return {
    kind: 'CANCELLED',
    dropId: drop.id,
    publicCode: drop.publicCode,
    voidedAuthorisations: voidResult.voided + voidResult.alreadyExpired,
    alreadyExpiredAuthorisations: voidResult.alreadyExpired,
    pendingVoids: voidResult.pending,
    notifiedParticipants: heldParticipants.length,
    auditId,
  };
}
