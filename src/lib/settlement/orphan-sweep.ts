import { prisma } from '@/lib/db/prisma';
import { isJoinProviderUnavailable } from '@/lib/join/payment-port';
import {
  type JoinReconciliationOutcome,
  type JoinReconciliationPort,
  unresolvedJoinReconciliationPort,
} from '@/lib/join/reconciliation-port';
import { logger } from '@/lib/logging/logger';

import { isPaymentProviderUnavailable, voidKey, type ChargePort } from './charge-port';

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
 * **After cutoff, measured against real Postgres on 2026-11-16, nothing did:**
 *
 * ```
 * drop FAILED by threshold:  1 row VOIDED,  orphan left PENDING/NONE forever
 * drop CAPTURED:             1 row CAPTURED, orphan left PENDING/NONE forever
 * ```
 *
 * Every other sweep was blind to it, each for a correct reason of its own: the
 * void sweep needs a `paymentIntentId` to cancel; `settle` reads `AUTHORIZED`
 * only; and the retry path requires `view.joinBlockedReason === null`.
 *
 * ## Dated correction — 2026-11-17: the provider is now asked
 *
 * The original sweep moved every orphan straight to `FAILED`, because the row had
 * no `paymentIntentId` and the codebase had no way to ask the provider what had
 * happened. That freed the plate and was honest about the row, but it could not
 * find — let alone release — a hold created by the lost response.
 *
 * The join port now has a read-only reconciliation seam. Stripe has no
 * "retrieve by idempotency key" API, so the seam searches the connected account by
 * `metadata.participantId` and `metadata.dropId`, the ids the create call already
 * writes next to that key. The sweep acts only on two unambiguous answers:
 *
 *   - `requires_capture` → cancel the hold, record its id, write `VOIDED`;
 *   - `canceled` → record its id, write `EXPIRED`.
 *
 * No matching intent still means `FAILED`. A timeout, several matching intents,
 * an unexpected status, or a missing void port means `FAILED` **plus a distinct
 * `UNRESOLVED` log and message** — never the reassuring "no money was captured"
 * sentence on evidence that cannot support it. A caller that supplies no lookup
 * port at all takes that same unresolved branch: nothing was queried, so the
 * sweep must not borrow the provider's `NOT_FOUND` answer.
 *
 * ## Why the row is claimed before the hold is cancelled
 *
 * The lookup is a read, so it may race a diner's retry. Cancelling a hold found
 * by that read *before* winning the row would be able to cancel the hold of a
 * join that resolved concurrently and legitimately owns it. So a found live hold
 * is first written to `FAILED` under the same `authStatus: 'PENDING'` guard the
 * sweep always used; only that winning write earns the right to call `void`.
 * A second guarded write then records `VOIDED`. If the void cannot reach the
 * provider, the row stays `FAILED` with the intent id in the log and the
 * `UNRESOLVED` message: a hold we found but could not release is never reported
 * as one we did.
 *
 * ## Why the grace window
 *
 * A row is only eligible if it is also older than `ORPHAN_GRACE_MS`. Without that,
 * the sweep races a join that is mid-flight: a join that reserved one millisecond
 * before cutoff and recorded its answer one millisecond after would have its row
 * swept out from under it. Ten minutes because a provider timeout is measured in
 * seconds and `STALL_THRESHOLD_MS` already treats ten minutes as an incident.
 */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export type OrphanResolution =
  | 'NO_CONFIRMED_HOLD'
  | 'HOLD_RELEASED'
  | 'HOLD_EXPIRED'
  | 'UNRESOLVED';

export type ResolvedOrphanRow = {
  /** The drop to name in the diner's message. */
  readonly dropId: string;
  readonly participantId: string;
  /** E.164, read from `Customer.phone`; the caller needs it to address the diner. */
  readonly phone: string;
  readonly qty: number;
  /** Which provider fact the message is allowed to assert. */
  readonly resolution: OrphanResolution;
};

