/**
 * The money seam — `ChargePort`, its request/result types, and the one retryable
 * error class. Design: `docs/M5-cutoff-design.md` §3.1.
 *
 * ## Why the interface exists before anything calls it
 *
 * `settle.ts` is written against this shape and `fake-charge-port.ts` is written
 * against the same shape, so neither can drift toward "whatever Stripe happened
 * to return". The fake is what the settlement tests exercise; if the interface
 * were derived from the real port, the tests would encode Stripe's accidental
 * response shape rather than our intent.
 *
 * ## Two error classes and no third
 *
 *   - `CaptureOutcome.status === 'DECLINED'` is **not** an error. A declined card
 *     is a normal, expected, terminal outcome (§8.5 expects 2–5 % of them), and
 *     modelling it as an exception would force the retry logic to catch an
 *     exception and re-throw it as data.
 *   - `PaymentProviderUnavailableError` is the only retryable condition: the
 *     provider could not answer, so the participant's state is UNKNOWN. That is
 *     exactly what an idempotency key is for — the retry returns the original
 *     charge instead of making a second one.
 *
 * `StripeNotConfiguredError` is imported from `@/lib/payments/connect-port`
 * rather than redeclared: one condition, one class.
 *
 * This file imports nothing. Not the SDK, not `server-only`, not Prisma — so it
 * can be imported by a pure test, by `settle.ts`, and by M8's reconciliation
 * without dragging a network client into any of them.
 */

/** A capture we are about to ask the provider to make. */
export type CaptureRequest = {
  readonly participantId: string;
  readonly dropId: string;
  /** The connected account. The charge lives there, never on the platform (ADR-001). */
  readonly stripeAccountId: string;
  readonly paymentIntentId: string;
  /** Integer cents, gross, read verbatim from `DropParticipant.amountCents`. */
  readonly amountCents: number;
  /** Integer cents, `application_fee_amount`, read verbatim from the row. */
  readonly platformFeeCents: number;
  /** `capture:${participantId}` — stable across every retry. */
  readonly idempotencyKey: string;
};

export type CaptureOutcome =
  | { readonly status: 'CAPTURED'; readonly chargeId: string }
  | { readonly status: 'DECLINED'; readonly declineCode: string };

export type VoidRequest = {
  readonly participantId: string;
  readonly stripeAccountId: string;
  readonly paymentIntentId: string;
  /** `void:${participantId}` */
  readonly idempotencyKey: string;
};

export type VoidOutcome =
  | { readonly status: 'VOIDED' }
  /** The authorisation had already lapsed. Terminal, and not a failure. */
  | { readonly status: 'ALREADY_EXPIRED' };

export type RefundRequest = {
  readonly participantId: string;
  readonly stripeAccountId: string;
  readonly chargeId: string;
  readonly amountCents: number;
  readonly platformFeeCents: number;
  /**
   * A literal `true`, not `boolean`. Under a direct charge the application fee is
   * NOT refunded automatically — `refund_application_fee` must be passed
   * explicitly (ADR-001 §3.2). Making the field `boolean` would let a caller pass
   * `false` and quietly keep our fee on a drop that never ran. The type refuses.
   */
  readonly reverseApplicationFee: true;
  /** `refund:${participantId}` */
  readonly idempotencyKey: string;
};

export type RefundOutcome =
  | { readonly status: 'REFUNDED'; readonly refundId: string }
  | { readonly status: 'ALREADY_REFUNDED' };

export interface ChargePort {
  capture(request: CaptureRequest): Promise<CaptureOutcome>;
  voidAuthorization(request: VoidRequest): Promise<VoidOutcome>;
  refund(request: RefundRequest): Promise<RefundOutcome>;
}

/** The reasons a provider call may be retried on the next tick. */
export type ProviderUnavailableReason =
  | 'timeout'
  | 'network'
  | 'http_5xx'
  | 'rate_limited'
  | 'unknown';

/**
 * The provider could not answer, or answered "try later". The participant's state
 * is UNKNOWN, which is exactly what an idempotency key is for: the retry returns
 * the original charge instead of making a second one.
 *
 * Never thrown for a decline. A decline is `CaptureOutcome`, not an exception.
 */
export class PaymentProviderUnavailableError extends Error {
  readonly reason: ProviderUnavailableReason;

  constructor(reason: ProviderUnavailableReason, message: string) {
    super(message);
    this.name = 'PaymentProviderUnavailableError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPaymentProviderUnavailable(
  error: unknown,
): error is PaymentProviderUnavailableError {
  return error instanceof PaymentProviderUnavailableError;
}

/** §11.5 — the key is derived from the participant id and nothing else. */
export function captureKey(participantId: string): string {
  return `capture:${participantId}`;
}

export function voidKey(participantId: string): string {
  return `void:${participantId}`;
}

export function refundKey(participantId: string): string {
  return `refund:${participantId}`;
}
