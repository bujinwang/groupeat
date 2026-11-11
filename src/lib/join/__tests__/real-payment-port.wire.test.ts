import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * What `real-payment-port.ts` actually puts on the wire — recorded, not inferred.
 *
 * ## The hole this file exists to close, measured
 *
 * `real-port-boundary.test.ts` asserts the *source text* of the port contains
 * `JOIN_CAPTURE_METHOD` and that `payment-port.ts` declares it `'manual' as const`.
 * `real-payment-port.contract.test.ts` asserts that a PaymentIntent the **test itself**
 * created (calling the SDK directly, with its own `capture_method: 'manual'` literal)
 * comes back with `capture_method: 'manual'` — which is a tautology about the mock, not
 * a statement about the port.
 *
 * Neither one pins the value the port sends. Mutating `real-payment-port.ts` line 107
 * from `capture_method: JOIN_CAPTURE_METHOD` to `capture_method: 'automatic'` — the
 * single most dangerous edit in this repository, because it charges a diner the instant
 * they tap join, before the minimum is met — passes **all ten** of those tests. Measured:
 *
 * ```
 * real-port-boundary.test.ts        4 passed
 * real-payment-port.contract.test.ts 6 passed
 * tsc --noEmit                      exit 0
 * ```
 *
 * `tsc` stays silent because the mutation leaves the `JOIN_CAPTURE_METHOD` import unused,
 * and `noUnusedLocals` is not enabled. The text guard stays silent because the token is
 * still present — just somewhere useless.
 *
 * ## Why a recording server rather than stripe-mock
 *
 * `stripe-mock` is a separate binary that is not installed by `npm ci`, so its suite
 * skips in a clean checkout and the skip is the default state, not the exception. This
 * file starts a plain `node:http` server on an ephemeral port in the same process. It
 * cannot skip: no external dependency, no network, no port collision (port `0`).
 *
 * ## What this file does and does not prove
 *
 * **Proves:** the exact form-encoded body the port sends, field by field, including
 * `capture_method=manual`, `confirm=true`, the idempotency key, and the absence of any
 * field it should not send. And, given a well-formed Stripe response, that the port maps
 * `requires_capture` → `AUTHORIZED`, `requires_payment_method` → a refusal, and a
 * `StripeCardError` body → `DECLINED`.
 *
 * **Does not prove:** that real Stripe *returns* those shapes, or that the intent lands on
 * the merchant's account. Those are properties of Stripe and are covered by
 * `scripts/verify-stripe.ts` against test mode; a recording server can only replay what
 * this file hands it. Stated here so a green run is not read as more.
 */

type Recorded = {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  /** Parsed `application/x-www-form-urlencoded` body — what Stripe itself would parse. */
  form: Record<string, string>;
};

const recorded: Recorded[] = [];

/** A response body the Stripe SDK accepts as a PaymentIntent. */
function intentBody(status: string, captureMethod = 'manual'): string {
  return JSON.stringify({
    id: 'pi_wire_recorded',
    object: 'payment_intent',
    amount: 1112,
    amount_received: 0,
    currency: 'cad',
    status,
    capture_method: captureMethod,
    client_secret: 'pi_wire_recorded_secret_wire',
    created: 1794193200,
    livemode: false,
    metadata: {},
  });
}

/** The status the next request should be answered with. Set per test. */
let nextResponse: { status: number; body: string; headers?: Record<string, string> } = {
  status: 200,
  body: intentBody('requires_capture'),
};

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const contentType = String(request.headers['content-type'] ?? '');
      const form: Record<string, string> = {};
      if (contentType.includes('application/x-www-form-urlencoded')) {
        for (const [key, value] of new URLSearchParams(raw)) form[key] = value;
      } else if (raw.length > 0) {
        form.__raw = raw;
      }

      recorded.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        form,
      });

      response.writeHead(nextResponse.status, {
        'content-type': 'application/json',
        'request-id': 'req_wire_recorded',
        ...(nextResponse.headers ?? {}),
      });
      response.end(nextResponse.body);
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
  nextResponse = { status: 200, body: intentBody('requires_capture') };
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = 'sk_test_wire_recording';

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
  const { realJoinPaymentPort } = await import('../real-payment-port');
  return realJoinPaymentPort();
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    dropId: 'drop_wire',
    participantId: 'participant_wire',
    stripeAccountId: 'acct_wire',
    amountCents: 1112,
    platformFeeCents: 89,
    paymentMethodId: 'pm_card_visa',
    currency: 'cad',
    idempotencyKey: 'join:participant_wire',
    ...overrides,
  } as Parameters<Awaited<ReturnType<typeof loadPort>>['createJoinAuthorisation']>[0];
}

/** The one POST to `/v1/payment_intents` this file expects. */
function intentPost(): Recorded {
  const post = recorded.find(
    (entry) => entry.method === 'POST' && entry.path.startsWith('/v1/payment_intents'),
  );
  expect(post, `no POST /v1/payment_intents was recorded; saw ${JSON.stringify(recorded.map((entry) => `${entry.method} ${entry.path}`))}`).toBeDefined();
  return post as Recorded;
}

