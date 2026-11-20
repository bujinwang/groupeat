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

  it('refuses a request with no card before it ever reaches the wire', async () => {
    // Slice 2b's bug, made permanent. `paymentMethodId` is optional on
    // `JoinAuthorisationRequest` (the fake-backed slice 2a tests have no `pm_…`), so
    // this branch is the only thing standing between "the route forgot to pass the
    // card" and an intent created at `requires_payment_method` — which looks like a
    // hold to every reader of the Dashboard and holds nothing.
    //
    // `real-payment-port.contract.test.ts:198` asserts the same message, but that
    // suite **skips without `stripe-mock`** (`1 passed | 5 skipped` in a clean
    // checkout), so before this test the guard ran in no default gate at all.
    const port = await loadPort();

    await expect(
      port.createJoinAuthorisation(request({ paymentMethodId: undefined })),
    ).rejects.toThrow(/no paymentMethodId/);
    // Refused *before* the create call, which is the whole claim.
    expect(recorded).toHaveLength(0);
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

/**
 * The reconciliation read. Stripe has no "get by idempotency key", so this suite
 * pins the two facts that make the new seam honest: the search is scoped to the
 * connected account and to the exact metadata the create call writes, and only
 * two provider statuses are turned into claims about a hold.
 */
describe('the real join payment port, reconciling a lost response', () => {
  function searchBody(statuses: readonly string[]): string {
    return JSON.stringify({
      object: 'search_result',
      url: '/v1/payment_intents/search',
      has_more: false,
      next_page: null,
      data: statuses.map((status) => JSON.parse(intentBody(status))),
    });
  }

  function searchGet(): Recorded {
    const get = recorded.find(
      (entry) =>
        entry.method === 'GET' && entry.path.startsWith('/v1/payment_intents/search'),
    );
    expect(
      get,
      `no GET /v1/payment_intents/search was recorded; saw ${JSON.stringify(recorded.map((entry) => `${entry.method} ${entry.path}`))}`,
    ).toBeDefined();
    return get as Recorded;
  }

  it('searches by both metadata ids on the connected account', async () => {
    nextResponse = { status: 200, body: searchBody([]) };

    const port = await loadPort();
    await port.findJoinAuthorisation({
      participantId: 'participant_wire',
      dropId: 'drop_wire',
      stripeAccountId: 'acct_reconcile',
    });

    const get = searchGet();
    const query = new URL(get.path, 'http://localhost').searchParams.get('query');
    expect(query).toBe(
      'metadata["participantId"]:"participant_wire" AND metadata["dropId"]:"drop_wire"',
    );
    expect(get.headers['stripe-account']).toBe('acct_reconcile');
  });

  it('escapes quotes in a search value rather than changing the query shape', async () => {
    nextResponse = { status: 200, body: searchBody([]) };

    const port = await loadPort();
    await port.findJoinAuthorisation({
      participantId: 'part"icipant',
      dropId: 'drop_wire',
      stripeAccountId: 'acct_reconcile',
    });

    const query = new URL(searchGet().path, 'http://localhost').searchParams.get('query');
    expect(query).toBe(
      'metadata["participantId"]:"part\\"icipant" AND metadata["dropId"]:"drop_wire"',
    );
  });

  it('maps requires_capture to an authoritative hold id', async () => {
    nextResponse = { status: 200, body: searchBody(['requires_capture']) };

    const port = await loadPort();
    expect(
      await port.findJoinAuthorisation({
        participantId: 'participant_wire',
        dropId: 'drop_wire',
        stripeAccountId: 'acct_reconcile',
      }),
    ).toEqual({ status: 'AUTHORIZED', paymentIntentId: 'pi_wire_recorded' });
  });

  it('maps canceled to EXPIRED with the id the provider reported', async () => {
    nextResponse = { status: 200, body: searchBody(['canceled']) };

    const port = await loadPort();
    expect(
      await port.findJoinAuthorisation({
        participantId: 'participant_wire',
        dropId: 'drop_wire',
        stripeAccountId: 'acct_reconcile',
      }),
    ).toEqual({ status: 'EXPIRED', paymentIntentId: 'pi_wire_recorded' });
  });

  it('reports no match instead of inventing a hold', async () => {
    nextResponse = { status: 200, body: searchBody([]) };

    const port = await loadPort();
    expect(
      await port.findJoinAuthorisation({
        participantId: 'participant_wire',
        dropId: 'drop_wire',
        stripeAccountId: 'acct_reconcile',
      }),
    ).toEqual({ status: 'NOT_FOUND' });
  });

  it('refuses to choose between multiple matching intents', async () => {
    nextResponse = { status: 200, body: searchBody(['requires_capture', 'canceled']) };

    const port = await loadPort();
    expect(
      await port.findJoinAuthorisation({
        participantId: 'participant_wire',
        dropId: 'drop_wire',
        stripeAccountId: 'acct_reconcile',
      }),
    ).toEqual({ status: 'UNRESOLVED', reason: 'MULTIPLE_MATCHES' });
  });

  it('keeps an unexpected provider status as a named unresolved reason', async () => {
    nextResponse = { status: 200, body: searchBody(['succeeded']) };

    const port = await loadPort();
    expect(
      await port.findJoinAuthorisation({
        participantId: 'participant_wire',
        dropId: 'drop_wire',
        stripeAccountId: 'acct_reconcile',
      }),
    ).toEqual({
      status: 'UNRESOLVED',
      reason: 'UNEXPECTED_STATUS',
      providerStatus: 'succeeded',
    });
  });
});

/**
 * `asUnavailable()` — the failure classifier, which decides whether a diner is
 * told to retry.
 *
 * ## Why these three branches matter more than their line count
 *
 * `JoinProviderUnavailableError.reason` is not cosmetic. `service.ts` writes the
 * participant row before the call and treats `PENDING` as "not a confirmed plate";
 * the reconciliation path resolves it by idempotency key. The reason is what the
 * retry measurement counts, so a misclassification is a diner charged for a drop
 * that never ran, or a drop abandoned that would have worked.
 *
 * V8 coverage over `src/lib/join` + `src/app/api/public/drops` left three
 * assignments dark — `reason = 'network'` (L212), `'rate_limited'` (L214) and
 * `'http_5xx'` (L216) — i.e. **every classified reason**. Only the `'unknown'`
 * default executed, and only because the `requires_payment_method` test falls
 * through it. So the classifier's three decisions were, until this block, asserted
 * by nothing in the default gate.
 *
 * The recording server is what makes them testable at all: these branches fire from
 * *how the transport failed*, which `stripe-mock` cannot produce (it never drops a
 * connection, never 429s, never 500s) and a unit test with a stubbed SDK cannot
 * reach without also stubbing away the branch.
 */
describe('asUnavailable — every classified failure reason is reachable', () => {
  async function failureReason(): Promise<string> {
    const port = await loadPort();
    try {
      await port.createJoinAuthorisation(request());
    } catch (error) {
      const reason = (error as { reason?: unknown }).reason;
      expect(typeof reason, `thrown value carried no reason: ${String(error)}`).toBe('string');
      return reason as string;
    }
    throw new Error('expected createJoinAuthorisation to reject; it resolved');
  }

  it('classifies a 5xx as http_5xx', async () => {
    nextResponse = {
      status: 500,
      body: JSON.stringify({ error: { type: 'api_error', message: 'Internal error.' } }),
    };

    expect(await failureReason()).toBe('http_5xx');
  });

  it('classifies a rate-limit response as rate_limited', async () => {
    // Stripe answers 429 with `StripeRateLimitError`. Both the type and the status
    // agree here; the type is what the classifier reads.
    nextResponse = {
      status: 429,
      body: JSON.stringify({
        error: { type: 'rate_limit_error', message: 'Too many requests.' },
      }),
    };

    expect(await failureReason()).toBe('rate_limited');
  });

  it('classifies a connection failure as network', async () => {
    // The one reason that cannot be produced by answering differently: the socket
    // has to actually fail. Pointing the already-injected base at a port nothing is
    // listening on does that, without touching the production configuration.
    const { __setStripeClientForTests } = await import('@/lib/payments/stripe');
    __setStripeClientForTests({
      host: '127.0.0.1',
      port: 1, // reserved, nothing listens
      protocol: 'http',
      maxNetworkRetries: 0,
      timeout: 2_000,
      typescript: true,
    });

    expect(await failureReason()).toBe('network');
    expect(recorded).toHaveLength(0);
  });
});

/**
 * `createJoinPaymentPort` — the one function the route actually calls.
 *
 * ## The hole this block closes, measured
 *
 * Everything above drives `realJoinPaymentPort()` directly. The **route** never
 * calls that function; it calls `createJoinPaymentPort()` (route.ts:154–155), and
 * both route suites (`route.test.ts:101`, `attribution.test.ts:53`) replace the
 * whole module with `vi.mock('@/lib/join/real-payment-port', …)` — so before this
 * block, `createJoinPaymentPort` had **zero executions** anywhere in the suite.
 *
 * That is not a coverage statistic. Replacing its body with a detached fake:
 *
 * ```ts
 * export async function createJoinPaymentPort(): Promise<JoinPaymentPort> {
 *   const { fakeJoinPaymentPort } = await import('./fake-payment-port');
 *   return fakeJoinPaymentPort();
 * }
 * ```
 *
 * — the edit the route's own docblock calls out as the one that must never happen
 * ("A fake in production would take a join and hold nothing") — **passed the entire
 * repository**: `tsc --noEmit` exit 0, `221 passed | 1 skipped` files,
 * `2881 passed | 8 skipped` tests. Measured 2026-11-13, before this block existed.
 *
 * The reason it passed is structural, not incidental. `FakeJoinPaymentPort` is typed
 * `JoinPaymentPort & { … }`, so it is assignable to the return type; it satisfies
 * every behavioural assertion in `real-payment-port.contract.test.ts`; and the two
 * route tests cannot see which implementation they got because they mock it away.
 * A type cannot distinguish "the real port" from "a fake that conforms to the same
 * interface" — only an observation *outside* the interface can.
 *
 * ## What this block observes
 *
 * The recording server, which sits outside the interface entirely. A returned port
 * that creates an intent **through `forMerchant()` to an HTTP server** is the real
 * port; one that returns a `pi_fake_join_N` without a request is not. The wire is
 * the only witness that cannot be faked from inside the port's own type.
 *
 * **Does not prove:** that the deployment's `STRIPE_SECRET_KEY` is real, or that the
 * intent lands on the merchant's account against real Stripe. Same caveat as the
 * rest of this file.
 *
 * ## `authorisedParticipantIds` — measured, and deliberately not tested
 *
 * A V8 census over `src/lib/join` + `src/app/api/public/drops` gave
 * `authorisedParticipantIds: hits=0 L108`, while its siblings `authorisedCount`
 * (hits=13) and `authorisedTotalCents` (hits=4) are used throughout. A grep for the
 * name across `src/` and `scripts/` returns exactly **two** hits: the interface
 * member (`fake-payment-port.ts:61`) and the implementation (`:108`). Zero callers,
 * **zero tests** — it is dead, not untested.
 *
 * It is left untested on purpose. A test here would pin behaviour that no caller
 * asks for, and the next reader would reasonably assume the accessor matters.
 * Disposition belongs with the other delete-or-wire decisions (`actorFor`,
 * `assertCanPublish`, `listMemberships`, `clearSessionCookieInAction`, …), which
 * need a production mandate rather than a test. Recorded here so the `hits=0` on
 * that line is not re-opened as a gap: it was measured, and it is a dead accessor
 * beside two live ones.
 */
describe('createJoinPaymentPort — the route’s entry point is the real port', () => {
  async function factoryPort() {
    const { createJoinPaymentPort } = await import('../real-payment-port');
    return createJoinPaymentPort();
  }

  it('returns a port that reaches the wire, so a fake in its place cannot pass', async () => {
    // The load-bearing assertion. Mutating the factory to return
    // `fakeJoinPaymentPort()` makes `recorded` stay empty here, because the fake
    // answers from a Map and never opens a socket — and `intentPost()` then fails on
    // the empty recording rather than on a missing assertion.
    const port = await factoryPort();
    expect(recorded).toHaveLength(0);

    const outcome = await port.createJoinAuthorisation(request());

    const post = intentPost();
    expect(post.headers['stripe-account']).toBe('acct_wire');
    // The id came from the server, not from the fake's module-scope counter.
    expect(outcome).toEqual({
      status: 'AUTHORIZED',
      paymentIntentId: 'pi_wire_recorded',
      providerStatus: 'requires_capture',
    });
  });

  it('sends the same body as realJoinPaymentPort, so it is a delegation and not a copy', async () => {
    // The factory is one line today (`return realJoinPaymentPort()`). The risk it
    // carries is drifting into a *near* copy — a second authorisation call site that
    // forgets `capture_method`, or sends the platform account instead of the
    // merchant's. Comparing the two recorded bodies pins delegation rather than
    // asserting the source text, which cannot see a re-implemented body.
    const direct = await loadPort();
    await direct.createJoinAuthorisation(request({ participantId: 'participant_direct' }));
    const fromFactory = await factoryPort();
    await fromFactory.createJoinAuthorisation(request({ participantId: 'participant_factory' }));

    const posts = recorded.filter(
      (entry) => entry.method === 'POST' && entry.path.startsWith('/v1/payment_intents'),
    );
    expect(posts).toHaveLength(2);

    const [first, second] = posts as [Recorded, Recorded];
    // Same fields, same values except the participant the two calls differ on.
    expect(Object.keys(second.form).sort()).toEqual(Object.keys(first.form).sort());
    expect({ ...second.form, 'metadata[participantId]': 'participant_direct' }).toEqual(
      first.form,
    );
    // And the value that must never differ into 'automatic'.
    expect(second.form.capture_method).toBe('manual');
    expect(second.headers['stripe-account']).toBe(first.headers['stripe-account']);
  });

  it('exposes nothing but the two interfaces — no testing surface on the production port', async () => {
    // `FakeJoinPaymentPort` adds `calls`, `authorisedCount`,
    // `authorisedTotalCents` and `authorisedParticipantIds`. Enumerating the keys
    // is what distinguishes the two even without a network call: a port carrying
    // those is a fake, and the route would be holding nothing. The production
    // port now has exactly two methods — the write and the read-only
    // reconciliation seam — and no observation hooks.
    const port = await factoryPort();

    expect(Object.keys(port).sort()).toEqual([
      'createJoinAuthorisation',
      'findJoinAuthorisation',
    ]);
  });

  it('throws StripeNotConfiguredError when no key is present, rather than falling back to a fake', async () => {
    // Unreachable from the route — `route.ts:142` returns 503 *before* the dynamic
    // import, and `route.test.ts:464` proves that ordering with `portCalls === 0`.
    // So this branch is not defended by the route. It is defended here, because the
    // factory is also reachable directly (it is exported, and the docblock says the
    // route is only its *first* caller), and a fallback to the fake would be exactly
    // the silent failure the route's 503 is written to prevent.
    delete process.env.STRIPE_SECRET_KEY;

    const { createJoinPaymentPort, realJoinPaymentPort } = await import('../real-payment-port');
    const { StripeNotConfiguredError } = await import('@/lib/payments/connect-port');

    await expect(createJoinPaymentPort()).rejects.toThrow(StripeNotConfiguredError);
    expect(() => realJoinPaymentPort()).toThrow(StripeNotConfiguredError);
    // And nothing was sent. A throw *after* an HTTP call would still be a leak.
    expect(recorded).toHaveLength(0);
  });

  it('refuses a key-shaped string that is not a Stripe key', async () => {
    // `isStripeConfigured()` requires an `sk_` / `rk_` prefix. A key that merely
    // exists — a placeholder, a secret pasted from another service — must not be
    // treated as configuration, or the port is handed to `forMerchant()` and fails
    // at the SDK with an error nobody classified.
    process.env.STRIPE_SECRET_KEY = 'stripe-key-goes-here';

    const { createJoinPaymentPort } = await import('../real-payment-port');
    const { StripeNotConfiguredError } = await import('@/lib/payments/connect-port');

    await expect(createJoinPaymentPort()).rejects.toThrow(StripeNotConfiguredError);
    expect(recorded).toHaveLength(0);
  });
});
