import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';

/**
 * Resolves `PENDING` joins that nothing else will ever resolve.
 *
 * ## The defect this exists for
 *
 * A `PENDING` participant means "this person reserved a plate and we are asking
 * their bank". `joinDrop` writes it before the provider call, deliberately, so a
 * crash between request and response leaves a row rather than a silently missing
 * join (see `service.ts` §2 and `payment-port.ts`).
 *
 * **Before cutoff that row is fine and the design intends it to hold a plate.** The
 * diner can retry: `PENDING` deliberately does not early-return as "already joined",
 * so a retry reuses the same row, keeps `joinKey(participantId)`, and calls the
 * provider again — which replays a hold the first attempt did create rather than
 * creating a second one. That is the reconciliation the docs promise, executed by
 * the only actor with a reason to retry.
 *
 * **After cutoff nothing resolves it.** Measured against real Postgres on
 * 2026-11-16, in both outcomes:
 *
 * ```
 * drop FAILED by threshold:  1 row VOIDED,  orphan left PENDING/NONE forever
 * drop CAPTURED:             1 row CAPTURED, orphan left PENDING/NONE forever
 * ```
 *
 * and in neither case does a second tick pick it up. Every other sweep is blind to
 * it, for reasons that are each individually correct:
 *
 *   - `findDropsAwaitingVoid` selects `authStatus: 'AUTHORIZED'` rows, because a
 *     void needs a `paymentIntentId` to cancel — and an orphan has none;
 *   - `settle` reads `AUTHORIZED` only, so it neither captures nor declines it;
 *   - the retry path requires `view.joinBlockedReason === null`, which is false on a
 *     past-cutoff drop, so the diner has no way back either.
 *
 * The row is therefore permanent, and `service.ts`'s own docblock says the cost of
 * the `PENDING` choice is a stale row "until it is resolved" — a moment that, on a
 * past-cutoff drop, never arrived.
 *
 * ## Why `FAILED` is the honest terminal state
 *
 * `paymentIntentId` is written in exactly one place — the `PENDING → AUTHORIZED`
 * transition (`service.ts:915`) — so an orphan's `paymentIntentId` is always `null`.
 * The row never carried a link to a hold, and marking it `FAILED` destroys nothing
 * that was there.
 *
 * `FAILED` also means the right thing. It is the state a declined card already
 * reaches (`markFailed`), it is excluded from both the capacity sum and the
 * threshold sum, and it is retryable if the drop were somehow reopened. The
 * alternative candidates are worse: `VOIDED` claims a hold was released, which we
 * cannot substantiate, and `EXPIRED` claims the issuer expired it, which we have not
 * observed.
 *
 * ## The state was UNKNOWN, and the log has to say so
 *
 * `service.ts` records why the row was left `PENDING` at all: on a provider timeout
 * "the hold may or may not exist". So marking the row `FAILED` does not prove no
 * hold exists — it records that **we never confirmed one**, and stops the row from
 * blocking anything.
 *
 * A hold created by the lost response is still findable: `real-payment-port.ts` sets
 * `metadata.participantId` on every intent (ids only, no PII). So each row this
 * sweep resolves is logged at `warn` **with its `participantId`**, which is the
 * search key an operator needs in the Stripe Dashboard. Without that id the warning
 * would name a drop that may own many intents and leave the hold unfindable — the
 * same mistake `join.record_failed` was fixed for on 2026-11-16.
 *
 * Note the contradiction this comment resolves: `void-queue.cross-product.test.ts`
 * states as fact that "`PENDING` has not been confirmed, so there is no hold". That
 * sentence is wrong, and the correction is dated there. Its *conclusion* — that the
 * void sweep must not select `PENDING` — is right, but for the other reason: there
 * is no `paymentIntentId` to cancel with.
 *
 * ## Why the grace window
 *
 * A row is only eligible if it is also older than `ORPHAN_GRACE_MS`. Without that,
 * the sweep races a join that is mid-flight: `joinDrop` refuses a past-cutoff drop
 * before it reserves, but a join that reserved one millisecond before the cutoff and
 * records its answer one millisecond after would have its row swept out from under
 * it, leaving a confirmed hold on a `FAILED` row.
 *
 * Ten minutes because a provider timeout is measured in seconds and the existing
 * stall alert (`STALL_THRESHOLD_MS`) already treats ten minutes as "this is not a
 * slow tick, it is an incident". A row past its drop's cutoff by more than that is
 * not in flight by any reading.
 */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export type ResolvedOrphanRow = {
  /** The drop to name in the diner's message. */
  readonly dropId: string;
  readonly participantId: string;
  /** E.164, read from `Customer.phone`; the caller needs it to address the diner. */
  readonly phone: string;
  readonly qty: number;
};

