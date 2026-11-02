import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';
import { verifyRedemptionCode } from '@/lib/settlement/redemption-code';

import {
  type RefusalReason,
  isRedeemableStatus,
  normaliseScannedCode,
  resolveRedeemQuantity,
} from './rules';

/**
 * Redeeming a code — FR-601…FR-605.
 *
 * ## The shape of the answer
 *
 * A discriminated union, not exceptions. `ALREADY_REDEEMED` and every refusal are
 * values, because none of them is a bug: a queue at 6pm contains double taps, a
 * diner at the wrong restaurant, and a drop that failed to fill. Throwing would
 * force the route to unpack a `catch` and would make the "normal" path the
 * exceptional one. This mirrors `CaptureOutcome` in settlement, where a declined
 * card is data rather than an error.
 *
 * ## The one hard invariant
 *
 * `redeemedQty` must never exceed `qty`, and two staff members scanning the same
 * code at the same second must not both take the last plate. That is enforced by
 * `SELECT … FOR UPDATE` inside a transaction — read the row under a lock, decide
 * from what that read says, write. The database is the arbiter, so a loser finds
 * `remaining = 0` and is told the truth.
 *
 * Read-then-write *without* a lock would be wrong in exactly the way that matters:
 * two requests both read `redeemedQty = 0`, both decide to take 2, and both write
 * 2 — the first diner's plates vanish. Prisma's default isolation on Postgres is
 * READ COMMITTED, which does not prevent this: two `UPDATE`s on the same row do
 * not conflict until they write, at which point the second has already decided.
 *
 * The lock is also what makes the reported quantity honest. See `claimUnits`.
 *
 * ## Why `redeemedAt` is set once
 *
 * FR-605's double scan shows "already redeemed at {time}". That is the time of the
 * **first** scan, so `redeemedAt` is only written when it is null. A `PARTIAL`
 * redeem therefore reports the time of the first bite, which is what the staff
 * member remembers, not the time of the most recent one.
 *
 * ## Why `server-only` is not imported here
 *
 * Same reason as `db/prisma.ts` and `settlement/run-tick.ts`: it throws outside a
 * React Server Component graph, which would make the concurrency tests — the ones
 * that prove the lock in `claimUnits` works against real Postgres — impossible to
 * run. The invariant in this file is not expressible in TypeScript, so the test
 * that checks it has to be able to import the file. The server boundary is held
 * by the route (which is where a client component would have to reach through) and
 * by the ESLint restricted-import rule.
 */

export type RedeemOutcome =
  | {
      readonly kind: 'REDEEMED';
      readonly participantId: string;
      readonly dropId: string;
      readonly name: string | null;
      readonly qty: number;
      readonly taken: number;
      readonly redeemedQty: number;
      readonly remaining: number;
    }
  | {
      readonly kind: 'PARTIAL';
      readonly participantId: string;
      readonly dropId: string;
      readonly name: string | null;
      readonly qty: number;
      readonly taken: number;
      readonly redeemedQty: number;
      readonly remaining: number;
      /** Why the rest could not be given: another scan got there first. */
      readonly reason: 'ALREADY_PARTLY_REDEEMED';
    }
  | {
      readonly kind: 'ALREADY_REDEEMED';
      readonly participantId: string;
      readonly dropId: string;
      readonly name: string | null;
      readonly qty: number;
      readonly redeemedQty: number;
      /** FR-605: the time of the first collection, not the most recent scan. */
      readonly redeemedAt: Date | null;
    }
  | {
      readonly kind: 'REFUSED';
      readonly reason: RefusalReason;
    };

export type RedeemArgs = {
  /** The raw string from the scanner or the keyboard, before cleaning. */
  readonly code: string;
  /** The signed-in user's merchant ids. A code outside this set is not found. */
  readonly merchantIds: readonly string[];
  /** The `User.id` recorded on the row, for the audit trail. */
  readonly userId: string;
  /** How many units to take. Omitted means "all remaining". */
  readonly requested?: number;
};

/**
 * The refusal is logged with the reason and the ids, and **never with the code**.
 *
 * The code is a bearer token: whoever holds it can claim food. A log line is the
 * one place a secret leaks by accident — into a dashboard, a support ticket, a
 * third-party aggregator — so it is not a parameter of this function at all.
 */
