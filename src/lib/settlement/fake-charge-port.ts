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

  const calls: FakeChargeCall[] = [];
  /** The provider's own memory of an idempotency key. */
  const captures = new Map<string, CaptureOutcome>();
  const voids = new Map<string, VoidOutcome>();
  const refunds = new Map<string, RefundOutcome>();
  /** chargeId → refundId, so a second refund of the same charge is not a second refund. */
  const refundedCharges = new Map<string, string>();

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
      const outcome: RefundOutcome = alreadyRefunded
        ? { status: 'ALREADY_REFUNDED' }
        : { status: 'REFUNDED', refundId: `re_fake_${++refundSeq}` };

      if (outcome.status === 'REFUNDED') {
        refundedCharges.set(request.chargeId, outcome.refundId);
      }
      refunds.set(request.idempotencyKey, outcome);
      return outcome;
    },
  };
}
