import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/lib/settlement/real-charge-port.ts` — the last zero-execution file that
 * contains a **safety branch** rather than only types.
 *
 * ## Why this file exists at all
 *
 * A V8 coverage run over the full suite found eight source files with zero
 * executed statements. Four are pure types, a re-export barrel or a wire-shape
 * file with nothing to run; four were runtime code, and the OpenGraph card plus
 * the two error pages and `instrumentation.ts` now have suites. This is the
 * fifth file, and it is the only one of the remainder whose *guard* matters:
 *
 * > ADR-001 §3.2, quoted in the module's own docblock: every call is scoped to
 * > the connected account via `forMerchant()`, because a capture on the platform
 * > account "does not fail loudly — it succeeds against the wrong account."
 *
 * `realChargePort()`'s first statement is the thing that keeps that promise
 * honest when no key is present: it **throws** `StripeNotConfiguredError`
 * instead of returning a port that would fall back to the platform. That branch
 * needs no network and no key — only the absence of one — so it can be proved
 * here, today, while the Stripe-touching half remains genuinely unproven.
 *
 * ## What this proves, and what it does not
 *
 * It proves the refusal: with no key, or a key that is not a Stripe key, the
 * factory throws the typed error and never constructs a port. It does **not**
 * prove capture, void or refund against Stripe — that is
 * `real-charge-port.live.test.ts`, which skips with a named reason, and today's
 * answer to "does capture work against Stripe?" is still **nobody knows**. This
 * suite must never be read as closing that gap; it closes the narrower one.
 *
 * ## What is replaced
 *
 * Only `server-only`, which throws outside a React Server Component graph. The
 * real `realChargePort`, the real `isStripeConfigured()` (it reads
 * `process.env` directly, and stubbing it would remove the only code that
 * decides whether a deployment can take money) and the real
 * `StripeNotConfiguredError` all execute.
 */

vi.mock('server-only', () => ({}));

const { realChargePort } = await import('../real-charge-port');
const { StripeNotConfiguredError } = await import('@/lib/payments/connect-port');

describe('realChargePort · the refusal that keeps a missing key from becoming the wrong account', () => {
  const saved = { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY };

  afterEach(() => {
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  });

  it('throws a typed refusal when STRIPE_SECRET_KEY is absent', async () => {
    /**
     * The absent case is the one a fresh checkout is in. A factory that returned
     * a port here would hand the first capture the platform account — the exact
     * wrong-account failure that succeeds silently. Asserted against the real
     * error CLASS, not a message string, because callers branch on the type
     * (`isStripeNotConfigured`), and a message edit must not fake a pass.
     */
    delete process.env.STRIPE_SECRET_KEY;

    expect(() => realChargePort()).toThrow(StripeNotConfiguredError);
    let caught: unknown;
    try {
      realChargePort();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StripeNotConfiguredError);
    // The message names the variable to set — a developer's only next step from a
    // boot-time refusal — and names the secret itself, never a value.
    expect((caught as Error).message).toContain('STRIPE_SECRET_KEY');
  });

  it('refuses a key that is not a Stripe key, rather than treating "set" as "configured"', async () => {
    /**
     * `isStripeConfigured()` requires an `sk_`/`rk_` prefix. This pins that the
     * factory inherits that check and does not merely test for a non-empty
     * string: a placeholder like `changeme` in a stray `.env` must still refuse,
     * or a misconfigured machine would attempt a live capture with a bogus key
     * and fail at the diner's expense instead of at boot.
     */
    process.env.STRIPE_SECRET_KEY = 'changeme';

    expect(() => realChargePort()).toThrow(StripeNotConfiguredError);
  });

  it('does NOT throw once a syntactically valid key is present', async () => {
    /**
     * The other direction, and the reason this is a refusal test and not a
     * "always throws" test: with a well-formed `sk_test_` key the factory must
     * return a port. No network call is made — `realChargePort()` only builds the
     * object, and capture/void/refund are lazy — so this runs keyless-safe with a
     * fake key. If the guard were inverted or the prefix check wrong, this fails.
     */
    process.env.STRIPE_SECRET_KEY = 'sk_test_not-a-real-key-only-for-the-guard';

    const port = realChargePort();
    expect(port).toBeTypeOf('object');
    // The three operations the port promises, so a port returning `{}` fails here
    // rather than at the first capture.
    expect(port.capture).toBeTypeOf('function');
    expect(port.voidAuthorization).toBeTypeOf('function');
    expect(port.refund).toBeTypeOf('function');
  });
});