function refuse(reason: RefusalReason, context: { dropId?: string; participantId?: string }): RedeemOutcome {
  logger.info('redemption.refused', {
    reason,
    ...(context.dropId ? { dropId: context.dropId } : {}),
    ...(context.participantId ? { participantId: context.participantId } : {}),
  });
  return { kind: 'REFUSED', reason };
}

/**
 * How many times a lost race is retried before the scan is answered with the
 * truth rather than another attempt.
 *
 * One retry is all the happy path needs: the loser re-reads and sees the row the
 * winner wrote. The limit exists because an unlocked retry loop under sustained
 * contention is an unbounded loop against the database — the failure mode of a
 * busy counter at 6pm, which is exactly when this code runs. Two failures give a
 * `PARTIAL`-like honest answer (`FULLY_REDEEMED`) instead of a hang.
 */
const MAX_CLAIM_ATTEMPTS = 3;

/** Internal: "the row moved under me, re-read it". Never escapes this module. */
type AttemptResult =
  | RedeemOutcome
  | { readonly kind: 'RETRY'; readonly participantId: string; readonly dropId: string };

export async function redeemCode(args: RedeemArgs): Promise<RedeemOutcome> {
  const { merchantIds } = args;

  // An empty scope means a user with no MerchantUser row. 404, per US-M1: they
  // must not learn that the code was valid.
  if (merchantIds.length === 0) {
    return refuse('NOT_YOUR_DROP', {});
  }

  // Normalised once, before the loop: it is a pure string transform, and doing it
  // per attempt would let a retry see a different code than the one verified.
  const code = normaliseScannedCode(args.code);
  if (code.length === 0) {
    return refuse('BAD_CODE', {});
  }

  let lastSeen: { participantId: string; dropId: string } | null = null;

  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const result = await attemptRedeem(args, code);
    if (result.kind !== 'RETRY') {
      return result;
    }
    lastSeen = { participantId: result.participantId, dropId: result.dropId };
    logger.info('redemption.retry', { attempt, maxAttempts: MAX_CLAIM_ATTEMPTS });
  }

  // Every attempt found the row taken by someone else. That is not an error; it is
  // the queue working. The diner is told their plates were collected — and, per
  // FR-605, told *when*, so the answer is re-read rather than guessed. One primary
  // key read, on a path that only a genuine race reaches.
  return alreadyRedeemedAnswer(lastSeen);
}

async function alreadyRedeemedAnswer(
  seen: { participantId: string; dropId: string } | null,
): Promise<RedeemOutcome> {
  if (!seen) {
    return refuse('FULLY_REDEEMED', {});
  }
  const row = await prisma.dropParticipant.findUnique({
    where: { id: seen.participantId },
    select: {
      id: true,
      dropId: true,
      qty: true,
      redeemedQty: true,
      redeemedAt: true,
      customer: { select: { name: true } },
    },
  });
  if (!row) {
    // Deleted mid-race. Nothing to hand over, and nothing to describe.
    return refuse('FULLY_REDEEMED', seen);
  }
  logger.info('redemption.already_redeemed', {
    dropId: row.dropId,
    participantId: row.id,
    afterRetries: true,
  });
  return {
    kind: 'ALREADY_REDEEMED',
    participantId: row.id,
    dropId: row.dropId,
    name: row.customer.name,
    qty: row.qty,
    redeemedQty: row.redeemedQty,
    redeemedAt: row.redeemedAt,
  };
}

