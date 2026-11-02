import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';

/**
 * `CAPTURED → PICKUP_OPEN → COMPLETED` — FR-604's precondition, and the reason
 * redemption works at all.
 *
 * ## The defect this module fixes, stated exactly
 *
 * `redeem.ts` gates on one thing: `isRedeemableStatus(drop.status)`, which is
 * `PICKUP_OPEN | COMPLETED`. It does **not** compare a clock — I checked, and there
 * is no `windowStart`/`windowEnd` read anywhere in that file. The status is the
 * clock.
 *
 * Nothing in this build wrote `PICKUP_OPEN`. `grep` found it only in status-label
 * maps and in `VOID_SWEEP_STATUSES`. So after a successful capture a drop sat in
 * `CAPTURED` forever, and every scan of a valid, paid code was refused with
 * `NOT_YET` — the message that means "the window has not opened", shown permanently
 * to a diner standing at a counter inside their window.
 *
 * That makes this module the difference between "the money moved" and "the food
 * changed hands". It is not a nicety; without it the product takes payment and
 * cannot deliver.
 *
 * ## Why the status carries the window instead of `redeem.ts` checking the clock
 *
 * Adding a `now` comparison to the redeem path would be a smaller diff, and it was
 * rejected for three reasons:
 *
 *   1. **Two clocks, two answers.** Settlement already owns the notion of "what
 *      time is it for this drop". A second clock in the scanner means a drop could
 *      be collectable by one rule and not by the other, and the disagreement would
 *      be invisible until a diner was refused.
 *   2. **`COMPLETED` has to exist anyway.** Reporting, organiser payouts and the
 *      manifest all want to know a drop is over, and "status is `PICKUP_OPEN` but
 *      the window closed six hours ago" is a state every consumer would have to
 *      re-derive. Writing it once is cheaper than teaching four screens to
 *      re-derive it.
 *   3. **A status transition is auditable.** `completedAt` lands in the row. A
 *      clock comparison leaves no trace that the drop finished, so "when did this
 *      drop end" would be unanswerable from the data.
 *
 * ## Why the transitions are monotonic
 *
 * `CAPTURED → PICKUP_OPEN → COMPLETED` only, never backwards, and each write is a
 * `updateMany` guarded on the **from** status. Two ticks racing produce one write
 * and the loser reports zero rows — the same discipline as `settle`'s capture
 * guard. A backwards transition would un-complete a drop whose pickup window has
 * been reopened by hand, and re-open code collection on food that has already been
 * handed over.
 *
 * ## What this module deliberately does not do
 *
 * It does not touch money, does not emit notifications, and does not look at
 * participants. `CAPTURED` already means the captures settled; this only moves the
 * clock forward. The one thing it shares with settlement is the timing source —
 * `now`, threaded from the tick, never `new Date()` in here (§11.2).
 */

export type PickupTransition = 'OPENED' | 'COMPLETED';

export type PickupDue = {
  readonly dropId: string;
  readonly transition: PickupTransition;
};

/** The statuses this module reads, and nothing else. */
const FROM_CAPTURED = 'CAPTURED' as const;
const TO_OPEN = 'PICKUP_OPEN' as const;
const FROM_OPEN = 'PICKUP_OPEN' as const;
const TO_COMPLETED = 'COMPLETED' as const;

/**
 * Which transition a row is due, if any.
 *
 * Pure and total: every `(status, windowStart, windowEnd, now)` combination gets an
 * answer, and the answer is `null` for everything this module must not touch. The
 * window boundaries are inclusive at the start and exclusive at the end, matching
 * `resolveOrderView`'s `now > windowEnd` test — the diner's page and the till must
 * close at the same instant.
 *
 * `CAPTURED` with an already-past `windowEnd` is the case a missed tick produces: a
 * job that was down for an hour must be able to skip `PICKUP_OPEN` and land on
 * `COMPLETED` directly, rather than opening the window for a pickup that is over.
 * It is one statement rather than two so that skipping is the natural outcome
 * instead of a special case.
 */
