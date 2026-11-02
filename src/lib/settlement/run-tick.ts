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
import { applyPickupTransition, findPickupDue } from './pickup-window';
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
 * 5. pickup  := findPickupDue(now, maxDrops)     -- CAPTURED→PICKUP_OPEN, →COMPLETED
 * 6. for id of voidQueue: voidRemainingAuthorisations
 * 7. for id of resume: staleness
 * ```
 *
 * Step 4 **must** dedupe. A drop locked in step 3 also satisfies step 1's query on
 * the next tick, and without a `Set` a single tick would settle it twice —
 * harmless for the money (all three guards in §4.2 hold) but it would emit every
 * notification intent twice and log a spurious `NOT_LOCKED`. Dedupe is one `Set`,
 * not a lock.
 *
 * Step 5 runs **after** step 4, and the order is load-bearing in one direction: a
 * drop captured by this tick is already `CAPTURED` in the database by the time the
 * pickup query runs, so a drop whose window opened while the tick was settling
 * transitions in the *same* tick instead of waiting for the next one. Reversing the
 * two would add up to a full tick of delay between "charged" and "collectable",
 * which is exactly the interval a diner spends standing at a counter.
 *
 * Step 6 is the deviation: see `findDropsAwaitingVoid`'s docblock. On the design
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
  /** Drops this tick moved `CAPTURED → PICKUP_OPEN`. */
  readonly pickupOpened: number;
  /** Drops this tick moved `PICKUP_OPEN → COMPLETED` (or `CAPTURED → COMPLETED`). */
  readonly pickupCompleted: number;
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
  /**
   * The public origin for links in notifications. Omitted means no link.
   *
   * Passed through to `settle`, which builds the `orderUrl` on the charged intent.
   * Threaded rather than read from env inside `settle` so the settlement library
   * stays free of deployment concerns — and so a test can assert the link shape
   * without touching global state.
   */
  baseUrl?: string;
  maxDrops?: number;
  maxParticipants?: number;
}): Promise<TickResult> {
  const { now, port, notify = noopNotifyPort(), baseUrl } = args;
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
      const outcome = await settle({ dropId, now, port, notify, maxParticipants, baseUrl });
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

  // ---------------------------------------------------------------- phase 5
  // The pickup clock. Runs after settlement (see the docblock) and before the void
  // sweep, because a drop that just became collectable may also be a drop holding a
  // declined diner's authorisation — and the sweep should see the row in its final
  // status rather than one iteration behind.
  const pickupDue = await findPickupDue({ now, limit: maxDrops });
  let pickupOpened = 0;
  let pickupCompleted = 0;
  for (const item of pickupDue) {
    try {
      const moved = await applyPickupTransition({
        dropId: item.dropId,
        transition: item.transition,
        now,
      });
      if (!moved) {
        // Another tick won the guarded write. Not an error: the transition
        // happened, just not here.
        continue;
      }
      if (item.transition === 'OPENED') {
        pickupOpened += 1;
      } else {
        pickupCompleted += 1;
      }
    } catch (error) {
      if (isIntegrityFailure(error)) {
        logIntegrityError(item.dropId, error);
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

  const truncated =
    due.length >= maxDrops ||
    resume.length >= maxDrops ||
    voidQueue.length >= maxDrops ||
    pickupDue.length >= maxDrops;
  if (truncated) {
    logger.info('settlement.batch_truncated', {
      dropsProcessed: due.length + toSettle.length + pickupDue.length,
      participantsProcessed: maxParticipants,
    });
  }

  return {
    due: due.length,
    locked,
    failed,
    settled,
    inProgress,
    pickupOpened,
    pickupCompleted,
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
