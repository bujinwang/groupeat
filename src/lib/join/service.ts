import { joinAuthorised, joinFailed, joinStarted, thresholdReached } from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';
import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';
import { isGuardrailError, readGuardrailSnapshot, type FeeConstants } from '@/lib/guardrail';
import { resolveDropView } from '@/lib/public/drop-view';
import { platformFeeCentsForOrder } from '@/lib/settlement/platform-fee';

import {
  type JoinPaymentPort,
  isJoinProviderUnavailable,
  joinKey,
} from './payment-port';
import {
  availableQty,
  checkQty,
  dollars,
  type JoinRefusalReason,
  normalisePhone,
  phoneLast4,
  refusalFromBlocked,
  resolveJoinMoney,
} from './rules';

/**
 * The join service — FR-401…FR-407. One row, one lock, two transactions.
 *
 * ## The shape, and why it is two transactions rather than one
 *
 * The obvious implementation is a single transaction that locks the drop, checks
 * capacity, inserts the row and calls the provider. It is wrong, and the reason is
 * already written down in `settle.ts`: **do not make a network call while holding a
 * row lock.** A provider that takes 20 seconds to time out would hold the drop row
 * for 20 seconds, and every other diner joining that drop queues behind it. On a
 * popular drop that is a self-inflicted outage whose symptom is "joining is slow",
 * misdiagnosed as a database problem.
 *
 * So:
 *
 *  1. **Reserve** (transaction 1): lock the drop, sum what is sold, refuse or insert
 *     a `PENDING` participant. Commit. Short, and this is where every race is
 *     decided.
 *  2. **Authorise** (no lock held): ask the provider for a hold, keyed on the
 *     participant id.
 *  3. **Record** (transaction 2): `PENDING → AUTHORIZED`, or `→ FAILED`.
 *
 * ## Why `PENDING` counts against capacity but not toward the threshold
 *
 * A `PENDING` row means "this person has a plate reserved and we are asking their
 * bank". If capacity counted only `AUTHORIZED`, ten diners could start joining a
 * drop with four plates left, all ten would pass the check, and the drop would
 * oversell by six. So capacity includes `PENDING`.
 *
 * The threshold is different: `settle.ts` counts only `AUTHORIZED`, and it is right
 * to. A crashed join must not help a drop reach its minimum. The two readings
 * disagree on purpose, and each is the safe one for its own question.
 *
 * The cost of the choice is a stale `PENDING` holding one plate until it is
 * resolved. The cost of the alternative is a diner paying for food promised to
 * someone else.
 *
 * ## Why `server-only` is not imported
 *
 * Same reason as `db/prisma.ts`, `settlement/settle.ts` and `redemption/redeem.ts`:
 * it throws outside a React Server Component graph, which would make every test in
 * `service.test.ts` impossible. The boundary is enforced by the fact that no
 * `'use client'` file imports this module — checked in `rules.purity.test.ts`.
 */

export type JoinServiceDeps = {
  /** The money seam. The real port in production; the fake in tests. */
  readonly paymentPort: JoinPaymentPort;
  /** Injected so a test can pin the clock. Defaults to now. */
  readonly now?: Date;
};

export type JoinRequest = {
  /** `Drop.publicCode` — the bearer token in the URL. */
  readonly publicCode: string;
  /** Digits as typed. Normalised here, so no caller has to remember the format. */
  readonly phone: string;
  readonly qty: number;
  readonly name?: string;
  /**
   * Whether the diner ticked the consent box.
   *
   * Absent means `false`. An unticked box is not consent, and defaulting the other
   * way would be a CASL problem dressed as a convenience.
   */
  readonly consented?: boolean;
  /** Recorded only when supplied. Never logged. */
  readonly ipAddress?: string;
};