export type OrphanSweepResult = {
  /** Rows moved `PENDING → FAILED`. Same count semantics as before: winners only. */
  readonly resolved: number;
  /**
   * Exactly the rows whose guarded write won, with the phone needed to notify.
   *
   * A candidate whose write lost to a concurrent resolve is absent, so the tick
   * cannot message a diner whose row was not actually changed by this sweep.
   */
  readonly resolvedRows: readonly ResolvedOrphanRow[];
};

/**
 * Drops whose `PENDING` rows are past the point of rescue: cutoff reached, not a
 * draft, and the row itself older than the grace window.
 *
 * Exported so the tick can report a count without re-deriving the predicate, and so
 * a test can assert the predicate directly rather than through a side effect.
 */
async function findOrphanedPendingRows(args: {
  now: Date;
  limit: number;
}): Promise<readonly (ResolvedOrphanRow & { readonly id: string })[]> {
  const cutoff = new Date(args.now.getTime() - ORPHAN_GRACE_MS);

  const rows = await prisma.dropParticipant.findMany({
    where: {
      authStatus: 'PENDING',
      // Older than the grace window. `createdAt` rather than any attempt
      // timestamp: a reused row is updated in place, so this is the age of the
      // *reservation*, which is what the race is about.
      createdAt: { lte: cutoff },
      drop: {
        // A `DRAFT` has never been joinable, so a `PENDING` row on one is a data
        // error of a different kind and not this sweep's business.
        status: { not: 'DRAFT' },
        // Past cutoff: the retry path is closed, so the diner cannot resolve it.
        cutoffAt: { lte: args.now },
      },
    },
    select: {
      id: true,
      dropId: true,
      qty: true,
      customer: { select: { phone: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: args.limit,
  });

  return rows.map((row) => ({
    id: row.id,
    dropId: row.dropId,
    participantId: row.id,
    qty: row.qty,
    phone: row.customer.phone,
  }));
}

/**
 * Moves every orphaned `PENDING` row to `FAILED`. See the module docblock.
 *
 * One guarded `updateMany` **per candidate**, rather than one batched write over
 * all ids. The batched form reports only a total, which is enough to say "N rows
 * resolved" but not enough to know *which* rows won — and FR-506 now messages
 * the winners. A second read cannot recover that fact reliably: a row that lost
 * the guard may have moved again before it. The per-row count is the fact
 * itself: `count === 1` means this write flipped this row, so only then is the
 * diner added to `resolvedRows`.
 *
 * The guard is unchanged: a concurrent join that flipped the row to `AUTHORIZED`
 * between the read and the write keeps its confirmed hold, and this sweep
 * neither clobbers it nor messages that diner. Idempotence is unchanged too — a
 * second tick matches nothing. `resolved` still counts rows actually moved.
 */
export async function resolveOrphanedPendingJoins(args: {
  now: Date;
  limit: number;
}): Promise<OrphanSweepResult> {
  const rows = await findOrphanedPendingRows(args);
  if (rows.length === 0) {
    return { resolved: 0, resolvedRows: [] };
  }

  const resolvedRows: ResolvedOrphanRow[] = [];
  for (const row of rows) {
    const updated = await prisma.dropParticipant.updateMany({
      where: {
        id: row.id,
        // The guard that makes this safe against a concurrent resolve.
        authStatus: 'PENDING',
      },
      data: { authStatus: 'FAILED' },
    });

    // Lost the write: that diner was resolved by somebody else and must not be
    // told a story about this sweep's outcome.
    if (updated.count !== 1) {
      continue;
    }

    resolvedRows.push({
      dropId: row.dropId,
      participantId: row.participantId,
      phone: row.phone,
      qty: row.qty,
    });

    // Per row, because each one is potentially a hold nobody cancelled. The
    // participant id is the `metadata.participantId` search key at the provider.
    logger.warn('settlement.orphaned_pending_resolved', {
      dropId: row.dropId,
      participantId: row.participantId,
      qty: row.qty,
      // Explicit in the payload rather than only in this comment: the provider
      // state was never observed, so a reader of the log must not conclude that no
      // hold exists.
      providerStateUnknown: true,
    });
  }

  return { resolved: resolvedRows.length, resolvedRows };
}
