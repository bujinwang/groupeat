import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { newImpersonationSession } from '@/lib/auth/jwt';

import { POST } from '../route';

/**
 * `POST /api/merchant/drops/:id/publish` — FR-207, and the reason a snapshot exists.
 *
 * > `FR-207 | Publish transitions DRAFT → PUBLISHED and freezes guardrailSnapshot |
 * > Snapshot is immutable; later edits to MenuItem do not alter it`
 * > — PRD-v1.md
 *
 * The immutability half is the whole point of the requirement and it had no test at
 * this surface. `lib/drops/publish.ts` has its own suite, so the *decisions* are
 * covered there; what is not covered is the claim the route makes about its own
 * division of labour:
 *
 * > *The route's whole job is gathering two facts the publish service must not look
 * > up itself: the session's scope, and whether Stripe payouts are ready.*
 *
 * That sentence names a specific ordering rule — `readOnboarding` is read, not
 * asserted, so that a merchant with both a bad price and no Stripe account hears
 * about the **price**. Reversing it (calling `assertCanPublish` first) would still
 * refuse both merchants and still return a 4xx, so nothing in the publish suite
 * would notice. This suite notices.
 *
 * ## The one thing mocked, and why it must be
 *
 * `readOnboarding` reaches Stripe. It is replaced so `payoutsReady` can be set to
 * either value; every money decision downstream runs for real against real rows.
 * Mocking it is also what makes the ordering assertion possible at all — with no
 * seam there is only one reachable branch.
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

/**
 * The payout gate's input.
 *
 * `state` is what the route reads; `NOT_STARTED` is what `readOnboarding` returns
 * for a merchant with no Connect account, so it is the honest default.
 */
const onboardingState: { state: string } = { state: 'NOT_STARTED' };

vi.mock('@/lib/payments/onboarding-service', () => ({
  readOnboarding: async () => ({ state: onboardingState.state }),
}));

/** Analytics `record` writes to disk; `emit` appends JSON lines. Both are noise here. */
vi.mock('@/lib/analytics/record-funnel', () => ({
  record: () => undefined,
}));

vi.mock('@/lib/analytics/events', () => ({
  emit: () => undefined,
}));

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `pub${Date.now().toString(36).slice(-5)}`;

const merchantIds: string[] = [];
const userIds: string[] = [];
const itemIds: string[] = [];
const dropIds: string[] = [];

let merchantId = '';
let ownerUserId = '';
let itemId = '';

/** A second tenant, so "another merchant's drop" is a real row and not a guess. */
let otherDropId = '';

