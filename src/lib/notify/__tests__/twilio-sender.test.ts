import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `server-only` throws on import outside a Server Component graph, so the module
 * under test cannot be loaded without this. The same one-liner, for the same reason,
 * as `real-payment-port.contract.test.ts` — it is a build-time marker for the Next
 * bundler, not behaviour, and replacing it with an empty module is the documented way
 * to unit-test the file it guards.
 */
vi.mock('server-only', () => ({}));

import { logger } from '@/lib/logging/logger';

import { resolveSender, twilioConfigFrom, twilioSender, MAX_SMS_CHARS } from '../twilio-sender';
import type { NotificationMessage } from '../copy';

/**
 * The Twilio sender, exercised against a stubbed `fetch`.
 *
 * ## What this can and cannot prove
 *
 * It proves the **request construction**: the URL, the Basic-auth header, the form
 * body, and every failure branch. That is what a transcription error breaks, and it
 * is the same standard `real-payment-port.contract.test.ts` holds itself to.
 *
 * It **cannot** prove that Twilio accepts it, that the Canadian sender ID is
 * registered, or that a message arrives. `stripe-mock` had the same limitation and
 * the contract test there says so; this file is the equivalent, minus the mock — a
 * stubbed `fetch` is weaker than a validating server, so the disclaimer has to be
 * louder, not quieter.
 *
 * **Treat the first real failure as a bug in `twilio-sender.ts` before a Twilio
 * outage.** ADR-001 §4 is the precedent for documentation being wrong here.
 */

const MESSAGE: NotificationMessage = {
  kind: 'DROP_CONFIRMED_CHARGED',
  phone: '+17805550123',
  body: 'Charged $26.20 for 2 plates. Your code: v1.payload.signature',
};

const CONFIG = {
  accountSid: 'AC_test_sid',
  authToken: 'test_token',
  from: '+15875550100',
};

