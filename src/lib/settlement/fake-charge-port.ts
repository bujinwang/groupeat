import {
  type CaptureOutcome,
  type CaptureRequest,
  type ChargePort,
  PaymentProviderUnavailableError,
  type RefundOutcome,
  type RefundRequest,
  type VoidOutcome,
  type VoidRequest,
} from './charge-port';

/**
 * The deterministic in-memory `ChargePort`. Design §9 T01.
 *
 * ## Why the fake dedupes by idempotency key
 *
 * Stripe does. A fake that made a second charge on the second call would make
 * every retry test in `settle.test.ts` pass for the wrong reason: the test would
 * assert "the retry produced one charge" against a fake that cannot produce two,
 * and the real bug — a caller that changes its idempotency key between attempts —
 * would survive to production. So the fake models the property the design leans
 * on (§4.2 guard 1), and `calls.length === 2` with one `chargeId` is the shape
 * that proves it.
 *
 * Not under `__tests__/`: `settle.ts`'s tests import it and so will M8's
 * reconciliation tests, and a file inside `__tests__/` is invisible to the
 * production import graph by convention.
 *
 * ## What it does not model
 *
 * Latency, ordering, partial failure of a batch, or the 24-hour expiry of a
 * stored idempotency key. Those are provider behaviours, and the design's answer
 * to them is the `Order`-row repair path in `settle.ts`, which is tested by
 * pre-creating the `Order` row rather than by making the fake forget.
 */

export type FakeChargeCall =
  | { readonly kind: 'capture'; readonly request: CaptureRequest }
  | { readonly kind: 'void'; readonly request: VoidRequest }
  | { readonly kind: 'refund'; readonly request: RefundRequest };

export type FakeChargePortOptions = {
  /** These participants' captures return `DECLINED`. They never throw. */
  readonly declineParticipantIds?: readonly string[];
  /** The `declineCode` reported for every decline. Default `card_declined`. */
  readonly declineCode?: string;
  /** The first capture for each of these participants throws `timeout`. */
  readonly unavailableOnceFor?: readonly string[];
  /** The first refund for each of these participants throws `timeout`. */
  readonly refundUnavailableOnceFor?: readonly string[];
  /** The first void for each of these participants throws `timeout`. */
  readonly voidUnavailableOnceFor?: readonly string[];
  /** These authorisations have already lapsed: void returns `ALREADY_EXPIRED`. */
  readonly expiredPaymentIntentIds?: readonly string[];
  /**
   * Charges the fake did not capture itself, keyed by charge id. Needed when a test
   * refunds a charge whose `Order` row a fixture wrote directly.
   *
   * The charge amount is here rather than on `RefundRequest` on purpose: the real
   * port never needs it — Stripe already knows what the charge was — so putting it
   * on the shared request would add a field whose wrong value changes this fake's
   * arithmetic and is silently ignored in production. That is the divergence the
   * fake exists to avoid.
   */
  readonly chargesByChargeId?: Readonly<
    Record<string, { readonly chargeCents: number; readonly feeCents: number }>
  >;
  /**
   * Charges whose reversal cannot be read back, returning the unexpanded
   * `application_fee` id instead of the object. The real port treats that as
   * retryable rather than assuming zero, and a fake that never produced it would
   * leave that branch untested.
   */
  readonly unreadableReversalForChargeIds?: readonly string[];
};

export type FakeChargePort = ChargePort & {
  /** Every call, in order, including the deduped ones. */
  readonly calls: readonly FakeChargeCall[];
};

