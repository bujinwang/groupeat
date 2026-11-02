import 'server-only';

import { logger } from '@/lib/logging/logger';
import { StripeNotConfiguredError } from '@/lib/payments/connect-port';
import { forMerchant, isStripeConfigured } from '@/lib/payments/stripe';

import {
  type CaptureOutcome,
  type CaptureRequest,
  type ChargePort,
  PaymentProviderUnavailableError,
  type ProviderUnavailableReason,
  type RefundOutcome,
  type RefundRequest,
  type VoidOutcome,
  type VoidRequest,
} from './charge-port';

/**
 * The real charge port — design §9 T05.
 *
 * ## THIS IMPLEMENTATION HAS NEVER BEEN EXECUTED AGAINST STRIPE
 *
 * It is transcribed from the API documentation. The only evidence it works will be
 * the first test-mode capture, and **until then a capture failure must be treated
 * as this module's bug before it is treated as the diner's**. ADR-001 §4 is the
 * precedent: PRD-v1 §17 D-1 asserted that `on_behalf_of` moves the Stripe fee to
 * the merchant, and it does not. Documentation has already been wrong once here,
 * and `real-charge-port.live.test.ts` skips with a named reason rather than
 * passing silently, so a green suite can never be read as "capture is verified".
 *
 * ## Why it is reached only by `await import()`
 *
 * `server-only` throws when imported outside a React Server Component graph, so a
 * **static** import of this module from `settle.ts` would make every DB-backed test
 * in the settlement suite fail at module load. The dynamic import in `run-tick.ts`'s
 * port resolution is what keeps that boundary while still letting the route use the
 * real thing. `grep -rn "real-charge-port" src/` must show exactly one non-test
 * reference, and it must be inside `await import(`.
 *
 * ## Three structural guarantees
 *
 *   1. **Every call is scoped to the connected account** via `forMerchant()`. A
 *      capture on the platform account is the wrong-account bug ADR-001 §3.2 is
 *      about, and it does not fail loudly — it succeeds against the wrong account.
 *   2. **No `new Stripe(...)`** here. `src/lib/payments/stripe.ts` stays the only
 *      constructor in the repo.
 *   3. **A decline is returned, not thrown.** `StripeCardError` is the diner's card,
 *      not our bug; everything else is `PaymentProviderUnavailableError` and is
 *      retried on the next tick with the same idempotency key.
 *
 * ## Why the error classification is duck-typed
 *
 * `error.type` is Stripe's own stable discriminator. `instanceof` against the SDK's
 * error classes breaks the moment two copies of the package exist in a bundle, and
 * it would force a direct SDK import into a file whose job is to keep the SDK at
 * arm's length. The one thing `instanceof` buys — narrowing — is not needed here,
 * because every branch throws or returns a value of our own type.
 */