async function attemptRedeem(args: RedeemArgs, code: string): Promise<AttemptResult> {
  const { merchantIds, userId, requested } = args;

  const payload = verifyRedemptionCode(code);
  if (!payload) {
    return refuse('BAD_CODE', {});
  }

  // One query for everything the decision needs. Scoped by the participant's own
  // drop's merchant, so a valid code from another merchant is indistinguishable
  // from a missing one.
  const participant = await prisma.dropParticipant.findUnique({
    where: { id: payload.participantId },
    select: {
      id: true,
      dropId: true,
      qty: true,
      redeemedQty: true,
      redeemedAt: true,
      chargeStatus: true,
      customer: { select: { name: true } },
      drop: { select: { id: true, status: true, merchantId: true } },
    },
  });

  if (!participant) {
    return refuse('UNKNOWN_PARTICIPANT', {});
  }
  if (!merchantIds.includes(participant.drop.merchantId)) {
    // The id exists; this user just may not see it. Reported as "not found" with
    // the same copy as a genuine miss — see `REFUSAL_COPY`.
    return refuse('NOT_YOUR_DROP', { dropId: participant.dropId, participantId: participant.id });
  }

  const context = { dropId: participant.dropId, participantId: participant.id };

  // The code's own claim about the drop must match the row. A code re-pointed at
  // another drop (or a participant moved between drops by a data fix) would
  // otherwise redeem against whatever the row says now.
  if (payload.dropId !== participant.dropId) {
    return refuse('NOT_YOUR_DROP', context);
  }

  // ---- the drop's state ----------------------------------------------------
  if (!isRedeemableStatus(participant.drop.status)) {
    if (participant.drop.status === 'FAILED') {
      return refuse('DROP_FAILED', context);
    }
    if (participant.drop.status === 'CANCELLED') {
      return refuse('DROP_CANCELLED', context);
    }
    // DRAFT, PUBLISHED, LOCKED, CAPTURED. `CAPTURED` lands here deliberately:
    // capture is at the cutoff, the window has not opened, and there is no food
    // to hand over yet.
    return refuse('NOT_YET', context);
  }

  // ---- the participant's money --------------------------------------------
  // Order matters: `NOT_CHARGED` before `REFUNDED`, because a refunded row is
  // also a row whose authorisation is spent, and "declined" is the more useful
  // sentence only when it is true.
  if (participant.chargeStatus === 'REFUNDED' || participant.chargeStatus === 'PARTIALLY_REFUNDED') {
    return refuse('REFUNDED', context);
  }
  if (participant.chargeStatus === 'FAILED' || participant.chargeStatus === 'NONE') {
    return refuse('NOT_CHARGED', context);
  }
  if (participant.chargeStatus !== 'CAPTURED') {
    // Exhaustive by exclusion: the only remaining value is CAPTURED. Written as a
    // guard rather than an assertion so a future enum member fails closed.
    return refuse('NOT_CHARGED', context);
  }

  // ---- the quantity -------------------------------------------------------
  const quantity = resolveRedeemQuantity({
    qty: participant.qty,
    alreadyRedeemed: participant.redeemedQty,
    requested,
  });

  if (!quantity.ok) {
    logger.info('redemption.already_redeemed', {
      dropId: participant.dropId,
      participantId: participant.id,
    });
    return {
      kind: 'ALREADY_REDEEMED',
      participantId: participant.id,
      dropId: participant.dropId,
      name: participant.customer.name,
      qty: participant.qty,
      redeemedQty: participant.redeemedQty,
      redeemedAt: participant.redeemedAt,
    };
  }

  const take = quantity.take;
  const outcome = await claimUnits({
    participantId: participant.id,
    userId,
    take,
  });

  if (outcome.kind === 'LOST_RACE') {
    // Someone claimed the units between the read above and this write. Ask the
    // caller to re-read and answer from what the row now says — never from the
    // stale snapshot, which is how a counter ends up handing over plates that are
    // not there.
    return { kind: 'RETRY', participantId: participant.id, dropId: participant.dropId };
  }

  const remaining = participant.qty - outcome.redeemedQty;
  const base = {
    participantId: participant.id,
    dropId: participant.dropId,
    name: participant.customer.name,
    qty: participant.qty,
    taken: outcome.took,
    redeemedQty: outcome.redeemedQty,
    remaining,
  };

  logger.info('redemption.redeemed', {
    dropId: participant.dropId,
    participantId: participant.id,
    taken: outcome.took,
    redeemedQty: outcome.redeemedQty,
    qty: participant.qty,
    partial: outcome.took < take,
  });

  // `took < take` means the row had fewer units left under the lock than the read
  // above suggested — a concurrent scan took some first. The units we did get are
  // real and must be reported as collected; the shortfall is reported so the screen
  // can say "the rest was already collected".
  return outcome.took < take
    ? { kind: 'PARTIAL', ...base, reason: 'ALREADY_PARTLY_REDEEMED' }
    : { kind: 'REDEEMED', ...base };
}