export function pickupTransitionFor(args: {
  readonly status: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly now: Date;
}): PickupTransition | null {
  const nowMs = args.now.getTime();

  if (args.status === FROM_CAPTURED) {
    if (nowMs >= args.windowEnd.getTime()) {
      // The whole window elapsed while nothing was ticking. Going straight to
      // `COMPLETED` is the truth; opening it first would flash a collectable drop
      // for a pickup that ended before anyone looked.
      return 'COMPLETED';
    }
    if (nowMs >= args.windowStart.getTime()) {
      return 'OPENED';
    }
    return null;
  }

  if (args.status === FROM_OPEN && nowMs >= args.windowEnd.getTime()) {
    return 'COMPLETED';
  }

  return null;
}

/**
 * Drops whose pickup clock has moved, bounded like every other tick phase.
 *
 * Two statuses, one query, because a drop in `CAPTURED` past its `windowStart` and a
 * drop in `PICKUP_OPEN` past its `windowEnd` are the same question asked twice:
 * "has this drop's window done something?" The `OR` is written out rather than
 * expressed as a `status: { in: [...] }` plus a date filter, because the two halves
 * compare **different columns** — a single `windowEnd` filter would miss every
 * `OPENED` transition, which is exactly the bug this whole module exists to fix.
 *
 * `orderBy` is `windowStart` so a backlog drains oldest-first: the drops most likely
 * to have diners standing outside move before the ones whose windows open tonight.
 */
export async function findPickupDue(args: {
  now: Date;
  limit: number;
}): Promise<readonly PickupDue[]> {
  const { now, limit } = args;

  const rows = await prisma.drop.findMany({
    where: {
      OR: [
        { status: FROM_CAPTURED, windowStart: { lte: now } },
        { status: FROM_OPEN, windowEnd: { lte: now } },
      ],
    },
    orderBy: { windowStart: 'asc' },
    take: limit,
    select: { id: true, status: true, windowStart: true, windowEnd: true },
  });

  const due: PickupDue[] = [];
  for (const row of rows) {
    const transition = pickupTransitionFor({
      status: row.status,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      now,
    });
    if (transition) {
      due.push({ dropId: row.id, transition });
    }
  }
  return due;
}

/**
 * The write. Returns whether it happened.
 *
 * Guarded on the **from** status, so a concurrent tick that got there first makes
 * this report `false` rather than re-running the transition. That is the same
 * discipline `settle` uses for capture and `decideFor` uses for the lock: the guard
 * is in the `where`, not in an `if` around it.
 *
 * `completedAt` is written only on `COMPLETED`. Writing it on `OPENED` would make
 * "when did this drop end" answer the window-start, and an `OPENED` row that
 * arrived via the skip path (window already past) would carry a `completedAt`
 * identical to its `windowStart` — a number that is true of nothing.
 */
export async function applyPickupTransition(args: {
  dropId: string;
  transition: PickupTransition;
  now: Date;
}): Promise<boolean> {
  const { dropId, transition, now } = args;

  const from = transition === 'OPENED' ? FROM_CAPTURED : FROM_OPEN;
  const to = transition === 'OPENED' ? TO_OPEN : TO_COMPLETED;

  const result = await prisma.drop.updateMany({
    where: { id: dropId, status: from },
    data:
      transition === 'COMPLETED'
        ? { status: to, completedAt: now }
        : { status: to },
  });

  if (result.count === 0) {
    // Lost the race, or the row moved by hand between the read and this write.
    // Not an error: the other writer did the work, and the tick reports it as a
    // no-op. Logged at `info` rather than `warn` because it is the expected
    // outcome of two overlapping schedules.
    return false;
  }

  logger.info('settlement.pickup_transition', { dropId, from, to });
  return true;
}
