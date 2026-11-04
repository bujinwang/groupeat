import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';

import { POST } from '../route';

/**
 * `POST /api/merchant/stripe/onboard` — FR-102's entry point.
 *
 * > `FR-102 | Connect Stripe account | … | Hosted onboarding + return state`
 *
 * ## What `onboarding-service.test.ts` cannot cover
 *
 * That suite proves the *sequencing* — create once, persist before minting, mint a
 * fresh link every time. It cannot prove any of what this route does, because the
 * route is where the two inputs that no service test has exist:
 *
 *   1. **The origin.** `originOf` builds the `return_url` and `refresh_url` from
 *      the incoming request's `host` and `x-forwarded-proto`. The service test
 *      passes literal URLs, so a route that built `http://localhost:3000/...` in
 *      production would pass every service assertion and send every merchant
 *      back to a host that does not exist. This is the highest-value assertion
 *      in the file: the URLs are *money-adjacent*, because a broken return URL
 *      leaves a merchant who believes they finished onboarding unable to be paid.
 *   2. **A missing key is a 503, not a 500.** `isStripeNotConfigured(error)` is a
 *      branch on a caught exception. Nothing else in the suite reaches it, and
 *      the distinction it draws is operational: "payments are not configured" is
 *      a fact about the deployment that a human should act on, and it must not
 *      be reported as a bug in the merchant's request — nor as the generic
 *      "Something went wrong. Try again.", which invites a retry that cannot work.
 *
 * ## The key: absent here, and that is the point
 *
 * This file deliberately does **not** set `STRIPE_SECRET_KEY`. The important
 * assertion is the 503 that results, and it is a real assertion against the real
 * `realConnectPort`, not a stub: the guard is `isStripeConfigured()`, which reads
 * `process.env` directly.
 *
 * The *successful* path therefore cannot be driven from here end to end — a real
 * `sk_test_` key would make `beginOnboarding` attempt a network call to Stripe.
 * That half is covered where it belongs, by injecting a fake port into the
 * service, and this file asserts the seam: the route passes the origin it built
 * into the service's arguments. The `NEXT_PUBLIC_...`-style temptation to stub
 * `isStripeConfigured` is refused — stubbing it would remove the only code path
 * that decides whether a deployment can take money.
 */

type MockSessionInput = {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword: boolean;
  absoluteExpiresAt: number;
  expiresAt: number;
  impersonation?: { actorUserId: string; auditId: string; expiresAt: number };
};

let currentSession: MockSessionInput | null = null;

vi.mock('server-only', () => ({}));

vi.mock('@/lib/auth/session', async () => {
  const jwt = await import('@/lib/auth/jwt');
  return {
    getSession: async () => currentSession,
    roleHome: jwt.roleHome,
    newSession: jwt.newSession,
  };
});

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `onbr${Date.now().toString(36).slice(-5)}`;

const merchantIds: string[] = [];
const userIds: string[] = [];

let merchantId = '';
let ownerUserId = '';

function sessionFor(userId: string): MockSessionInput {
  return {
    userId,
    role: 'MERCHANT',
    mustChangePassword: false,
    absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function post(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/merchant/stripe/onboard', {
    method: 'POST',
    headers,
  });
}

/** Stripe configuration is read from `process.env`; make the absence explicit. */
const savedKey = process.env.STRIPE_SECRET_KEY;

beforeAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;

  const owner = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  ownerUserId = owner.id;
  userIds.push(owner.id);

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} kitchen`,
      slug: `${PREFIX}-slug`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantId = merchant.id;
  merchantIds.push(merchant.id);
});

beforeEach(() => {
  currentSession = sessionFor(ownerUserId);
  delete process.env.STRIPE_SECRET_KEY;
});

afterAll(async () => {
  if (savedKey !== undefined) {
    process.env.STRIPE_SECRET_KEY = savedKey;
  }
  if (merchantIds.length > 0) {
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

type ErrorBody = { error: string; message: string; fieldErrors?: Record<string, string> };

describe('POST /api/merchant/stripe/onboard — a missing key is an operational fact', () => {
  it('answers 503 with STRIPE_NOT_CONFIGURED, not a 500', async () => {
    const response = await POST(post({ host: 'groupeat.test' }));
    expect(response.status).toBe(503);

    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe('STRIPE_NOT_CONFIGURED');
    // The message must name the variable, because the reader is an operator
    // holding the deploy config, not a merchant.
    expect(body.message).toContain('STRIPE_SECRET_KEY');
  });

  it('is not the generic 500, and does not say "try again"', async () => {
    /**
     * The distinction that justifies the branch existing. Without
     * `isStripeNotConfigured`, this request falls to `errorResponse`'s catch-all:
     * a 500 saying "Something went wrong. Try again." — which is a lie, because
     * trying again cannot help and the fix is on the server.
     */
    const response = await POST(post({ host: 'groupeat.test' }));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).not.toBe(500);
    expect(body.error).not.toBe('INTERNAL');
    expect(body.message).not.toContain('Try again');
  });

  it('writes no stripeAccountId when it cannot reach Stripe', async () => {
    // `beginOnboarding` resolves the port before it reads the merchant, so the
    // merchant row is untouched — no orphaned half-onboarding state.
    await POST(post({ host: 'groupeat.test' }));
    const row = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { stripeAccountId: true, onboardingComplete: true },
    });
    expect(row).toEqual({ stripeAccountId: null, onboardingComplete: false });
  });
});

describe('POST /api/merchant/stripe/onboard — authorisation precedes everything', () => {
  it('refuses an anonymous caller with 401, not 503', async () => {
    /**
     * Ordering, and it is a security property rather than a nicety: the
     * configuration state of the deployment must not be visible to a caller who
     * has not signed in. An unauthenticated 503 would tell an anonymous prober
     * whether this instance has Stripe keys.
     */
    currentSession = null;
    const response = await POST(post({ host: 'groupeat.test' }));
    expect(response.status).toBe(401);

    const body = (await response.json()) as ErrorBody;
    expect(body.error).not.toBe('STRIPE_NOT_CONFIGURED');
  });

  it('refuses a non-merchant role with 403', async () => {
    currentSession = { ...sessionFor(ownerUserId), role: 'ADMIN' };
    const response = await POST(post({ host: 'groupeat.test' }));
    expect(response.status).toBe(403);
  });

  it('refuses an impersonating admin with 403 and does not reach Stripe', async () => {
    /**
     * FR-904. Starting onboarding creates a real Stripe account holding a real
     * identity record (rule 1 in `onboarding-service`), so a borrowed session
     * triggering it would attach a live financial account to a merchant without
     * the merchant's owner doing anything.
     */
    const jwt = await import('@/lib/auth/jwt');
    currentSession = jwt.newImpersonationSession({
      merchantUserId: ownerUserId,
      actorUserId: '00000000-0000-4000-8000-000000000001',
      auditId: '00000000-0000-4000-8000-000000000002',
    }) as MockSessionInput;

    const response = await POST(post({ host: 'groupeat.test' }));
    expect(response.status).toBe(403);

    const body = (await response.json()) as ErrorBody;
    expect(body.message).toContain('viewing this account as an admin');
    const row = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { stripeAccountId: true },
    });
    expect(row.stripeAccountId).toBeNull();
  });

  it('answers 404 for a merchant account with no merchant row', async () => {
    const loner = await prisma.user.create({
      data: {
        email: `${PREFIX}-loner@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    userIds.push(loner.id);
    currentSession = sessionFor(loner.id);

    const response = await POST(post({ host: 'groupeat.test' }));
    expect(response.status).toBe(404);
  });
});