function sessionFor(userId: string): MockSessionInput {
  return {
    userId,
    role: 'MERCHANT',
    mustChangePassword: false,
    absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function request(id: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/merchant/drops/${id}/publish`, {
    method: 'POST',
  });
}

type PublishBody = {
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  drop?: { id: string; status: string; dealPriceCents: number };
  snapshot?: {
    version: number;
    input: { menuPriceCents: number; foodCostCents: number; packagingCents: number };
  };
};

/**
 * A draft that satisfies every publish rule.
 *
 * The numbers are the ones the guardrail produces a viable price for: at menu 1600
 * / food 480 / packaging 80 with a 25% floor, the minimum viable price is 1112, so
 * pricing at exactly 1112 is publishable. `windowStart` is far enough ahead that
 * the five-day cap and the "cutoff before window" rule both pass, and `cutoffAt`
 * is derived from it rather than hardcoded so the two cannot drift apart.
 */
async function makeDraft(args: {
  merchantId: string;
  status?: 'DRAFT' | 'PUBLISHED';
  dealPriceCents?: number;
}): Promise<string> {
  const windowStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const cutoffAt = new Date(windowStart.getTime() - 6 * 60 * 60 * 1000);

  const drop = await prisma.drop.create({
    data: {
      merchantId: args.merchantId,
      menuItemId: itemId,
      publicCode: `${PREFIX}${dropIds.length}${Date.now()}`.slice(0, 24).toUpperCase(),
      title: `${PREFIX} draft ${dropIds.length + 1}`,
      dealPriceCents: args.dealPriceCents ?? 1112,
      minQty: 2,
      maxQty: 10,
      maxPerCustomer: 4,
      cutoffAt,
      windowStart,
      windowEnd: new Date(windowStart.getTime() + 3 * 60 * 60 * 1000),
      status: args.status ?? 'DRAFT',
      /**
       * A draft's snapshot is `{}`, not `null` — and that is a fact about the
       * schema worth having in the fixture rather than papering over.
       *
       * `Drop.guardrailSnapshot` is a **required** `Json` column, so "no snapshot
       * yet" is expressed as an empty object. `createDraft` writes `{}` for exactly
       * this reason. Two consequences for the assertions below:
       *
       *   1. `not.toBeNull()` cannot distinguish a draft from a published drop, so
       *      the refusal tests assert on `status` and `publishedAt` instead, and
       *      assert the snapshot is still *empty* rather than merely present.
       *   2. A published drop's snapshot must be non-empty — `Object.keys(...)`
       *      length is the check that actually means "something was frozen".
       */
      guardrailSnapshot: {},
    },
    select: { id: true },
  });
  dropIds.push(drop.id);
  return drop.id;
}

beforeAll(async () => {
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
      slug: `${PREFIX}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantId = merchant.id;
  merchantIds.push(merchant.id);

  const item = await prisma.menuItem.create({
    data: {
      merchantId,
      name: `${PREFIX} bowl`,
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      batchYield: 60,
      isBatchable: true,
      containsAlcohol: false,
    },
    select: { id: true },
  });
  itemId = item.id;
  itemIds.push(item.id);

  const otherOwner = await prisma.user.create({
    data: {
      email: `${PREFIX}-other@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  userIds.push(otherOwner.id);

  const otherMerchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} other kitchen`,
      slug: `${PREFIX}-o-${Math.random().toString(36).slice(2, 8)}`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      users: { create: { userId: otherOwner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantIds.push(otherMerchant.id);

  otherDropId = await makeDraft({ merchantId: otherMerchant.id });
});

beforeEach(() => {
  currentSession = sessionFor(ownerUserId);
  onboardingState.state = 'READY';
});

afterAll(async () => {
  if (dropIds.length > 0) {
    await prisma.drop.deleteMany({ where: { id: { in: dropIds } } }).catch(() => undefined);
  }
  if (itemIds.length > 0) {
    await prisma.menuItem.deleteMany({ where: { id: { in: itemIds } } }).catch(() => undefined);
  }
  if (merchantIds.length > 0) {
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('FR-207 · the transition and the snapshot', () => {
  it('moves a draft to PUBLISHED and returns the frozen snapshot', async () => {
    const dropId = await makeDraft({ merchantId });

    const response = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });

    expect(response.status).toBe(200);
    const body = (await response.json()) as PublishBody;

    expect(body.drop?.status).toBe('PUBLISHED');
    expect(body.drop?.dealPriceCents).toBe(1112);
    // The snapshot is returned over the wire so a caller can confirm what was frozen
    // without a second read — and so this suite can assert its shape.
    expect(body.snapshot?.version).toBe(1);
    expect(body.snapshot?.input.menuPriceCents).toBe(1600);
    expect(body.snapshot?.input.foodCostCents).toBe(480);

    // And it was persisted, not merely echoed.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true, guardrailSnapshot: true, publishedAt: true },
    });
    expect(row.status).toBe('PUBLISHED');
    // Non-empty, which is the only claim that means "something was frozen" — the
    // column is a required `Json`, so a draft holds `{}` and `not.toBeNull()` would
    // be satisfied by a drop whose snapshot was never written.
    expect(Object.keys(row.guardrailSnapshot as object).length).toBeGreaterThan(0);
    expect(row.publishedAt).not.toBeNull();
  });

  /**
   * **The requirement's second clause, which is the one that can silently rot.**
   *
   * "Later edits to `MenuItem` do not alter it." The failure is not a crash — it is
   * a report or a settlement that recomputes contribution from the *current* food
   * cost instead of the frozen one, so an old drop's numbers change when a dish is
   * re-costed. Doubling `foodCostCents` after publishing and reading the snapshot
   * back is the only way to see it.
   */
  it('keeps the snapshot frozen when the dish is re-costed afterwards', async () => {
    const dropId = await makeDraft({ merchantId });

    const published = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });
    expect(published.status).toBe(200);
    const before = (await published.json()) as PublishBody;

    await prisma.menuItem.update({ where: { id: itemId }, data: { foodCostCents: 960 } });
    try {
      const after = await prisma.drop.findUniqueOrThrow({
        where: { id: dropId },
        select: { guardrailSnapshot: true },
      });

      // The dish doubled; the snapshot did not move.
      const snapshot = after.guardrailSnapshot as {
        input: { foodCostCents: number };
      } | null;
      expect(snapshot?.input.foodCostCents).toBe(480);
      expect(snapshot?.input.foodCostCents).toBe(before.snapshot?.input.foodCostCents);
    } finally {
      await prisma.menuItem.update({ where: { id: itemId }, data: { foodCostCents: 480 } });
    }
  });

  /**
   * Publishing twice is refused, and it is a **409** rather than a 422.
   *
   * The body of this request is empty and perfectly valid; no different body would
   * be accepted. It is the resource's *state* that says no. Getting this wrong in
   * the 422 direction would tell a merchant to fix their input when there is nothing
   * to fix.
   */
  it('refuses to publish an already-published drop with 409', async () => {
    const dropId = await makeDraft({ merchantId });
    const first = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });
    expect(first.status).toBe(200);

    const second = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });
    expect(second.status).toBe(409);
    const body = (await second.json()) as PublishBody;
    // The sentence was always right; the status is what was wrong. Both are asserted
    // so a future refactor cannot fix one and break the other.
    expect(body.message).toMatch(/already been published/i);
  });
});

