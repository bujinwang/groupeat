import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/prisma';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logging/logger';

import { refundKey, type ChargePort } from '@/lib/settlement/charge-port';
import { isVoidSweepStatus } from '@/lib/settlement/drop-status';
import { assertLedgerReconciles, refundEntries } from '@/lib/settlement/ledger';
import { SettlementIntegrityError } from '@/lib/settlement/settlement-error';

/**
 * FR-903 — issue a partial refund on one participant.
 *
 * > `FR-903 | Issue a partial refund on one participant | Ledger adjusted; Stripe refund created`
 * > — PRD-v1.md:550
 *
 * ## The order of operations, and why
 *
 * ```
 * 1. read the participant, its Order, and the merchant's Stripe account
 * 2. refuse anything that is not a refundable capture          (guards, no I/O)
 * 3. call the provider                                         (refunds.create)
 * 4. one transaction: the participant CAS, the Order totals, the ledger rows
 * 5. re-assert L1–L4 against what is now stored
 * ```
 *
 * Step 3 is **before** step 4, and that is the same order `finaliseFailed` uses,
 * for the same reason: a ledger row written before the money moved would be a
 * record of an intention. The window this opens — provider succeeds, process dies
 * before the transaction — is the one §4.2 accepts, and it is survivable because
 * `refundKey(participantId)` is stable: the retry gets the original refund back
 * rather than making a second one.
 *
 * ## Why the reversed fee is read from the outcome and not computed
 *
 * Stripe's docs say a partial refund reverses "a proportional amount of the
 * application fee" and do not state the rounding. `ChargePort.refund` returns
 * `applicationFeeRefundCents`, which the real port reads from
 * `ApplicationFee.amount_refunded`. This module records that number. Recomputing it
 * here — `fee × refunded ÷ subtotal` — would produce a figure one cent off on
 * roughly half of all partial refunds, and nothing would notice, because the only
 * check on the reversal is against itself.
 *
 * ## Why a second refund is refused rather than attempted
 *
 * `LedgerEntry`'s `@@unique([orderId, type])` permits one `REFUND` and one
 * `ADJUSTMENT` per order, so a second refund would fail on a Prisma constraint —
 * an error that reads like a bug in the caller. V1 deliberately permits one refund
 * per order (see the model's docblock); this function says so in a sentence the
 * operator can act on, and the refusal is `409` rather than `500`.
 */

export type RefundOutcome =
  | {
      readonly kind: 'REFUNDED';
      readonly participantId: string;
      readonly dropId: string;
      readonly refundedCents: number;
      readonly platformFeeReversedCents: number;
      /** `re_...` — the provider's id, so the refund can be found later. */
      readonly refundId: string;
    }
  | {
      /**
       * The provider said a refund for this participant already exists. The money
       * is back; this call changed nothing. Not an error — a retry that arrives
       * after the first attempt landed is the normal way this is reached.
       */
      readonly kind: 'ALREADY_REFUNDED';
      readonly participantId: string;
      readonly dropId: string;
      readonly refundedCents: number;
      readonly platformFeeReversedCents: number;
    };

/** The participant fields a refund decision reads. Nothing else. */
type RefundableParticipant = {
  readonly id: string;
  readonly dropId: string;
  readonly qty: number;
  readonly amountCents: number;
  readonly chargeStatus: string;
  readonly dropStatus: string;
  readonly stripeAccountId: string | null;
  readonly order: {
    readonly id: string;
    readonly subtotalCents: number;
    readonly platformFeeCents: number;
    readonly stripeChargeId: string | null;
    readonly refundedCents: number;
  } | null;
};

/**
 * Loads everything one refund needs in one query, then refuses if it may not go
 * ahead.
 *
 * Separated from `issueParticipantRefund` so the guards can be tested without a
 * provider — and so the reason a refund was refused is a value, not an early
 * return buried in a function that also talks to Stripe.
 */