describe('the origin the return URL is built from', () => {
  /**
   * The service is where the URL is *used*; this is where it is *made*, and the
   * route cannot be tested for the made value without observing the service's
   * arguments. So `beginOnboarding` is wrapped — not replaced — and the arguments
   * are read from the real call.
   *
   * This is the one mock in the file, and it is deliberately a spy on the module
   * boundary rather than a fake of the behaviour: everything about
   * `updateOwnPickup`-style masking applies here, because the subject is the
   * *argument*, not the result.
   */
  it('honours x-forwarded-proto over the request protocol', async () => {
    const seen = await captureOnboardingArgs({ host: 'groupeat.test', 'x-forwarded-proto': 'https' });
    expect(seen.returnUrl).toBe('https://groupeat.test/merchant/payouts?state=return');
    expect(seen.refreshUrl).toBe('https://groupeat.test/merchant/payouts?state=refresh');
  });

  it('falls back to the request protocol when the header is absent', async () => {
    const seen = await captureOnboardingArgs({ host: 'localhost:3000' });
    // The `NextRequest` was built with `http://`, and `nextUrl.protocol` is the
    // fallback the docblock describes.
    expect(seen.returnUrl).toBe('http://localhost:3000/merchant/payouts?state=return');
  });

  it('does not hardcode localhost, which is the failure the fallback exists for', async () => {
    const seen = await captureOnboardingArgs({ host: 'drops.example.com', 'x-forwarded-proto': 'https' });
    expect(seen.returnUrl).not.toContain('localhost');
    expect(seen.returnUrl).toContain('drops.example.com');
  });

  it('keeps the return and refresh paths distinct', async () => {
    // Stripe sends the merchant to `refresh_url` when the link expired and to
    // `return_url` when they finished. One URL for both means a merchant who
    // abandoned the flow is told they completed it.
    const seen = await captureOnboardingArgs({ host: 'groupeat.test', 'x-forwarded-proto': 'https' });
    expect(seen.returnUrl).toContain('state=return');
    expect(seen.refreshUrl).toContain('state=refresh');
    expect(seen.returnUrl).not.toBe(seen.refreshUrl);
  });

  it('answers 400 when there is no host header at all', async () => {
    /**
     * `originOf` throws `AppError.badRequest` rather than guessing a base URL.
     * The alternative — a configured default — is how a return URL silently
     * points at the wrong deployment for months.
     *
     * `NextRequest` always populates `host` from the URL it was constructed with,
     * so this branch needs a request whose headers genuinely lack it. Deleting
     * `host` after construction is the only way to produce that state.
     */
    const request = post();
    request.headers.delete('host');
    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.message).toContain('host header');
  });

  it('is checked after authorisation, so an anonymous caller cannot probe it', async () => {
    currentSession = null;
    const request = post();
    request.headers.delete('host');
    const response = await POST(request);
    // 401, not 400: the gate runs first.
    expect(response.status).toBe(401);
  });
});

describe('the audit identity handed to the service', () => {
  it('names the signed-in user as the actor, and the scoped merchant as the subject', async () => {
    /**
     * `stripe.onboarding_started` is a log row about someone opening a real
     * financial account. If the route passed a constant here the log would still
     * be written, still be well-formed, and name nobody — which is the failure
     * mode an assertion on "was it called" cannot see.
     */
    const seen = await captureOnboardingArgs({ host: 'groupeat.test' });
    expect(seen.actorId).toBe(ownerUserId);
    expect(seen.merchantId).toBe(merchantId);
  });

  it('does not use the impersonated user as the actor, because it refuses them first', async () => {
    // The write gate makes this unreachable, and that is the point: there is no
    // path where an impersonating admin's id — or the merchant's — becomes the
    // actor of an onboarding start.
    const jwt = await import('@/lib/auth/jwt');
    currentSession = jwt.newImpersonationSession({
      merchantUserId: ownerUserId,
      actorUserId: '00000000-0000-4000-8000-000000000001',
      auditId: '00000000-0000-4000-8000-000000000002',
    }) as MockSessionInput;

    const response = await POST(post({ host: 'groupeat.test' }));
    expect(response.status).toBe(403);
  });
});

/**
 * Calls the route and returns the arguments `beginOnboarding` received.
 *
 * `vi.spyOn` on the imported module is the mechanism, and `mockRestore` is called
 * by the caller via `afterEach`-free try/finally so a thrown assertion inside the
 * test cannot leave the spy installed for the next file — this suite runs with
 * `fileParallelism: false`, but a leaked spy is still a leak.
 */
async function captureOnboardingArgs(headers: Record<string, string>): Promise<{
  returnUrl: string;
  refreshUrl: string;
  actorId: string;
  merchantId: string;
}> {
  const service = await import('@/lib/payments/onboarding-service');
  type BeginArgs = Parameters<typeof service.beginOnboarding>[0];
  let captured: {
    returnUrl: string;
    refreshUrl: string;
    actorId: string;
    merchantId: string;
  } | null = null;

  const spy = vi
    .spyOn(service, 'beginOnboarding')
    .mockImplementation(async (args: BeginArgs) => {
      captured = {
        returnUrl: args.returnUrl,
        refreshUrl: args.refreshUrl,
        // Captured because they are what the audit row records, and a route
        // that hardcoded either would leave `stripe.onboarding_started` naming
        // nobody. The first version of this helper captured only the URLs, and
        // a probe that replaced `actorId: session.userId` with `'unknown'`
        // survived it.
        actorId: args.actorId,
        merchantId: args.merchantId,
      };
      // The migration to `CreateAccountLink` would throw here to satisfy the
      // type; casting keeps the assertion about the *arguments* rather than
      // about the service, which is covered elsewhere.
      return { url: 'https://example.test/link', accountId: 'acct_fake', reusedAccount: false };
    });

  try {
    await POST(post(headers));
  } finally {
    spy.mockRestore();
  }

  if (!captured) {
    throw new Error('beginOnboarding was never called; the route refused before it.');
  }
  return captured;
}
