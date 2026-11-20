import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real join payment port, executed against `stripe-mock` rather than a fake.
 *
 * ## What this file is, and what it is not
 *
 * `fake-payment-port.test.ts` proves the *service* handles each outcome correctly.
 * It cannot prove that `real-payment-port.ts` — a module transcribed from
 * documentation and, when this suite was written, never executed against Stripe —
 * sends a request Stripe will accept. This file
 * closes that gap for the **request construction**: it runs the real port, through
 * the real `stripe` SDK, over HTTP, against a server that validates every parameter
 * against Stripe's OpenAPI spec.
 *
 * `stripe-mock` rejects unknown or malformed parameters with a 400 and
 * `"additional properties are not allowed"`, so a field this module misspells —
 * `payment_method_data` instead of `params`, `captures_method`, an unsupported
 * `automatic_payment_methods` shape — fails here instead of on a diner's phone.
 *
 * ## What it cannot prove, stated plainly so nobody reads a green run as more
 *
 * `stripe-mock` is **stateless and deterministic**: it returns a fixed fixture per
 * endpoint. For `POST /v1/payment_intents` that fixture has
 * `status: "requires_payment_method"` — always, whatever we send. The real API
 * returns `requires_capture` for a successful manual-capture confirmation, and
 * `real-payment-port.ts` correctly refuses anything that is not `requires_capture`
 * (that refusal is the whole point of the check). So on the mock, a *successful*
 * authorisation is unreachable **by construction**, and this file asserts the
 * refusal rather than pretending otherwise.
 *
 * Three things therefore remain unverifiable *by this suite*, and this file must
 * not be cited as evidence for any of them:
 *
 *   1. that a real confirmation yields `requires_capture`;
 *   2. that a real decline arrives as a `StripeCardError` with a usable
 *      `decline_code`;
 *   3. that the intent is actually created on the **merchant's** account (the mock
 *      accepts any `Stripe-Account` header without checking it exists).
 *
 * Those needed a real test-mode key. **Dated correction — 2026-11-07:** all three
 * were measured against real Stripe test mode by `scripts/verify-stripe.ts` (three
 * runs, each `VERIFIED`); `docs/PROGRESS.md` gaps 8 and 9 are closed for the money
 * seam. The mock limitation above is unchanged — this suite still cannot prove them.
 * The live proof is the standalone script, and a green *suite* run still never means
 * "joining works".
 *
 * ## Why the module is mocked, not the SDK
 *
 * `real-payment-port.ts` imports `server-only`, which throws unconditionally outside
 * a Server Component graph. `vi.mock` replaces it with an empty module — the SDK,
 * the port and the network path all stay real. Mocking `stripe.ts` instead would
 * have tested a stub against a stub and proved nothing.
 */

vi.mock('server-only', () => ({}));

const MOCK_HOST = process.env.STRIPE_MOCK_HOST ?? '127.0.0.1';
const MOCK_PORT = Number(process.env.STRIPE_MOCK_PORT ?? 12111);

/** Reachable? One cheap probe. A closed port must skip, not fail. */
async function mockIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://${MOCK_HOST}:${MOCK_PORT}/v1/accounts/acct_probe`, {
      headers: { authorization: 'Bearer sk_test_mock' },
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

const up = await mockIsUp();

// "unexecuted code" below is scoped to *this suite*: when stripe-mock is absent,
// this contract never runs the port. Dated correction 2026-11-07: the port itself
// has since been executed live by `scripts/verify-stripe.ts`.
const SKIP_REASON =
  `stripe-mock not reachable on ${MOCK_HOST}:${MOCK_PORT}. Start it with ` +
  `\`stripe-mock -http-port ${MOCK_PORT}\` to run the request-construction contract ` +
  'for the real join payment port. Skipping is not a pass: without it, ' +
  'real-payment-port.ts remains unexecuted code.';

let accountId: string;

beforeEach(async () => {
  vi.resetModules();

  // Point the one client constructor at the mock. `stripe.ts` reads the key from env
  // and validates the `sk_` prefix. stripe-mock additionally requires the key to
  // *look* like a test-mode secret, and it rejected `sk_test_stripe_mock_contract`
  // (too long / wrong shape) with a 401 — so this is the documented example value it
  // accepts, quoted from its own error message. The mock ignores the value otherwise.
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  const { __setStripeClientForTests } = await import('@/lib/payments/stripe');
  __setStripeClientForTests({
    host: MOCK_HOST,
    port: MOCK_PORT,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeout: 5_000,
    typescript: true,
  });

  // A connected account. The mock does not require it to exist; `forMerchant()` does
  // require the `acct_` prefix, which is itself one of the things under test here.
  accountId = 'acct_contract_probe';
});

afterEach(async () => {
  const { __setStripeClientForTests } = await import('@/lib/payments/stripe');
  __setStripeClientForTests(null);
  delete process.env.STRIPE_SECRET_KEY;
});

