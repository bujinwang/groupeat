import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * What `real-connect-port.ts` actually puts on the wire — recorded, not inferred.
 *
 * ## The hole this file exists to close, measured
 *
 * Not guessed: `vitest --coverage.include='src/lib/payments/*.ts'` reported
 *
 * ```
 * real-connect-port.ts  |  7.35 % stmts  |  50 % branch  |  20 % funcs  |  uncovered 33-109
 * ```
 *
 * Of five functions only one executes — `realConnectPort()` itself, i.e. the
 * `isStripeConfigured()` guard. **Every Stripe call, every field it sends, and every
 * mapping it performs was dead code as far as the suite was concerned.** The reason is
 * structural rather than sloppy: `onboarding-service.ts` reaches the port through a
 * dynamic `import()` so that `server-only` does not explode under Vitest, which means
 * tests inject a fake and the real module is never loaded. The four route/page suites
 * either mock `onboarding-service` wholesale or replace `real-connect-port` with an
 * object literal.
 *
 * ## The specific failures this file was written to catch
 *
 * The module's own docblock claims three guarantees. Two of them were asserted nowhere.
 *
 * **The silent one is `disabled_reason`.** Lines 75-84 pass
 * `account.requirements.disabled_reason` through to *both* the top-level field and the
 * nested block, and the comment explains why. Drop that pass-through — return `null`,
 * the obvious "we don't have that field" shortcut — and nothing throws. `assessOnboarding`
 * then takes its `INCOMPLETE` branch instead of `ACTION_REQUIRED`, so a merchant whose
 * verification document Stripe rejected is shown "Payout setup is not finished yet"
 * forever, and a merchant who *was* `READY` and has since been restricted is reported as
 * merely incomplete. The state machine that distinguishes those is 100 % covered; the
 * adapter that feeds it was 7 % covered.
 *
 * **The expensive one is the boolean defaults.** `?? false` reads as boilerplate. Invert
 * one to `?? true` and an account Stripe has not evaluated is treated as
 * `charges_enabled`, which is precisely the "merchant looks ready, every drop fails at
 * capture after diners have been authorised" failure FR-102 exists to prevent.
 *
 * ## Why a recording server rather than stripe-mock
 *
 * Same reason as the other two wire suites: `stripe-mock` is not installed by `npm ci`,
 * so its suite skips in a clean checkout and skipping becomes the default state. This
 * server is `node:http` on port `0`, in the same process. It cannot skip, and it can
 * answer shapes a fixed fixture cannot (`disabled_reason`, omitted booleans, error
 * bodies with specific status codes).
 *
 * ## What this proves, and what it does not
 *
 * **Proves:** the endpoint, method, form fields, and account scope of all three
 * operations; the mapping from a Stripe `Account` to `StripeAccountSnapshot`; that a
 * Stripe error leaves as an `AppError` rather than as the SDK's own class; and that no
 * charge-shaped request is made from here.
 *
 * **Does not prove:** that real Stripe accepts these parameters or returns these
 * shapes. That is `scripts/verify-stripe.ts` against test mode, and a green run here is
 * not a substitute for it.
 */

type Recorded = {
  method: string;
  path: string;
  /** Absent means the platform account; present means a connected account. */
  stripeAccount: string | undefined;
  form: Record<string, string>;
};

const recorded: Recorded[] = [];

type Route = {
  match: (url: URL, method: string) => boolean;
  status?: number;
  body: unknown;
};

let routes: Route[] = [];

/**
 * A response body the Stripe SDK accepts as an Account.
 *
 * Returns an **object**, not a string: the server below serialises once. An earlier
 * draft returned `JSON.stringify(...)` and one call site passed it straight through,
 * which double-encoded it into a JSON *string literal*; the SDK then failed with
 * `Object.defineProperty called on non-object` from inside `RequestSender`. One
 * serialisation point, so that class of mistake cannot recur.
 */
function accountBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct_wire_recorded',
    object: 'account',
    type: 'express',
    country: 'CA',
    email: 'owner@example.test',
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    created: 1794193200,
    ...overrides,
  };
}

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const header = request.headers['stripe-account'];
      const rawBody = Buffer.concat(chunks).toString('utf8');

      recorded.push({
        method: request.method ?? '',
        path: url.pathname,
        stripeAccount: typeof header === 'string' ? header : undefined,
        form: Object.fromEntries(new URLSearchParams(rawBody)),
      });

      const hit = routes.find((candidate) => candidate.match(url, request.method ?? ''));
      const status = hit?.status ?? 200;
      const body = hit ? hit.body : {};

      response.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_cp' });
      response.end(JSON.stringify(body));
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
  routes = [];
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = 'sk_test_connect_recording';

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
  const { realConnectPort } = await import('../real-connect-port');
  return realConnectPort();
}