/** The fields of a join that may leave the service. No phone number, ever, in full. */
export type JoinSuccess = {
  readonly ok: true;
  readonly participantId: string;
  readonly dropId: string;
  readonly qty: number;
  readonly amountCents: number;
  /** `"$26.20"` — formatted once, here (CONTRIBUTING.md). */
  readonly amountLabel: string;
  readonly phoneLast4: string;
  /**
   * The row's real state, not an assumption.
   *
   * `PENDING` is returned when this call found an existing join whose authorisation
   * never resolved — a crashed earlier attempt. Reporting that as `AUTHORIZED`
   * would tell a diner their card is held when nobody knows.
   */
  readonly status: 'AUTHORIZED' | 'PENDING';
  /** True when this call found an existing join rather than creating one. */
  readonly alreadyJoined: boolean;
  readonly minQty: number;
  readonly maxQty: number;
  readonly cutoffAt: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  /** ADR-003: the drop already has its minimum, so the copy drops the condition. */
  readonly isConfirmedAlready: boolean;
};

export type JoinFailure = {
  readonly ok: false;
  readonly reason: JoinRefusalReason;
  /** The HTTP status the route should use. */
  readonly status: 400 | 402 | 404 | 409 | 422 | 500 | 503;
};

export type JoinResult = JoinSuccess | JoinFailure;

function fail(reason: JoinRefusalReason, status: JoinFailure['status']): JoinFailure {
  return { ok: false, reason, status };
}

/**
 * Records a refusal in the funnel.
 *
 * The log line and the funnel event are written from the same `reason` string on
 * purpose: a refusal reason added to `rules.ts` is then measured automatically,
 * rather than needing a second hand-maintained list here that would silently omit
 * it. Analytics is not allowed to break the refusal path, and `record`/`emit`
 * cannot throw.
 */
function recordRefusal(reason: JoinRefusalReason, dropId?: string): void {
  record(joinFailed({ dropId, reason }));
}

/**
 * The fee constants in force when the drop was **published**.
 *
 * Reading `DEFAULT_FEES` here would re-price a published drop the day the platform
 * changed its fee, and two diners on the same drop would pay different fees
 * depending on when they joined. The snapshot is the only correct source
 * (M5 design §11.1), and `platformFeeCentsForOrder` requires it with no default for
 * exactly this reason.
 *
 * An unreadable snapshot is a **refusal**. `public-drops.ts` deliberately falls
 * back to the dish's current price so a diner holding a link still sees a page, and
 * that is the right call for display. Taking money on a guessed fee is not the same
 * act.
 */
function feesFromSnapshot(snapshot: unknown): FeeConstants | null {
  try {
    const { input } = readGuardrailSnapshot(snapshot);
    return {
      platformFeePct: input.platformFeePct,
      platformFeeFloorCents: input.platformFeeFloorCents,
      platformFeeCapCents: input.platformFeeCapCents,
      stripePct: input.stripePct,
      stripeFixedCents: input.stripeFixedCents,
    };
  } catch (error) {
    if (!isGuardrailError(error)) throw error;
    return null;
  }
}

/**
 * A refusal raised inside the transaction so that it rolls back.
 *
 * An exception for control flow, and the reason is mechanical: `return` inside a
 * Prisma interactive transaction **commits** it, so a refused join that returned
 * early would commit whatever it had already written — a `Customer` row, say, for a
 * join that never happened. Throwing is the only way to both refuse and roll back,
 * and this class carries the refusal so the caller gets a value rather than a stack
 * trace.
 */
class JoinRefused extends Error {
  readonly result: JoinFailure;
  /**
   * Which drop, when it is known.
   *
   * `NOT_FOUND` is thrown before a drop row exists, so the field is optional and
   * the refusal is still measured — just not attributable to a drop, which is
   * correct: there is no drop it happened to.
   */
  readonly dropId?: string;

  constructor(result: JoinFailure, dropId?: string) {
    super(`join refused: ${result.reason}`);
    this.name = 'JoinRefused';
    this.result = result;
    this.dropId = dropId;
  }
}

