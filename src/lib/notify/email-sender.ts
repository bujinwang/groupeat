import { logger } from '@/lib/logging/logger';

/**
 * FR-704's delivery seam — the email half of `sender.ts`.
 *
 * ## Why this is not `NotificationSender`
 *
 * `NotificationSender` delivers SMS bodies composed from a settlement intent. It
 * carries a `phone` and a `kind` from the five-message vocabulary, and none of that
 * describes a weekly digest: an email has a **subject**, an HTML alternative, and a
 * recipient address, and it is not emitted by settlement. Reusing the SMS types would
 * have meant a `phone` field holding an email address and a `kind` that no composer
 * knows — two lies in one interface.
 *
 * What *is* reused is the discipline, because it is the same discipline: `send()`
 * never throws, every message gets an outcome, and the caller can report "2 of 3 sent"
 * rather than logging a count and hoping.
 *
 * ## The one rule
 *
 * A digest that fails to send must not fail the cron job in a way that looks like a
 * payment failure. This route has no money in it, but it shares `CRON_SECRET` with the
 * cutoff job and an operator reads both the same way. Failure is returned, not raised.
 */

/** One email, ready to leave the building. */
export type EmailMessage = {
  /**
   * The bounded vocabulary of things this deployment emails. Today there is one.
   *
   * Kept as a union rather than a free string so a future "receipt" email cannot
   * reuse the digest's consent gate by accident.
   */
  readonly kind: 'weekly_digest' | 'owner_invite';
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** The HTML alternative. Plain text is the fallback every mail client has. */
  readonly html: string;
};

export type EmailSendOutcome = {
  readonly kind: EmailMessage['kind'];
  readonly to: string;
  readonly sent: boolean;
  /** The provider's own message id, when it returned one. */
  readonly providerId?: string;
  /**
   * `NOT_CONFIGURED` means no provider credentials; this deployment composes but
   * cannot send. The same three reasons the SMS sender uses, for the same reason:
   * a short machine token survives a log without carrying an address or a body.
   */
  readonly reason?: 'NOT_CONFIGURED' | 'PROVIDER_ERROR' | 'NETWORK_ERROR';
};

export type EmailSendResult = {
  readonly outcomes: readonly EmailSendOutcome[];
  readonly sentCount: number;
  readonly failedCount: number;
};

export interface EmailSender {
  /** Human name for logs and for the job's JSON response. */
  readonly name: string;
  /** Never throws. */
  send(messages: readonly EmailMessage[]): Promise<EmailSendResult>;
}

/**
 * The sender for every deployment without `RESEND_API_KEY` — which is every
 * deployment today.
 *
 * It counts and logs, exactly like `loggingSender` and for the same reason: the seam
 * must be provably reachable before a provider exists, or the first real send is also
 * the first test of the wiring. It reports `NOT_CONFIGURED` per message so the job can
 * distinguish "composed and not sent" from "composed and sent", and so a keyless
 * deployment does not look like a successful digest run.
 *
 * ## Why it logs no address and no subject
 *
 * The subject can contain a merchant's name and the body contains money. §11.7's rule
 * is no PII in logs, and an email address is PII. The log line names the count and the
 * kind, which is enough to answer "did the job run" and nothing a log reader could
 * misuse.
 */
export function loggingEmailSender(): EmailSender {
  return {
    name: 'logging',
    async send(messages) {
      if (messages.length === 0) {
        return { outcomes: [], sentCount: 0, failedCount: 0 };
      }

      logger.warn('email.not_sent', {
        reason: 'NOT_CONFIGURED',
        total: messages.length,
        kind: [...new Set(messages.map((message) => message.kind))].join(','),
      });

      return {
        outcomes: messages.map((message) => ({
          kind: message.kind,
          to: message.to,
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
 * The recording sender, for tests and for the job's dry-run path.
 *
 * Lives in `src/` rather than a test file because both the route test and the
 * orchestration test need it, and a second hand-rolled recorder would be a second set
 * of assumptions about what `send()` receives.
 */
export function recordingEmailSender(): EmailSender & {
  readonly sent: EmailMessage[];
  failNext(count: number): void;
} {
  const sent: EmailMessage[] = [];
  let failures = 0;

  return {
    name: 'recording',
    sent,
    failNext(count) {
      failures = count;
    },
    async send(messages) {
      const outcomes: EmailSendOutcome[] = [];
      for (const message of messages) {
        if (failures > 0) {
          failures -= 1;
          outcomes.push({
            kind: message.kind,
            to: message.to,
            sent: false,
            reason: 'PROVIDER_ERROR',
          });
          continue;
        }
        sent.push(message);
        outcomes.push({ kind: message.kind, to: message.to, sent: true });
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
