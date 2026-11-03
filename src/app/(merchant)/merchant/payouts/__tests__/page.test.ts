import 'dotenv/config';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/merchant/payouts` rendered — gap 12, FR-102's merchant-facing surface.
 *
 * ## The page's headline claim is about which function runs, not what it says
 *
 * The docblock's first paragraph is a rule about writes: **an ordinary visit is a pure
 * read, and only a return from Stripe writes.**
 *
 * > "A page that flips `Merchant.status` on every anonymous GET makes a status change
 * > impossible to attribute later."
 *
 * No rendering can observe that. The two paths can print byte-identical HTML — a READY
 * merchant looks the same whether the assessment was read or synced — so an assertion on
 * the output would pass on a page that wrote on every GET, which is the exact regression
 * the rule exists to prevent. The test therefore observes the **call**: with no query
 * parameter, `readOnboarding` runs and `syncOnboarding` does not; with `?state=return` or
 * `?state=refresh`, the reverse.
 *
 * This is the one place in gap 12 where the assertion is on a mock's call log rather than
 * on rendered text, and it is not a weaker kind of test — it is the only kind that can
 * reach the claim. `onboarding-service.test.ts` covers what `syncOnboarding` *does*.
 *
 * ## Why the service is mocked and the state machine is not
 *
 * `readOnboarding` and `syncOnboarding` both end in `realConnectPort()`, which throws
 * `StripeNotConfiguredError` without `STRIPE_SECRET_KEY` — and this repo's `.env` has none,
 * deliberately (the Stripe suites skip with a reason; see AGENTS.md). So the boundary is
 * mocked and **everything behind it is real**: the assessments are built with the real
 * `assessOnboarding` from five real Stripe snapshots, and the sentences are the real
 * `onboardingMessage`. Mocking that function too would leave the suite asserting its own
 * fixtures.
 *
 * ## Two assertions this suite originally got wrong, and how
 *
 * Both were found by probes rather than by reading, and both are the same shape: an
 * assertion checking *presence* where the claim was about *identity* or *order*.
 *
 *   - The null-assessment test asserted the body sentence and the absence of the success
 *     panel, but not the **badge**. Mutating the fallback from `NOT_STARTED` to `READY`
 *     stayed green — the page would have shown a green "Ready" above "Checking your payout
 *     status…". The badge is now asserted.
 *   - The requirements test asserted both names were present, so dropping `.sort()` stayed
 *     green. Sorted order is now asserted by index, with the fixture supplying the two names
 *     in the opposite order.
 *
 * ## The `!merchant` branch cannot be reached, and that is a finding
 *
 * The page guards `if (!merchant)` with "No merchant is attached to this account." — but
 * `merchantId` comes from `primaryMerchantId(merchantIds)`, which throws `AppError.notFound`
 * when the list is empty. And `MerchantUser.merchantId` has `onDelete: Cascade`, so a
 * dangling membership row cannot outlive its merchant. A user with no merchant therefore
 * gets a 404 from the page function, never the sentence — asserted below, so nobody later
 * reads the guard's absence of a test as an oversight.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

/**
 * The I/O seam. Records every call and returns whatever the test set.
 *
 * `vi.mock` is hoisted above the imports, so the state it closes over must be declared with
 * `vi.hoisted` — otherwise the factory runs before `let` bindings are initialised and the
 * whole file fails with "Cannot access before initialization".
 */
const seam = vi.hoisted(() => ({
  calls: [] as string[],
  readResult: null as unknown,
  syncResult: null as unknown,
  readThrows: false,
  syncThrows: false,
}));

vi.mock('@/lib/payments/onboarding-service', () => ({
  readOnboarding: async (): Promise<unknown> => {
    seam.calls.push('readOnboarding');
    if (seam.readThrows) throw new Error('stripe unreachable');
    return seam.readResult;
  },
  syncOnboarding: async (): Promise<unknown> => {
    seam.calls.push('syncOnboarding');
    if (seam.syncThrows) throw new Error('stripe unreachable');
    return seam.syncResult;
  },
}));

const { prisma } = await import('@/lib/db/prisma');
const { assessOnboarding } = await import('@/lib/payments/onboarding');
/**
 * A top-level `import type`, not `type X = import(...)`: the repo's lint forbids the latter
 * (`consistent-type-imports`). Safe here because a type-only import is erased before the
 * `vi.mock` factories are hoisted past it.
 */
import type { StripeAccountSnapshot } from '@/lib/payments/onboarding';

const PREFIX = `mchpay${Date.now().toString(36).slice(-5)}`;

const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];

const ids = { merchantId: '', userId: '' };

/** A user with a MERCHANT session and no merchant row. */
let orphanUserId = '';

const OWNER_EMAIL = `${PREFIX}-owner@example.test`;

async function makeMerchant(name: string): Promise<string> {
  const merchant = await prisma.merchant.create({
    data: {
      name,
      slug: `${PREFIX}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'PENDING',
      floorPctOfMenu: '0.25',
    },
    select: { id: true },
  });
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

