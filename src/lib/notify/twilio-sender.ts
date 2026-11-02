import 'server-only';

import { logger } from '@/lib/logging/logger';

import type { NotificationMessage } from './copy';
import {
  loggingSender,
  type NotificationSender,
  type SendOutcome,
  type SendResult,
} from './sender';

/**
 * The real sender — Twilio, per PRD-v1 §17 D-5.
 *
 * ## THIS IMPLEMENTATION HAS NEVER BEEN EXECUTED AGAINST TWILIO
 *
 * It is transcribed from the REST API documentation (Messages resource, 2010-04-01),
 * exactly as `real-charge-port.ts` was transcribed from Stripe's. The only evidence
 * it works will be the first message that arrives on a real phone. **Until then a
 * send failure must be treated as this module's bug before it is treated as a
 * Twilio outage** — ADR-001 §4 is the precedent: documentation has already been
 * wrong once in this repo, and `on_behalf_of` did not do what the PRD said it did.
 *
 * ## Why `fetch` and not the SDK
 *
 * Two reasons, one of which is a real constraint rather than taste:
 *
 *   1. The Twilio Node SDK is ~5 MB and would be pulled into the route's module graph
 *      for one POST. This job sends at most a few dozen messages per tick; a `fetch`
 *      with a pre-encoded form body is the whole requirement.
 *   2. There is no `twilio` dependency in `package.json`, and adding one would install
 *      code that cannot be run or verified here. A transcription of a documented HTTP
 *      contract is honest about being unverified; an unused SDK is unverified *and*
 *      looks tested.
 *
 * ## Why Canadian sender ID matters and is not a detail
 *
 * D-5 says "verify Canadian sender ID". Canadian carriers (via CWTA) require
 * application-to-person senders to be registered, and an unregistered sender is
 * throttled or filtered — the message is accepted by Twilio, billed, and never seen.
 * That failure mode is invisible from here: no error, no bounce, a 201 from the API.
 * So the sender is a required configuration value rather than a default, and
 * `notification.sender_unconfigured` fires loudly at construction rather than
 * silently sending from a shared shortcode that carriers drop.
 *
 * ## The one rule, restated because this is where it is easiest to break
 *
 * `send()` never throws. Every failure path returns a `SendResult`. This runs after
 * money has moved; an exception here becomes a 500 from the cutoff job, which the
 * scheduler retries, which re-enters settlement for a drop already charged.
 */

const TWILIO_API = 'https://api.twilio.com/2010-04-01/Accounts';

/**
 * Twilio's message-length limit for a concatenated SMS.
 *
 * 1600 characters is 10 segments, which is the practical ceiling: beyond it Twilio
 * returns 21617 and drops the message. Enforced here rather than at composition,
 * because the composer does not know the channel — a future email sender has no such
 * limit, and truncating there would lose a redemption code for no reason.
 */
export const MAX_SMS_CHARS = 1600;

/** What this module needs from config, passed in rather than read from `process.env`. */
export type TwilioConfig = {
  readonly accountSid: string;
  readonly authToken: string;
  /** E.164. The registered Canadian A2P sender. */
  readonly from: string;
};

/**
 * The slice of an environment this module reads.
 *
 * Deliberately not `NodeJS.ProcessEnv`: that type requires `NODE_ENV`, so every test
 * that wanted to prove "an incomplete config yields `null`" had to cast a literal to
 * `ProcessEnv` — six conversions asserting something the function never reads. A
 * reader of three keys should accept three keys. `process.env` satisfies this
 * structurally, which is the only call site that matters.
 */
export type EnvLike = {
  readonly TWILIO_ACCOUNT_SID?: string | undefined;
  readonly TWILIO_AUTH_TOKEN?: string | undefined;
  readonly TWILIO_FROM_NUMBER?: string | undefined;
  /**
   * An environment is a string map, and this index signature is what lets
   * `process.env` satisfy the type. Without it the three optional keys above make
   * this a *weak* type — TypeScript then refuses `ProcessEnv`, which shares no
   * **required** property, with "has no properties in common".
   */
  readonly [key: string]: string | undefined;
};

/**
 * Resolves the config, or `null` when incomplete.
 *
 * Returns `null` rather than throwing: "no provider configured" is a supported mode
 * (`loggingSender` handles it), not a boot failure. Partial configuration — an SID
 * with no token — is also `null`, and logs the missing key names, because that state
 * is almost always a typo in a deployment secret rather than a deliberate choice.
 */