export type OrphanSweepResult = {
  /** Rows moved out of `PENDING` by this sweep. Winners only. */
  readonly resolved: number;
  /** Exactly the rows whose guarded write won, with the phone needed to notify. */
  readonly resolvedRows: readonly ResolvedOrphanRow[];
  /** Subset of `resolved`: a live hold was found and cancelled. */
  readonly released: number;
  /** Subset of `resolved`: the provider reported the hold already gone. */
  readonly expired: number;
  /** Subset of `resolved`: the provider answer cannot support a money claim. */
  readonly unresolved: number;
};

/** The void half of `ChargePort`, so a test cannot smuggle a capture into the sweep. */
type OrphanChargePort = Pick<ChargePort, 'voidAuthorization'>;

type Candidate = ResolvedOrphanRow & {
  readonly id: string;
  readonly stripeAccountId: string | null;
};

/**
 * Drops whose `PENDING` rows are past the point of rescue: cutoff reached, not a
 * draft, and the row itself older than the grace window.
 */
async function findOrphanedPendingRows(args: {
  now: Date;
  limit: number;
}): Promise<readonly Candidate[]> {
  const cutoff = new Date(args.now.getTime() - ORPHAN_GRACE_MS);

  const rows = await prisma.dropParticipant.findMany({
    where: {
      authStatus: 'PENDING',
      createdAt: { lte: cutoff },
      drop: {
        status: { not: 'DRAFT' },
        cutoffAt: { lte: args.now },
      },
    },
    select: {
      id: true,
      dropId: true,
      qty: true,
      customer: { select: { phone: true } },
      drop: { select: { merchant: { select: { stripeAccountId: true } } } },
    },
    orderBy: { createdAt: 'asc' },
    take: args.limit,
  });

  // Filled in by the caller after reconciliation; the candidate itself carries no
  // claim about the provider.
  return rows.map((row) => ({
    id: row.id,
    dropId: row.dropId,
    participantId: row.id,
    qty: row.qty,
    phone: row.customer.phone,
    stripeAccountId: row.drop.merchant.stripeAccountId,
    resolution: 'UNRESOLVED',
  }));
}

/**
 * Turns a provider answer into a state, an evidence level and an optional hold id.
 *
 * The `AUTHORIZED` case deliberately leaves the final state unresolved until the
 * guarded claim and the void call have both succeeded. It is the only case where
 * the sweep acts on the provider after winning the row.
 */
function planFor(lookup: JoinReconciliationOutcome): {
  readonly authStatus: 'FAILED' | 'EXPIRED';
  readonly resolution: OrphanResolution;
  readonly paymentIntentId?: string;
  readonly reason?: string;
  readonly providerStatus?: string;
  readonly voidAfterClaim: boolean;
} {
  switch (lookup.status) {
    case 'NOT_FOUND':
      return {
        authStatus: 'FAILED',
        resolution: 'NO_CONFIRMED_HOLD',
        voidAfterClaim: false,
      };
    case 'EXPIRED':
      return {
        authStatus: 'EXPIRED',
        resolution: 'HOLD_EXPIRED',
        paymentIntentId: lookup.paymentIntentId,
        voidAfterClaim: false,
      };
    case 'AUTHORIZED':
      return {
        // Claim first, cancel second. See the module docblock.
        authStatus: 'FAILED',
        resolution: 'UNRESOLVED',
        paymentIntentId: lookup.paymentIntentId,
        voidAfterClaim: true,
      };
    case 'UNRESOLVED':
      return {
        authStatus: 'FAILED',
        resolution: 'UNRESOLVED',
        reason: lookup.reason,
        providerStatus: lookup.providerStatus,
        voidAfterClaim: false,
      };
  }
}

/**
 * Moves every orphaned `PENDING` row out of `PENDING`, with provider evidence.
 *
 * One guarded `updateMany` per candidate, not one batched write: the per-row count
 * is the fact that tells us which diner may be messaged. A concurrent resolve that
 * wins the guard is absent from `resolvedRows`, so no sentence is sent about a row
 * this sweep did not change.
 */
