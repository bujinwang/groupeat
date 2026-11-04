import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `server-only` is a build-time marker, not behaviour. The same one-line mock, for the
 * same reason, as `twilio-sender.test.ts`: without it the module cannot be imported in
 * a test at all.
 */
vi.mock('server-only', () => ({}));

import { logger } from '@/lib/logging/logger';

import { loggingEmailSender, type EmailMessage } from '../email-sender';
import { resendConfigFrom, resendEmailSender, resolveEmailSender } from '../resend-sender';

/**
 * The Resend sender, against a stubbed `fetch`.
 *
 * What it proves: the URL, the bearer header, the JSON body and every failure branch.
 * What it cannot prove: that Resend accepts the request, that the sending domain is
 * verified, or that a message arrives. There is no key on this machine, so the first
 * real send is still the first evidence — the same disclaimer `twilio-sender.test.ts`
 * carries, and for the same reason.
 */

const MESSAGE: EmailMessage = {
  kind: 'weekly_digest',
  to: 'owner@example.test',
  subject: 'Café Test: 24 plates, $160.80 kept',
  text: 'Hi Sam,\n\nYou kept $160.80.\n',
  html: '<p>Hi Sam,</p>',
};

const CONFIG = {
  apiKey: 're_test_key',
  from: 'GroupEat <digest@groupeat.example>',
};

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

describe('resendConfigFrom', () => {
  it('is silent and null when no credential is present', () => {
    expect(resendConfigFrom({})).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and refuses on a partial configuration', () => {
    expect(resendConfigFrom({ RESEND_API_KEY: 're_test_key' })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('digest.sender_unconfigured', {
      missing: ['DIGEST_FROM_EMAIL'],
    });
  });

  it('trims whitespace out of a copied secret', () => {
    const config = resendConfigFrom({
      RESEND_API_KEY: '  re_test_key \n',
      DIGEST_FROM_EMAIL: ' GroupEat <digest@groupeat.example> ',
    });

    expect(config).toEqual({
      apiKey: 're_test_key',
      from: 'GroupEat <digest@groupeat.example>',
    });
  });
});

describe('resendEmailSender.send', () => {
  it('posts the whole message to the emails endpoint with a bearer token', async () => {
    const { calls } = stubFetch({ ok: true, status: 200, json: { id: 'email-1' } });

    const result = await resendEmailSender(CONFIG).send([MESSAGE]);

    expect(result).toEqual({
      outcomes: [
        { kind: 'weekly_digest', to: 'owner@example.test', sent: true, providerId: 'email-1' },
      ],
      sentCount: 1,
      failedCount: 0,
    });

    const [call] = calls;
    expect(call?.url).toBe('https://api.resend.com/emails');
    expect(call?.init.method).toBe('POST');
    expect((call?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer re_test_key',
    );
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: CONFIG.from,
      to: ['owner@example.test'],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  it('returns a failure outcome and never throws when the provider answers an error', async () => {
    stubFetch({ ok: false, status: 422, json: { message: 'invalid from' } });

    const result = await resendEmailSender(CONFIG).send([MESSAGE]);

    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ sent: false, reason: 'PROVIDER_ERROR' });
    expect(logger.warn).toHaveBeenCalledWith('digest.provider_error', {
      status: 422,
      kind: 'weekly_digest',
    });
    // The provider's body can echo the address; it must not reach the log.
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      'owner@example.test',
    );
  });

  it('turns a network failure into NETWORK_ERROR rather than an exception', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up');
    });

    const result = await resendEmailSender(CONFIG).send([MESSAGE]);

    expect(result.outcomes[0]).toMatchObject({ sent: false, reason: 'NETWORK_ERROR' });
    expect(logger.warn).toHaveBeenCalledWith('digest.network_error', {
      kind: 'weekly_digest',
      error: 'Error',
    });
  });

  it('sends nothing, and reports nothing, for an empty batch', async () => {
    const { calls } = stubFetch({ ok: true, status: 200 });
    const result = await resendEmailSender(CONFIG).send([]);

    expect(result).toEqual({ outcomes: [], sentCount: 0, failedCount: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('resolveEmailSender', () => {
  it('falls back to the logging sender without credentials', () => {
    expect(resolveEmailSender({}).name).toBe('logging');
  });

  it('uses Resend when both values are present', () => {
    expect(
      resolveEmailSender({
        RESEND_API_KEY: 're_test_key',
        DIGEST_FROM_EMAIL: 'digest@groupeat.example',
      }).name,
    ).toBe('resend');
  });

  it('the logging sender reports NOT_CONFIGURED per message, not success', async () => {
    const result = await loggingEmailSender().send([MESSAGE]);

    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ sent: false, reason: 'NOT_CONFIGURED' });
  });
});