async function makeOwner(emailSuffix: string, merchantId: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${emailSuffix}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  await prisma.merchantUser.create({ data: { merchantId, userId: user.id, role: 'OWNER' } });
  return user.id;
}

/**
 * A Stripe account snapshot, with the four fields `assessOnboarding` reads.
 *
 * Defaults describe a fully-working account; each test overrides the one field that its
 * state depends on, so the difference between two states is visible in the call site.
 */
function snapshot(overrides: Partial<StripeAccountSnapshot> = {}): StripeAccountSnapshot {
  return {
    id: 'acct_fake_1',
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    disabled_reason: null,
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
    ...overrides,
  };
}

beforeAll(async () => {
  ids.merchantId = await makeMerchant('Copper Kettle');
  ids.userId = await makeOwner('owner', ids.merchantId);

  const orphan = await prisma.user.create({
    data: {
      email: `${PREFIX}-orphan@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  createdUserIds.push(orphan.id);
  orphanUserId = orphan.id;

  expect(OWNER_EMAIL).toContain(PREFIX);
});

afterAll(async () => {
  await prisma.merchantUser.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

beforeEach(() => {
  seam.calls.length = 0;
  seam.readResult = null;
  seam.syncResult = null;
  seam.readThrows = false;
  seam.syncThrows = false;
});

async function render(
  userId: string,
  searchParams: { state?: string } = {},
): Promise<{ html: string; text: string }> {
  const previous = sessionState.session;
  sessionState.session = { userId, role: 'MERCHANT', mustChangePassword: false };
  try {
    const page = await import('@/app/(merchant)/merchant/payouts/page');
    const element = await page.default({ searchParams: Promise.resolve(searchParams) });
    const html = await renderToHtml(element);
    return { html, text: textOf(html) };
  } finally {
    sessionState.session = previous;
  }
}

/** The `<span>` badge's own text, so a label is not confused with the body copy. */
function badgeText(html: string): string {
  const badge = /<span\b[^>]*class="[^"]*rounded-full[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  if (!badge) {
    throw new Error('No status badge in the markup');
  }
  return textOf(badge[1] ?? '');
}

describe('/merchant/payouts — an ordinary visit reads and does not write', () => {
  it('calls the read path, never the sync path, on a plain GET', async () => {
    seam.readResult = assessOnboarding(snapshot());

    const { text } = await render(ids.userId);

    // The page's headline rule. An output assertion cannot reach it: a READY merchant
    // renders identically whether the assessment was read or synced.
    expect(seam.calls).toEqual(['readOnboarding']);
    expect(seam.calls).not.toContain('syncOnboarding');
    // And the read is actually used, so the call is not decorative.
    expect(text).toContain('Payouts are set up. You can run a deal.');
  });

  it('calls the sync path on ?state=return', async () => {
    seam.syncResult = assessOnboarding(snapshot());

    await render(ids.userId, { state: 'return' });

    expect(seam.calls).toEqual(['syncOnboarding']);
    expect(seam.calls).not.toContain('readOnboarding');
  });

  it('calls the sync path on ?state=refresh, which Stripe also sends merchants back with', async () => {
    // `refresh` is the branch where Stripe says the link expired. Missing it would leave the
    // merchant on a stale screen after the one journey that most needs a re-read.
    seam.syncResult = assessOnboarding(snapshot());

    await render(ids.userId, { state: 'refresh' });

    expect(seam.calls).toEqual(['syncOnboarding']);
  });

  it('does not write for any other query value', async () => {
    // `?state=weird` is not a return from Stripe. The check is an equality against two
    // literals, so a truthy test would have written here.
    seam.readResult = assessOnboarding(snapshot());

    await render(ids.userId, { state: 'weird' });

    expect(seam.calls).toEqual(['readOnboarding']);
  });
});

describe('/merchant/payouts — the five states', () => {
  const cases: {
    state: string;
    label: string;
    snapshot: () => StripeAccountSnapshot | null;
    message: string;
  }[] = [
    {
      state: 'NOT_STARTED',
      label: 'Not set up',
      snapshot: () => null,
      message: 'Set up payouts before you run a deal. It takes about five minutes.',
    },
    {
      state: 'INCOMPLETE',
      label: 'Incomplete',
      snapshot: () => snapshot({ details_submitted: false }),
      message: 'Payout setup is not finished yet. Stripe is still waiting on some details.',
    },
    {
      state: 'ACTION_REQUIRED',
      label: 'Stripe needs something',
      snapshot: () =>
        snapshot({
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          disabled_reason: 'requirements.past_due',
        }),
      message:
        'Stripe needs something from you before you can be paid. Open the payout setup to see what.',
    },
    {
      state: 'RESTRICTED',
      label: 'Paused',
      snapshot: () =>
        snapshot({ charges_enabled: true, payouts_enabled: true, disabled_reason: 'rejected.fraud' }),
      message:
        'Payouts are paused on your account. Nothing can be charged until this is resolved.',
    },
    {
      state: 'READY',
      label: 'Ready',
      snapshot: () => snapshot(),
      message: 'Payouts are set up. You can run a deal.',
    },
  ];

  for (const testCase of cases) {
    it(`labels ${testCase.state} as "${testCase.label}" and says what to do`, async () => {
      const assessment = assessOnboarding(testCase.snapshot());
      // Guard the fixture: if the snapshot does not actually produce the state this case
      // claims, the row would be testing a different state under the right name.
      expect(assessment.state).toBe(testCase.state);
      seam.readResult = assessment;

      const { html, text } = await render(ids.userId);

      expect(badgeText(html)).toBe(testCase.label);
      expect(text).toContain(testCase.message);
      // No Stripe vocabulary on a merchant's screen. `onboardingMessage`'s docblock is
      // explicit: a merchant reading "individual.verification.document" learns nothing.
      expect(text).not.toContain('requirements.');
      expect(text).not.toContain('charges_enabled');
    });
  }

  it('offers the success sentence only in READY, and the setup button otherwise', async () => {
    seam.readResult = assessOnboarding(snapshot());
    const ready = await render(ids.userId);
    expect(ready.text).toContain('Payouts are working. You can run a deal.');
    expect(ready.text).not.toContain('Set up payouts');

    seam.readResult = assessOnboarding(snapshot({ details_submitted: false }));
    const notReady = await render(ids.userId);
    expect(notReady.text).toContain('Set up payouts');
    expect(notReady.text).not.toContain('Payouts are working.');
  });

  it('never claims payouts work on a state it does not know', async () => {
    // The page falls back to `STATE_TONE.NOT_STARTED` when the assessment is null, which is
    // what a failed Stripe read produces. It must not fall back to `READY`.
    //
    // Found by a probe: the first version asserted only the body sentence and the absence of
    // the success panel, so mutating the fallback to `STATE_TONE.READY` stayed green — the
    // page would have shown a green **"Ready"** badge above "Checking your payout status…".
    // The badge is the loudest thing on the card, so it is the thing to assert.
    seam.readResult = null;

    const { html, text } = await render(ids.userId);

    expect(badgeText(html)).toBe('Not set up');
    expect(text).toContain('Checking your payout status');
    expect(text).not.toContain('Payouts are working.');
  });
});

describe('/merchant/payouts — the setup button', () => {
  it('says "Set up payouts" on a first attempt and "Continue payout setup" on a return', async () => {
    // `StartOnboardingButton` picks its verb from the `returnState` prop: `start` uses the
    // label it was given, `return` uses its own "Continue payout setup". A page that always
    // passed `start` would tell a merchant who has already begun to start over.
    seam.readResult = assessOnboarding(snapshot({ details_submitted: false }));

    const first = await render(ids.userId);
    expect(first.text).toContain('Set up payouts');
    expect(first.text).not.toContain('Continue payout setup');

    seam.syncResult = assessOnboarding(snapshot({ details_submitted: false }));
    const returned = await render(ids.userId, { state: 'return' });
    expect(returned.text).toContain('Continue payout setup');
  });

  it('reassures the merchant that GroupEat never sees bank details', async () => {
    seam.readResult = assessOnboarding(snapshot({ details_submitted: false }));

    const { text } = await render(ids.userId);

    expect(text).toContain('finish this on Stripe');
    expect(text).toContain('GroupEat never sees your bank details.');
  });
});

describe('/merchant/payouts — outstanding requirements', () => {
  it('lists what Stripe is waiting on, sorted and de-duplicated', async () => {
    // `collectOutstanding` unions `currently_due` and `past_due`. The list is for ops, not
    // the merchant — the docblock says names only, never values — and it is sorted so the
    // UI does not reshuffle between polls.
    //
    // The `sort()` needs an **order** assertion, not a containment one. Found by a probe:
    // dropping `.sort()` left all 20 green, because both names were present either way. The
    // fixture is written with the two names out of order relative to the sort so that a page
    // preserving insertion order fails.
    seam.readResult = assessOnboarding(
      snapshot({
        details_submitted: false,
        requirements: {
          currently_due: ['individual.verification.document', 'external_account'],
          past_due: ['external_account'],
          disabled_reason: null,
        },
      }),
    );

    const { text } = await render(ids.userId);

    expect(text).toContain('Stripe is waiting on:');
    expect(text).toContain('These open on Stripe');
    // `Set` + `sort`: the duplicated `external_account` appears once in the list markup.
    const occurrences = text.split('external_account').length - 1;
    expect(occurrences).toBe(1);

    // Sorted, so `external_account` precedes `individual.verification.document` — the
    // reverse of the order the fixture supplies them in.
    const externalAt = text.indexOf('external_account');
    const individualAt = text.indexOf('individual.verification.document');
    expect(externalAt).toBeGreaterThan(-1);
    expect(individualAt).toBeGreaterThan(-1);
    expect(externalAt).toBeLessThan(individualAt);
  });

  it('renders no requirements block when the list is empty', async () => {
    seam.readResult = assessOnboarding(snapshot());

    const { text } = await render(ids.userId);

    expect(text).not.toContain('Stripe is waiting on:');
  });
});

describe('/merchant/payouts — a failed Stripe read', () => {
  it('says it could not reach Stripe on a return, rather than implying "not set up"', async () => {
    // The distinction is the point: "not set up" would send the merchant round the loop
    // again for a setup that already exists. Only reachable on the return path, because
    // that is where the page has just told Stripe to do something.
    seam.syncThrows = true;

    const { text } = await render(ids.userId, { state: 'return' });

    expect(text).toContain('We could not reach Stripe to check your status.');
    expect(text).toContain('Your setup is not lost');
    expect(text).toContain('reload this page in a moment');
  });

  it('does not show that card on an ordinary visit, where a failure is not news', async () => {
    seam.readThrows = true;

    const { text } = await render(ids.userId);

    expect(text).not.toContain('We could not reach Stripe to check your status.');
    // Still honest: the neutral fallback, not a success claim.
    expect(text).toContain('Checking your payout status');
    expect(text).not.toContain('Payouts are working.');
  });
});

describe('/merchant/payouts — what the page explains', () => {
  it('states why payouts are needed before a deal, without Stripe vocabulary', async () => {
    seam.readResult = assessOnboarding(null);

    const { text } = await render(ids.userId);

    expect(text).toContain('Why this is needed before a deal');
    expect(text).toContain('authorises each diner');
    expect(text).toContain('charges it only if');
    expect(text).toContain('Money moves from their card to your account directly');
    // ADR-001's merchant-of-record sentence, which is a legal statement not decoration.
    expect(text).toContain('You are the seller of record for every deal you run.');
    expect(text).toContain('GroupEat takes a fee; the food, the tax and the customer relationship are yours.');
  });

  it('shows the merchant’s own name, so a multi-merchant account knows which one', async () => {
    seam.readResult = assessOnboarding(null);

    const { text } = await render(ids.userId);

    expect(text).toContain('Copper Kettle');
  });
});

describe('/merchant/payouts — the unreachable guard', () => {
  it('is a 404 for a user with no merchant, so the "no merchant attached" sentence never prints', async () => {
    // `primaryMerchantId([])` throws before the page reaches its own `!merchant` guard, and
    // `MerchantUser.merchantId` cascades so a dangling membership cannot exist. The guard is
    // defensive code, not a reachable branch — recorded rather than asserted as copy.
    await expect(render(orphanUserId)).rejects.toMatchObject({ status: 404 });
    expect(seam.calls).toEqual([]);
  });
});
