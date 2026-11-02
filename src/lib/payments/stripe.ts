import Stripe from 'stripe';

import { AppError } from '@/lib/errors';

/**
 * The one place a Stripe client is constructed.
 *
 * ## Why every call is account-scoped by construction
 *
 * ADR-001 chose **direct charges**, which means the `PaymentIntent`, the
 * `Charge`, the balance and the disputes all live on the **connected account**,
 * not on ours. Consequence: a call made with the platform client and no
 * `{ stripeAccount }` option does not fail — it succeeds against the wrong
 * account. The worst version of that bug is a refund issued on the platform
 * account for a charge that exists only on the merchant's, which Stripe rejects
 * with a confusing "no such charge" and which a merchant experiences as
 * "GroupEat cannot refund my customer".
 *
 * So this module exposes **two** things and no third:
 *
 *   - `platform()` — for account lifecycle and webhook signature checks, the only
 *     operations that legitimately run on the platform account;
 *   - `forMerchant(accountId)` — everything money-touching, which returns a client
 *     pre-bound to the connected account so a caller cannot forget the option.
 *
 * Never `new Stripe(...)` outside this file.
 */

let client: Stripe | null = null;

/**
 * A base configuration injected by a suite, used by **both** `platform()` and
 * `forMerchant()`.
 *
 * ## Why this had to be fixed, and what the old version did
 *
 * This seam originally replaced only `platform()`. `forMerchant()` constructs a fresh
 * client on every call (deliberately — see below), so it ignored the stub entirely
 * and went to the real `api.stripe.com` over the network. A contract test written
 * against `stripe-mock` therefore reached the live API instead of the mock, and the
 * failure it produced was a 401 on a fake key rather than anything to do with the
 * code under test.
 *
 * That is worth stating precisely, because the old docblock claimed this seam "lets a
 * suite inject a stub without touching env or the network". For the one method that
 * moves money, that claim was false. It is true now.
 *
 * ## Why configuration rather than a client instance
 *
 * The first fix tried to read the injected instance's private `_config`. In
 * `stripe@23` that field is not populated — the options live on `_api` and friends —
 * so the spread produced `{}` and the call still went to production. Depending on
 * private fields across SDK minor versions is how a test suite starts lying.
 *
 * So a suite injects the *options* instead, and `forMerchant()` builds a
 * genuinely account-scoped client from them. ADR-001's property — every
 * money-touching call carries `stripeAccount` at construction — is preserved
 * exactly rather than bypassed, which is the point: a test stub that skipped
 * `stripeAccount` would stop testing the thing that makes the design safe.
 */
let injectedBase: Stripe.StripeConfig | null = null;

/**
 * Test seam: injects base client options (host, port, protocol, retries) so a suite
 * can point both `platform()` and `forMerchant()` at a local server without touching
 * env or the network.
 */
export function __setStripeClientForTests(base: Stripe.StripeConfig | null): void {
  injectedBase = base;
  client = base === null ? null : null;
}

function secretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw AppError.badRequest(
      'Card payments are not configured on this server. Set STRIPE_SECRET_KEY.',
    );
  }
  if (!key.startsWith('sk_') && !key.startsWith('rk_')) {
    // A publishable key here would fail later with a confusing 401 from Stripe.
    throw AppError.badRequest('STRIPE_SECRET_KEY must be a secret or restricted key.');
  }
  return key;
}

/**
 * Client options, with a suite's injected base merged on top.
 *
 * `apiVersion` is deliberately NOT set. Omitting it pins the account's configured
 * version, which is what the SDK was built against; passing a literal instead picks
 * up Stripe's most recent release the moment the SDK is upgraded, and `tsc` rejects
 * any string that is not the SDK's exact current one (which is how this line read
 * `2025-08-27.basil` against a package that ships `2026-10-28.endive`). Pin
 * deliberately in the Dashboard, not here.
 */
function baseConfig(): Stripe.StripeConfig {
  const defaults: Stripe.StripeConfig = {
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 20_000,
  };
  return injectedBase ? { ...defaults, ...injectedBase } : defaults;
}

/**
 * The platform-account client.
 *
 * Only for: creating connected accounts, creating account links, retrieving an
 * account, and verifying webhook signatures. It must never create a charge.
 */
export function platform(): Stripe {
  if (client) {
    return client;
  }
  client = new Stripe(secretKey(), baseConfig());
  return client;
}

/**
 * A client bound to one connected account.
 *
 * Uses a per-account instance rather than passing the option on each call: with
 * `stripeAccount` set at construction, **every** method on the returned object
 * carries it, including the ones a caller reaches for without thinking
 * (`refunds.create`, `balanceTransactions.retrieve`). The alternative — a
 * convention that every call site remembers `{ stripeAccount }` — is the class of
 * bug this file exists to make impossible.
 */
export function forMerchant(stripeAccountId: string): Stripe {
  if (!stripeAccountId.startsWith('acct_')) {
    throw new Error(
      `Connected account id must start with "acct_"; received "${stripeAccountId}".`,
    );
  }

  // A suite has injected a base configuration: build the account-scoped client from
  // it, so `stripeAccount` stays set and the test talks to whatever host the suite
  // pointed at (stripe-mock, usually) rather than production. Production never sets
  // `injectedBase`.
  return new Stripe(secretKey(), {
    ...baseConfig(),
    stripeAccount: stripeAccountId,
  });
}

/** True when Stripe is configured. Used to render setup notices instead of 500s. */
export function isStripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  return typeof key === 'string' && (key.startsWith('sk_') || key.startsWith('rk_'));
}

/** True when the configured key is a test-mode key. Guarded in §6 of ADR-001. */
export function isTestMode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  return key.startsWith('sk_test_') || key.startsWith('rk_test_');
}

/**
 * Maps a Stripe error to the app's error type.
 *
 * Two rules: a card decline is a **422 with a message the diner can act on**
 * (their card, not our bug), and everything else is a 502 — the failure is
 * upstream and retryable, and it must not be reported as the diner's fault.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof Stripe.errors.StripeCardError) {
    // Stripe's decline message is written for cardholders and is safe to show.
    return new AppError(422, error.message);
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return new AppError(422, 'That payment could not be set up. Check the details and try again.');
  }
  if (error instanceof Stripe.errors.StripeAuthenticationError) {
    return new AppError(500, 'Card payments are misconfigured on this server.');
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return new AppError(502, 'We could not reach the payment provider. Try again.');
  }
  return new AppError(502, 'The payment provider did not respond as expected. Try again.');
}
