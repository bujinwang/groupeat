import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * What `real-charge-port.ts` actually puts on the wire — capture, void and refund.
 *
 * ## Why this file exists
 *
 * `real-charge-port.guard.test.ts` covers the *factory refusal*: no key, or a
 * non-Stripe key, throws instead of handing out a port that would fall back to the
 * platform account. That is the safety branch, and it is well covered.
 *
 * Nothing covered the three operations, which is where money actually moves. The
 * existing suites all mock the port out (`vi.mock('@/lib/settlement/real-charge-port')`
 * in five route tests) or skip (`real-charge-port.live.test.ts` needs
 * `RUN_STRIPE_LIVE_TESTS=1` and real test-mode money). So the request bodies were
 * unverified in the unit gate — and the two fee-bearing parameters are exactly the
 * kind that fail **silently** when wrong:
 *
 *   - `application_fee_amount: 0` at capture → we take no platform fee, the merchant
 *     keeps it, and every test still passes. The ledger records a fee we never
 *     collected.
 *   - `refund_application_fee: false` at refund → ADR-001 §3.2's named mistake. The
 *     refund succeeds, the diner is made whole, and we are still holding our fee on a
 *     drop that never ran. The merchant's balance is short by it and nothing throws.
 *
 * Both are one-token edits. This file makes them fail.
 *
 * ## Why a recording server rather than the live suite
 *
 * `real-charge-port.live.test.ts` is opt-in for good reasons (it spends test-mode
 * money and creates connected accounts). A `node:http` server on port 0 costs nothing,
 * runs on every commit, and can answer with shapes the live suite cannot easily
 * arrange — an unexpanded `application_fee` string, a `charge_already_refunded`, a
 * `payment_intent_unexpected_state`. Those branches are the ones with the retry
 * semantics attached, and they were as unexecuted as the happy path.
 *
 * ## What this proves, and what it must never be read as proving
 *
 * **Proves:** the exact parameters on the wire, the HTTP verb and path of each call,
 * the `Idempotency-Key` and `Stripe-Account` headers, and the mapping from each Stripe
 * response/error shape to a `CaptureOutcome` / `VoidOutcome` / `RefundOutcome`.
 *
 * **Does not prove:** that real Stripe accepts these parameters or returns those
 * shapes. A recording server replays what this test hands it. The live proof remains
 * `scripts/verify-stripe.ts`, and a green run here is not a substitute.
 */

type Recorded = {
  method: string;
  path: string;
  search: string;
  headers: IncomingMessage['headers'];
  form: Record<string, string>;
};

const recorded: Recorded[] = [];

type Reply = { status: number; body: unknown };
/** Path-prefix → reply. First match wins, so order matters for `/v1/payment_intents`. */
let replies: Array<{ match: (entry: { method: string; path: string }) => boolean; reply: Reply }> = [];

function reply(status: number, body: unknown): Reply {
  return { status, body };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_charge_recorded',
    object: 'payment_intent',
    amount: 1112,
    amount_received: 1112,
    currency: 'cad',
    status: 'succeeded',
    capture_method: 'manual',
    latest_charge: 'ch_charge_recorded',
    client_secret: 'pi_charge_recorded_secret',
    created: 1794193200,
    livemode: false,
    metadata: {},
    ...overrides,
  };
}

function charge(applicationFee: unknown) {
  return {
    id: 'ch_charge_recorded',
    object: 'charge',
    amount: 1112,
    amount_refunded: 1112,
    currency: 'cad',
    paid: true,
    refunded: true,
    status: 'succeeded',
    application_fee: applicationFee,
  };
}