export function realChargePort(): ChargePort {
  if (!isStripeConfigured()) {
    throw new StripeNotConfiguredError();
  }

  return {
    async capture(request: CaptureRequest): Promise<CaptureOutcome> {
      try {
        const intent = await forMerchant(request.stripeAccountId).paymentIntents.capture(
          request.paymentIntentId,
          {
            // ADR-001 §3.2: under a direct charge the application fee is attached
            // to the charge on the connected account, so it is passed here, at
            // capture, and never as a `transfer_data`/`on_behalf_of` parameter —
            // those describe the destination charge the ADR rejected.
            application_fee_amount: request.platformFeeCents,
          },
          { idempotencyKey: request.idempotencyKey },
        );

        const chargeId =
          typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
        if (!chargeId) {
          // The capture succeeded but we cannot name the charge, so we cannot
          // record a `stripeRef` and cannot refund it later. Treat it as unknown:
          // the retry is safe (same idempotency key) and will return the charge.
          throw new PaymentProviderUnavailableError(
            'unknown',
            `PaymentIntent ${request.paymentIntentId} captured with no latest_charge`,
          );
        }
        return { status: 'CAPTURED', chargeId };
      } catch (error) {
        if (isStripeType(error, 'StripeCardError')) {
          // A decline is data (§3.1), and it is terminal.
          return { status: 'DECLINED', declineCode: declineCodeOf(error) };
        }
        throw asUnavailable(error, `capture of ${request.participantId}`);
      }
    },

    async voidAuthorization(request: VoidRequest): Promise<VoidOutcome> {
      try {
        await forMerchant(request.stripeAccountId).paymentIntents.cancel(
          request.paymentIntentId,
          { cancellation_reason: 'abandoned' },
          { idempotencyKey: request.idempotencyKey },
        );
        return { status: 'VOIDED' };
      } catch (error) {
        if (isAlreadyFinal(error)) {
          // The authorisation lapsed, or was already captured or cancelled. Either
          // way the diner's hold is gone and there is nothing to do.
          return { status: 'ALREADY_EXPIRED' };
        }
        throw asUnavailable(error, `void of ${request.participantId}`);
      }
    },

    async refund(request: RefundRequest): Promise<RefundOutcome> {
      try {
        const refund = await forMerchant(request.stripeAccountId).refunds.create(
          {
            charge: request.chargeId,
            amount: request.amountCents,
            // ADR-001 §3.2, and the reason the field is the literal `true`: on a
            // direct charge the application fee is NOT reversed automatically. A
            // refund that omitted this would leave us holding our fee on a drop
            // that never ran, and the merchant's balance would be short by it.
            refund_application_fee: request.reverseApplicationFee,
          },
          { idempotencyKey: request.idempotencyKey },
        );
        return { status: 'REFUNDED', refundId: refund.id };
      } catch (error) {
        if (isAlreadyRefunded(error)) {
          return { status: 'ALREADY_REFUNDED' };
        }
        throw asUnavailable(error, `refund of ${request.participantId}`);
      }
    },
  };
}

type StripeLikeError = {
  type?: unknown;
  code?: unknown;
  decline_code?: unknown;
  statusCode?: unknown;
};

function asStripeLike(error: unknown): StripeLikeError {
  return typeof error === 'object' && error !== null ? (error as StripeLikeError) : {};
}

function isStripeType(error: unknown, type: string): boolean {
  return asStripeLike(error).type === type;
}

function declineCodeOf(error: unknown): string {
  const candidate = asStripeLike(error);
  const decline = candidate.decline_code ?? candidate.code;
  return typeof decline === 'string' && decline.length > 0 ? decline : 'card_declined';
}

/**
 * A `PaymentIntent` that can no longer be cancelled: already cancelled, already
 * captured, or expired. Stripe reports all three as an invalid request with
 * `payment_intent_unexpected_state`.
 */
function isAlreadyFinal(error: unknown): boolean {
  const candidate = asStripeLike(error);
  return (
    candidate.code === 'payment_intent_unexpected_state' ||
    candidate.code === 'payment_intent_unexpected_state_for_cancel'
  );
}

/** Stripe refuses a second full refund of the same charge with this code. */
function isAlreadyRefunded(error: unknown): boolean {
  const candidate = asStripeLike(error);
  return candidate.code === 'charge_already_refunded';
}

/**
 * Everything that is not a decline and not a terminal provider answer.
 *
 * The classification is what §4.2's retry policy rests on: `timeout`, `network`,
 * `http_5xx` and `rate_limited` are worth another tick, and the caller leaves the
 * participant at `chargeStatus = 'NONE'` so the retry uses the same idempotency
 * key. `unknown` is retried too — deliberately, because the alternative is to
 * declare a drop failed on the strength of an unclassifiable error, and voiding a
 * diner's authorisation on that basis is the worse mistake.
 */
function asUnavailable(error: unknown, what: string): PaymentProviderUnavailableError {
  if (error instanceof PaymentProviderUnavailableError) {
    return error;
  }
  const candidate = asStripeLike(error);
  const statusCode = typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined;
  const type = typeof candidate.type === 'string' ? candidate.type : '';

  let reason: ProviderUnavailableReason = 'unknown';
  if (type === 'StripeConnectionError') {
    reason = 'network';
  } else if (type === 'StripeRateLimitError') {
    reason = 'rate_limited';
  } else if (statusCode !== undefined && statusCode >= 500) {
    reason = 'http_5xx';
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.warn('settlement.provider_unavailable', { reason, operation: what });

  return new PaymentProviderUnavailableError(reason, `${what} failed: ${message}`);
}
