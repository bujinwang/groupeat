import type { StripeAccountSnapshot } from '@/lib/payments/onboarding';

/**
 * The Connect port — the seam that lets the onboarding flow be tested without
 * Stripe, a key, or a network.
 *
 * ## Why a port rather than calling the SDK from the orchestration
 *
 * FR-102's flow is a **sequence with a state transition in it**: create-or-reuse
 * an account, mint a single-use link, then later re-read the account and persist
 * whatever it now says. The interesting bugs are not in the HTTP calls, they are
 * in the sequencing — reusing an account instead of creating a second one,
 * not persisting the account id before minting the link, flipping a merchant to
 * ACTIVE and then back.
 *
 * Every one of those is testable in milliseconds against a fake. Against the
 * real API they need an account, a network and a signed-in human, so in practice
 * they would not be tested at all. `realPort()` in `./real-port.ts` is the only
 * file that imports the SDK.
 */

export type ConnectAccount = {
  id: string;
  /** The account's own email, for the onboarding UI. Not a separate fetch. */
  email: string | null;
};

export interface ConnectPort {
  /** Creates an Express account. Throws on a Stripe error. */
  createAccount(input: { email: string; businessName: string }): Promise<ConnectAccount>;

  /**
   * Mints a fresh account link. **Single-use and short-lived** — a "resume
   * onboarding" button must mint a new one every time rather than reusing the
   * URL it showed last week.
   */
  createAccountLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: number }>;

  /** The subset of the account that `assessOnboarding()` reads. */
  getAccount(accountId: string): Promise<StripeAccountSnapshot>;
}

/** Thrown when the environment has no Stripe key. Routes turn this into a 503. */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      'Card payments are not configured on this server. Set STRIPE_SECRET_KEY to enable onboarding.',
    );
    this.name = 'StripeNotConfiguredError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isStripeNotConfigured(error: unknown): error is StripeNotConfiguredError {
  return error instanceof StripeNotConfiguredError;
}