/** A `fetch` double that records calls and answers with a scripted response. */
function stubFetch(response: { ok: boolean; status: number; json?: unknown }): {
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json ?? {},
    };
  });
  return { calls };
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('twilioConfigFrom', () => {
  it('is silent and null when no credential is present', () => {
    // The normal keyless state. A warning here would fire on every boot of every
    // deployment without a provider, and a warning that always fires is not a warning.
    expect(twilioConfigFrom({})).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and refuses on a partial configuration', () => {
    // Almost always a typo in a deployment secret rather than a decision, so it is
    // loud. Sending from `undefined` would be worse than not sending.
    const config = twilioConfigFrom({ TWILIO_ACCOUNT_SID: 'AC_test_sid' });

    expect(config).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('notification.sender_unconfigured', {
      missing: ['TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
    });
  });

  it('returns the config when all three are present', () => {
    const config = twilioConfigFrom({
      TWILIO_ACCOUNT_SID: 'AC_test_sid',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+15875550100',
    });

    expect(config).toEqual({
      accountSid: 'AC_test_sid',
      authToken: 'token',
      from: '+15875550100',
    });
  });

  it('trims whitespace, because a secret copied from a dashboard has it', () => {
    const config = twilioConfigFrom({
      TWILIO_ACCOUNT_SID: '  AC_test_sid \n',
      TWILIO_AUTH_TOKEN: ' token ',
      TWILIO_FROM_NUMBER: ' +15875550100 ',
    });

    expect(config?.accountSid).toBe('AC_test_sid');
    expect(config?.from).toBe('+15875550100');
  });
});

describe('twilioSender.send', () => {
  it('posts to the account Messages endpoint with Basic auth', async () => {
    const { calls } = stubFetch({ ok: true, status: 201 });

    const result = await twilioSender(CONFIG).send([MESSAGE]);

    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const [call] = calls;
    expect(call?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.accountSid}/Messages.json`,
    );

    const headers = call?.init.headers as Record<string, string>;
    // The header, decoded: a transcription error in the encoding is invisible
    // otherwise, and produces a 401 that reads like a bad token.
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('AC_test_sid:test_token', 'utf8').toString('base64')}`,
    );
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('sends To, From and Body as a form body', async () => {
    const { calls } = stubFetch({ ok: true, status: 201 });

    await twilioSender(CONFIG).send([MESSAGE]);

    const body = calls[0]?.init.body as URLSearchParams;
    expect(body.get('To')).toBe('+17805550123');
    expect(body.get('From')).toBe('+15875550100');
    expect(body.get('Body')).toBe(MESSAGE.body);
  });

  it('sends nothing for an empty batch, and calls no provider', async () => {
    const { calls } = stubFetch({ ok: true, status: 201 });

    const result = await twilioSender(CONFIG).send([]);

    expect(result).toEqual({ outcomes: [], sentCount: 0, failedCount: 0 });
    expect(calls).toHaveLength(0);
  });

  it('returns a failure rather than throwing on a provider error', async () => {
    // The one rule. This runs after money has moved; an exception becomes a 500 the
    // scheduler retries against an already-settled drop.
    stubFetch({ ok: false, status: 400, json: { code: 21610 } });

    const result = await twilioSender(CONFIG).send([MESSAGE]);

    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.outcomes[0]).toEqual({
      kind: 'DROP_CONFIRMED_CHARGED',
      sent: false,
      reason: 'PROVIDER_ERROR',
    });
  });

  it('records Twilio’s numeric code, and nothing else from the response', async () => {
    // Twilio's error prose echoes the message back on several paths, and the message
    // contains a bearer token. Only the code is safe.
    stubFetch({
      ok: false,
      status: 400,
      json: { code: 21610, message: `Attempt to send to ${MESSAGE.phone} failed: ${MESSAGE.body}` },
    });

    await twilioSender(CONFIG).send([MESSAGE]);

    expect(logger.warn).toHaveBeenCalledWith('notification.provider_error', {
      status: 400,
      code: 21610,
      kind: 'DROP_CONFIRMED_CHARGED',
    });

    // The phone number and the body must not appear in any logged field.
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain(MESSAGE.phone);
    expect(logged).not.toContain('v1.payload.signature');
  });

  it('returns a network failure rather than throwing when fetch rejects', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const result = await twilioSender(CONFIG).send([MESSAGE]);

    expect(result.outcomes[0]).toEqual({
      kind: 'DROP_CONFIRMED_CHARGED',
      sent: false,
      reason: 'NETWORK_ERROR',
    });
    // The error *name* only — never the message.
    expect(logger.warn).toHaveBeenCalledWith('notification.network_error', {
      kind: 'DROP_CONFIRMED_CHARGED',
      error: 'TypeError',
    });
  });

  it('refuses an over-long body instead of truncating it', async () => {
    // Truncation can cut a redemption code in half, and a half-code scans as valid
    // and is not. A refused message is a composer bug that shows up in logs; a
    // truncated one shows up at a counter.
    const { calls } = stubFetch({ ok: true, status: 201 });

    const result = await twilioSender(CONFIG).send([
      { ...MESSAGE, body: 'x'.repeat(MAX_SMS_CHARS + 1) },
    ]);

    expect(calls).toHaveLength(0);
    expect(result.sentCount).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('notification.too_long', {
      kind: 'DROP_CONFIRMED_CHARGED',
      length: MAX_SMS_CHARS + 1,
      limit: MAX_SMS_CHARS,
    });
  });

  it('keeps going after one failure, so one bad number does not silence a drop', async () => {
    // A batch is one drop's participants. Failing the rest because the first number
    // was disconnected would leave 15 diners uninformed about a charge on their card.
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      return {
        ok: call !== 1,
        status: call === 1 ? 400 : 201,
        json: async () => ({ code: 21211 }),
      };
    });

    const result = await twilioSender(CONFIG).send([
      MESSAGE,
      { ...MESSAGE, phone: '+17805550124' },
      { ...MESSAGE, phone: '+17805550125' },
    ]);

    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(call).toBe(3);
  });

  it('sends sequentially, not in parallel', async () => {
    // A parallel burst is the fastest route to Twilio's per-number rate limit, which
    // fails the *last* messages — the ones nobody looks at.
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal('fetch', async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { ok: true, status: 201, json: async () => ({}) };
    });

    await twilioSender(CONFIG).send([MESSAGE, MESSAGE, MESSAGE]);

    expect(maxInFlight).toBe(1);
  });
});

describe('resolveSender', () => {
  it('falls back to the logging sender with no credentials', () => {
    const sender = resolveSender({});

    expect(sender.name).toBe('logging');
  });

  it('returns the Twilio sender when configured', () => {
    const sender = resolveSender({
      TWILIO_ACCOUNT_SID: 'AC_test_sid',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+15875550100',
    });

    expect(sender.name).toBe('twilio');
  });

  it('never returns a logging sender on a keyed deployment', async () => {
    // The silent failure this guards: a keyed deployment that sends nothing and looks
    // healthy. `logging` here would mean the credentials were not read.
    const sender = resolveSender({
      TWILIO_ACCOUNT_SID: 'AC_test_sid',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+15875550100',
    });

    expect(sender.name).not.toBe('logging');
  });
});