/** Every request the port made for the given path. */
function hits(path: string): Recorded[] {
  return recorded.filter((entry) => entry.path === path);
}

const ACCOUNT = 'acct_connect_wire';

describe('Connect · createAccount', () => {
  it('creates an Express account for Canada, on the platform account', async () => {
    routes = [
      {
        match: (url) => url.pathname === '/v1/accounts',
        body: accountBody({ email: 'owner@example.test' }),
      },
    ];

    const created = await (await loadPort()).createAccount({
      email: 'owner@example.test',
      businessName: 'Autobebe Kitchen',
    });

    const [request] = hits('/v1/accounts');
    expect(request).toBeDefined();
    expect(request?.method).toBe('POST');
    // Guarantee 1: account creation is a platform operation — there is no account yet
    // to scope to, so a `Stripe-Account` header here would be the bug.
    expect(request?.stripeAccount, 'accounts.create must run on the platform account').toBeUndefined();

    expect(request?.form.type).toBe('express');
    expect(request?.form.country).toBe('CA');
    expect(request?.form.email).toBe('owner@example.test');
    expect(request?.form['business_profile[name]']).toBe('Autobebe Kitchen');

    expect(created).toEqual({ id: 'acct_wire_recorded', email: 'owner@example.test' });
  });

  it('requests both capabilities, which is what makes a drop chargeable', async () => {
    // Dropping either one produces an account that Stripe creates happily and that
    // cannot do the thing we created it for: `card_payments` to charge the diner,
    // `transfers` to pay the merchant. Neither omission errors at creation time.
    routes = [{ match: (url) => url.pathname === '/v1/accounts', body: accountBody() }];

    await (await loadPort()).createAccount({ email: 'a@b.test', businessName: 'X' });

    const form = hits('/v1/accounts')[0]?.form ?? {};
    expect(form['capabilities[card_payments][requested]']).toBe('true');
    expect(form['capabilities[transfers][requested]']).toBe('true');
  });

  it('marks the account as ours in metadata, and sends no charge-shaped field', async () => {
    // `metadata[source]` is what makes an orphaned account findable in the Stripe
    // dashboard. The helper `findMerchantByAccountId` below is *not* a caller — a
    // repo-wide grep found none, and the webhook inlines its own lookup — so no
    // coverage claim here depends on it.
    // The absence assertion is guarantee 2: this file must never create a charge, and
    // on a connected account a stray `destination`/`transfer_data` is how a destination
    // charge gets written by accident (ADR-001 §3.3).
    routes = [{ match: (url) => url.pathname === '/v1/accounts', body: accountBody() }];

    await (await loadPort()).createAccount({ email: 'a@b.test', businessName: 'X' });

    const form = hits('/v1/accounts')[0]?.form ?? {};
    expect(form['metadata[source]']).toBe('groupeat');

    const keys = Object.keys(form).sort();
    expect(keys).toEqual([
      'business_profile[name]',
      'capabilities[card_payments][requested]',
      'capabilities[transfers][requested]',
      'country',
      'email',
      'metadata[source]',
      'type',
    ]);
  });

  it('returns a null email when Stripe omits one, rather than undefined', async () => {
    // The port declares `email: string | null` and the onboarding UI renders it
    // directly. `undefined` would render as the string "undefined".
    routes = [
      {
        match: (url) => url.pathname === '/v1/accounts',
        body: accountBody({ email: undefined }),
      },
    ];

    const created = await (await loadPort()).createAccount({ email: 'a@b.test', businessName: 'X' });

    expect(created.email).toBeNull();
  });
});

