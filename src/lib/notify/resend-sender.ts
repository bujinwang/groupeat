import 'server-only';

import { logger } from '@/lib/logging/logger';

import {
  loggingEmailSender,
  type EmailMessage,
  type EmailSendOutcome,
  type EmailSendResult,
  type EmailSender,
} from './email-sender';

/**
 * The real email sender — Resend, per PRD-v1 §17 D-5's "email via Resend".
 *
 * ## THIS IMPLEMENTATION HAS NEVER BEEN EXECUTED AGAINST RESEND
 *
 * It is transcribed from the documented `POST /emails` contract, exactly as
 * `twilio-sender.ts` and `real-charge-port.ts` were transcribed from theirs. There is
 * no `RESEND_API_KEY` on this machine, so the only evidence it works will be the first
 * digest that arrives. **Until then a send failure is this module's bug before it is a
 * Resend outage** — that is now the third provider in this repo to carry the warning,
 * and the first two are why it is written down.
 *
 * ## Why `fetch` and not the installed SDK
 *
 * `resend` is a dependency, but it is not needed: the request is one POST with a JSON
 * body, and a `fetch` keeps the whole contract visible in this file instead of behind
 * an SDK's retry and error-mapping choices. It also makes the boundary testable with a
 * stubbed `fetch` and no module mocking of a native-free client. If the SDK later buys
 * something real — webhook verification, a typed event stream — it can replace this
 * function without changing `EmailSender`.
 *
 * ## Why the sender is required configuration rather than a default
 *
 * A digest from `noreply@example.com` is either rejected by the provider or lands in
 * spam, and both look like "the feature is broken" to a merchant. So `DIGEST_FROM_EMAIL`
 * is required alongside the key, and its absence degrades to the logging sender rather
 * than inventing an address. The deployment must verify the domain with Resend first;
 * that is a console step this file cannot perform.
 */

const RESEND_API = 'https://api.resend.com/emails';

/** What this module needs from config, passed in rather than read from `process.env`. */
export type ResendConfig = {
  readonly apiKey: string;
  /** `GroupEat <digest@groupeat.example>` or a bare address. Resend accepts both. */
  readonly from: string;
};

/**
 * The slice of an environment this module reads.
 *
 * Deliberately not `NodeJS.ProcessEnv`, for the reason `twilio-sender.ts` records:
 * a reader of two keys should accept two keys, and `ProcessEnv`'s required `NODE_ENV`
 * forced every test to cast a literal that asserted nothing.
 */
export type EnvLike = {
  readonly RESEND_API_KEY?: string | undefined;
  readonly DIGEST_FROM_EMAIL?: string | undefined;
  readonly [key: string]: string | undefined;
};

/**
 * Resolves the config, or `null` when incomplete.
 *
 * Both keys absent is the normal keyless state and is silent. One absent is a typo in
 * a deployment secret and is logged with the missing key name — the same distinction
 * `twilioConfigFrom` makes.
 */
export function resendConfigFrom(env: EnvLike): ResendConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.DIGEST_FROM_EMAIL?.trim();

  const configured = [
    { key: 'RESEND_API_KEY', value: apiKey },
    { key: 'DIGEST_FROM_EMAIL', value: from },
  ];
  const missing = configured.filter((entry) => !entry.value).map((entry) => entry.key);

  if (missing.length === configured.length) {
    return null;
  }

  if (!apiKey || !from) {
    logger.warn('digest.sender_unconfigured', { missing });
    return null;
  }

  return { apiKey, from };
}

/**
 * The Resend-backed sender.
 *
 * ## Sequential, like the SMS sender
 *
 * A digest run emails a handful of owners. Parallel requests would be marginally
 * faster and would also make the provider's rate-limit response arrive on the last
 * message, which is the one nobody re-reads. Sequential keeps the outcome list in the
 * order the report built it.
 */
export function resendEmailSender(config: ResendConfig): EmailSender {
  return {
    name: 'resend',

    async send(messages) {
      if (messages.length === 0) {
        return { outcomes: [], sentCount: 0, failedCount: 0 };
      }

      const outcomes: EmailSendOutcome[] = [];
      for (const message of messages) {
        outcomes.push(await sendOne(message));
      }

      const failedCount = outcomes.filter((outcome) => !outcome.sent).length;
      const result: EmailSendResult = {
        outcomes,
        sentCount: outcomes.length - failedCount,
        failedCount,
      };

      if (failedCount > 0) {
        // Counts only. A recipient address and a subject are PII, and the body
        // contains money.
        logger.warn('digest.send_failed', {
          sent: result.sentCount,
          failed: failedCount,
        });
      }

      return result;
    },
  };

  async function sendOne(message: EmailMessage): Promise<EmailSendOutcome> {
    try {
      const response = await fetch(RESEND_API, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });

      if (!response.ok) {
        // The status only. Resend's error body can echo the `to` address, and on a
        // validation error it can echo the subject too.
        logger.warn('digest.provider_error', {
          status: response.status,
          kind: message.kind,
        });
        return { kind: message.kind, to: message.to, sent: false, reason: 'PROVIDER_ERROR' };
      }

      // A successful create returns `{ id }`. The id is what an operator looks up in
      // the Resend dashboard when a merchant says nothing arrived, so it is returned
      // rather than only logged.
      const created = await response.json().catch(() => null);
      const providerId = typeof created?.id === 'string' ? created.id : undefined;
      logger.info('digest.sent', { kind: message.kind });
      return providerId
        ? { kind: message.kind, to: message.to, sent: true, providerId }
        : { kind: message.kind, to: message.to, sent: true };
    } catch (error) {
      // Name only: the caught value can carry the request body on some runtimes.
      logger.warn('digest.network_error', {
        kind: message.kind,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { kind: message.kind, to: message.to, sent: false, reason: 'NETWORK_ERROR' };
    }
  }
}

/**
 * Chooses a sender for this deployment: Resend if configured, otherwise logging.
 *
 * One place makes the decision, so a keyed deployment cannot accidentally compose into
 * the logging sender and report a successful run that reached nobody.
 */
export function resolveEmailSender(env: EnvLike = process.env): EmailSender {
  const config = resendConfigFrom(env);
  if (!config) {
    return loggingEmailSender();
  }
  return resendEmailSender(config);
}