type ClaimResult =
  | { readonly kind: 'CLAIMED'; readonly took: number; readonly redeemedQty: number }
  | { readonly kind: 'LOST_RACE' };

/**
 * Take the units, under a row lock.
 *
 * ## Why `SELECT … FOR UPDATE` and not a conditional `UPDATE`
 *
 * A conditional `UPDATE … WHERE redeemedQty <= qty - n` is race-safe, and it was
 * the first thing written here. It was replaced because it cannot report the
 * **delta**: Postgres's `RETURNING` yields the new row, so a statement that sets
 * `redeemedQty = qty` gives you the total and not how many plates this scan
 * actually claimed. Reconstructing the delta meant a second read that a concurrent
 * scanner could invalidate — reintroducing the bug the conditional was there to
 * prevent, in the reporting layer rather than the write.
 *
 * `SELECT … FOR UPDATE` gives the prior value **under the lock**, so `taking` is
 * computed from a row nothing else can touch until this transaction ends. It is
 * also the pattern `settlement/` already uses (`SELECT … FOR UPDATE` with the
 * status predicate inside the transaction), so there is one concurrency idiom in
 * the codebase rather than two.
 *
 * The consequence for the loser: two scanners for the last two plates both enter,
 * one blocks on the lock, then finds `remaining = 0` and is told the truth. That
 * is the correct outcome, and it is the outcome a conditional UPDATE would also
 * have produced — this one just also knows how much it was.
 *
 * ## Why the timestamp says `AT TIME ZONE 'UTC'`
 *
 * `redeemedAt` is `timestamp(3) **without** time zone`. Prisma writes `DateTime`
 * by sending a UTC instant, so every timestamp in this table is UTC — and a bare
 * `NOW()` would not be. `NOW()` returns `timestamptz`, and assigning that to a
 * `timestamp` column silently strips the offset using the **session** time zone,
 * which on the developer's machine is `America/Edmonton`. The stored value would
 * then be seven hours earlier than every other timestamp in the row.
 *
 * That is not a cosmetic bug. FR-605 shows the diner "already collected at
 * {time}", and the value is rendered against the merchant's timezone — so an
 * 8:24pm scan would be reported as 1:24pm, and staff would believe a plate had
 * been handed over before the window opened. It is also invisible in tests that
 * only assert the column is non-null, which is why `redeem.test.ts` pins the
 * stored instant against the clock rather than against `now()`.
 *
 * `cutoff-decision.ts` documents the same cast for the same reason on the read
 * side.
 */
async function claimUnits(args: {
  participantId: string;
  userId: string;
  take: number;
}): Promise<ClaimResult> {
  const { participantId, userId, take } = args;

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ redeemedQty: number; qty: number }[]>`
      SELECT "redeemedQty", "qty"
        FROM "DropParticipant"
       WHERE "id" = ${participantId}
         FOR UPDATE
    `;

    const row = locked[0];
    if (!row) {
      return { kind: 'LOST_RACE' };
    }

    const remaining = row.qty - row.redeemedQty;
    if (remaining <= 0) {
      // Someone collected the rest between the caller's read and this lock.
      return { kind: 'LOST_RACE' };
    }

    // Clamped under the lock, so this is the only place the real number is
    // decided. `take` came from a possibly-stale read; `remaining` is current.
    const taking = Math.min(take, remaining);

    const updated = await tx.$queryRaw<{ redeemedQty: number }[]>`
      UPDATE "DropParticipant"
         SET "redeemedQty" = "redeemedQty" + ${taking},
             "redeemedAt" = COALESCE("redeemedAt", NOW() AT TIME ZONE 'UTC'),
             "redeemedByUserId" = ${userId}
       WHERE "id" = ${participantId}
      RETURNING "redeemedQty"
    `;

    const after = updated[0];
    if (!after) {
      // Unreachable while the lock is held — the row was just read under it. Left
      // as a refusal rather than a throw so a data anomaly cannot 500 a counter.
      return { kind: 'LOST_RACE' };
    }

    return { kind: 'CLAIMED', took: taking, redeemedQty: after.redeemedQty };
  });
}