type Reserved = {
  readonly participantId: string;
  readonly dropId: string;
  /** For analytics only — never rendered, never part of the response. */
  readonly merchantId: string;
  readonly qty: number;
  readonly amountCents: number;
  readonly platformFeeCents: number;
  readonly stripeAccountId: string | null;
  readonly minQty: number;
  readonly maxQty: number;
  readonly cutoffAt: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly isConfirmedAlready: boolean;
  /** `false` when an existing live join was found and nothing was created. */
  readonly newlyCreated: boolean;
  readonly existingStatus: 'AUTHORIZED' | 'PENDING' | null;
};

export async function joinDrop(
  request: JoinRequest,
  deps: JoinServiceDeps,
): Promise<JoinResult> {
  const now = deps.now ?? new Date();

  // --------------------------------------------------------------- 1. Input
  //
  // Cheap refusals before opening a transaction. Normalising the phone here also
  // means the participant row and the `ConsentRecord` cannot disagree about its
  // format — the record must reference the same string the texts will go to.
  const phone = normalisePhone(request.phone);
  if (!phone.ok) {
    logger.info('join.refused', { reason: 'BAD_PHONE' });
    recordRefusal('BAD_PHONE');
    return fail('BAD_PHONE', 422);
  }

  // `join_started` — somebody with a valid request tried to join. Emitted here
  // rather than at the route so that the funnel's second step means "a real
  // attempt", not "a request arrived": a bodiless POST from a scanner is not a
  // diner, and counting it would make the funnel busy in a way that is not true.
  // No `merchantId` yet — the drop has not been read, and reading it here to
  // decorate a log line would be a second query on every attempt.
  record(joinStarted({ qty: request.qty }));

  // -------------------------------------------------- 2. Reserve, under the lock
  let reserved: Reserved;

  try {
    reserved = await prisma.$transaction(async (tx) => {
      /**
       * The lock.
       *
       * `FOR UPDATE` on the **drop** row, not on participant rows, because capacity
       * is a sum over participants: locking a participant would lock nothing the
       * next joiner reads. Serialising joins per drop is the guarantee needed and
       * costs nothing at this scale.
       *
       * Under READ COMMITTED (Prisma's Postgres default) the row is re-read after
       * the lock is won, so the values below are the committed ones — the same
       * idiom, and the same reason, as `cutoff-decision.ts`.
       */
      const locked = await tx.$queryRaw<
        {
          id: string;
          merchantId: string;
          status: string;
          dealPriceCents: number;
          minQty: number;
          maxQty: number;
          maxPerCustomer: number;
          cutoffAt: Date;
          windowStart: Date;
          windowEnd: Date;
          guardrailSnapshot: unknown;
        }[]
      >`
        SELECT "id", "merchantId", "status"::text AS "status", "dealPriceCents", "minQty",
               "maxQty", "maxPerCustomer", "cutoffAt", "windowStart", "windowEnd",
               "guardrailSnapshot"
          FROM "Drop"
         WHERE "publicCode" = ${request.publicCode}
           FOR UPDATE`;

      const drop = locked[0];
      if (!drop || drop.status === 'DRAFT') {
        // A draft and a nonexistent code answer identically, on purpose: a guessed
        // code must not reveal that an unpublished drop exists.
        throw new JoinRefused(fail('NOT_FOUND', 404));
      }

      // Sold = committed or being committed. `PENDING` included; see the docblock.
      const soldRows = await tx.$queryRaw<{ sold: number }[]>`
        SELECT COALESCE(SUM("qty"), 0)::int AS "sold"
          FROM "DropParticipant"
         WHERE "dropId" = ${drop.id}
           AND "authStatus" IN ('PENDING', 'AUTHORIZED')`;
      const soldQty = Number(soldRows[0]?.sold ?? 0);

      // The quantity limit for this request: the drop's cap, clamped, and never
      // more than what is left.
      const limit = availableQty({
        maxPerCustomer: drop.maxPerCustomer,
        remaining: drop.maxQty - soldQty,
      });
      const qtyCheck = checkQty(request.qty, limit);

      // The drop's own state machine, taken from `drop-view.ts` rather than
      // re-derived. Passing it the same numbers the page used is what stops the
      // button and the API disagreeing about whether the door is open.
      const view = resolveDropView({
        status: drop.status,
        minQty: drop.minQty,
        maxQty: drop.maxQty,
        cutoffAt: drop.cutoffAt,
        windowStart: drop.windowStart,
        windowEnd: drop.windowEnd,
        joinedQty: soldQty,
        now,
      });

      // An existing live join answers before the quantity check does: a person who
      // already holds four plates asking for one more should hear "you are already
      // in", not "you asked for too many". The customer upsert has to happen first
      // to know who this is, which is why it precedes both checks.
      const customer = await tx.customer.upsert({
        where: { phone: phone.e164 },
        create: { phone: phone.e164, ...(request.name ? { name: request.name } : {}) },
        update: request.name ? { name: request.name } : {},
        select: { id: true },
      });

      const existing = await tx.dropParticipant.findUnique({
        where: { dropId_customerId: { dropId: drop.id, customerId: customer.id } },
        select: { id: true, qty: true, amountCents: true, authStatus: true },
      });

      if (existing && existing.authStatus !== 'FAILED') {
        // The double-submit case. Answer with the join they already have rather
        // than putting a second hold on their card. `@@unique([dropId, customerId])`
        // is the schema half of this rule; this is the behaviour half.
        if (existing.authStatus === 'AUTHORIZED' || existing.authStatus === 'PENDING') {
          return {
            participantId: existing.id,
            dropId: drop.id,
            merchantId: drop.merchantId,
            qty: existing.qty,
            amountCents: existing.amountCents,
            platformFeeCents: 0,
            stripeAccountId: null,
            minQty: drop.minQty,
            maxQty: drop.maxQty,
            cutoffAt: drop.cutoffAt,
            windowStart: drop.windowStart,
            windowEnd: drop.windowEnd,
            isConfirmedAlready: view.thresholdMet,
            newlyCreated: false,
            existingStatus: existing.authStatus,
          };
        }
        // VOIDED / EXPIRED: the drop is past its cutoff, so `view` will already have
        // refused above. Belt and braces — treat it as closed rather than reviving it.
        throw new JoinRefused(fail('CLOSED', 409), drop.id);
      }

      // The drop's own state, and whether *this quantity* fits in what is left.
      // Checked before the per-customer cap, because "this one is full" and "you
      // asked for one too many" are different sentences and the first is the one a
      // diner on a sold-out drop needs to read.
      const blockedReason = refusalFromBlocked(
        view.joinBlockedReason,
        request.qty,
        drop.maxQty - soldQty,
      );
      if (blockedReason !== null) {
        throw new JoinRefused(fail(blockedReason, 409), drop.id);
      }

      if (!qtyCheck.ok) {
        // Past this point the drop has room, so the only remaining objection is the
        // per-customer cap.
        throw new JoinRefused(fail('BAD_QTY', 422), drop.id);
      }

      // ---- Money. Authored here and nowhere else (ADR-002).
      const fees = feesFromSnapshot(drop.guardrailSnapshot);
      if (fees === null) {
        // Logged as a data error with the drop id, because it is one: a published
        // drop whose snapshot this build cannot read.
        logger.error('join.pricing_unavailable', { dropId: drop.id });
        throw new JoinRefused(fail('PRICE_UNAVAILABLE', 500), drop.id);
      }

      // Per unit, then multiplied — ADR-004 §4, via the one function that
      // implements it. Qty is a positive integer here because `checkQty` passed.
      const platformFeeCents = platformFeeCentsForOrder({
        qty: request.qty,
        dealPriceCents: drop.dealPriceCents,
        fees,
      });

      const money = resolveJoinMoney({
        qty: request.qty,
        dealPriceCents: drop.dealPriceCents,
        platformFeeCents,
      });
      if (!money.ok) {
        logger.error('join.pricing_unavailable', { dropId: drop.id });
        throw new JoinRefused(fail('PRICE_UNAVAILABLE', 500), drop.id);
      }

      // Consent, written in the same transaction as the join: a consent record that
      // can exist without the join it belongs to, or vice versa, is a record nobody
      // can rely on in a CASL dispute.
      if (request.consented === true) {
        await tx.consentRecord.create({
          data: {
            phone: phone.e164,
            basis: 'EXPRESS',
            source: 'drop_join',
            ...(request.ipAddress ? { ipAddress: request.ipAddress } : {}),
          },
          select: { id: true },
        });
      }

      const participant = existing
        ? // A previous attempt was declined. Reuse the row: it keeps one person's
          // history in one place and keeps the unique index honest.
          await tx.dropParticipant.update({
            where: { id: existing.id },
            data: {
              qty: request.qty,
              amountCents: money.money.amountCents,
              platformFeeCents: money.money.platformFeeCents,
              authStatus: 'PENDING',
              chargeStatus: 'NONE',
              paymentIntentId: null,
              redeemedQty: 0,
              redeemedAt: null,
              redeemedByUserId: null,
            },
            select: { id: true },
          })
        : await tx.dropParticipant.create({
            data: {
              dropId: drop.id,
              customerId: customer.id,
              qty: request.qty,
              amountCents: money.money.amountCents,
              platformFeeCents: money.money.platformFeeCents,
              authStatus: 'PENDING',
              chargeStatus: 'NONE',
            },
            select: { id: true },
          });

      const stripeAccountId = await tx.merchant
        .findUnique({
          where: { id: drop.merchantId },
          select: { stripeAccountId: true },
        })
        .then((row) => row?.stripeAccountId ?? null);

      return {
        participantId: participant.id,
        dropId: drop.id,
        merchantId: drop.merchantId,
        qty: request.qty,
        amountCents: money.money.amountCents,
        platformFeeCents: money.money.platformFeeCents,
        stripeAccountId,
        minQty: drop.minQty,
        maxQty: drop.maxQty,
        cutoffAt: drop.cutoffAt,
        windowStart: drop.windowStart,
        windowEnd: drop.windowEnd,
        isConfirmedAlready: view.thresholdMet,
        newlyCreated: true,
        existingStatus: null,
      };
    });
  } catch (error) {
    if (error instanceof JoinRefused) {
      logger.info('join.refused', { reason: error.result.reason });
      // One place for all six in-transaction refusals (not found, closed, blocked,
      // bad qty, price unavailable) rather than a call beside each `throw` — the
      // `reason` travels on the error, so a seventh throw added later is measured
      // without anyone remembering to add a line here.
      recordRefusal(error.result.reason, error.dropId);
      return error.result;
    }
    throw error;
  }

  // An existing join: nothing to authorise, and nothing new to log.
  if (!reserved.newlyCreated && reserved.existingStatus !== null) {
    logger.info('join.already_joined', {
      dropId: reserved.dropId,
      participantId: reserved.participantId,
      status: reserved.existingStatus,
    });
    return {
      ok: true,
      participantId: reserved.participantId,
      dropId: reserved.dropId,
      qty: reserved.qty,
      amountCents: reserved.amountCents,
      amountLabel: dollars(reserved.amountCents),
      phoneLast4: phoneLast4(phone.e164),
      status: reserved.existingStatus,
      alreadyJoined: true,
      minQty: reserved.minQty,
      maxQty: reserved.maxQty,
      cutoffAt: reserved.cutoffAt,
      windowStart: reserved.windowStart,
      windowEnd: reserved.windowEnd,
      isConfirmedAlready: reserved.isConfirmedAlready,
    };
  }

  // -------------------------------------- 3. Authorise, with no lock held
  if (reserved.stripeAccountId === null) {
    // A merchant who has not finished Connect onboarding cannot take a card. Mark
    // the reserved row failed rather than leaving a `PENDING` that will never
    // resolve, and release the plate.
    await markFailed(reserved.participantId);
    logger.info('join.refused', { reason: 'PAYMENTS_NOT_CONFIGURED', dropId: reserved.dropId });
    recordRefusal('PAYMENTS_NOT_CONFIGURED', reserved.dropId);
    return fail('PAYMENTS_NOT_CONFIGURED', 503);
  }

  let outcome;
  try {
    outcome = await deps.paymentPort.createJoinAuthorisation({
      dropId: reserved.dropId,
      participantId: reserved.participantId,
      stripeAccountId: reserved.stripeAccountId,
      amountCents: reserved.amountCents,
      platformFeeCents: reserved.platformFeeCents,
      currency: 'cad',
      idempotencyKey: joinKey(reserved.participantId),
    });
  } catch (error) {
    if (isJoinProviderUnavailable(error)) {
      // The state is UNKNOWN: the hold may or may not exist. Leave the row
      // `PENDING` on purpose — it holds the plate, so the diner is not told they
      // have food they might not, and reconciliation resolves it by idempotency
      // key rather than by guessing.
      logger.warn('join.payment_unavailable', {
        dropId: reserved.dropId,
        participantId: reserved.participantId,
        reason: error.reason,
      });
      recordRefusal('PAYMENT_UNAVAILABLE', reserved.dropId);
      return fail('PAYMENT_UNAVAILABLE', 503);
    }
    throw error;
  }

  // -------------------------------------------------- 4. Record the answer
  //
  // The row is matched by id **and** by the `PENDING` state it was left in. If a
  // concurrent request already resolved it, or a unique constraint rejected the
  // write, the update matches nothing — and `updateMany` reports that as `count: 0`
  // instead of throwing. A hold with no row recording it is the worst outcome
  // available here, so a missing row is treated as a failure the caller can see
  // rather than a success with a log line.
  if (outcome.status === 'DECLINED') {
    await markFailed(reserved.participantId);
    logger.info('join.declined', {
      dropId: reserved.dropId,
      participantId: reserved.participantId,
      declineCode: outcome.declineCode,
    });
    recordRefusal('PAYMENT_DECLINED', reserved.dropId);
    return fail('PAYMENT_DECLINED', 402);
  }

  const recorded = await prisma.$transaction(async (tx) => {
    // The drop row is locked for the same reason the reserve transaction locks it:
    // the before/after totals below are only meaningful if no other join can flip
    // a participant in between reading them and flipping ours. There is no network
    // call here — the provider has already answered — so the lock is held for two
    // statements, which is the whole cost.
    await tx.$queryRaw`SELECT "id" FROM "Drop" WHERE "id" = ${reserved.dropId} FOR UPDATE`;

    const before = await thresholdTotal(tx, reserved.dropId);

    const updated = await tx.dropParticipant.updateMany({
      where: { id: reserved.participantId, authStatus: 'PENDING' },
      data: {
        authStatus: 'AUTHORIZED',
        paymentIntentId: outcome.paymentIntentId,
      },
    });

    const after = updated.count === 1 ? before + reserved.qty : before;

    return { count: updated.count, before, after };
  });

  if (recorded.count !== 1) {
    // The card is held but the row is not ours. Logged with the intent id so the
    // money can be traced and released by hand or by M8's reconciliation; the diner
    // is told the truth (nothing is confirmed) rather than that they are in.
    logger.error('join.record_failed', {
      dropId: reserved.dropId,
      participantId: reserved.participantId,
    });
    recordRefusal('PAYMENT_UNAVAILABLE', reserved.dropId);
    return fail('PAYMENT_UNAVAILABLE', 503);
  }

  logger.info('join.authorised', {
    dropId: reserved.dropId,
    participantId: reserved.participantId,
    qty: reserved.qty,
    amountCents: reserved.amountCents,
    platformFeeCents: reserved.platformFeeCents,
  });

  // ------------------------------------------------ 5. The funnel (§10.1)
  //
  // `join_authorised` is the numerator of PRD §10.2's join-conversion target, so
  // it is emitted on the one path where a hold genuinely exists. A `PENDING` row is
  // not a join; the authorisation is.
  record(
    joinAuthorised({
      dropId: reserved.dropId,
      merchantId: reserved.merchantId,
      participantId: reserved.participantId,
      qty: reserved.qty,
      amountCents: reserved.amountCents,
    }),
  );

  // The crossing is decided by `thresholdReached` from the totals the transaction
  // just read, on the same population `settle.ts` and the public page use —
  // `AUTHORIZED` only, because a `PENDING` row holds a plate it has not paid for.
  // Passing both totals rather than a boolean keeps the "exactly once" logic in one
  // testable place: the builder returns `null` unless this authorisation is the one
  // that took the drop from below its minimum to at or past it.
  record(
    thresholdReached({
      dropId: reserved.dropId,
      merchantId: reserved.merchantId,
      minQty: reserved.minQty,
      previousQty: recorded.before,
      currentQty: recorded.after,
    }),
  );

  return {
    ok: true,
    participantId: reserved.participantId,
    dropId: reserved.dropId,
    qty: reserved.qty,
    amountCents: reserved.amountCents,
    amountLabel: dollars(reserved.amountCents),
    phoneLast4: phoneLast4(phone.e164),
    status: 'AUTHORIZED',
    alreadyJoined: false,
    minQty: reserved.minQty,
    maxQty: reserved.maxQty,
    cutoffAt: reserved.cutoffAt,
    windowStart: reserved.windowStart,
    windowEnd: reserved.windowEnd,
    isConfirmedAlready: reserved.isConfirmedAlready,
  };
}

