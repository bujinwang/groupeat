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
 *
 * **Dated correction — 2026-11-12.** For all three guarantees above, the only
 * evidence used to be this comment. Measured with
 * `vitest --coverage.include='src/lib/payments/*.ts'`: **7.35 % statements,
 * 20 % functions, uncovered 33-109** — of five functions only `realConnectPort()`
 * itself ran, i.e. the `isStripeConfigured()` guard. Every Stripe call, every field
 * it sends, and every mapping it performs was dead code to the suite. The cause is
 * structural: `onboarding-service.ts` reaches this module by dynamic `import()` so
 * `server-only` does not throw under Vitest, so the DB-backed tests inject a fake;
 * the four route/page suites mock either `onboarding-service` or this module
 * wholesale. `real-connect-port.wire.test.ts` now executes all three operations
 * against an in-process `node:http` recorder. Coverage after: **85.29 % statements,
 * 100 % branches, 80 % functions**, with the residual 15 % being exactly the
 * uncalled `findMerchantByAccountId` below. Fifteen deliberate mutations of this
 * file — including `disabled_reason -> null`, each `?? false -> ?? true`,
 * `platform() -> forMerchant()`, `account_onboarding -> account_update`, and a
 * dropped `transfers` capability — each killed at least one test. Two controls
 * (a hardcoded snapshot `id`, and reordering `currently_due`) correctly stayed
 * green, because `assessOnboarding()` normalises both downstream.
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
 * record.
 *
 * **Correction — 2026-11-12.** This used to say "Called manually from ops tooling,
 * not on a schedule in V1". Measured: there is **no caller anywhere in the repo**.
 * A repo-wide grep excluding `node_modules`/`.git`/`.next` finds three references:
 * this definition, a mock in `app/api/webhooks/stripe/__tests__/route.test.ts`
 * that deliberately throws "not reachable from the webhook", and a comment. The
 * webhook has its **own inline copy** of this lookup at `route.ts:68`, including
 * the same `logger.warn('stripe.webhook_rejected', { reason: 'unknown_account' })`.
 * So the statement was a claim about intent written as a fact about wiring.
 *
 * This is the residual 15 % of the file's statement coverage. It is left in place
 * deliberately: it is exported, and deleting an exported symbol is a production
 * change this test work has no mandate to make. Two options remain open — wire the
 * webhook to it so the lookup exists once, or delete it and its mock. Neither is
 * claimed done here.
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