export function fakeChargePort(options: FakeChargePortOptions = {}): FakeChargePort {
  const declineIds = new Set(options.declineParticipantIds ?? []);
  const declineCode = options.declineCode ?? 'card_declined';
  const unavailableOnce = new Set(options.unavailableOnceFor ?? []);
  const refundUnavailableOnce = new Set(options.refundUnavailableOnceFor ?? []);
  const voidUnavailableOnce = new Set(options.voidUnavailableOnceFor ?? []);
  const expiredPaymentIntents = new Set(options.expiredPaymentIntentIds ?? []);
  const unreadableReversals = new Set(options.unreadableReversalForChargeIds ?? []);

  const calls: FakeChargeCall[] = [];
  /** The provider's own memory of an idempotency key. */
  const captures = new Map<string, CaptureOutcome>();
  const voids = new Map<string, VoidOutcome>();
  const refunds = new Map<string, RefundOutcome>();
  /** chargeId → refundId, so a second refund of the same charge is not a second refund. */
  const refundedCharges = new Map<string, string>();
  /** chargeId → what the charge was for, the fee attached, and what has come back. */
  const applicationFees = new Map<
    string,
    { chargeCents: number; feeCents: number; refundedCents: number }
  >();

  for (const [chargeId, known] of Object.entries(options.chargesByChargeId ?? {})) {
    applicationFees.set(chargeId, {
      chargeCents: known.chargeCents,
      feeCents: known.feeCents,
      refundedCents: 0,
    });
  }

  let chargeSeq = 0;
  let refundSeq = 0;

  return {
    get calls() {
      return calls;
    },

    async capture(request: CaptureRequest): Promise<CaptureOutcome> {
      calls.push({ kind: 'capture', request });

      const remembered = captures.get(request.idempotencyKey);
      if (remembered) {
        // Stripe replays the original outcome, including a decline.
        return remembered;
      }

      if (unavailableOnce.delete(request.participantId)) {
        throw new PaymentProviderUnavailableError(
          'timeout',
          `fake: capture for ${request.participantId} timed out (first attempt)`,
        );
      }

      const outcome: CaptureOutcome = declineIds.has(request.participantId)
        ? { status: 'DECLINED', declineCode }
        : { status: 'CAPTURED', chargeId: `ch_fake_${++chargeSeq}` };

      if (outcome.status === 'CAPTURED') {
        // Remember what was charged and the fee attached, so a later refund can
        // report what came back — the same facts the real port reads from Stripe.
        applicationFees.set(outcome.chargeId, {
          chargeCents: request.amountCents,
          feeCents: request.platformFeeCents,
          refundedCents: 0,
        });
      }

      captures.set(request.idempotencyKey, outcome);
      return outcome;
    },

    async voidAuthorization(request: VoidRequest): Promise<VoidOutcome> {
      calls.push({ kind: 'void', request });

      const remembered = voids.get(request.idempotencyKey);
      if (remembered) {
        return remembered;
      }

      if (voidUnavailableOnce.delete(request.participantId)) {
        throw new PaymentProviderUnavailableError(
          'timeout',
          `fake: void for ${request.participantId} timed out (first attempt)`,
        );
      }

      const outcome: VoidOutcome = expiredPaymentIntents.has(request.paymentIntentId)
        ? { status: 'ALREADY_EXPIRED' }
        : { status: 'VOIDED' };

      voids.set(request.idempotencyKey, outcome);
      return outcome;
    },

    async refund(request: RefundRequest): Promise<RefundOutcome> {
      calls.push({ kind: 'refund', request });

      const remembered = refunds.get(request.idempotencyKey);
      if (remembered) {
        return remembered;
      }

      if (refundUnavailableOnce.delete(request.participantId)) {
        throw new PaymentProviderUnavailableError(
          'timeout',
          `fake: refund for ${request.participantId} timed out (first attempt)`,
        );
      }

      const alreadyRefunded = refundedCharges.get(request.chargeId);
      const applied = applicationFees.get(request.chargeId);

      if (alreadyRefunded) {
        return {
          status: 'ALREADY_REFUNDED',
          applicationFeeRefundCents: applied?.refundedCents ?? 0,
        };
      }

      if (unreadableReversals.has(request.chargeId)) {
        // The real port reads the reversal back and refuses to guess when the
        // expansion does not take effect; this reproduces that refusal, so the
        // caller's retry path is exercised by a test rather than by production.
        throw new PaymentProviderUnavailableError(
          'unknown',
          `fake: reversal for ${request.chargeId} came back as an unexpanded id`,
        );
      }

      const reversalCents = proportionalApplicationFeeRefund({
        chargedCents: applied?.chargeCents ?? 0,
        feeCents: applied?.feeCents ?? 0,
        refundCents: request.amountCents,
      });

      const outcome: RefundOutcome = {
        status: 'REFUNDED',
        refundId: `re_fake_${++refundSeq}`,
        applicationFeeRefundCents: reversalCents,
      };

      refundedCharges.set(request.chargeId, outcome.refundId);
      if (applied) {
        applied.refundedCents = Math.min(applied.refundedCents + reversalCents, applied.feeCents);
      }
      refunds.set(request.idempotencyKey, outcome);
      return outcome;
    },
  };
}

/**
 * What Stripe returns of our application fee when `refundCents` of a `chargedCents`
 * charge is refunded: `round(fee × refund / charge)`, capped at the fee.
 *
 * ## This is a MODEL of Stripe, not a reimplementation of it
 *
 * Read the two customers of this function and see that neither is the production
 * ledger:
 *
 *   - the **fake port** uses it, so a test's refund behaves like Stripe's, and
 *   - `refundEntries` is tested against it, because a hand-waved `−44` in a fixture
 *     would let an off-by-one pass.
 *
 * The **real** port does not call it. It reads `ApplicationFee.amount_refunded`
 * from Stripe. That asymmetry is the whole point: Stripe documents that a partial
 * refund reverses "a proportional amount of the application fee" and does not
 * document the rounding, so the production figure must be the provider's answer.
 * This function exists so the *test fixture* is not a magic number, and it says
 * `Math.round` because round-half-up is the only rule that produces no observed
 * example — it is a choice, and when the first live partial refund disagrees by a
 * cent, the number that matters is still the one Stripe returns.
 */
export function proportionalApplicationFeeRefund(args: {
  chargedCents: number;
  feeCents: number;
  refundCents: number;
}): number {
  if (args.chargedCents <= 0 || args.feeCents <= 0 || args.refundCents <= 0) {
    return 0;
  }
  const proportional = Math.round((args.feeCents * args.refundCents) / args.chargedCents);
  return Math.min(proportional, args.feeCents);
}