describe('the ordering the docblock promises', () => {
  /**
   * **A bad price and no payouts must report the price.**
   *
   * This is the route's stated reason for reading `readOnboarding` instead of
   * calling `assertCanPublish`: payouts are checked *last*, so the merchant hears
   * about the thing that is their job first. Reversing the order leaves both
   * merchants refused, so only a fixture with **both** problems can tell the two
   * implementations apart.
   *
   * The price here is below any viable floor, so `reviewForPublish` refuses.
   */
  it('reports a price problem, not a payout problem, when both apply', async () => {
    onboardingState.state = 'NOT_STARTED';
    const dropId = await makeDraft({ merchantId, dealPriceCents: 500 });

    const response = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });

    // 422 (a refusal about the drop's own numbers), not 409 (payouts).
    expect(response.status).toBe(422);
    const body = (await response.json()) as PublishBody;
    // The sentence is about money the merchant controls, and it does not mention
    // Stripe or payouts — that is the assertion, not merely the status code.
    expect(JSON.stringify(body)).not.toMatch(/payout/i);
    expect(JSON.stringify(body)).not.toMatch(/stripe/i);
  });

  /**
   * The control: a good price with no payouts is a **409** that names payouts.
   *
   * Without this, a route that always answered 422 would pass the test above.
   */
  it('reports a payout problem when the price is fine', async () => {
    onboardingState.state = 'NOT_STARTED';
    const dropId = await makeDraft({ merchantId });

    const response = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });

    expect(response.status).toBe(409);
    const body = (await response.json()) as PublishBody;
    expect(body.message).toMatch(/payout/i);

    // And the drop stayed a draft — a refused publish must not half-publish.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true, guardrailSnapshot: true },
    });
    expect(row.status).toBe('DRAFT');
    // Still the empty object a draft carries — a refusal wrote nothing.
    expect(Object.keys(row.guardrailSnapshot as object)).toHaveLength(0);
  });

  /**
   * A refusal leaves no snapshot behind.
   *
   * A publish that wrote the snapshot and *then* refused would leave a draft
   * carrying a frozen price for a drop that never went live — and a retry after
   * fixing the price would be evaluating against the stale one. Asserted separately
   * from the payout case because the refusal reason differs.
   */
  it('writes no snapshot when the price is refused', async () => {
    const dropId = await makeDraft({ merchantId, dealPriceCents: 500 });

    const response = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });
    expect(response.status).toBe(422);

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true, guardrailSnapshot: true, publishedAt: true },
    });
    expect(row.status).toBe('DRAFT');
    expect(Object.keys(row.guardrailSnapshot as object)).toHaveLength(0);
    expect(row.publishedAt).toBeNull();
  });
});

describe('scope and the write gate', () => {
  it('answers 404 for another merchant\'s drop', async () => {
    const response = await POST(request(otherDropId), {
      params: Promise.resolve({ id: otherDropId }),
    });

    expect(response.status).toBe(404);

    // The other tenant's drop is untouched — a refusal must not publish it.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: otherDropId },
      select: { status: true },
    });
    expect(row.status).toBe('DRAFT');
  });

  it('answers 404 for an id that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const response = await POST(request(missing), { params: Promise.resolve({ id: missing }) });
    expect(response.status).toBe(404);
  });

  it('refuses an impersonated session with 403 and publishes nothing', async () => {
    const dropId = await makeDraft({ merchantId });
    currentSession = {
      ...newImpersonationSession({
        merchantUserId: ownerUserId,
        actorUserId: ownerUserId,
        auditId: '77777777-7777-4777-8777-777777777777',
      }),
    };

    const response = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });
    expect(response.status).toBe(403);

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('DRAFT');
  });

  it('refuses an anonymous caller with 401', async () => {
    const dropId = await makeDraft({ merchantId });
    currentSession = null;
    const response = await POST(request(dropId), { params: Promise.resolve({ id: dropId }) });
    expect(response.status).toBe(401);
  });
});