export function refusalFor(participant: RefundableParticipant): AppError | null {
  if (!participant.order) {
    // No capture, no charge, nothing to refund. A `PENDING` or declined
    // participant reaches here, which is correct: their hold is released by the
    // void sweep, not by a refund.
    return AppError.conflict(
      'That participant was never charged, so there is nothing to refund. Their authorisation is released automatically.',
    );
  }

  if (participant.chargeStatus !== 'CAPTURED') {
    // Covers REFUNDED, PARTIALLY_REFUNDED and FAILED with one sentence each needs
    // its own: telling an operator "already refunded" when the card merely declined
    // would send them looking for money that never left.
    if (participant.chargeStatus === 'REFUNDED' || participant.chargeStatus === 'PARTIALLY_REFUNDED') {
      return AppError.conflict('That participant has already been refunded.');
    }
    return AppError.conflict(
      'That participant\u2019s card was never successfully charged, so there is nothing to refund.',
    );
  }

  if (!participant.order.stripeChargeId) {
    // A captured order with no charge id is a data defect, not an operator error.
    // It is a 409 rather than a 500 because the operator can see the sentence and
    // escalate it; the loud trace is the integrity error the caller throws below.
    return AppError.conflict(
      'That order has no Stripe charge reference, so it cannot be refunded automatically. Escalate this one.',
    );
  }

  if (!participant.stripeAccountId) {
    return AppError.conflict(
      'That merchant has no connected Stripe account, so the refund cannot be created.',
    );
  }

  if (participant.order.refundedCents > 0) {
    // Belt to the `chargeStatus` brace. A row can in principle hold a refund
    // total while showing CAPTURED if an earlier transaction half-finished, and
    // attempting a second refund against `@@unique([orderId, type])` would surface
    // as a constraint violation instead of a sentence.
    return AppError.conflict(
      'That order already carries a refund. V1 allows one refund per order.',
    );
  }

  // A drop that is `LOCKED`, `PUBLISHED` or `DRAFT` has not settled: its money is
  // either still a hold or still in flight, and a refund now would race the sweep
  // that is about to void or capture it. `FAILED` and `CANCELLED` are included
  // because a captured participant on a failed drop is exactly FR-902's case, and
  // an operator refunding one by hand is legitimate.
  if (!isVoidSweepStatus(participant.dropStatus)) {
    return AppError.conflict(
      'That drop has not finished settling yet, so its charges cannot be refunded. Try again once it has.',
    );
  }

  return null;
}

export async function issueParticipantRefund(args: {
  participantId: string;
  /** The amount to return. Defaults to the whole order; FR-903 permits less. */
  amountCents?: number;
  port: ChargePort;
  /** The admin who asked, for the log line. Never trusted for authorisation. */
  actorId: string;
  /** Why, for the log. Required by the caller's own UI, not by this function. */
  reason?: string;
}): Promise<RefundOutcome> {
  const participant = await loadParticipant(args.participantId);

  const refusal = refusalFor(participant);
  if (refusal) {
    logger.info('admin.refund_refused', {
      actorId: args.actorId,
      participantId: args.participantId,
      reason: refusal.publicMessage,
    });
    throw refusal;
  }

  // `refusalFor` has proved both are present; the assertions keep the compiler
  // honest without a non-null assertion in the money path.
  const order = participant.order;
  if (!order?.stripeChargeId || !participant.stripeAccountId) {
    throw new SettlementIntegrityError({
      dropId: participant.dropId,
      participantId: participant.id,
      check: 'MISSING_PAYMENT_INTENT',
      detail: 'a refund passed the guards with no charge id or no connected account',
    });
  }

  const requestedCents = args.amountCents ?? order.subtotalCents;
  assertRefundAmount({ requestedCents, orderSubtotalCents: order.subtotalCents, dropId: participant.dropId, participantId: participant.id });

  const outcome = await args.port.refund({
    participantId: participant.id,
    stripeAccountId: participant.stripeAccountId,
    chargeId: order.stripeChargeId,
    amountCents: requestedCents,
    platformFeeCents: order.platformFeeCents,
    // Not configurable: under a direct charge the application fee is only reversed
    // when asked for explicitly (ADR-001 §3.2), and the literal type refuses `false`.
    reverseApplicationFee: true,
    idempotencyKey: refundKey(participant.id),
  });

  await recordRefund({
    participant,
    order,
    refundedCents: requestedCents,
    platformFeeReversedCents: outcome.applicationFeeRefundCents,
    stripeRef: outcome.status === 'REFUNDED' ? outcome.refundId : order.stripeChargeId,
  });

  logger.info('admin.participant_refunded', {
    actorId: args.actorId,
    participantId: participant.id,
    dropId: participant.dropId,
    refundedCents: requestedCents,
    platformFeeReversedCents: outcome.applicationFeeRefundCents,
    outcome: outcome.status,
    // The operator's own words, if the caller captured them. Logged only: this path
    // still writes no `AuditLog` row, even though the table exists (FR-902) and
    // `AuditAction` already declares `'participant.refund'`. Named here rather than
    // quietly omitted — a logged reason is not the record the table is for, and
    // PROGRESS.md carries it as an open gap instead of this file pretending otherwise.
    reason: args.reason ?? null,
  });

  // Read back what is stored and re-assert, exactly as settlement does. A refund
  // path that only trusted its own arithmetic would be the one place a ledger
  // mismatch could be written without anyone noticing.
  await reconcileDrop(participant.dropId);

  return outcome.status === 'REFUNDED'
    ? {
        kind: 'REFUNDED',
        participantId: participant.id,
        dropId: participant.dropId,
        refundedCents: requestedCents,
        platformFeeReversedCents: outcome.applicationFeeRefundCents,
        refundId: outcome.refundId,
      }
    : {
        kind: 'ALREADY_REFUNDED',
        participantId: participant.id,
        dropId: participant.dropId,
        refundedCents: requestedCents,
        platformFeeReversedCents: outcome.applicationFeeRefundCents,
      };
}

