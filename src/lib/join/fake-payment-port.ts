import {
  type JoinAuthorisationOutcome,
  type JoinAuthorisationRequest,
  type JoinPaymentPort,
  JoinProviderUnavailableError,
} from './payment-port';
import type {
  JoinReconciliationOutcome,
  JoinReconciliationPort,
  JoinReconciliationRequest,
} from './reconciliation-port';

/**
 * The deterministic in-memory `JoinPaymentPort`. Design §9 T01, the mirror of
 * `fake-charge-port.ts`.
 *
 * ## Why the fake dedupes by idempotency key
 *
 * Stripe does, and the property is load-bearing for the whole join path. If the
 * fake created a second authorisation on the second call, every retry test would
 * pass for the wrong reason: the test would assert "the retry produced one hold"
 * against a fake structurally incapable of producing two, and the real defect —
 * a caller whose key changes between attempts, so Stripe sees two different
 * requests and puts two holds on a diner's card — would sail into production with
 * a green suite behind it.
 *
 * So `calls.length === 2` with one `paymentIntentId` is the shape that proves the
 * retry worked, and that shape is only meaningful because this fake remembers.
 *
 * ## Why it counts holds per card
 *
 * `authorisedTotalCents()` exists so a test can assert the thing that actually
 * matters to a diner: after a double submit, has their card been held for twice the
 * money? A test that only counted rows in `DropParticipant` would miss a service
 * that wrote one row and made two provider calls — the row count would be right
 * and the diner's held balance would be wrong.
 *
 * Not under `__tests__/`: `service.test.ts` imports it, and a file inside a
 * `__tests__/` directory is invisible to the production import graph by convention.
 */

export type FakeJoinCall = {
  readonly kind: 'authorise';
  readonly request: JoinAuthorisationRequest;
};

export type FakeJoinPaymentPortOptions = {
  /** These participants' authorisations return `DECLINED`. They never throw. */
  readonly declineParticipantIds?: readonly string[];
  /** The `declineCode` reported for every decline. Default `card_declined`. */
  readonly declineCode?: string;
  /** The first call for each of these participants throws `timeout`. */
  readonly unavailableOnceFor?: readonly string[];
  /** Every call for these participants throws — a provider that is simply down. */
  readonly unavailableAlwaysFor?: readonly string[];
  /**
   * These participants get a real hold recorded *before* the timeout is thrown.
   *
   * This is the lost-response case the reconciliation seam exists for. A plain
   * timeout that never created a hold would make every reconciliation test pass
   * because there was nothing to find; this option makes the fake remember what
   * Stripe would have remembered, so a lookup has to discover it.
   */
  readonly hiddenHoldFor?: readonly string[];
  /** Explicit lookup answers, keyed by participantId, for unusual provider states. */
  readonly lookupOutcomeFor?: Readonly<Record<string, JoinReconciliationOutcome>>;
};

export type FakeJoinPaymentPort = JoinPaymentPort &
  JoinReconciliationPort & {
  /** Every call, in order, including the deduped ones. */
  readonly calls: readonly FakeJoinCall[];
  /** How many distinct authorisations exist — i.e. what the diner's card feels. */
  authorisedCount(): number;
  /** Total cents currently held across all cards. */
  authorisedTotalCents(): number;
  /** Ids of every participant that holds an authorisation. */
  authorisedParticipantIds(): string[];
};

/**
 * The intent-id counter, at module scope rather than inside the factory.
 *
 * Stripe's intent ids are unique across the whole account, so the fake must be too.
 * A per-instance counter makes two fakes in one test file both mint
 * `pi_fake_join_1`, and because `DropParticipant.paymentIntentId` is `@unique`, the
 * second write then fails with a constraint error that has nothing to do with the
 * behaviour under test — a fake colliding with itself, teaching the wrong lesson.
 *
 * Found exactly that way: three service tests failed on
 * `Unique constraint failed on the fields: (paymentIntentId)` the first time this
 * suite ran, and the defect was here rather than in `service.ts`.
 */