describe('Connect · createAccountLink', () => {
  it('mints an account_onboarding link for the given account, on the platform', async () => {
    routes = [
      {
        match: (url) => url.pathname === '/v1/account_links',
        body: {
          object: 'account_link',
          url: 'https://connect.stripe.test/setup/abc',
          expires_at: 1794193500,
          created: 1794193200,
        },
      },
    ];

    const link = await (await loadPort()).createAccountLink({
      accountId: ACCOUNT,
      refreshUrl: 'https://groupeat.test/refresh',
      returnUrl: 'https://groupeat.test/return',
    });

    const [request] = hits('/v1/account_links');
    expect(request?.method).toBe('POST');
    expect(request?.stripeAccount).toBeUndefined();
    expect(request?.form.account).toBe(ACCOUNT);
    // `account_update` is the other valid value, and Stripe accepts it. Using it here
    // produces a link that edits an existing account instead of onboarding one.
    expect(request?.form.type).toBe('account_onboarding');
    expect(request?.form.refresh_url).toBe('https://groupeat.test/refresh');
    expect(request?.form.return_url).toBe('https://groupeat.test/return');

    expect(link).toEqual({ url: 'https://connect.stripe.test/setup/abc', expiresAt: 1794193500 });
  });

  it('sends the two URLs through verbatim, including their query strings', async () => {
    // These come from the route and carry state (merchant id, `?state=return`). A URL
    // assembled or trimmed here would send the merchant back to the wrong page.
    routes = [
      {
        match: (url) => url.pathname === '/v1/account_links',
        body: { object: 'account_link', url: 'https://x.test/l', expires_at: 1 },
      },
    ];

    await (await loadPort()).createAccountLink({
      accountId: ACCOUNT,
      refreshUrl: 'https://groupeat.test/m/42/payouts?state=refresh&step=1',
      returnUrl: 'https://groupeat.test/m/42/payouts?state=return',
    });

    const form = hits('/v1/account_links')[0]?.form ?? {};
    expect(form.refresh_url).toBe('https://groupeat.test/m/42/payouts?state=refresh&step=1');
    expect(form.return_url).toBe('https://groupeat.test/m/42/payouts?state=return');
  });
});

describe('Connect · getAccount', () => {
  it('retrieves the account on the PLATFORM client, not the account-scoped one', async () => {
    // Guarantee 1's read side. Scoping this call to the account itself happens to
    // return the same object, which is exactly why it is worth pinning structurally
    // rather than by observing the result: the habit it forms is what mis-scopes the
    // next call, where the difference does bite.
    routes = [
      {
        match: (url) => url.pathname === `/v1/accounts/${ACCOUNT}`,
        body: accountBody({ id: ACCOUNT }),
      },
    ];

    await (await loadPort()).getAccount(ACCOUNT);

    const [request] = hits(`/v1/accounts/${ACCOUNT}`);
    expect(request?.method).toBe('GET');
    expect(request?.stripeAccount).toBeUndefined();
  });

  it('defaults each missing status flag to false, never to true', async () => {
    // The expensive mistake in this file. `?? true` on any of these makes an account
    // Stripe has not evaluated read as usable, and the failure lands at capture time
    // after diners were told they were in.
    routes = [
      {
        match: (url) => url.pathname === `/v1/accounts/${ACCOUNT}`,
        body: { id: ACCOUNT, object: 'account' },
      },
    ];

    const snapshot = await (await loadPort()).getAccount(ACCOUNT);

    expect(snapshot.charges_enabled).toBe(false);
    expect(snapshot.payouts_enabled).toBe(false);
    expect(snapshot.details_submitted).toBe(false);
    expect(snapshot.disabled_reason).toBeNull();
    expect(snapshot.requirements).toEqual({
      currently_due: [],
      past_due: [],
      disabled_reason: null,
    });
  });

  it('passes requirements.disabled_reason through to BOTH fields', async () => {
    // The silent failure. A `null` here flips `assessOnboarding` from ACTION_REQUIRED
    // to INCOMPLETE, so a rejected document is reported as "not finished yet" forever.
    // Asserted on both the top-level field and the nested block because the docblock
    // promises both, and `assessOnboarding` reads either.
    routes = [
      {
        match: (url) => url.pathname === `/v1/accounts/${ACCOUNT}`,
        body: {
          id: ACCOUNT,
          object: 'account',
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: true,
          requirements: {
            currently_due: ['individual.verification.document'],
            past_due: ['individual.id_number'],
            disabled_reason: 'rejected.fraud',
          },
        },
      },
    ];

    const snapshot = await (await loadPort()).getAccount(ACCOUNT);

    expect(snapshot.disabled_reason).toBe('rejected.fraud');
    expect(snapshot.requirements?.disabled_reason).toBe('rejected.fraud');
    expect(snapshot.requirements?.currently_due).toEqual(['individual.verification.document']);
    expect(snapshot.requirements?.past_due).toEqual(['individual.id_number']);
  });

  it('keeps a fully-enabled account fully enabled', async () => {
    // The control for the defaults above: if every flag were hardcoded false, the
    // previous test would still pass and no merchant would ever publish.
    routes = [
      {
        match: (url) => url.pathname === `/v1/accounts/${ACCOUNT}`,
        body: accountBody({
          id: ACCOUNT,
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        }),
      },
    ];

    const snapshot = await (await loadPort()).getAccount(ACCOUNT);

    expect(snapshot.charges_enabled).toBe(true);
    expect(snapshot.payouts_enabled).toBe(true);
    expect(snapshot.details_submitted).toBe(true);
  });
});

