import 'dotenv/config';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import type { ConnectPort } from '@/lib/payments/connect-port';
import type { StripeAccountSnapshot } from '@/lib/payments/onboarding';
import { beginOnboarding, readOnboarding, syncOnboarding } from '@/lib/payments/onboarding-service';

/**
 * FR-102 — onboarding orchestration against a fake port.
 *
 * These are the failures that only show up in production against the real API,
 * which is to say: the ones that would never be tested. A fake makes each of them
 * a two-line assertion.
 */

const SLUG_PREFIX = 'onboard-test-';

type Fixture = { merchantId: string; ownerId: string };
let fixture: Fixture;

/** Records every call, so ordering can be asserted rather than assumed. */
type FakeCalls = {
  createAccount: number;
  createAccountLink: number;
  getAccount: number;
  /** Interleaved log, to prove the write happens before the link. */
  sequence: string[];
};

function makeFakePort(options: {
  snapshot?: StripeAccountSnapshot | null;
  onCreateAccount?: () => void;
} = {}): { port: ConnectPort; calls: FakeCalls } {
  const calls: FakeCalls = { createAccount: 0, createAccountLink: 0, getAccount: 0, sequence: [] };
  let counter = 0;

  const port: ConnectPort = {
    async createAccount({ email }) {
      calls.createAccount += 1;
      calls.sequence.push('createAccount');
      options.onCreateAccount?.();
      counter += 1;
      return { id: `acct_fake_${counter}`, email };
    },
    async createAccountLink({ accountId }) {
      calls.createAccountLink += 1;
      calls.sequence.push('createAccountLink');
      return { url: `https://connect.stripe.test/${accountId}`, expiresAt: Date.now() + 300_000 };
    },
    async getAccount(accountId) {
      calls.getAccount += 1;
      calls.sequence.push('getAccount');
      return (
        options.snapshot ?? {
          id: accountId,
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          disabled_reason: null,
          requirements: { currently_due: [], past_due: [], disabled_reason: null },
        }
      );
    },
  };

  return { port, calls };
}

beforeAll(async () => {
  const stamp = Date.now();
  const owner = await prisma.user.create({
    data: {
      email: `${SLUG_PREFIX}owner-${stamp}@example.test`,
      passwordHash: 'x',
      role: 'MERCHANT',
      mustChangePassword: true,
    },
    select: { id: true },
  });
  const merchant = await prisma.merchant.create({
    data: {
      name: 'Onboarding Test Kitchen',
      slug: `${SLUG_PREFIX}${stamp}`,
      status: 'PENDING',
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  fixture = { merchantId: merchant.id, ownerId: owner.id };
});

beforeEach(async () => {
  // Each test starts from "no account", so the create-once rule is meaningful.
  await prisma.merchant.update({
    where: { id: fixture.merchantId },
    data: { stripeAccountId: null, onboardingComplete: false, status: 'PENDING' },
  });
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: fixture.merchantId } });
  await prisma.user.deleteMany({ where: { id: fixture.ownerId } });
  await prisma.$disconnect();
});

const URLS = { returnUrl: 'https://x.test/return', refreshUrl: 'https://x.test/refresh' };