let intentSeq = 0;

export function fakeJoinPaymentPort(
  options: FakeJoinPaymentPortOptions = {},
): FakeJoinPaymentPort {
  const declineIds = new Set(options.declineParticipantIds ?? []);
  const declineCode = options.declineCode ?? 'card_declined';
  const unavailableOnce = new Set(options.unavailableOnceFor ?? []);
  const unavailableAlways = new Set(options.unavailableAlwaysFor ?? []);
  const hiddenHold = new Set(options.hiddenHoldFor ?? []);
  const lookupOutcome = new Map(Object.entries(options.lookupOutcomeFor ?? {}));

  const calls: FakeJoinCall[] = [];
  /** The provider's own memory: idempotency key → the outcome it already returned. */
  const outcomes = new Map<string, JoinAuthorisationOutcome>();
  /** participantId → what is held, so the totals answer in cents. */
  const held = new Map<string, number>();
  /** participantId → the intent id a reconciliation lookup would find. */
  const heldIntentIds = new Map<string, string>();

  return {
    get calls() {
      return calls;
    },

    authorisedCount(): number {
      return held.size;
    },

    authorisedTotalCents(): number {
      let total = 0;
      for (const cents of held.values()) total += cents;
      return total;
    },

    authorisedParticipantIds(): string[] {
      return [...held.keys()];
    },

    async createJoinAuthorisation(
      request: JoinAuthorisationRequest,
    ): Promise<JoinAuthorisationOutcome> {
      calls.push({ kind: 'authorise', request });

      // The replay. Note this happens *before* the decline and unavailability
      // checks, exactly as Stripe replays a stored response: a card declined once
      // is declined again on retry, and it does not get a second attempt at the
      // network. Getting this order wrong makes the retry tests describe behaviour
      // the provider does not have.
      const remembered = outcomes.get(request.idempotencyKey);
      if (remembered) {
        return remembered;
      }

      if (!hiddenHold.has(request.participantId)) {
        if (unavailableAlways.has(request.participantId)) {
          throw new JoinProviderUnavailableError(
            'http_5xx',
            `fake: authorisation for ${request.participantId} is unavailable`,
          );
        }

        if (unavailableOnce.delete(request.participantId)) {
          throw new JoinProviderUnavailableError(
            'timeout',
            `fake: authorisation for ${request.participantId} timed out (first attempt)`,
          );
        }
      }

      if (declineIds.has(request.participantId)) {
        const outcome: JoinAuthorisationOutcome = { status: 'DECLINED', declineCode };
        outcomes.set(request.idempotencyKey, outcome);
        return outcome;
      }

      intentSeq += 1;
      const paymentIntentId = `pi_fake_join_${intentSeq}`;

      const outcome: JoinAuthorisationOutcome = {
        status: 'AUTHORIZED',
        paymentIntentId,
        providerStatus: 'requires_capture',
      };
      outcomes.set(request.idempotencyKey, outcome);
      held.set(request.participantId, request.amountCents);
      heldIntentIds.set(request.participantId, paymentIntentId);

      if (hiddenHold.has(request.participantId)) {
        // Stripe has stored the hold under the idempotency key; the caller never
        // saw the answer. A retry would replay this exact outcome.
        throw new JoinProviderUnavailableError(
          'timeout',
          `fake: authorisation for ${request.participantId} was created but its response was lost`,
        );
      }

      return outcome;
    },

    async findJoinAuthorisation(
      request: JoinReconciliationRequest,
    ): Promise<JoinReconciliationOutcome> {
      const override = lookupOutcome.get(request.participantId);
      if (override) {
        return override;
      }
      const intentId = heldIntentIds.get(request.participantId);
      return intentId
        ? { status: 'AUTHORIZED', paymentIntentId: intentId }
        : { status: 'NOT_FOUND' };
    },
  };
}
