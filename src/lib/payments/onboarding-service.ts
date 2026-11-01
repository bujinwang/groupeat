import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logging/logger';
import { prisma } from '@/lib/db/prisma';

import type { ConnectPort } from './connect-port';
import { assessOnboarding, type OnboardingAssessment, type OnboardingState } from './onboarding';

/**
 * Lazily loads the real port, which is the only module that imports
 * `server-only` *and* the Stripe SDK.
 *
 * A static import here would execute `server-only` at module load, which throws
 * outside a React Server Component graph — including under Vitest, which would
 * make this whole file untestable. Deferring it means the seam works (tests
 * inject a fake and never load the real port) while the production path still
 * hard-fails if it is ever reached from a client bundle.
 */
async function resolvePort(injected?: ConnectPort): Promise<ConnectPort> {
  if (injected) {
    return injected;
  }
  const { realConnectPort } = await import('./real-connect-port');
  return realConnectPort();
}

/**
 * FR-102 — Stripe Connect onboarding orchestration.
 *
 * The route handlers are thin; the sequencing lives here so it can be tested with
 * a fake port. Four rules, each with a failure it prevents:
 *
 *   1. **Create the account at most once per merchant.**
 *      A merchant who abandons onboarding and comes back must resume the *same*
 *      account. Creating a second one silently orphans the first, with a real
 *      identity record attached to it and no merchant pointing at it.
 *
 *   2. **Persist the account id before minting the link.**
 *      If the link is minted first and the write fails, the merchant completes
 *      onboarding into an account nothing references — they are "done" and we
 *      cannot find them. Write first, link second.
 *
 *   3. **Mint a link every time.** Stripe account links are single-use and
 *      short-lived; a stored URL is a dead URL.
 *
 *   4. **`onboardingComplete` is derived, never asserted.**
 *      Only `assessOnboarding()` decides, and the status write happens here in
 *      the same call that reads the account, so there is no window in which the
 *      merchant row disagrees with Stripe.
 *
 * The port is a parameter with a default so production calls omit it and tests
 * inject a fake.
 *
 * No `server-only` here, for the same reason `lib/db/prisma.ts` and
 * `lib/db/merchants.ts` omit it: this module is imported by the DB-backed test
 * suite under Vitest, and `server-only` throws outside a React Server Component
 * graph. The runtime boundary is held by `realConnectPort()`, which *does* import
 * `server-only`, so nothing here can reach the network from a client bundle.
 */

export type OnboardingLinkResult = {
  url: string;
  accountId: string;
  /** True when the merchant asked to resume and the account already existed. */
  reusedAccount: boolean;
};

/** Owner email for the Stripe account, or the reason there isn't one. */
async function ownerEmailFor(merchantId: string): Promise<string> {
  const owner = await prisma.merchantUser.findFirst({
    where: { merchantId, role: 'OWNER' },
    select: { user: { select: { email: true } } },
  });
  const email = owner?.user.email;
  if (!email) {
    // Not a 4xx: this is a seeding/ops mistake, and it must be loud.
    throw new Error(
      `Merchant ${merchantId} has no OWNER user, so a Stripe account cannot be opened for it.`,
    );
  }
  return email;
}

/**
 * Starts or resumes onboarding and returns a **fresh** hosted link.
 */
export async function beginOnboarding(args: {
  merchantId: string;
  actorId: string;
  returnUrl: string;
  refreshUrl: string;
  port?: ConnectPort;
}): Promise<OnboardingLinkResult> {
  const port = await resolvePort(args.port);

  const merchant = await prisma.merchant.findUnique({
    where: { id: args.merchantId },
    select: { id: true, name: true, stripeAccountId: true },
  });
  if (!merchant) {
    throw AppError.notFound('That merchant no longer exists.');
  }

  let accountId = merchant.stripeAccountId;
  const reusedAccount = accountId !== null;

  if (!accountId) {
    const email = await ownerEmailFor(merchant.id);
    const created = await port.createAccount({ email, businessName: merchant.name });
    accountId = created.id;

    // Rule 2: the id is durable before any link exists.
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { stripeAccountId: accountId },
    });
  }

  // Rule 3: always a new link.
  const link = await port.createAccountLink({
    accountId,
    returnUrl: args.returnUrl,
    refreshUrl: args.refreshUrl,
  });

  logger.info('stripe.onboarding_started', {
    actorId: args.actorId,
    merchantId: merchant.id,
    reusedAccount,
  });

  return { url: link.url, accountId, reusedAccount };
}

/**
 * Reads Stripe and persists the resulting state.
 *
 * Called from three places, and it is important that it is one function:
 *   - the return page after onboarding (`?state=return`);
 *   - the `account.updated` webhook;
 *   - ops tooling, to re-check a merchant by hand.
 *
 * Returns the assessment so the caller can render it without a second read.
 */
export async function syncOnboarding(args: {
  merchantId: string;
  port?: ConnectPort;
}): Promise<OnboardingAssessment> {
  const port = await resolvePort(args.port);

  const merchant = await prisma.merchant.findUnique({
    where: { id: args.merchantId },
    select: { id: true, stripeAccountId: true, onboardingComplete: true, status: true },
  });
  if (!merchant) {
    throw AppError.notFound('That merchant no longer exists.');
  }

  if (!merchant.stripeAccountId) {
    // No account yet: nothing to sync, and nothing to write. Answering NOT_STARTED
    // is more useful than throwing, because the page renders it as a setup prompt.
    const assessment = assessOnboarding(null);
    return assessment;
  }

  const snapshot = await port.getAccount(merchant.stripeAccountId);
  const assessment = assessOnboarding(snapshot);

  const changed =
    assessment.onboardingComplete !== merchant.onboardingComplete ||
    assessment.merchantStatus !== merchant.status;

  if (changed) {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: {
        onboardingComplete: assessment.onboardingComplete,
        status: assessment.merchantStatus,
      },
    });
  }

  logger.info('stripe.account_synced', {
    merchantId: merchant.id,
    state: assessment.state,
    changed,
  });

  return assessment;
}

/**
 * The state a merchant is in, for rendering, without writing anything.
 *
 * `syncOnboarding` is the write path; this is the read path. Kept separate so a
 * page render cannot accidentally mutate `Merchant.status` — a GET that writes is
 * how a status flip gets attributed to the wrong cause.
 */
export async function readOnboarding(args: {
  merchantId: string;
  port?: ConnectPort;
}): Promise<OnboardingAssessment> {
  const merchant = await prisma.merchant.findUnique({
    where: { id: args.merchantId },
    select: { stripeAccountId: true },
  });
  if (!merchant?.stripeAccountId) {
    return assessOnboarding(null);
  }
  const port = await resolvePort(args.port);
  return assessOnboarding(await port.getAccount(merchant.stripeAccountId));
}

/**
 * Whether a drop may be published for this merchant (FR-102 + M3's precondition).
 *
 * A named function rather than `readOnboarding(...).state === 'READY'` at the
 * call site: M3 will call this from the publish action, and one spelling of the
 * rule means one thing to change when the rule does.
 */
export async function assertCanPublish(merchantId: string, port?: ConnectPort): Promise<void> {
  const assessment = await readOnboarding({ merchantId, port });
  if (assessment.state !== 'READY') {
    throw new AppError(
      409,
      'Finish payout setup before publishing a drop. Diners cannot be charged until payouts work.',
    );
  }
}

/** Exported for the onboarding page's status list. */
export type { OnboardingState };