/**
 * Marks a reserved row failed, releasing no capacity-visible plate.
 *
 * `FAILED` is excluded from the capacity sum in the reserve transaction, so this
 * frees the plate for the next diner. It is written in its own statement rather than
 * in a transaction because it is a single-row update whose only requirement is that
 * it happens at all.
 */
async function markFailed(participantId: string): Promise<void> {
  await prisma.dropParticipant.update({
    where: { id: participantId },
    data: { authStatus: 'FAILED' },
    select: { id: true },
  });
}

/**
 * Plates on a drop that count toward its **threshold**.
 *
 * `AUTHORIZED` only. This is deliberately a different population from the one the
 * reserve transaction sums for **capacity**, which includes `PENDING` — the two
 * questions have different safe answers and conflating them produces a specific,
 * plausible-looking bug:
 *
 *   - Capacity must include `PENDING`, or a drop oversells by the number of joins
 *     in flight.
 *   - The threshold must exclude `PENDING`, or a join whose card was never
 *     authorised helps a drop "reach" its minimum, and a drop that reached its
 *     minimum is a drop whose diners get charged.
 *
 * It matches `public-drops.ts` (`authStatus: 'AUTHORIZED'`) and `settle.ts`
 * (FR-501), so the number a diner sees, the number that decides the cutoff, and the
 * number the funnel reports are the same number.
 */
async function thresholdTotal(
  tx: { $queryRaw: typeof prisma.$queryRaw },
  dropId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ total: number }[]>`
    SELECT COALESCE(SUM("qty"), 0)::int AS "total"
      FROM "DropParticipant"
     WHERE "dropId" = ${dropId}
       AND "authStatus" = 'AUTHORIZED'`;
  return Number(rows[0]?.total ?? 0);
}