export async function resolveOrphanedPendingJoins(args: {
  now: Date;
  limit: number;
  reconciliation?: JoinReconciliationPort;
  chargePort?: OrphanChargePort;
}): Promise<OrphanSweepResult> {
  const reconciliation = args.reconciliation ?? unresolvedJoinReconciliationPort();
  const rows = await findOrphanedPendingRows(args);
  if (rows.length === 0) {
    return { resolved: 0, resolvedRows: [], released: 0, expired: 0, unresolved: 0 };
  }

  const resolvedRows: ResolvedOrphanRow[] = [];
  let released = 0;
  let expired = 0;
  let unresolved = 0;

  for (const row of rows) {
    let lookup: JoinReconciliationOutcome;
    if (!row.stripeAccountId) {
      lookup = { status: 'UNRESOLVED', reason: 'NO_PROVIDER_ACCOUNT' };
    } else {
      try {
        lookup = await reconciliation.findJoinAuthorisation({
          participantId: row.participantId,
          dropId: row.dropId,
          stripeAccountId: row.stripeAccountId,
        });
      } catch (error) {
        if (!isJoinProviderUnavailable(error)) {
          throw error;
        }
        lookup = { status: 'UNRESOLVED', reason: 'PROVIDER_UNAVAILABLE' };
      }
    }

    const plan = planFor(lookup);
    const updated = await prisma.dropParticipant.updateMany({
      where: { id: row.id, authStatus: 'PENDING' },
      data: {
        authStatus: plan.authStatus,
        ...(plan.paymentIntentId ? { paymentIntentId: plan.paymentIntentId } : {}),
      },
    });

    // Lost the write: somebody else resolved this row and must tell its diner.
    if (updated.count !== 1) {
      continue;
    }

    let resolution = plan.resolution;
    let reason = plan.reason;
    const providerStatus = plan.providerStatus;
    const paymentIntentId = plan.paymentIntentId;

    if (plan.voidAfterClaim && paymentIntentId && args.chargePort) {
      try {
        const voided = await args.chargePort.voidAuthorization({
          participantId: row.participantId,
          stripeAccountId: row.stripeAccountId!,
          paymentIntentId,
          idempotencyKey: voidKey(row.participantId),
        });
        const finalStatus = voided.status === 'VOIDED' ? 'VOIDED' : 'EXPIRED';
        const final = await prisma.dropParticipant.updateMany({
          where: { id: row.id, authStatus: 'FAILED', paymentIntentId },
          data: { authStatus: finalStatus },
        });
        if (final.count === 1) {
          resolution = voided.status === 'VOIDED' ? 'HOLD_RELEASED' : 'HOLD_EXPIRED';
        } else {
          reason = 'FINAL_WRITE_LOST';
        }
      } catch (error) {
        reason = isPaymentProviderUnavailable(error) ? error.reason : 'VOID_FAILED';
      }
    } else if (plan.voidAfterClaim) {
      reason = 'NO_VOID_PORT';
    }

    resolvedRows.push({
      dropId: row.dropId,
      participantId: row.participantId,
      phone: row.phone,
      qty: row.qty,
      resolution,
    });

    if (resolution === 'HOLD_RELEASED') {
      released += 1;
    } else if (resolution === 'HOLD_EXPIRED') {
      expired += 1;
    } else if (resolution === 'UNRESOLVED') {
      unresolved += 1;
    }

    logger.warn('settlement.orphaned_pending_resolved', {
      dropId: row.dropId,
      participantId: row.participantId,
      qty: row.qty,
      resolution,
      ...(paymentIntentId ? { paymentIntentId } : {}),
      ...(reason ? { reason } : {}),
      ...(providerStatus ? { providerStatus } : {}),
    });
  }

  return {
    resolved: resolvedRows.length,
    resolvedRows,
    released,
    expired,
    unresolved,
  };
}
