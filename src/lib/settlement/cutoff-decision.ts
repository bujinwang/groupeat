import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';

import { SettlementIntegrityError } from './settlement-error';

/**
 * Phase 1 — the decision. Design §1.4, §2, §4.1.
 *
 * Postgres only, no network, one transaction. `decideFor` is the only place in
 * the codebase that writes `LOCKED`, and `LOCKED` is what `LockedDrop` proves.
 *
 * ## The chain that makes "never charge when the threshold is missed" structural
 *
 * ```
 * capture() is called only from settle(locked: LockedDrop)
 *    ↑
 * LockedDrop is produced only by decideFor() or loadLockedDrop(), both here
 *    ↑
 * decideFor() writes LOCKED only when  now >= cutoffAt  AND  joinedQty >= minQty
 * loadLockedDrop() throws unless the row's status is LOCKED, read from Postgres
 *    ↑
 * LOCKED is unreachable except through decideFor's guarded UPDATE
 * ```
 *
 * The brand is the point: `settle.ts` imports `LockedDrop` with `import type`,
 * which is erased, so it **cannot construct** one. To capture a drop that missed
 * its threshold, someone would have to add a second constructor to this file — a
 * change a reviewer sees, rather than a boolean someone forgets to check.
 *
 * The brand is a real `Symbol`, not a `declare const`: a declared unique symbol
 * would erase to a runtime reference to an undeclared binding, and
 * `{ [LOCKED_DROP]: true }` would throw `ReferenceError` the first time a drop
 * was locked.
 *
 * ## Why the status guard is part of the locking select
 *
 * In `READ COMMITTED` (Prisma's default), when `SELECT … FOR UPDATE` blocks on a
 * row another transaction is updating, Postgres waits, then **re-evaluates the
 * `WHERE` clause against the newly committed row version** (EvalPlanQual). If the
 * other worker already moved the drop to `LOCKED`, the row is not returned. So
 * two workers cannot both get a row, and no second `if` is needed after the lock.
 *
 * ## `NO_OP` is deliberately not finer-grained
 *
 * "not due yet" and "another worker just took it" cannot be distinguished without
 * a second, unlocked read whose answer is stale by construction. Both mean *do
 * nothing*, so the type says `NO_OP`. A log line that said `not_due` when the
 * truth was `raced` would be a lie that costs an hour during an incident.
 *
 * ## No `new Date()` in this file
 *
 * Every function takes `now` (§11.2). That is what makes a tick reproducible.
 */

const LOCKED_DROP: unique symbol = Symbol('groupeat.locked-drop');

export type LockedParticipant = {
  readonly participantId: string;
  readonly qty: number;
  readonly amountCents: number;
  readonly platformFeeCents: number;
  readonly paymentIntentId: string;
  /** E.164. Carried for the FR-506 intent only. Never a log field (§11.7). */
  readonly phone: string;
};

/** A drop that Postgres said was LOCKED, with its participant set frozen. */
export type LockedDrop = {
  readonly [LOCKED_DROP]: true;
  readonly dropId: string;
  readonly merchantId: string;
  readonly stripeAccountId: string;
  readonly dealPriceCents: number;
  readonly minQty: number;
  readonly maxQty: number;
  readonly cutoffAt: Date;
  readonly decidedAt: Date;
  readonly joinedQty: number;
  readonly participants: readonly LockedParticipant[];
  /**
   * The pickup window. Not in the design's field list, and required by it:
   * `NotifyIntent` `DROP_CONFIRMED_CHARGED` carries `windowStart`/`windowEnd`
   * (§3.5), and a settled drop must not re-read the row to fill in a message it
   * has already decided to send.
   */
  readonly windowStart: Date;
  readonly windowEnd: Date;
};

export type DecisionOutcome =
  | { readonly kind: 'NO_OP' }
  | { readonly kind: 'LOCKED'; readonly drop: LockedDrop }
  | { readonly kind: 'FAILED'; readonly dropId: string; readonly joinedQty: number };

/** `ceil(minQty × 9/10)`, integer arithmetic only (§2.1, §11.1). */
export function captureToleranceOf(minQty: number): number {
  return Math.ceil((minQty * 9) / 10);
}

/**
 * The second barrier (§1.4). Pure, and exported so it can be tested directly —
 * the SQL filter makes it unreachable through `decideFor`, and an untestable
 * guard is a comment.
 *
 * It exists to fail loudly if a future edit drops `cutoffAt <= $now` from the
 * locking select, which is the one edit that would silently reintroduce charging
 * before the cutoff.
 */