/**
 * A refund must be a positive whole number of cents, and must not exceed what is
 * left of the order.
 *
 * The upper bound is not defensive padding: a refund larger than the charge is
 * rejected by Stripe with an error that says nothing about which of our rows was
 * wrong, and the operator sees a provider message instead of a sentence.
 */
function assertRefundAmount(args: {
  requestedCents: number;
  orderSubtotalCents: number;
  dropId: string;
  participantId: string;
}): void {
  if (!Number.isInteger(args.requestedCents) || args.requestedCents <= 0) {
    throw AppError.validation({
      amountCents: 'Enter a refund amount in whole cents, greater than zero.',
    });
  }
  if (args.requestedCents > args.orderSubtotalCents) {
    throw AppError.validation({
      amountCents: `That is more than the ${(args.orderSubtotalCents / 100).toFixed(2)} originally charged.`,
    });
  }
}

/**
 * The refund's transaction: the participant CAS, the `Order`'s running total, and
 * the ledger rows.
 *
 * The CAS is the guard, not a formality. It requires `chargeStatus = 'CAPTURED'`,
 * so a second worker that also got past the (unlocked) read writes zero rows here
 * and therefore writes no ledger entry — the same shape as `recordCapture` and
 * `recordRefund` in `settle.ts`. The `@@unique([orderId, type])` index is the
 * independent second barrier.
 */
async function recordRefund(args: {
  participant: RefundableParticipant;
  order: NonNullable<RefundableParticipant['order']>;
  refundedCents: number;
  platformFeeReversedCents: number;
  stripeRef: string;
}): Promise<void> {
  const { participant, order } = args;

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.dropParticipant.updateMany({
        where: { id: participant.id, chargeStatus: 'CAPTURED' },
        data: { chargeStatus: 'REFUNDED' },
      });
      if (claimed.count !== 1) {
        // Another worker refunded it between our read and this write. Its ledger
        // rows are the truth; ours would be a duplicate, so nothing is written.
        throw AppError.conflict('That participant was refunded by another request.');
      }

      await tx.order.update({
        where: { id: order.id },
        data: {
          refundedCents: { increment: args.refundedCents },
          platformFeeReversedCents: { increment: args.platformFeeReversedCents },
        },
      });

      const entries = refundEntries({
        dropId: participant.dropId,
        orderId: order.id,
        refundedCents: args.refundedCents,
        platformFeeReversedCents: args.platformFeeReversedCents,
        stripeRef: args.stripeRef,
      });
      await tx.ledgerEntry.createMany({ data: [...entries] });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // The unique index on (orderId, type). Reachable if a previous attempt wrote
      // the ledger but not the participant row — the §4.2 window — or by a race the
      // CAS above did not close. The money at Stripe is already back, so this is
      // reported as "already refunded" rather than retried.
      logger.warn('admin.refund_ledger_conflict', {
        participantId: participant.id,
        dropId: participant.dropId,
      });
      throw AppError.conflict('That order already carries a refund entry.');
    }
    throw error;
  }
}

/**
 * L1–L4 against the stored rows, for the one drop.
 *
 * Imported from `ledger.ts` rather than reimplemented, and called with rows read
 * back from the database rather than with the shapes just written — the assertion
 * is about what is stored.
 */
async function reconcileDrop(dropId: string): Promise<void> {
  const [entryRows, orderRows] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { dropId },
      select: { orderId: true, dropId: true, type: true, amountCents: true, stripeRef: true, note: true },
    }),
    prisma.order.findMany({
      where: { dropId },
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
    dropId,
    entries: entryRows.map((row) => ({
      orderId: row.orderId,
      dropId: row.dropId ?? dropId,
      type: row.type,
      amountCents: row.amountCents,
      stripeRef: row.stripeRef,
      note: row.note,
    })),
    orders: orderRows,
  });
}

async function loadParticipant(participantId: string): Promise<RefundableParticipant> {
  const row = await prisma.dropParticipant.findUnique({
    where: { id: participantId },
    select: {
      id: true,
      dropId: true,
      qty: true,
      amountCents: true,
      chargeStatus: true,
      drop: {
        select: {
          status: true,
          merchant: { select: { stripeAccountId: true } },
        },
      },
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
  });

  if (!row) {
    // A foreign participant is 404, never 403 — `authorize.ts`'s rule, applied to a
    // resource id that arrives from a URL.
    throw AppError.notFound('That participant does not exist.');
  }

  return {
    id: row.id,
    dropId: row.dropId,
    qty: row.qty,
    amountCents: row.amountCents,
    chargeStatus: row.chargeStatus,
    dropStatus: row.drop.status,
    stripeAccountId: row.drop.merchant.stripeAccountId,
    order: row.order,
  };
}