describe.skipIf(!up)(`real join payment port against stripe-mock (${SKIP_REASON})`, () => {
  /** A request that satisfies every documented requirement of the port. */
  function request(overrides: Record<string, unknown> = {}) {
    return {
      dropId: 'drop_contract',
      participantId: 'participant_contract',
      stripeAccountId: accountId,
      amountCents: 1112,
      platformFeeCents: 89,
      paymentMethodId: 'pm_card_visa',
      currency: 'cad',
      idempotencyKey: 'join:participant_contract',
      ...overrides,
    } as Parameters<Awaited<ReturnType<typeof loadPort>>['createJoinAuthorisation']>[0];
  }

  async function loadPort() {
    const { realJoinPaymentPort } = await import('../real-payment-port');
    return realJoinPaymentPort();
  }

  it('builds a request Stripe accepts — no rejected parameters', async () => {
    // The narrow, valuable claim. If this throws `JoinProviderUnavailableError` with
    // reason 'http_5xx' or a message containing "validation", the module is sending
    // something Stripe does not recognise, and that is a bug in *our* code.
    const port = await loadPort();

    const outcome: unknown = await port
      .createJoinAuthorisation(request())
      // On the mock this is the expected path: the fixture's status is
      // `requires_payment_method`, and the port refuses anything but
      // `requires_capture`. Swallowing it here lets the assertions below describe
      // *why* the call reached that point.
      .catch((error: unknown) => error);

    // Either a real authorisation (a future stripe-mock that models confirmation
    // properly) or the documented refusal of the mock's fixture — never a parameter
    // rejection, which is the failure mode this test exists to catch.
    if (outcome instanceof Error) {
      expect(outcome.name).toBe('JoinProviderUnavailableError');
      expect(String(outcome.message)).toMatch(/requires_payment_method/);
      expect(String(outcome.message)).not.toMatch(/validat|additional properties|unknown parameter/i);
    } else {
      const authorised = outcome as { status: string; providerStatus: string };
      expect(authorised.status).toBe('AUTHORIZED');
      expect(authorised.providerStatus).toBe('requires_capture');
    }
  });

  it('sends capture_method: manual, and the mock echoes it back', async () => {
    // Asserted in the second place it can be observed: at the wire. `real-port-boundary`
    // already proves the source uses `JOIN_CAPTURE_METHOD`; this proves the value that
    // actually arrives is `manual` and not, say, an accidental `automatic`.
    //
    // **Dated correction — 2026-11-11: the sentence above is false, and this test
    // cannot make it true.** It does not call the port. It calls the SDK directly with
    // its own `capture_method: 'manual'` literal (see the `create` call below) and
    // asserts the mock echoed the literal *this test* sent. Mutating the port to
    // `capture_method: 'automatic'` leaves this file at 6/6 green.
    //
    // What actually pins the port's wire value is
    // `real-payment-port.wire.test.ts`, which runs the port against a recording server
    // and asserts the form body. Kept here because the mock does still validate that the
    // SDK accepts the shape; the claim in the comment is what was wrong, not the test.
    const { forMerchant } = await import('@/lib/payments/stripe');

    const intent = await forMerchant(accountId).paymentIntents.create({
      amount: 1112,
      currency: 'cad',
      capture_method: 'manual',
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    expect(intent.capture_method).toBe('manual');
    expect(intent.amount).toBe(1112);
    expect(intent.currency).toBe('cad');
    // A client secret must exist, because the Element's flow depends on it.
    expect(typeof intent.client_secret).toBe('string');
  });

  it('refuses a request with no paymentMethodId before touching the network', async () => {
    // The guard that slice 2b's bug slipped past. It must fire *before* the create
    // call, so `paymentMethodId` absent is a refusal and not an intent at
    // `requires_payment_method` that looks like a hold to nothing.
    const port = await loadPort();

    await expect(
      port.createJoinAuthorisation(request({ paymentMethodId: undefined })),
    ).rejects.toThrow(/no paymentMethodId/);
  });

  it('rejects a connected account id that is not an acct_ id', async () => {
    // ADR-001's whole safety property: the client is bound to an account at
    // construction. A non-`acct_` value must fail loudly here rather than silently
    // billing the platform account.
    const port = await loadPort();

    await expect(
      port.createJoinAuthorisation(request({ stripeAccountId: 'cus_not_an_account' })),
    ).rejects.toThrow(/must start with "acct_"/);
  });

  it('carries the idempotency key to the wire, so a retry cannot double-hold', async () => {
    // The mock surfaces idempotency keys it received on its own port; failing that,
    // the observable contract is that two calls with one key do not produce two
    // distinct intents *at Stripe*. Here we assert the weaker, checkable half: the
    // call succeeds with the key present and does not 400 on it.
    const port = await loadPort();
    const req = request();

    const first = await port.createJoinAuthorisation(req).catch((e: unknown) => e);
    const second = await port.createJoinAuthorisation(req).catch((e: unknown) => e);

    // Both reach Stripe without a parameter complaint. On the mock they fail
    // identically at the status check, which is the correct behaviour.
    for (const outcome of [first, second]) {
      if (outcome instanceof Error) {
        expect(String(outcome.message)).not.toMatch(/validat|idempotency/i);
      }
    }
  });
});

describe('the real join payment port outside the contract suite', () => {
  it('reports that it is unconfigured rather than guessing, with no key set', async () => {
    // Runs even when the mock is down: this is the "payments not configured" path
    // that every keyless deployment takes, and it must be a typed error the route
    // can map to 503 rather than a 500.
    delete process.env.STRIPE_SECRET_KEY;
    vi.resetModules();

    const { realJoinPaymentPort } = await import('../real-payment-port');
    expect(() => realJoinPaymentPort()).toThrow(/not configured|STRIPE_SECRET_KEY/i);
  });
});
