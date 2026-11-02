import { logger } from '@/lib/logging/logger';

import type { NotificationMessage } from './copy';

/**
 * The sender seam — FR-408 and FR-506, and D-5's delivery half.
 *
 * ## What this adds that `notify-port.ts` deliberately did not
 *
 * `NotifyPort` decides **what to tell whom**: it takes intents and is on the
 * settlement path. This decides **how a message leaves the building**: it takes
 * finished bodies and is nowhere near a transaction. Keeping them apart is what lets
 * the composer be pure and testable without a network, and lets a provider be
 * swapped without touching a single settlement test.
 *
 * ## The one rule
 *
 * `send()` must **never throw**. It is called from the cutoff job, after money has
 * moved. A Twilio timeout that propagated would turn a successful capture into a 500
 * the scheduler retries, and the retry would re-enter settlement for a drop that has
 * already been charged. Failures are logged and swallowed; the caller records the
 * outcome in the returned `SendResult` and moves on.
 *
 * That is the same discipline as `settle.ts`'s `deliver()` and `joinDrop`'s
 * `deliverNotify`, and it is worth restating because this is the layer where a
 * developer is most tempted to "just let the error bubble so we notice".
 * ## What notices instead
 *
 * `SendResult` — a per-message outcome, so the job can report "14 of 16 sent" rather
 * than logging a count and hoping. A silent swallow with no return value is how a
 * notification pipeline rots: everything is green and nobody is being texted.
 */

/** One message and what became of it. Never thrown — always returned. */
export type SendOutcome = {
  readonly kind: string;
  readonly sent: boolean;
  /**
   * Why it did not send. A short machine token, not a provider's prose — the prose
   * can contain a phone number or a body fragment, and this reaches a log.
   *
   *   - `NOT_CONFIGURED` — no provider credentials; this deployment cannot send.
   *   - `PROVIDER_ERROR`  — the provider answered with an error.
   *   - `NETWORK_ERROR`   — could not reach the provider.
   */
  readonly reason?: 'NOT_CONFIGURED' | 'PROVIDER_ERROR' | 'NETWORK_ERROR';
};

export type SendResult = {
  readonly outcomes: readonly SendOutcome[];
  /** Counts only, for the one log line per batch. */
  readonly sentCount: number;
  readonly failedCount: number;
};

export interface NotificationSender {
  /** Human name for logs and for the job's JSON response. */
  readonly name: string;
  /** Never throws. See the note above. */
  send(messages: readonly NotificationMessage[]): Promise<SendResult>;
}

/**
 * The sender for every deployment without provider credentials — which is every
 * deployment today.
 *
 * It counts and logs, exactly like `noopNotifyPort`, and for the same reason: the
 * seam must be provably reachable before a provider exists, or the first real send is
 * also the first test of the wiring. It reports `NOT_CONFIGURED` per message so a job
 * response can distinguish "composed and not sent" from "composed and sent".
 *
 * ## Why it does not throw, even though "not configured" is arguably an error
 *
 * Because the cutoff job's job is to charge cards. A missing SMS provider is a
 * degraded feature; refusing to settle would be a broken product. It logs at `warn`,
 * once per batch, with a count — loud enough for an operator reading logs, quiet
 * enough not to look like a failure in the response.
 */
export function loggingSender(): NotificationSender {
  return {
    name: 'logging',
    async send(messages) {
      if (messages.length === 0) {
        return { outcomes: [], sentCount: 0, failedCount: 0 };
      }

      // Grouped by kind so a batch of 40 writes two lines, not forty. Counts only:
      // a body contains a bearer token and a phone number, neither of which may
      // reach a log (§11.7).
      const byKind = new Map<string, number>();
      for (const message of messages) {
        byKind.set(message.kind, (byKind.get(message.kind) ?? 0) + 1);
      }

      logger.warn('notification.not_sent', {
        reason: 'NOT_CONFIGURED',
        total: messages.length,
        kinds: Object.fromEntries(byKind),
      });

      return {
        outcomes: messages.map((message) => ({
          kind: message.kind,
          sent: false,
          reason: 'NOT_CONFIGURED' as const,
        })),
        sentCount: 0,
        failedCount: messages.length,
      };
    },
  };
}

/**
 * The recording sender, for tests.
 *
 * Lives in `src/` rather than a test file because both the job test and the
 * settlement-level tests need it, and a second hand-rolled recorder in the second
 * test file would be a second set of assumptions about what `send()` receives.
 *
 * `failNext` exists so the "must not throw" rule can be tested from the caller's side:
 * a provider that rejects must produce a `SendResult`, not an exception, and the only
 * way to prove the caller survives is to hand it a sender that misbehaves.
 */
export function recordingSender(): NotificationSender & {
  readonly sent: NotificationMessage[];
  failNext(count: number): void;
} {
  const sent: NotificationMessage[] = [];
  let failures = 0;

  return {
    name: 'recording',
    sent,
    failNext(count) {
      failures = count;
    },
    async send(messages) {
      const outcomes: SendOutcome[] = [];
      for (const message of messages) {
        if (failures > 0) {
          failures -= 1;
          outcomes.push({ kind: message.kind, sent: false, reason: 'PROVIDER_ERROR' });
          continue;
        }
        sent.push(message);
        outcomes.push({ kind: message.kind, sent: true });
      }

      const failedCount = outcomes.filter((outcome) => !outcome.sent).length;
      return {
        outcomes,
        sentCount: outcomes.length - failedCount,
        failedCount,
      };
    },
  };
}
