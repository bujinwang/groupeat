/**
 * The read-only provider seam for a join whose response was lost.
 *
 * ## Why this is not "retrieve by idempotency key"
 *
 * Stripe uses an idempotency key to dedupe a **write**, not as a lookup index:
 * there is no `paymentIntents.retrieve(idempotencyKey)` call. The create call in
 * `real-payment-port.ts` writes `metadata.participantId` and `metadata.dropId`
 * on every intent, so that is the searchable handle. The key stays on the write,
 * where it prevents a second hold; claiming it was read back would be a fiction.
 *
 * ## Why the outcome is a union and not a PaymentIntent
 *
 * The sweep has to make a terminal decision from what the provider says. Only two
 * answers are unambiguous enough to act on: `requires_capture` (a live hold that
 * can be cancelled) and `canceled` (a hold the provider has already expired).
 * "No matching intent" is the third honest answer. Anything else — several
 * matches, an unexpected status, or a provider that did not answer — must not be
 * dressed up as one of those three, so it keeps its own `UNRESOLVED` member.
 */
export type JoinReconciliationRequest = {
  readonly participantId: string;
  readonly dropId: string;
  readonly stripeAccountId: string;
};

export type JoinReconciliationOutcome =
  /** The lost call did create a hold, and it is still cancellable. */
  | {
      readonly status: 'AUTHORIZED';
      readonly paymentIntentId: string;
    }
  /** The provider has already released the hold. */
  | {
      readonly status: 'EXPIRED';
      readonly paymentIntentId: string;
    }
  /** The provider has no intent carrying this participant and drop. */
  | { readonly status: 'NOT_FOUND' }
  /**
   * The provider answer cannot support a claim about the hold.
   *
   * `MULTIPLE_MATCHES` and `UNEXPECTED_STATUS` are data facts; a transport or
   * provider failure is thrown as `JoinProviderUnavailableError` and mapped here
   * by the caller, so a retry remains a retry rather than a terminal answer.
   * `NO_RECONCILIATION_PORT` is the local default when no seam was supplied; it
   * is not a provider answer and must never be reported as one.
   */
  | {
      readonly status: 'UNRESOLVED';
      readonly reason:
        | 'PROVIDER_UNAVAILABLE'
        | 'MULTIPLE_MATCHES'
        | 'UNEXPECTED_STATUS'
        | 'NO_PROVIDER_ACCOUNT'
        | 'NO_RECONCILIATION_PORT'
        | 'NO_VOID_PORT';
      readonly providerStatus?: string;
    };

export interface JoinReconciliationPort {
  findJoinAuthorisation(
    request: JoinReconciliationRequest,
  ): Promise<JoinReconciliationOutcome>;
}

/**
 * The default for callers with no provider seam — tests and deployments without
 * Stripe.
 *
 * It is deliberately not a hidden `NOT_FOUND`. Nothing was queried, so the sweep
 * must not claim the provider found no matching intent. Returning `UNRESOLVED`
 * keeps the row terminal but sends the "we could not confirm" message and logs
 * `resolution: 'UNRESOLVED'` with the reason `NO_RECONCILIATION_PORT`. A caller
 * that *did* ask the provider and got an empty search result uses the real port
 * and earns the no-confirmed-hold sentence.
 */
export function unresolvedJoinReconciliationPort(): JoinReconciliationPort {
  return {
    async findJoinAuthorisation() {
      return { status: 'UNRESOLVED', reason: 'NO_RECONCILIATION_PORT' };
    },
  };
}