describe('beginOnboarding', () => {
  it('creates one account, persists it, then mints a link — in that order', async () => {
    const { port, calls } = makeFakePort();

    const result = await beginOnboarding({
      merchantId: fixture.merchantId,
      actorId: fixture.ownerId,
      ...URLS,
      port,
    });

    expect(calls.createAccount).toBe(1);
    expect(calls.createAccountLink).toBe(1);
    expect(result.reusedAccount).toBe(false);
    expect(result.url).toContain('acct_fake_1');

    // Rule 2: the account id is durable before the merchant is sent to Stripe.
    const merchant = await prisma.merchant.findUnique({
      where: { id: fixture.merchantId },
      select: { stripeAccountId: true },
    });
    expect(merchant?.stripeAccountId).toBe(result.accountId);
  });

  it('reuses the existing account on a second visit instead of creating another', async () => {
    const first = makeFakePort();
    const initial = await beginOnboarding({
      merchantId: fixture.merchantId,
      actorId: fixture.ownerId,
      ...URLS,
      port: first.port,
    });

    const second = makeFakePort();
    const resumed = await beginOnboarding({
      merchantId: fixture.merchantId,
      actorId: fixture.ownerId,
      ...URLS,
      port: second.port,
    });

    // The failure this prevents: an abandoned onboarding leaves a real identity
    // record on an account nothing points at.
    expect(second.calls.createAccount).toBe(0);
    expect(second.calls.createAccountLink).toBe(1);
    expect(resumed.accountId).toBe(initial.accountId);
    expect(resumed.reusedAccount).toBe(true);
  });

  it('mints a fresh link every time — links are single-use', async () => {
    const { port, calls } = makeFakePort();
    await beginOnboarding({ merchantId: fixture.merchantId, actorId: fixture.ownerId, ...URLS, port });
    await beginOnboarding({ merchantId: fixture.merchantId, actorId: fixture.ownerId, ...URLS, port });
    expect(calls.createAccountLink).toBe(2);
    expect(calls.createAccount).toBe(1);
  });

  it('404s for a merchant that does not exist', async () => {
    const { port } = makeFakePort();
    await expect(
      beginOnboarding({
        merchantId: '00000000-0000-0000-0000-000000000000',
        actorId: fixture.ownerId,
        ...URLS,
        port,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('throws loudly when the merchant has no OWNER to open an account for', async () => {
    // A missing owner is an ops mistake, not a user error: it must not 4xx.
    const orphan = await prisma.merchant.create({
      data: { name: 'No Owner', slug: `${SLUG_PREFIX}noowner-${Date.now()}`, status: 'PENDING' },
      select: { id: true },
    });
    const { port } = makeFakePort();
    await expect(
      beginOnboarding({ merchantId: orphan.id, actorId: fixture.ownerId, ...URLS, port }),
    ).rejects.toThrow(/no OWNER/);
    await prisma.merchant.delete({ where: { id: orphan.id } });
  });
});

describe('syncOnboarding', () => {
  it('flips the merchant to ACTIVE when Stripe reports fully enabled', async () => {
    await prisma.merchant.update({
      where: { id: fixture.merchantId },
      data: { stripeAccountId: 'acct_fake_ready' },
    });
    const { port } = makeFakePort();

    const assessment = await syncOnboarding({ merchantId: fixture.merchantId, port });
    expect(assessment.state).toBe('READY');

    const merchant = await prisma.merchant.findUnique({
      where: { id: fixture.merchantId },
      select: { onboardingComplete: true, status: true },
    });
    expect(merchant?.onboardingComplete).toBe(true);
    expect(merchant?.status).toBe('ACTIVE');
  });

  it('does NOT flip to ACTIVE when payouts are disabled, even if charges work', async () => {
    await prisma.merchant.update({
      where: { id: fixture.merchantId },
      data: { stripeAccountId: 'acct_fake_half' },
    });
    const { port } = makeFakePort({
      snapshot: {
        id: 'acct_fake_half',
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
        disabled_reason: null,
        requirements: { currently_due: ['external_account'], past_due: [] },
      },
    });

    const assessment = await syncOnboarding({ merchantId: fixture.merchantId, port });
    expect(assessment.state).toBe('INCOMPLETE');

    const merchant = await prisma.merchant.findUnique({
      where: { id: fixture.merchantId },
      select: { onboardingComplete: true, status: true },
    });
    expect(merchant?.onboardingComplete).toBe(false);
    expect(merchant?.status).toBe('PENDING');
  });

  it('demotes a previously-ready merchant when Stripe restricts the account', async () => {
    await prisma.merchant.update({
      where: { id: fixture.merchantId },
      data: {
        stripeAccountId: 'acct_fake_restricted',
        onboardingComplete: true,
        status: 'ACTIVE',
      },
    });
    const { port } = makeFakePort({
      snapshot: {
        id: 'acct_fake_restricted',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        disabled_reason: 'rejected.fraud',
        requirements: { currently_due: [], past_due: [], disabled_reason: 'rejected.fraud' },
      },
    });

    const assessment = await syncOnboarding({ merchantId: fixture.merchantId, port });
    expect(assessment.state).toBe('RESTRICTED');

    const merchant = await prisma.merchant.findUnique({
      where: { id: fixture.merchantId },
      select: { onboardingComplete: true, status: true },
    });
    expect(merchant?.onboardingComplete).toBe(false);
    expect(merchant?.status).toBe('PENDING');
  });

  it('answers NOT_STARTED and writes nothing when there is no account', async () => {
    const { port, calls } = makeFakePort();
    const assessment = await syncOnboarding({ merchantId: fixture.merchantId, port });
    expect(assessment.state).toBe('NOT_STARTED');
    // No account means no Stripe call at all.
    expect(calls.getAccount).toBe(0);
  });
});

describe('readOnboarding', () => {
  it('never writes, even when it finds a ready account', async () => {
    await prisma.merchant.update({
      where: { id: fixture.merchantId },
      data: { stripeAccountId: 'acct_fake_readonly', status: 'PENDING', onboardingComplete: false },
    });
    const { port } = makeFakePort({ snapshot: {
      id: 'acct_fake_readonly',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      disabled_reason: null,
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
    } });

    await readOnboarding({ merchantId: fixture.merchantId, port });

    // A GET that writes is how a status change gets attributed to the wrong cause.
    const merchant = await prisma.merchant.findUnique({
      where: { id: fixture.merchantId },
      select: { status: true, onboardingComplete: true },
    });
    expect(merchant?.status).toBe('PENDING');
    expect(merchant?.onboardingComplete).toBe(false);
  });
});