function applicationFee(amountRefunded: number) {
  return {
    id: 'fee_charge_recorded',
    object: 'application_fee',
    amount: 89,
    amount_refunded: amountRefunded,
    currency: 'cad',
    charge: 'ch_charge_recorded',
  };
}

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const form: Record<string, string> = {};
      if (String(request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
        for (const [key, value] of new URLSearchParams(raw)) form[key] = value;
      } else if (raw.length > 0) {
        form.__raw = raw;
      }

      const entry = {
        method: request.method ?? '',
        path: url.pathname,
        search: url.search,
        headers: request.headers,
        form,
      };
      recorded.push(entry);

      const hit = replies.find((candidate) => candidate.match(entry));
      const chosen = hit?.reply ?? reply(404, {
        error: { type: 'invalid_request_error', message: `no reply configured for ${request.method} ${url.pathname}` },
      });

      response.writeHead(chosen.status, {
        'content-type': 'application/json',
        'request-id': 'req_charge_recorded',
      });
      response.end(JSON.stringify(chosen.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(async () => {
  recorded.length = 0;
  replies = [];
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = 'sk_test_charge_recording';

  const { __setStripeClientForTests } = await import('@/lib/payments/stripe');
  __setStripeClientForTests({
    host: '127.0.0.1',
    port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeout: 5_000,
    typescript: true,
  });
});

afterEach(async () => {
  const { __setStripeClientForTests } = await import('@/lib/payments/stripe');
  __setStripeClientForTests(null);
  delete process.env.STRIPE_SECRET_KEY;
});

async function loadPort() {
  const { realChargePort } = await import('../real-charge-port');
  return realChargePort();
}

const ACCOUNT = 'acct_charge_recording';
const PARTICIPANT = 'participant_charge';

function captureRequest(overrides: Record<string, unknown> = {}) {
  return {
    participantId: PARTICIPANT,
    dropId: 'drop_charge',
    stripeAccountId: ACCOUNT,
    paymentIntentId: 'pi_charge_recorded',
    amountCents: 1112,
    platformFeeCents: 89,
    idempotencyKey: 'capture:participant_charge',
    ...overrides,
  } as Parameters<Awaited<ReturnType<typeof loadPort>>['capture']>[0];
}

function refundRequest(overrides: Record<string, unknown> = {}) {
  return {
    participantId: PARTICIPANT,
    stripeAccountId: ACCOUNT,
    chargeId: 'ch_charge_recorded',
    amountCents: 1112,
    platformFeeCents: 89,
    reverseApplicationFee: true,
    idempotencyKey: 'refund:participant_charge',
    ...overrides,
  } as Parameters<Awaited<ReturnType<typeof loadPort>>['refund']>[0];
}

function voidRequest(overrides: Record<string, unknown> = {}) {
  return {
    participantId: PARTICIPANT,
    stripeAccountId: ACCOUNT,
    paymentIntentId: 'pi_charge_recorded',
    idempotencyKey: 'void:participant_charge',
    ...overrides,
  } as Parameters<Awaited<ReturnType<typeof loadPort>>['voidAuthorization']>[0];
}

function only(entry: { method: string; path: string }): Recorded {
  const hits = recorded.filter((candidate) => candidate.method === entry.method && candidate.path === entry.path);
  expect(
    hits.length,
    `expected exactly one ${entry.method} ${entry.path}; saw ${JSON.stringify(recorded.map((r) => `${r.method} ${r.path}`))}`,
  ).toBe(1);
  return hits[0] as Recorded;
}

describe('capture — the parameter that decides who keeps the fee', () => {
  it('sends application_fee_amount equal to platformFeeCents', async () => {
    // ADR-001 §3.2 under a direct charge. A zero or absent fee here is invisible:
    // the capture succeeds, the diner is charged correctly, and the platform simply
    // never collects. Nothing else in the suite would notice.
    replies = [
      { match: (e) => e.method === 'POST', reply: reply(200, intent()) },
    ];

    const outcome = await (await loadPort()).capture(captureRequest({ platformFeeCents: 89 }));

    expect(outcome).toEqual({ status: 'CAPTURED', chargeId: 'ch_charge_recorded' });
    expect(only({ method: 'POST', path: '/v1/payment_intents/pi_charge_recorded/capture' }).form.application_fee_amount).toBe('89');
  });

  it('carries a different fee through unchanged, so it is the request value and not a constant', async () => {
    // The complement of the test above: a hard-coded `89` would satisfy that one.
    replies = [{ match: () => true, reply: reply(200, intent()) }];

    await (await loadPort()).capture(captureRequest({ platformFeeCents: 137 }));

    expect(only({ method: 'POST', path: '/v1/payment_intents/pi_charge_recorded/capture' }).form.application_fee_amount).toBe('137');
  });

  it('sends no transfer_data and no on_behalf_of — these are direct charges', async () => {
    // Passing either of these is the destination-charge shape ADR-001 rejected.
    // Stripe would accept them and pay out differently, which is why the assertion is
    // an exact key set rather than a search for the two names.
    replies = [{ match: () => true, reply: reply(200, intent()) }];

    await (await loadPort()).capture(captureRequest());

    expect(Object.keys(only({ method: 'POST', path: '/v1/payment_intents/pi_charge_recorded/capture' }).form).sort()).toEqual([
      'application_fee_amount',
    ]);
  });

  it('scopes to the merchant account and carries the idempotency key', async () => {
    replies = [{ match: () => true, reply: reply(200, intent()) }];

    await (await loadPort()).capture(captureRequest({ stripeAccountId: 'acct_merchant_9', idempotencyKey: 'capture:abc' }));

    const post = only({ method: 'POST', path: '/v1/payment_intents/pi_charge_recorded/capture' });
    expect(post.headers['stripe-account']).toBe('acct_merchant_9');
    expect(post.headers['idempotency-key']).toBe('capture:abc');
  });

  it('refuses to report CAPTURED when the response names no charge', async () => {
    // Without a charge id there is no `stripeRef`, so the diner could never be
    // refunded. Reporting CAPTURED here would write a ledger row nobody can reverse.
    replies = [{ match: () => true, reply: reply(200, intent({ latest_charge: null })) }];

    await expect((await loadPort()).capture(captureRequest())).rejects.toThrow(/no latest_charge/);
  });

  it('maps a decline to DECLINED with its code rather than throwing', async () => {
    replies = [
      {
        match: () => true,
        reply: reply(402, {
          error: { type: 'card_error', code: 'card_declined', decline_code: 'expired_card', message: 'Expired.' },
        }),
      },
    ];

    expect(await (await loadPort()).capture(captureRequest())).toEqual({
      status: 'DECLINED',
      declineCode: 'expired_card',
    });
  });
});

describe('voidAuthorization — releasing a hold without charging', () => {
  it('cancels with reason abandoned, scoped and idempotent', async () => {
    replies = [{ match: () => true, reply: reply(200, intent({ status: 'canceled' })) }];

    expect(await (await loadPort()).voidAuthorization(voidRequest())).toEqual({ status: 'VOIDED' });

    const post = only({ method: 'POST', path: '/v1/payment_intents/pi_charge_recorded/cancel' });
    expect(post.form.cancellation_reason).toBe('abandoned');
    expect(post.headers['stripe-account']).toBe(ACCOUNT);
    expect(post.headers['idempotency-key']).toBe('void:participant_charge');
  });

  it('reports an already-final intent as ALREADY_EXPIRED, not as a failure', async () => {
    // Both codes Stripe uses for "this intent can no longer be cancelled". The first
    // is generic; the second is the cancel-specific one. A miss on either turns a
    // successful void into an infinite retry.
    for (const code of ['payment_intent_unexpected_state', 'payment_intent_unexpected_state_for_cancel']) {
      recorded.length = 0;
      replies = [
        {
          match: () => true,
          reply: reply(400, { error: { type: 'invalid_request_error', code, message: 'Already final.' } }),
        },
      ];

      expect(await (await loadPort()).voidAuthorization(voidRequest())).toEqual({ status: 'ALREADY_EXPIRED' });
    }
  });

  it('throws a retryable error for anything else', async () => {
    replies = [
      { match: () => true, reply: reply(503, { error: { type: 'api_error', message: 'Upstream.' } }) },
    ];

    await expect((await loadPort()).voidAuthorization(voidRequest())).rejects.toMatchObject({
      reason: 'http_5xx',
    });
  });
});

describe('refund — the parameter that decides whether we give our fee back', () => {
  it('sends refund_application_fee=true, and reads the reversal from the charge', async () => {
    // ADR-001 §3.2's named mistake lives here: `refund_application_fee: false` still
    // refunds the diner, still succeeds, and quietly keeps a fee on a drop that never
    // ran. The merchant's balance is short by it and nothing throws.
    replies = [
      { match: (e) => e.path === '/v1/refunds', reply: reply(200, { id: 're_recorded', object: 'refund', amount: 1112, status: 'succeeded' }) },
      { match: (e) => e.path.startsWith('/v1/charges/'), reply: reply(200, charge(applicationFee(89))) },
    ];

    const outcome = await (await loadPort()).refund(refundRequest());

    expect(outcome).toEqual({ status: 'REFUNDED', refundId: 're_recorded', applicationFeeRefundCents: 89 });

    const post = only({ method: 'POST', path: '/v1/refunds' });
    expect(post.form.refund_application_fee).toBe('true');
    expect(post.form.charge).toBe('ch_charge_recorded');
    expect(post.form.amount).toBe('1112');
    expect(post.headers['stripe-account']).toBe(ACCOUNT);
    expect(post.headers['idempotency-key']).toBe('refund:participant_charge');
  });

  it('asks for the application fee to be expanded, rather than assuming zero', async () => {
    // The reversal figure is only on the ApplicationFee, reachable from the Charge
    // with `expand`. Without the expand the response carries an id string, and the
    // port must refuse rather than record a refund that kept our fee.
    replies = [
      { match: (e) => e.path === '/v1/refunds', reply: reply(200, { id: 're_recorded', object: 'refund', amount: 1112, status: 'succeeded' }) },
      // Deliberately unexpanded: this is what a missed expand looks like.
      { match: (e) => e.path.startsWith('/v1/charges/'), reply: reply(200, charge('fee_charge_recorded')) },
    ];

    await expect((await loadPort()).refund(refundRequest())).rejects.toThrow(/unexpanded id/);

    const get = only({ method: 'GET', path: '/v1/charges/ch_charge_recorded' });
    expect(get.search).toContain('expand');
    expect(decodeURIComponent(get.search)).toContain('application_fee');
  });

  it('reports zero when the charge genuinely has no application fee', async () => {
    // A merchant configured without a platform fee, or a zero-fee deal. A real zero,
    // not a failure — and distinguishable from the unexpanded case above.
    replies = [
      { match: (e) => e.path === '/v1/refunds', reply: reply(200, { id: 're_recorded', object: 'refund', amount: 1112, status: 'succeeded' }) },
      { match: (e) => e.path.startsWith('/v1/charges/'), reply: reply(200, charge(null)) },
    ];

    expect(await (await loadPort()).refund(refundRequest())).toMatchObject({ applicationFeeRefundCents: 0 });
  });

  it('maps charge_already_refunded to ALREADY_REFUNDED and still reads the reversal', async () => {
    // A previous attempt landed. The refund is a no-op, but the ledger still needs the
    // reversed figure — so it is read, not assumed. Returning ALREADY_REFUNDED with a
    // guessed number would misstate the merchant's balance.
    replies = [
      {
        match: (e) => e.path === '/v1/refunds',
        reply: reply(400, { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Already refunded.' } }),
      },
      { match: (e) => e.path.startsWith('/v1/charges/'), reply: reply(200, charge(applicationFee(89))) },
    ];

    expect(await (await loadPort()).refund(refundRequest())).toEqual({
      status: 'ALREADY_REFUNDED',
      applicationFeeRefundCents: 89,
    });
  });

  it('refuses to report ALREADY_REFUNDED when the reversal cannot be read', async () => {
    // The refund exists but its reversed fee is unknown. Guessing would write a ledger
    // row that cannot be reconciled; the retry with the same key is safe.
    replies = [
      {
        match: (e) => e.path === '/v1/refunds',
        reply: reply(400, { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Already refunded.' } }),
      },
      { match: (e) => e.path.startsWith('/v1/charges/'), reply: reply(500, { error: { type: 'api_error', message: 'boom' } }) },
    ];

    await expect((await loadPort()).refund(refundRequest())).rejects.toThrow(/could not be read/);
  });

  it('classifies a connection failure as retryable rather than as a decline', async () => {
    // §4.2's retry policy: a network failure leaves the participant at NONE and the
    // next tick retries with the same key. Classifying it as terminal would strand a
    // diner's money.
    replies = [{ match: () => true, reply: reply(500, { error: { type: 'api_error', message: 'Upstream.' } }) }];

    await expect((await loadPort()).refund(refundRequest())).rejects.toMatchObject({ reason: 'http_5xx' });
  });
});