export function twilioConfigFrom(env: EnvLike): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_FROM_NUMBER?.trim();

  const configured = [
    { key: 'TWILIO_ACCOUNT_SID', value: accountSid },
    { key: 'TWILIO_AUTH_TOKEN', value: authToken },
    { key: 'TWILIO_FROM_NUMBER', value: from },
  ];
  const missing: string[] = configured
    .filter((entry) => !entry.value)
    .map((entry) => entry.key);

  if (missing.length === 3) {
    // The normal keyless state. Silent: every deployment without a provider would
    // otherwise warn on boot, and a warning that always fires is not a warning.
    return null;
  }

  if (missing.length > 0 || !accountSid || !authToken || !from) {
    logger.warn('notification.sender_unconfigured', { missing });
    return null;
  }

  return { accountSid, authToken, from };
}

/**
 * The Twilio-backed sender.
 *
 * ## Retries: none, deliberately
 *
 * A failed send is recorded and returned. Retrying inside the job would hold the tick
 * open, and Twilio's own guidance is to retry idempotently at the application level —
 * which this build cannot do yet, because there is no outbox. That is the honest
 * limitation: `failedCount > 0` in the job response is the signal that a follow-up
 * (an outbox, M8) is needed, rather than a hidden retry that appears to work because
 * the first attempt is repeated.
 */
export function twilioSender(config: TwilioConfig): NotificationSender {
  // Basic auth: `AccountSID:AuthToken`. Encoded once at construction because it is
  // the same for every message in every batch.
  const authorisation = `Basic ${Buffer.from(
    `${config.accountSid}:${config.authToken}`,
    'utf8',
  ).toString('base64')}`;

  return {
    name: 'twilio',

    async send(messages) {
      if (messages.length === 0) {
        return { outcomes: [], sentCount: 0, failedCount: 0 };
      }

      const outcomes: SendOutcome[] = [];

      // Sequential rather than `Promise.all`. A batch is at most a few dozen, the
      // tick is not latency-sensitive, and a parallel burst is the fastest route to
      // Twilio's per-number rate limit (21610) — which would fail the *last*
      // messages, i.e. the ones nobody looks at.
      for (const message of messages) {
        outcomes.push(await sendOne(message));
      }

      const failedCount = outcomes.filter((outcome) => !outcome.sent).length;
      const result: SendResult = {
        outcomes,
        sentCount: outcomes.length - failedCount,
        failedCount,
      };

      if (failedCount > 0) {
        logger.warn('notification.send_failed', {
          sent: result.sentCount,
          failed: failedCount,
        });
      }

      return result;
    },
  };

  async function sendOne(message: NotificationMessage): Promise<SendOutcome> {
    const body = message.body;

    if (body.length > MAX_SMS_CHARS) {
      // Not sent, and not truncated. A truncated body can cut a redemption code in
      // half, and a half-code at a counter is worse than a message with no code —
      // it looks valid. This is a composer bug and the log says so.
      logger.error('notification.too_long', {
        kind: message.kind,
        length: body.length,
        limit: MAX_SMS_CHARS,
      });
      return { kind: message.kind, sent: false, reason: 'PROVIDER_ERROR' };
    }

    const form = new URLSearchParams({ To: message.phone, From: config.from, Body: body });

    try {
      const response = await fetch(`${TWILIO_API}/${config.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: authorisation,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
      });

      if (!response.ok) {
        // The status and Twilio's numeric `code` only. Never the response body: it
        // echoes the message text on several error paths, and the text contains a
        // bearer token (§11.7).
        const detail = await response.json().catch(() => null);
        const code = typeof detail?.code === 'number' ? detail.code : null;
        logger.warn('notification.provider_error', {
          status: response.status,
          code,
          kind: message.kind,
        });
        return { kind: message.kind, sent: false, reason: 'PROVIDER_ERROR' };
      }

      logger.info('notification.sent', { kind: message.kind });
      return { kind: message.kind, sent: true };
    } catch (error) {
      // A network failure is not the diner's problem and must not become an
      // exception on the settlement path. Name only, never the message.
      logger.warn('notification.network_error', {
        kind: message.kind,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { kind: message.kind, sent: false, reason: 'NETWORK_ERROR' };
    }
  }
}

/**
 * Chooses a sender for this deployment: Twilio if configured, otherwise logging.
 *
 * The single place the decision is made, so a caller cannot accidentally construct
 * the logging sender on a keyed deployment — which would be a silent "everything
 * works, nobody is texted".
 */
export function resolveSender(env: EnvLike = process.env): NotificationSender {
  const config = twilioConfigFrom(env);

  if (!config) {
    return loggingSender();
  }

  return twilioSender(config);
}
