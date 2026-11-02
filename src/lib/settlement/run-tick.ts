import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';

import type { ChargePort } from './charge-port';
import {
  decideFor,
  findDropsAwaitingVoid,
  findDueDrops,
  findLockedDrops,
} from './cutoff-decision';
import { noopNotifyPort, type NotifyPort } from './notify-port';
import { settle, voidRemainingAuthorisations } from './settle';

/**
 * The bounded orchestrator — design §4.3, §4.4.
 *
 * ## The order, and why it is this order
 *
 * ```
 * 1. resume  := findLockedDrops(maxDrops)        -- locked by an earlier tick
 * 2. due     := findDueDrops(now, maxDrops)      -- candidates for the decision
 * 3. for id of due: decideFor                    -- may write LOCKED or FAILED
 * 4. for id of new Set(resume ∪ lockedNow): settle
 * 5. for id of voidQueue: voidRemainingAuthorisations
 * 6. for id of resume: staleness
 * ```
 *
 * Step 4 **must** dedupe. A drop locked in step 3 also satisfies step 1's query on
 * the next tick, and without a `Set` a single tick would settle it twice —
 * harmless for the money (all three guards in §4.2 hold) but it would emit every
 * notification intent twice and log a spurious `NOT_LOCKED`. Dedupe is one `Set`,
 * not a lock.
 *
 * Step 5 is the deviation: see `findDropsAwaitingVoid`'s docblock. On the design
 * as written, the authorisations of a drop that failed its threshold are never
 * released, because `settle` only runs for `LOCKED` drops and nothing re-selects a
 * `FAILED` one.
 *
 * ## Bounded, not exhaustive
 *
 * At most `maxDrops` drops and `maxParticipants` participants per drop per
 * invocation. Everything is resumable, so making progress beats finishing: a
 * 60-second cron that tries to settle 400 participants will be killed at the
 * function timeout mid-loop, which is safe but wasteful. A tick that hits the
 * bound logs `settlement.batch_truncated` and returns; the next tick continues.
 *
 * ## `now` is a parameter
 *
 * Created once per tick in the route handler and threaded down (§11.2). A tick
 * must evaluate every comparison against a single instant, or a drop can be both
 * due and not due within one tick.
 */

/** A drop `LOCKED` for longer than this is an incident, not a slow tick (§1.2). */
export const STALL_THRESHOLD_MS = 10 * 60 * 1000;

export type TickResult = {
  /** Drops `PUBLISHED` past their cutoff when the tick started. */
  readonly due: number;
  /** Drops this tick moved `PUBLISHED` → `LOCKED`. */
  readonly locked: number;
  /** Drops this tick moved `PUBLISHED` → `FAILED`. */
  readonly failed: number;
  /** Drops this tick moved to `CAPTURED`. */
  readonly settled: number;
  /** Drops still `LOCKED` at the end of the tick. */
  readonly inProgress: number;
  /** Decisions that found nothing to do — including a race another tick won. */
  readonly noop: number;
  /** Authorisations released on terminal drops this tick. */
  readonly voided: number;
  /** True when a bound was hit; the next tick continues. */
  readonly truncated: boolean;
};

export async function runCutoffTick(args: {
  now: Date;
  port: ChargePort;
  notify?: NotifyPort;
  maxDrops?: number;
  maxParticipants?: number;
}): Promise<TickResult> {
  const { now, port, notify = noopNotifyPort() } = args;
  const maxDrops = args.maxDrops ?? 20;
  const maxParticipants = args.maxParticipants ?? 50;

  const resume = await findLockedDrops({ limit: maxDrops });
  const due = await findDueDrops({ now, limit: maxDrops });

  let locked = 0;
  let failed = 0;
  let noop = 0;
  const lockedNow: string[] = [];
  const failedNow: string[] = [];

  for (const dropId of due) {
    try {
      const outcome = await decideFor({ dropId, now });
      if (outcome.kind === 'LOCKED') {
        locked += 1;
        lockedNow.push(dropId);
      } else if (outcome.kind === 'FAILED') {
        failed += 1;
        failedNow.push(dropId);
      } else {
        noop += 1;
      }
    } catch (error) {
      // §11.4: an integrity error stops *that* drop and the tick continues. It is
      // logged by the thrower (or here) and is a page-on-call condition; refusing
      // to settle the other nineteen drops would turn one bad row into an outage.
      if (isIntegrityFailure(error)) {
        logIntegrityError(dropId, error);
        continue;
      }
      throw error;
    }
  }

  const toSettle = [...new Set([...resume, ...lockedNow])];
  let settled = 0;
  let inProgress = 0;

  for (const dropId of toSettle) {
    try {
      const outcome = await settle({ dropId, now, port, notify, maxParticipants });
      if (outcome.kind === 'CAPTURED') {
        settled += 1;
      } else if (outcome.kind === 'IN_PROGRESS') {
        inProgress += 1;
      }
    } catch (error) {
      if (isIntegrityFailure(error)) {
        logIntegrityError(dropId, error);
        continue;
      }
      throw error;
    }
  }

  const voidQueue = [...new Set([...failedNow, ...(await findDropsAwaitingVoid({ limit: maxDrops }))])];
  let voided = 0;
  for (const dropId of voidQueue) {
    try {
      const result = await voidRemainingAuthorisations({ dropId, port, maxParticipants });
      voided += result.voided + result.alreadyExpired;
    } catch (error) {
      if (isIntegrityFailure(error)) {
        logIntegrityError(dropId, error);
        continue;
      }
      throw error;
    }
  }

  await reportStalls(resume, now);

  const truncated = due.length >= maxDrops || resume.length >= maxDrops || voidQueue.length >= maxDrops;
  if (truncated) {
    logger.info('settlement.batch_truncated', {
      dropsProcessed: due.length + toSettle.length,
      participantsProcessed: maxParticipants,
    });
  }

  return {
    due: due.length,
    locked,
    failed,
    settled,
    inProgress,
    noop,
    voided,
    truncated,
  };
}

/**
 * A drop `LOCKED` for more than ten minutes is the alert §1.2 keeps verbatim from
 * §8.4. It replaces exponential backoff: once failures are classified (§4.2), only
 * genuinely transient provider errors retry — at 60 s spacing, which *is* the
 * backoff — so the thing worth alerting on is a drop that has been stuck for a
 * while, not an attempt count.
 */
async function reportStalls(dropIds: readonly string[], now: Date): Promise<void> {
  for (const dropId of dropIds) {
    const row = await prisma.drop.findUnique({
      where: { id: dropId },
      select: { status: true, lockedAt: true, cutoffAt: true },
    });
    if (!row || row.status !== 'LOCKED') {
      continue;
    }
    const lockedAt = row.lockedAt ?? row.cutoffAt;
    const lockedForMs = now.getTime() - lockedAt.getTime();
    if (lockedForMs <= STALL_THRESHOLD_MS) {
      continue;
    }
    const pendingParticipants = await prisma.dropParticipant.count({
      where: { dropId, chargeStatus: 'NONE', authStatus: 'AUTHORIZED' },
    });
    logger.warn('settlement.stalled', { dropId, lockedForMs, pendingParticipants });
  }
}

function isIntegrityFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'SettlementIntegrityError';
}

function logIntegrityError(dropId: string, error: unknown): void {
  logger.error('settlement.integrity_error', {
    dropId,
    check: error instanceof Error && 'check' in error ? String(error.check) : 'unknown',
  });
}
