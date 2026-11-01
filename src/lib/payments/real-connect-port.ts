import 'server-only';

import { logger } from '@/lib/logging/logger';
import { prisma } from '@/lib/db/prisma';

import {
  type ConnectPort,
  StripeNotConfiguredError,
} from './connect-port';
import { isStripeConfigured, platform, toAppError } from './stripe';

/**
 * The real Connect port. The only file in the onboarding path that imports the
 * Stripe SDK.
 *
 * Three structural guarantees, each of which is a bug avoided:
 *
 *   1. **Account lifecycle goes through `platform()`**, because creating an
 *      account is a platform operation — there is no account yet to scope to.
 *   2. **Nothing here creates a charge.** Charges are direct and belong on
 *      `forMerchant(accountId)`; mixing the two in one factory is how a
 *      destination charge gets written by accident (ADR-001 §3.3).
 *   3. **A missing key throws `StripeNotConfiguredError`**, not a generic 500, so
 *      the UI can say "payments aren't configured yet" instead of "something
 *      went wrong".
 */

export function realConnectPort(): ConnectPort {
  if (!isStripeConfigured()) {
    throw new StripeNotConfiguredError();
  }

  return {
    async createAccount({ email, businessName }) {
      try {
        const account = await platform().accounts.create({
          type: 'express',
          country: 'CA',
          email,
          business_profile: { name: businessName },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: { source: 'groupeat' },
        });
        return { id: account.id, email: account.email ?? null };
      } catch (error) {
        throw toAppError(error);
      }
    },

    async createAccountLink({ accountId, refreshUrl, returnUrl }) {
      try {
        const link = await platform().accountLinks.create({
          account: accountId,
          refresh_url: refreshUrl,
          return_url: returnUrl,
          type: 'account_onboarding',
        });
        return { url: link.url, expiresAt: link.expires_at };
      } catch (error) {
        throw toAppError(error);
      }
    },

    async getAccount(accountId) {
      try {
        const account = await platform().accounts.retrieve(accountId);
        return {
          id: account.id,
          charges_enabled: account.charges_enabled ?? false,
          payouts_enabled: account.payouts_enabled ?? false,
          details_submitted: account.details_submitted ?? false,
          // Stripe exposes `disabled_reason` only on `requirements` for a
          // retrieved account; there is no top-level field to read. Passing it
          // through here (rather than leaving it null) is what lets
          // `assessOnboarding()` distinguish ACTION_REQUIRED from INCOMPLETE.
          disabled_reason: account.requirements?.disabled_reason ?? null,
          requirements: {
            currently_due: account.requirements?.currently_due ?? [],
            past_due: account.requirements?.past_due ?? [],
            disabled_reason: account.requirements?.disabled_reason ?? null,
          },
        };
      } catch (error) {
        throw toAppError(error);
      }
    },
  };
}

/**
 * Orphan-account detection for ops.
 *
 * An account created here but never linked to a merchant is money-adjacent
 * garbage: Stripe charges for nothing, but the account holds a real identity
 * record. Called manually from ops tooling, not on a schedule in V1.
 */
export async function findMerchantByAccountId(accountId: string): Promise<string | null> {
  const merchant = await prisma.merchant.findUnique({
    where: { stripeAccountId: accountId },
    select: { id: true },
  });
  if (!merchant) {
    logger.warn('stripe.webhook_rejected', { reason: 'unknown_account' });
  }
  return merchant?.id ?? null;
}
