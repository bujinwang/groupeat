/**
 * The join money seam — FR-403/FR-404. Design: `docs/M5-cutoff-design.md` §3.1,
 * extended backwards to the moment the authorisation is created.
 *
 * ## The distinction this interface exists to keep
 *
 * `ChargePort` (M5) captures, voids and refunds an authorisation that already
 * exists. Nothing in the codebase could *create* one, because until now nothing
 * could take a join. This port is the missing half: it puts a hold on a card and
 * returns the id that settlement will later capture.
 *
 * That separation is not tidiness. **FR-404 says no charge may happen at join.**
 * The way to make that checkable is for the join path to have no method that can
 * move money at all: `createJoinAuthorisation` returns `requires_capture` or a
 * refusal, and there is no `capture` in this interface for a join to call by
 * accident. Settlement keeps its own port, on the other side of the cutoff.
 *
 * ## Why the request carries the amount it does
 *
 * Every figure is passed in, computed by the service from the **frozen** snapshot
 * (ADR-002). The port does not read `DEFAULT_FEES`, does not know the drop's price,
 * and cannot derive a fee — it is handed `amountCents` and `platformFeeCents` and
 * is expected to send them verbatim. A port that computed either would be a second
 * place money is authored, and ADR-002 says the server has exactly one.
 *
 * ## Error classes, following `charge-port.ts`
 *
 *   - A **decline** is a normal outcome, not an exception (§8.5 expects 2–5 % of
 *     them). It is a union member.
 *   - `JoinProviderUnavailableError` is the only retryable condition: the provider
 *     could not answer, so whether a hold exists is UNKNOWN. That is what the
 *     idempotency key is for.
 *   - "Stripe is not configured" reuses `StripeNotConfiguredError` from
 *     `payments/connect-port`, because it is one condition with one meaning.
 *
 * This file reaches the network in production but never holds a client itself, so
 * it is importable from a pure test, from `service.ts`, and from the route.
 */

/** What the join service asks the provider to hold. */
export type JoinAuthorisationRequest = {
  readonly dropId: string;
  readonly participantId: string;
  /** The connected account. The hold lives there, never on the platform (ADR-001). */
  readonly stripeAccountId: string;
  /** `qty × dealPriceCents`, integer cents. From `resolveJoinMoney()`. */
  readonly amountCents: number;
  /** `application_fee_amount`, integer cents. From `platformFeeCentsForOrder()`. */
  readonly platformFeeCents: number;
  /**
   * The Stripe Customer for the connected account, if one exists.
   *
   * Optional: a first-time diner has none, and creating one is the provider's job
   * on the create call. Present so a repeat diner's card can be reused, which is
   * the difference between a 40-second join and a 40-second join every time.
   */
  readonly providerCustomerId?: string;
  /**
   * The `pm_…` id from Stripe.js, created in the browser.
   *
   * ## Why the server confirms rather than the browser
   *
   * The Payment Element tokenises card details into a PaymentMethod **inside
   * Stripe's iframe** and hands back an id. Confirming server-side with
   * `confirm: true` then produces a `requires_capture` intent synchronously, in the
   * same call, which is what lets the join service know within one request whether
   * the card is held.
   *
   * The alternative — create the intent unconfirmed, let the browser confirm — is
   * equally safe but makes "authorised" an asynchronous fact: the intent comes back
   * `requires_payment_method`, a webhook brings it to `requires_capture`, and the
   * participant sits at `PENDING` in between. That is a whole state machine and an
   * event source, and it buys nothing here, because the join screen is already
   * waiting on this request.
   *
   * Either way card data never reaches this server: Stripe.js tokenises it, and
   * this field carries an id.
   *
   * **Optional on the type, required by the real port.** Slice 2a has no join page,
   * so the fake-backed tests have no `pm_…` to supply; the real port throws
   * `JoinProviderUnavailableError('unknown', …)` when it is missing, which means
   * shipping 2b without wiring this through fails loudly on the first join instead
   * of creating an unconfirmable intent. Making the field required here would have
   * bought a compile error at the cost of a fake that has to invent fake card ids.
   */
  readonly paymentMethodId?: string;
  /** ISO-4217, lowercase. `cad` for V1 (PRD-v1 §0.5). */
  readonly currency: string;
  /**
   * `join:${participantId}` — stable across every retry of this one join.
   *
   * Derived from the participant id and nothing else, for the same reason
   * `captureKey()` is: a key that includes a timestamp or an attempt counter makes
   * a retry look like a new request, which is the one way to double-authorise.
   */
  readonly idempotencyKey: string;
};

export type JoinAuthorisationOutcome =
  /**
   * The card is held, not charged. `requires_capture` in Stripe's vocabulary —
   * the only outcome that may move a participant out of `PENDING`.
   */
  | {
      readonly status: 'AUTHORIZED';
      readonly paymentIntentId: string;
      /** The status the provider reported, recorded so a mismatch is auditable. */
      readonly providerStatus: 'requires_capture';
    }
  /**
   * The provider refused the card. Terminal for this attempt; the participant is
   * `FAILED` and there is no hold to void later, because none was created.
   */
  | {
      readonly status: 'DECLINED';
      readonly declineCode: string;
      /** Safe to show? A decline code can be shown verbatim or mapped to our copy. */
      readonly message?: string;
    };

export interface JoinPaymentPort {
  createJoinAuthorisation(
    request: JoinAuthorisationRequest,
  ): Promise<JoinAuthorisationOutcome>;
}

/** The reasons a provider call may be retried. Mirrors `ProviderUnavailableReason`. */
export type JoinUnavailableReason =
  | 'timeout'
  | 'network'
  | 'http_5xx'
  | 'rate_limited'
  | 'unknown';

/**
 * The provider could not answer, so whether a hold exists is **unknown**.
 *
 * This is the dangerous state and it is why the participant row is written before
 * the call: a crash between the request and the response leaves a `PENDING` row
 * whose `paymentIntentId` may or may not exist at Stripe. Settlement treats
 * `PENDING` as "not a confirmed plate" and the reconciliation path in M8 resolves
 * it by idempotency key. Retrying with the same key is safe; retrying with a new
 * one is not.
 */
export class JoinProviderUnavailableError extends Error {
  readonly reason: JoinUnavailableReason;

  constructor(reason: JoinUnavailableReason, message: string) {
    super(message);
    this.name = 'JoinProviderUnavailableError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isJoinProviderUnavailable(
  error: unknown,
): error is JoinProviderUnavailableError {
  return error instanceof JoinProviderUnavailableError;
}

/**
 * "Stripe is not configured" is one condition with one meaning, so the class is
 * re-exported from where it already lives rather than redeclared. `service.ts` does
 * not need it — it checks the connected account id before calling any port — but a
 * real port and its tests do, and one class is the point.
 */
export { isStripeNotConfigured, StripeNotConfiguredError } from '@/lib/payments/connect-port';

/** §11.5's rule, applied to the hold: the key names the participant, nothing else. */
export function joinKey(participantId: string): string {
  return `join:${participantId}`;
}

/**
 * The interface a *future* real port must satisfy, stated as a type so the fake and
 * the real one cannot drift.
 *
 * `capture_method: 'manual'` is not a parameter, and its absence is deliberate
 * (FR-404). A port that could be asked for an automatic capture would put a
 * `join*` call one argument away from charging a diner at the moment they tapped
 * "Join", which is the single thing AGENTS.md lists first as a non-negotiable.
 * The real port supplies the flag itself, unconditionally.
 */
export const JOIN_CAPTURE_METHOD = 'manual' as const;
