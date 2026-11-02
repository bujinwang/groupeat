import 'server-only';

import { logger } from '@/lib/logging/logger';
import { StripeNotConfiguredError } from '@/lib/payments/connect-port';
import { forMerchant, isStripeConfigured } from '@/lib/payments/stripe';

import {
  type JoinAuthorisationOutcome,
  type JoinAuthorisationRequest,
  type JoinPaymentPort,
  JoinProviderUnavailableError,
  type JoinUnavailableReason,
  JOIN_CAPTURE_METHOD,
} from './payment-port';

/**
 * The real join payment port — the half of the money seam that creates a hold.
 *
 * ## THIS IMPLEMENTATION HAS NEVER BEEN EXECUTED AGAINST STRIPE
 *
 * Same status as `real-charge-port.ts`, and the same instruction applies: until the
 * first test-mode join runs, **treat a failure here as this module's bug before
 * treating it as the diner's card**. ADR-001 §4 is the precedent — PRD-v1 §17 D-1
 * asserted that `on_behalf_of` moves the Stripe fee to the merchant, and it does
 * not. Documentation has been wrong once in this project already.
 *
 * `real-payment-port.contract.test.ts` executes this module against `stripe-mock`,
 * which validates every request parameter against Stripe's OpenAPI spec — so a
 * misspelled or unsupported field fails here rather than on a diner's phone. It does
 * **not** prove a successful authorisation: the mock always returns
 * `requires_payment_method`, so the `requires_capture` branch below is unexercised
 * and this suite asserts the refusal instead. A green run means "Stripe would accept
 * this request", never "joining works".
 *
 * ## The one parameter that is not configurable
 *
 * `capture_method: 'manual'`. Not a field on the request, not an environment
 * variable, not a default that a caller can override — hard-coded here and asserted
 * in the live test. FR-404 and AGENTS.md's first non-negotiable are the same rule:
 * **never charge before the cutoff.** A join that captured would charge a diner the
 * instant they tapped a button, for food that might never be made because the
 * minimum was not met.
 *
 * ## Why `server-only`, and why it is still importable
 *
 * `server-only` throws outside a React Server Component graph. That is why the route
 * reaches this file through `await import()` rather than a static import: a static
 * one would fail at module load in any DB-backed test that transitively imports the
 * route. `grep -rn "real-payment-port" src/` must show exactly one non-test
 * reference and it must be inside `await import(`.
 *
 * ## Why no `new Stripe(...)` here
 *
 * `src/lib/payments/stripe.ts` is the only constructor in the repo, and every
 * money-touching call goes through `forMerchant()` so the `stripeAccount` option is
 * carried at construction rather than remembered at each call site (ADR-001 §3.1).
 * A hold created on the platform account instead of the merchant's is the
 * wrong-account bug that does not fail loudly — it succeeds against the wrong
 * account.
 */

export function realJoinPaymentPort(): JoinPaymentPort {
  if (!isStripeConfigured()) {
    throw new StripeNotConfiguredError();
  }

  return {
    async createJoinAuthorisation(
      request: JoinAuthorisationRequest,
    ): Promise<JoinAuthorisationOutcome> {
      try {
        if (!request.paymentMethodId) {
          // No card reached us. Refuse before creating an intent that could never be
          // confirmed — an intent left at `requires_payment_method` would look like a
          // hold to nothing and a failure to nobody.
          throw new JoinProviderUnavailableError(
            'unknown',
            `join for ${request.participantId} arrived with no paymentMethodId`,
          );
        }
        // `confirm: true` with a PaymentMethod tokenised by Stripe.js in the
        // browser. The card never reaches this server — Stripe.js puts it in
        // Stripe's own iframe and returns a `pm_…` id, which is all that crosses
        // the wire here. That is what keeps the integration at SAQ A-EP.
        //
        // Confirming **here** rather than in the browser is a deliberate choice
        // with one observable consequence: an intent confirmed server-side comes
        // back `requires_capture` synchronously, so this one request knows whether
        // the card is held. Letting the browser confirm instead would leave the
        // intent at `requires_payment_method` and make "authorised" an
        // asynchronous fact needing a webhook and a state machine, for no gain —
        // the join screen is already waiting on this response.
        const intent = await forMerchant(request.stripeAccountId).paymentIntents.create(
          {
            amount: request.amountCents,
            currency: request.currency,
            // Hard-coded, never a parameter (FR-404). See the module docblock.
            capture_method: JOIN_CAPTURE_METHOD,
            payment_method: request.paymentMethodId,
            confirm: true,
            // The diner is on a phone, often on mobile data, and off-session
            // redirects are where group-chat ordering goes to die. Card-only via
            // the Element avoids the redirect methods that would need a return URL.
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            ...(request.providerCustomerId
              ? { customer: request.providerCustomerId }
              : {}),
            metadata: {
              dropId: request.dropId,
              participantId: request.participantId,
              // Metadata is displayed in the Dashboard and is treated like a log
              // line: ids only, no phone, no name.
            },
          },
          { idempotencyKey: request.idempotencyKey },
        );

        // Only `requires_capture` is an authorisation. Anything else means Stripe
        // disagreed with what we asked for, and guessing is worse than refusing.
        if (intent.status !== 'requires_capture') {
          throw new JoinProviderUnavailableError(
            'unknown',
            `PaymentIntent ${intent.id} came back "${intent.status}", expected "requires_capture"`,
          );
        }

        return {
          status: 'AUTHORIZED',
          paymentIntentId: intent.id,
          providerStatus: 'requires_capture',
        };
      } catch (error) {
        if (isStripeType(error, 'StripeCardError')) {
          // A decline is data, not an exception. Terminal for this attempt.
          return { status: 'DECLINED', declineCode: declineCodeOf(error) };
        }
        throw asUnavailable(error, `authorisation for ${request.participantId}`);
      }
    },
  };
}

type StripeLikeError = {
  type?: unknown;
  code?: unknown;
  decline_code?: unknown;
  statusCode?: unknown;
  message?: unknown;
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
 * Everything that is not a decline.
 *
 * The classification is duck-typed on `error.type` for the reason recorded in
 * `real-charge-port.ts`: `instanceof` breaks when two copies of the SDK exist in a
 * bundle, and narrowing is not needed because every branch either returns a value of
 * our own type or throws one.
 *
 * `unknown` is treated as retryable. The alternative is to tell a diner their card
 * failed on the strength of an error nobody classified, and the retry is safe
 * because the idempotency key is derived from the participant id.
 */
function asUnavailable(error: unknown, what: string): JoinProviderUnavailableError {
  if (error instanceof JoinProviderUnavailableError) {
    return error;
  }
  const candidate = asStripeLike(error);
  const statusCode = typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined;
  const type = typeof candidate.type === 'string' ? candidate.type : '';

  let reason: JoinUnavailableReason = 'unknown';
  if (type === 'StripeConnectionError') {
    reason = 'network';
  } else if (type === 'StripeRateLimitError') {
    reason = 'rate_limited';
  } else if (statusCode !== undefined && statusCode >= 500) {
    reason = 'http_5xx';
  }

  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  logger.warn('join.payment_unavailable', {
    reason,
    operation: what,
  });

  return new JoinProviderUnavailableError(reason, `${what} failed: ${message}`);
}

/**
 * The route's entry point.
 *
 * `await`ed because the route reaches this module with a dynamic import, and async so
 * that adding a `retrieve`-based pre-flight later does not change the call shape.
 */
export async function createJoinPaymentPort(): Promise<JoinPaymentPort> {
  return realJoinPaymentPort();
}