describe('Connect · the error boundary', () => {
  it('turns an invalid request into a 422 AppError, not the SDK error', async () => {
    // Guarantee 3's other half: routes map `AppError` to a status. A raw
    // `StripeInvalidRequestError` escaping here reaches the route's mapper as an
    // unrecognised type and becomes a generic 500 with no safe message.
    routes = [
      {
        match: (url) => url.pathname === '/v1/accounts',
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            message: 'Invalid email address: not-an-email',
            param: 'email',
          },
        },
      },
    ];

    const error = await (await loadPort())
      .createAccount({ email: 'not-an-email', businessName: 'X' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as { name: string }).name).toBe('AppError');
    expect((error as { status: number }).status).toBe(422);
    // The message is ours, not Stripe's: a card-network sentence is never safe by default.
    expect((error as { publicMessage: string }).publicMessage).toBe(
      'That payment could not be set up. Check the details and try again.',
    );
  });

  it('turns a bad key into a 500 AppError on every operation', async () => {
    routes = [
      {
        match: () => true,
        status: 401,
        body: { error: { type: 'authentication_error', message: 'Invalid API Key provided' } },
      },
    ];

    const port = await loadPort();

    for (const call of [
      () => port.createAccount({ email: 'a@b.test', businessName: 'X' }),
      () => port.createAccountLink({ accountId: ACCOUNT, refreshUrl: 'r', returnUrl: 'u' }),
      () => port.getAccount(ACCOUNT),
    ]) {
      const error = await call().catch((caught: unknown) => caught);
      expect((error as { name: string }).name).toBe('AppError');
      expect((error as { status: number }).status).toBe(500);
    }
  });
});

describe('Connect · the scope of this file', () => {
  it('never touches a charge or a payment intent endpoint', async () => {
    // Guarantee 2, asserted across all three operations rather than per-call. ADR-001
    // §3.3: charges are direct and belong on `forMerchant(accountId)`. One factory that
    // does both is how a destination charge gets written by accident.
    routes = [
      { match: (url) => url.pathname === '/v1/accounts', body: accountBody() },
      {
        match: (url) => url.pathname === '/v1/account_links',
        body: { object: 'account_link', url: 'https://x.test/l', expires_at: 1 },
      },
      {
        match: (url) => url.pathname === `/v1/accounts/${ACCOUNT}`,
        body: accountBody({ id: ACCOUNT }),
      },
    ];

    const port = await loadPort();
    await port.createAccount({ email: 'a@b.test', businessName: 'X' });
    await port.createAccountLink({ accountId: ACCOUNT, refreshUrl: 'r', returnUrl: 'u' });
    await port.getAccount(ACCOUNT);

    const chargeShaped = recorded.filter(
      (entry) =>
        entry.path.startsWith('/v1/charges') ||
        entry.path.startsWith('/v1/payment_intents') ||
        entry.path.startsWith('/v1/refunds'),
    );
    expect(chargeShaped).toEqual([]);
    expect(recorded).toHaveLength(3);
  });

  it('refuses to construct at all without a usable key', async () => {
    // Guarantee 3: the named error, so the UI can say "payments aren't configured yet".
    delete process.env.STRIPE_SECRET_KEY;

    const { StripeNotConfiguredError, isStripeNotConfigured } = await import('../connect-port');
    const { realConnectPort } = await import('../real-connect-port');

    const error = (() => {
      try {
        realConnectPort();
        return null;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(StripeNotConfiguredError);
    expect(isStripeNotConfigured(error)).toBe(true);
    // Nothing was attempted: the guard runs before any client is built.
    expect(recorded).toEqual([]);
  });

  it('treats a publishable key as unconfigured rather than as a secret key', async () => {
    // `sk_`/`rk_` only. A `pk_` key here would 401 later, from inside a Stripe call,
    // with a message about authentication rather than about configuration.
    process.env.STRIPE_SECRET_KEY = 'pk_test_looks_valid_but_is_public';

    const { realConnectPort } = await import('../real-connect-port');

    expect(() => realConnectPort()).toThrow(/not configured/i);
  });
});