export function assertCutoffReached(args: { cutoffAt: Date; now: Date }): void {
  if (args.now.getTime() < args.cutoffAt.getTime()) {
    throw new CutoffNotReachedError(args);
  }
}

export class CutoffNotReachedError extends Error {
  readonly cutoffAt: Date;
  readonly now: Date;

  constructor(args: { cutoffAt: Date; now: Date }) {
    super(
      `The cutoff has not been reached: now is ${args.now.toISOString()}, cutoff is ${args.cutoffAt.toISOString()}.`,
    );
    this.name = 'CutoffNotReachedError';
    this.cutoffAt = args.cutoffAt;
    this.now = args.now;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type LockingRow = {
  id: string;
  merchantId: string;
  dealPriceCents: number;
  minQty: number;
  maxQty: number;
  cutoffAt: Date;
  windowStart: Date;
  windowEnd: Date;
};

type ParticipantRow = {
  id: string;
  qty: number;
  amountCents: number;
  platformFeeCents: number;
  paymentIntentId: string | null;
  customer: { phone: string };
};

type TxLike = Pick<typeof prisma, 'dropParticipant'>;

/**
 * The participant set, read under the drop lock.
 *
 * Two predicates, deliberately:
 *   - `authStatus = 'AUTHORIZED'` is FR-501 verbatim — `FAILED`, `EXPIRED`,
 *     `VOIDED` and `PENDING` are not claimed plates;
 *   - **or** any row that has charge activity, so a drop resumed after a crash
 *     still sees the participants it already charged or declined. Without the
 *     second clause, a declined participant (which `settle` marks `VOIDED`) would
 *     vanish from the set on the next tick, and the refund and notification
 *     sweeps would forget it existed.
 *
 * On the decide path the second clause can match nothing: no charge has been
 * attempted yet. It is the resume path it is there for.
 */
async function readParticipants(client: TxLike, dropId: string): Promise<ParticipantRow[]> {
  return client.dropParticipant.findMany({
    where: {
      dropId,
      OR: [
        { authStatus: 'AUTHORIZED' },
        { chargeStatus: { in: ['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED'] } },
      ],
    },
    select: {
      id: true,
      qty: true,
      amountCents: true,
      platformFeeCents: true,
      paymentIntentId: true,
      customer: { select: { phone: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

function toLockedParticipants(
  rows: readonly ParticipantRow[],
  dropId: string,
): LockedParticipant[] {
  return rows.map((row) => {
    if (!row.paymentIntentId) {
      // A participant with a live authorisation always has a PaymentIntent: the
      // join path creates both together. Its absence is a data error, and a
      // capture without it is impossible — so the drop stops here rather than
      // settling a subset of its participants and calling that a success.
      throw new SettlementIntegrityError({
        dropId,
        participantId: row.id,
        check: 'MISSING_PAYMENT_INTENT',
        detail: 'an authorised participant has no paymentIntentId, so it cannot be captured',
      });
    }
    return {
      participantId: row.id,
      qty: row.qty,
      amountCents: row.amountCents,
      platformFeeCents: row.platformFeeCents,
      paymentIntentId: row.paymentIntentId,
      phone: row.customer.phone,
    };
  });
}

function sumQty(participants: readonly { qty: number }[]): number {
  return participants.reduce((total, participant) => total + participant.qty, 0);
}

type DecisionContext = {
  readonly merchantId: string;
  readonly minQty: number;
  readonly joinedQty: number;
  readonly outcome: 'LOCKED' | 'FAILED';
};

/**
 * Decide one drop: `PUBLISHED` → `LOCKED` or `FAILED`, or nothing.
 *
 * Returns the `LockedDrop` it just built, so the happy path in a single tick
 * needs one participant read instead of two.
 */
export async function decideFor(args: {
  dropId: string;
  now: Date;
}): Promise<DecisionOutcome> {
  const { dropId, now } = args;

  const result = await prisma.$transaction(
    async (
      tx,
    ): Promise<{ outcome: DecisionOutcome; context: DecisionContext | null }> => {
      // The lock and the status guard are ONE statement (§4.1). The
      // `::timestamptz … AT TIME ZONE 'UTC'` cast is not decoration:
      // `Drop.cutoffAt` is a `timestamp(3)` holding UTC, and comparing it against
      // a bare parameter would let the connection's session time zone decide what
      // "now" means.
      const rows = await tx.$queryRaw<LockingRow[]>`
        SELECT id,
               "merchantId",
               "dealPriceCents",
               "minQty",
               "maxQty",
               "cutoffAt",
               "windowStart",
               "windowEnd"
        FROM "Drop"
        WHERE id = ${dropId}
          AND status = 'PUBLISHED'
          AND "cutoffAt" <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        FOR UPDATE
      `;

      const row = rows[0];
      if (!row) {
        return { outcome: { kind: 'NO_OP' }, context: null };
      }

      // Unreachable through this function — the SQL already filtered. Kept
      // because it is the assertion that fails loudly if someone edits the WHERE.
      assertCutoffReached({ cutoffAt: row.cutoffAt, now });

      const merchant = await tx.merchant.findUnique({
        where: { id: row.merchantId },
        select: { stripeAccountId: true },
      });
      if (!merchant?.stripeAccountId) {
        // Q6, decided by the delivery director: stop and alert. Voiding every
        // authorisation on the strength of a data error would be the worse
        // failure, so the drop stays PUBLISHED past its cutoff until a human
        // fixes it. The throw rolls the transaction back, which is exactly "no
        // write happened".
        throw new SettlementIntegrityError({
          dropId,
          check: 'MISSING_STRIPE_ACCOUNT',
          detail: `merchant ${row.merchantId} has no stripeAccountId, so no charge can be made on its account`,
        });
      }

      const participants = toLockedParticipants(await readParticipants(tx, dropId), dropId);
      const joinedQty = sumQty(participants);

      if (joinedQty >= row.minQty) {
        const updated = await tx.drop.updateMany({
          where: { id: dropId, status: 'PUBLISHED' },
          data: { status: 'LOCKED', lockedAt: now },
        });
        // Under the lock this is unreachable, so a count of 0 means the lock was
        // dropped from the code. Loud beats silent.
        if (updated.count !== 1) {
          throw new Error(
            `decideFor: expected to lock drop ${dropId} but updated ${updated.count} rows. The row lock is not being taken.`,
          );
        }

        const drop: LockedDrop = {
          [LOCKED_DROP]: true,
          dropId,
          merchantId: row.merchantId,
          stripeAccountId: merchant.stripeAccountId,
          dealPriceCents: row.dealPriceCents,
          minQty: row.minQty,
          maxQty: row.maxQty,
          cutoffAt: row.cutoffAt,
          decidedAt: now,
          joinedQty,
          participants,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
        };

        return {
          outcome: { kind: 'LOCKED', drop },
          context: { merchantId: row.merchantId, minQty: row.minQty, joinedQty, outcome: 'LOCKED' },
        };
      }

      const updated = await tx.drop.updateMany({
        where: { id: dropId, status: 'PUBLISHED' },
        data: { status: 'FAILED' },
      });
      if (updated.count !== 1) {
        throw new Error(
          `decideFor: expected to fail drop ${dropId} but updated ${updated.count} rows. The row lock is not being taken.`,
        );
      }

      return {
        outcome: { kind: 'FAILED', dropId, joinedQty },
        context: { merchantId: row.merchantId, minQty: row.minQty, joinedQty, outcome: 'FAILED' },
      };
    },
  );

  // Logged outside the transaction: a log line written inside a transaction that
  // then rolls back would describe something that did not happen.
  if (result.context) {
    logger.info('cutoff.drop_decided', {
      dropId,
      merchantId: result.context.merchantId,
      outcome: result.context.outcome,
      joinedQty: result.context.joinedQty,
      minQty: result.context.minQty,
    });
  }

  return result.outcome;
}

/**
 * The resume path: a `LOCKED` drop from an earlier tick, with its participant set
 * frozen.
 *
 * `null` when the drop is not `LOCKED` — including when it is already `CAPTURED`
 * or `FAILED`. Total and idempotent on purpose: a racing tick asking about a drop
 * another tick just finished is the normal outcome of two overlapping
 * invocations, and must not produce an error.
 */
export async function loadLockedDrop(args: { dropId: string }): Promise<LockedDrop | null> {
  const row = await prisma.drop.findFirst({
    where: { id: args.dropId, status: 'LOCKED' },
    select: {
      id: true,
      merchantId: true,
      dealPriceCents: true,
      minQty: true,
      maxQty: true,
      cutoffAt: true,
      lockedAt: true,
      windowStart: true,
      windowEnd: true,
      merchant: { select: { stripeAccountId: true } },
    },
  });

  if (!row) {
    return null;
  }

  if (!row.merchant.stripeAccountId) {
    // Same posture as Q6 in `decideFor`: stop, alert, leave the row alone. A
    // LOCKED drop in this state has no correct automated exit; FR-902's admin
    // force-fail is M7's.
    throw new SettlementIntegrityError({
      dropId: row.id,
      check: 'MISSING_STRIPE_ACCOUNT',
      detail: `merchant ${row.merchantId} has no stripeAccountId on a LOCKED drop`,
    });
  }

  const participants = toLockedParticipants(await readParticipants(prisma, row.id), row.id);

  const drop: LockedDrop = {
    [LOCKED_DROP]: true,
    dropId: row.id,
    merchantId: row.merchantId,
    stripeAccountId: row.merchant.stripeAccountId,
    dealPriceCents: row.dealPriceCents,
    minQty: row.minQty,
    maxQty: row.maxQty,
    cutoffAt: row.cutoffAt,
    // `lockedAt` is always written by `decideFor`; a null here means the row was
    // moved by hand. Falling back to the cutoff keeps `decidedAt` a `Date`
    // without inventing a clock read (§11.2), and it is only ever used for
    // staleness arithmetic.
    decidedAt: row.lockedAt ?? row.cutoffAt,
    joinedQty: sumQty(participants),
    participants,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
  };

  return drop;
}

/**
 * Drops whose cutoff has passed and which are still `PUBLISHED`.
 *
 * Uses `Drop_status_cutoffAt_idx`. Deliberately not raw SQL: this read takes no
 * lock and its predicate is the same one the locking select re-checks, so the
 * typed query is strictly clearer than the SQL and no less safe.
 */
export async function findDueDrops(args: {
  now: Date;
  limit: number;
}): Promise<readonly string[]> {
  const rows = await prisma.drop.findMany({
    where: { status: 'PUBLISHED', cutoffAt: { lte: args.now } },
    orderBy: { cutoffAt: 'asc' },
    take: args.limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Drops a previous tick locked but did not finish settling.
 *
 * Ordered by `cutoffAt` so it uses `Drop_status_cutoffAt_idx`; a drop locked long
 * ago is the one that needs attention first, and it is also the one the
 * 10-minute stall alert is about.
 */
export async function findLockedDrops(args: { limit: number }): Promise<readonly string[]> {
  const rows = await prisma.drop.findMany({
    where: { status: 'LOCKED' },
    orderBy: { cutoffAt: 'asc' },
    take: args.limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Drops that still hold an authorisation nothing is going to use — the V1 sweep's
 * work queue.
 *
 * **Not in the design, and required by it.** §2.1 lists `FAILED → FAILED` (void
 * sweep) as a transition "this job performs", and §2.2 calls the sweep
 * idempotent. But §4.3 feeds `settle` only the drops that are `LOCKED`, and
 * `findDueDrops` selects `PUBLISHED` only — so on the design as written the
 * authorisations of a drop that failed its threshold are never released, and a
 * crash between writing `FAILED` and sweeping leaves them held for as long as the
 * bank allows. That is a diner's money held for a drop that never ran.
 *
 * ## Why the two statuses are listed here *and* in the guard
 *
 * This queue and the status guard at the top of `voidRemainingAuthorisations` are
 * one rule expressed twice, and **they must list the same statuses**. They are
 * the two terminal statuses a drop can hold an unusable authorisation in:
 *
 *   - `FAILED` — a declined card whose cancellation timed out, or a drop that
 *     failed its threshold with every authorisation still live;
 *   - `CAPTURED` — a declined card on a drop that ran, whose cancellation timed
 *     out in `finaliseCaptured`.
 *
 * A status added to one and not the other produces one of two defects, and both
 * are silent: listed here but refused by the guard means the drop is selected
 * every tick and never progresses; accepted by the guard but not listed here means
 * the work is never queued, so it is never retried — which is the defect QA found,
 * with a `CAPTURED` diner's balance held until the issuer expired it, about seven
 * days later, and nothing in the log.
 *
 * ## Why the participant predicate is the sweep's own, not just `AUTHORIZED`
 *
 * `chargeStatus` must be `NONE` or `FAILED`. A captured participant keeps
 * `authStatus = 'AUTHORIZED'` for ever (the capture consumed the authorisation;
 * there is nothing to cancel), so keying on `authStatus` alone would select every
 * successful drop on every tick: the queue would never drain, and because it is
 * ordered by `cutoffAt` the oldest rows would fill `limit` and starve newer work.
 *
 * Costs one indexed query per tick.
 */
export async function findDropsAwaitingVoid(args: {
  limit: number;
}): Promise<readonly string[]> {
  const rows = await prisma.drop.findMany({
    where: {
      status: { in: ['FAILED', 'CAPTURED'] },
      participants: { some: { authStatus: 'AUTHORIZED', chargeStatus: { in: ['NONE', 'FAILED'] } } },
    },
    orderBy: { cutoffAt: 'asc' },
    take: args.limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