describe('the real join payment port, recorded at the wire', () => {
  it('sends capture_method=manual — the value the port chose, not one the test chose', async () => {
    // The FR-404 guard. This is the assertion that fails when line 107 of
    // `real-payment-port.ts` becomes `'automatic'`, and nothing else in the repo
    // currently does. `automatic` means the diner is charged at join time, before the
    // drop has met its minimum, which is the one rule AGENTS.md calls non-negotiable.
    const port = await loadPort();
    await port.createJoinAuthorisation(request());

    const post = intentPost();
    expect(post.form.capture_method).toBe('manual');
  });

  it('sends confirm=true, amount, currency and the PaymentMethod', async () => {
    // The authorisation has to be *confirmed server-side* for this response to carry an
    // authorisation at all. `confirm` absent would leave the intent at
    // `requires_payment_method` and make "authorised" an asynchronous fact needing a
    // webhook — the design decision documented in the port.
    const port = await loadPort();
    await port.createJoinAuthorisation(request());

    const { form } = intentPost();
    expect(form.confirm).toBe('true');
    expect(form.amount).toBe('1112');
    expect(form.currency).toBe('cad');
    expect(form.payment_method).toBe('pm_card_visa');
    // Card-only, no off-session redirects: a phone in a group chat has no return URL.
    expect(form['automatic_payment_methods[enabled]']).toBe('true');
    expect(form['automatic_payment_methods[allow_redirects]']).toBe('never');
  });

  it('carries the idempotency key as a header, so a retry cannot double-hold', async () => {
    // The key is an HTTP header, not a form field — asserting it in the body would pass
    // against a port that sent it in the wrong place.
    const port = await loadPort();
    await port.createJoinAuthorisation(request({ idempotencyKey: 'join:wire:abc123' }));

    const post = intentPost();
    expect(post.headers['idempotency-key']).toBe('join:wire:abc123');
  });

  it('scopes the request to the merchant account via the Stripe-Account header', async () => {
    // ADR-001's safety property. A hold created without this header lands on the
    // platform account and succeeds silently against the wrong account, which is the
    // failure mode that does not fail loudly.
    const port = await loadPort();
    await port.createJoinAuthorisation(request({ stripeAccountId: 'acct_merchant_42' }));

    expect(intentPost().headers['stripe-account']).toBe('acct_merchant_42');
  });

  it('sends ids in metadata and no cardholder data', async () => {
    // Metadata is displayed in the Dashboard and treated as a log line: ids only.
    const port = await loadPort();
    await port.createJoinAuthorisation(request());

    const { form } = intentPost();
    expect(form['metadata[dropId]']).toBe('drop_wire');
    expect(form['metadata[participantId]']).toBe('participant_wire');

    // Asserted as an exact key set rather than a `/phone|name|email|card/i` scan.
    // That scan was the first draft and it failed against correct code: `participantId`
    // contains the substring "pan" (parti-c-**pan**-t), so a card-shaped regex over
    // camelCase field names matches a field that has nothing to do with cards. Enumerate
    // instead — it also catches a *new* field being added, which a denylist never would.
    expect(Object.keys(form).sort()).toEqual(
      [
        'amount',
        'automatic_payment_methods[allow_redirects]',
        'automatic_payment_methods[enabled]',
        'capture_method',
        'confirm',
        'currency',
        'metadata[dropId]',
        'metadata[participantId]',
        'payment_method',
      ].sort(),
    );
  });

  it('does not send providerCustomerId when the caller has none', async () => {
    // The spread is conditional. An unconditional `customer: undefined` would serialise
    // as the string "undefined" and Stripe would reject it — or worse, accept it.
    const port = await loadPort();
    await port.createJoinAuthorisation(request({ providerCustomerId: undefined }));

    expect(intentPost().form.customer).toBeUndefined();
  });

  it('sends providerCustomerId when the caller has one', async () => {
    const port = await loadPort();
    await port.createJoinAuthorisation(request({ providerCustomerId: 'cus_wire_1' }));

    expect(intentPost().form.customer).toBe('cus_wire_1');
  });
});

describe('the real join payment port, mapping a response to an outcome', () => {
  it('maps requires_capture to AUTHORIZED', async () => {
    // `stripe-mock` cannot exercise this — its fixture is always
    // `requires_payment_method`, so the existing contract suite can only assert the
    // refusal. A recording server can answer whatever it likes, so the *mapping* is
    // testable here even though real Stripe's behaviour is not.
    const port = await loadPort();
    const outcome = await port.createJoinAuthorisation(request());

    expect(outcome).toEqual({
      status: 'AUTHORIZED',
      paymentIntentId: 'pi_wire_recorded',
      providerStatus: 'requires_capture',
    });
  });

  it('refuses any other status rather than guessing it is a hold', async () => {
    nextResponse = { status: 200, body: intentBody('requires_payment_method') };

    const port = await loadPort();
    await expect(port.createJoinAuthorisation(request())).rejects.toThrow(
      /requires_payment_method.*expected "requires_capture"|expected "requires_capture"/,
    );
  });

  it('maps a card decline to DECLINED with the decline code, not to an error', async () => {
    // A decline is data. Turning it into a 502 would tell the diner our service is
    // broken when in fact their card was refused.
    nextResponse = {
      status: 402,
      body: JSON.stringify({
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card has insufficient funds.',
        },
      }),
    };

    const port = await loadPort();
    const outcome = await port.createJoinAuthorisation(request());

    expect(outcome).toEqual({ status: 'DECLINED', declineCode: 'insufficient_funds' });
  });

  it('falls back to card_declined when the decline carries no usable code', async () => {
    nextResponse = {
      status: 402,
      body: JSON.stringify({
        error: { type: 'card_error', code: 'card_declined', message: 'Declined.' },
      }),
    };

    const port = await loadPort();
    expect(await port.createJoinAuthorisation(request())).toEqual({
      status: 'DECLINED',
      declineCode: 'card_declined',
    });
  });
});
