import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { newImpersonationSession } from '@/lib/auth/jwt';

import { POST as createDraftRoute } from '../route';
import { GET as getDropRoute, PATCH as patchDropRoute } from '../[id]/route';

/**
 * `POST /api/merchant/drops` and `PATCH /api/merchant/drops/:id` — where a draft
 * is born and edited.
 *
 * ## The claim this suite exists to falsify
 *
 * The `POST` docblock says a draft is allowed to be **unprofitable** but not
 * **impossible**:
 *
 * > *a draft with an impossible window is not a draft worth saving — and a 422 at
 * > save is a better teacher than a 422 at publish.*
 *
 * and the `PATCH` docblock says the same policy runs again, so that:
 *
 * > *a draft cannot be edited into a state it could never have been created in.*
 *
 * That second sentence was once **false**, and the repository has a unit test
 * called `draft-validation.test.ts` whose whole subject is the defect. So the
 * route-level version of the rule has to be tested at the route, not inferred from
 * the shared helper — the helper is shared, the *wiring* is what broke.
 *
 * ## The two status codes that mean different things
 *
 *   - **422** — the body is wrong; send a different one.
 *   - **409** — the body is fine; the *resource* is in the wrong state.
 *
 * Editing a published drop is the 409 case, and conflating the two is the exact
 * bug the publish suite already caught once (`NOT_DRAFT` was a 422 until a route
 * test asserted the status instead of the message). This suite pins both sides:
 * a published drop refuses edits with 409, and a bad window refuses with 422 — with
 * assertions on the status, never on the message alone.
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

const emitted: { event: string; payload: Record<string, unknown> }[] = [];

vi.mock('@/lib/analytics/events', () => ({
  emit: (event: string, payload: Record<string, unknown>) => {
    emitted.push({ event, payload });
  },
}));

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `drp${Date.now().toString(36).slice(-5)}`;

const merchantIds: string[] = [];
const userIds: string[] = [];
const itemIds: string[] = [];

let merchantId = '';
let ownerUserId = '';
let itemId = '';

let otherMerchantId = '';
let otherOwnerUserId = '';
let otherItemId = '';

/** The dish's `batchYield`, so the quantity tests can name a real ceiling. */
const BATCH_YIELD = 30;

const MS_PER_HOUR = 60 * 60 * 1000;

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * MS_PER_HOUR).toISOString();
}

function sessionFor(userId: string): MockSessionInput {
  return {
    userId,
    role: 'MERCHANT',
    mustChangePassword: false,
    absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * A valid draft body.
 *
 * The window is cutoff in 24h, pickup in 48h–50h: comfortably inside §8.3's
 * five-day authorisation cap, and shaped the way `DropForm`'s defaults are.
 */
function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    menuItemId: itemId,
    title: `${PREFIX} lunch drop`,
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1300,
    minQty: 5,
    maxQty: 10,
    maxPerCustomer: 4,
    windowStart: hoursFromNow(48),
    windowEnd: hoursFromNow(50),
    cutoffAt: hoursFromNow(24),
    aiRationale: null,
    ...overrides,
  };
}

function createRequest(raw: string | null): NextRequest {
  return new NextRequest('http://localhost:3000/api/merchant/drops', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(raw === null ? {} : { body: raw }),
  });
}

function patchRequest(raw: string | null, id: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/merchant/drops/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    ...(raw === null ? {} : { body: raw }),
  });
}

type DropBody = {
  drop: {
    id: string;
    merchantId: string;
    menuItemId: string;
    status: string;
    title: string;
    dealPriceCents: number;
    publicCode: string | null;
    guardrailSnapshot: unknown;
    publishedAt: string | null;
  };
};

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
      name: `${PREFIX} noodle bowl`,
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      batchYield: BATCH_YIELD,
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
  otherOwnerUserId = otherOwner.id;
  userIds.push(otherOwner.id);

  const otherMerchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} other kitchen`,
      slug: `${PREFIX}-other-${Math.random().toString(36).slice(2, 8)}`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      users: { create: { userId: otherOwner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  otherMerchantId = otherMerchant.id;
  merchantIds.push(otherMerchant.id);

  const otherItem = await prisma.menuItem.create({
    data: {
      merchantId: otherMerchantId,
      name: `${PREFIX} other bowl`,
      menuPriceCents: 2000,
      foodCostCents: 500,
      packagingCents: 100,
      batchYield: 40,
      isBatchable: true,
      containsAlcohol: false,
    },
    select: { id: true },
  });
  otherItemId = otherItem.id;
  itemIds.push(otherItem.id);
});

beforeEach(() => {
  currentSession = sessionFor(ownerUserId);
  emitted.length = 0;
});

afterAll(async () => {
  /**
   * Cleanup is **by tenant**, not by an id list, and the difference is not
   * cosmetic.
   *
   * The first version of this file deleted only the ids it had pushed into
   * `dropIds`. But several tests deliberately call `createDraftRoute` with a body
   * they expect to be *refused* — a bad window, a whitespace title, a negative
   * price — and do not register anything, because on a correct implementation
   * nothing is created. **Under a mutant, something is.** The suite then fails, and
   * the row it should never have written stays in the database.
   *
   * That is exactly what happened: a mutation sweep of 16 mutants left 14 `DRAFT`
   * drops behind, which then tripped an *unrelated* admin suite whose test asserts
   * that the dev database holds no drafts, and that suite's error message names
   * "leaked data from another suite" — correctly, and about this file.
   *
   * Deleting every drop belonging to this suite's merchants makes cleanup
   * independent of which assertions passed, which is the only property that holds
   * while a mutation probe is running.
   */
  if (merchantIds.length > 0) {
    await prisma.drop
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
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

/** Creates a draft through the route and registers it for cleanup. */
async function makeDraft(overrides: Record<string, unknown> = {}): Promise<DropBody['drop']> {
  const response = await createDraftRoute(createRequest(JSON.stringify(draftBody(overrides))));
  expect(response.status, `draft creation should succeed: ${JSON.stringify(overrides)}`).toBe(201);
  const body = (await response.json()) as DropBody;
  return body.drop;
}

describe('create: a draft is born a draft', () => {
  /**
   * The happy path, and the three facts a new draft must have.
   *
   * `status` and `guardrailSnapshot` are asserted here rather than in a comment
   * because they are the two fields the body is **not** allowed to decide.
   */
  it('creates a DRAFT with an empty snapshot and a public code', async () => {
    const drop = await makeDraft();

    expect(drop.status).toBe('DRAFT');
    expect(drop.merchantId).toBe(merchantId);
    expect(drop.publishedAt).toBeNull();

    /**
     * The snapshot is `{}`, not `null` — `Drop.guardrailSnapshot` is a required
     * `Json` column, and `createDraft` writes `{}`.
     *
     * So `not.toBeNull()` here would be vacuous, and it would also be compatible
     * with a published drop (`{...}` is not null either). The check that actually
     * means "nothing has been frozen yet" is that the object has **no keys**.
     */
    expect(drop.guardrailSnapshot).toEqual({});
    expect(Object.keys(drop.guardrailSnapshot as object)).toHaveLength(0);

    // A draft still gets a code, because FR-206's preview link needs a stable URL
    // before publishing, and a code minted at publish would change under a link
    // the merchant already shared.
    expect(drop.publicCode).toBeTruthy();
  });

  /**
   * **The body cannot publish.** `status`, `guardrailSnapshot`, `publicCode` and
   * `publishedAt` are not in `draftInputSchema`, and Zod strips unknown keys — so
   * they are ignored. Asserted on the **stored row** for the same reason as the
   * items suite: a stripped response is compatible with a spread that writes.
   */
  it('ignores a body that tries to create a published drop', async () => {
    const drop = await makeDraft({
      status: 'PUBLISHED',
      guardrailSnapshot: { evil: true, minViablePriceCents: 1 },
      publishedAt: new Date().toISOString(),
      publicCode: 'HACKED',
      merchantId: otherMerchantId,
    });

    const stored = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.id },
      select: {
        status: true,
        guardrailSnapshot: true,
        publishedAt: true,
        publicCode: true,
        merchantId: true,
      },
    });

    expect(stored.status).toBe('DRAFT');
    expect(stored.guardrailSnapshot).toEqual({});
    expect(stored.publishedAt).toBeNull();
    expect(stored.publicCode).not.toBe('HACKED');
    // Not the other merchant's kitchen.
    expect(stored.merchantId).toBe(merchantId);
  });

  /**
   * **A draft may be unprofitable.**
   *
   * `dealPriceCents: 900` against a $11.12 floor loses money, and `POST` must
   * still store it — FR-203's slider needs a state to exist before the merchant
   * has moved it, and the refusal belongs at publish. This is the control for the
   * window tests below: the route is not simply strict about everything.
   */
  it('stores a draft priced below the floor, because publishing is what refuses', async () => {
    const drop = await makeDraft({ dealPriceCents: 900 });
    expect(drop.dealPriceCents).toBe(900);
    expect(drop.status).toBe('DRAFT');

    // And proving the publish path *would* refuse it is the publish suite's job;
    // here the claim is only that the save is allowed.
  });

  /**
   * **A draft may not be impossible.** An impossible window is a save-time 422.
   *
   * Three shapes, because three different rules are involved: pickup ending before
   * it starts (`windowEnd`), the cutoff landing after pickup begins (`cutoffAt`),
   * and the cutoff outside §8.3's five-day authorisation cap (`cutoffAt` again,
   * from a different rule — which is why the field name alone is not enough and the
   * cases are listed separately).
   */
  it('refuses a window that closes before it opens', async () => {
    const response = await createDraftRoute(
      createRequest(JSON.stringify(draftBody({ windowStart: hoursFromNow(50), windowEnd: hoursFromNow(48) }))),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; fieldErrors: Record<string, string> };
    expect(body.error).toBe('VALIDATION');
    expect(Object.keys(body.fieldErrors)).toContain('windowEnd');
  });

  it('refuses a cutoff that lands after pickup starts', async () => {
    const response = await createDraftRoute(
      createRequest(
        JSON.stringify(draftBody({ cutoffAt: hoursFromNow(49), windowStart: hoursFromNow(48) })),
      ),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(Object.keys(body.fieldErrors)).toContain('cutoffAt');
  });

  it('refuses a cutoff beyond the five-day authorisation window', async () => {
    // 6 days out: beyond §8.3's cap. The window itself is coherent, so only the
    // authorisation rule can be what rejects it.
    const response = await createDraftRoute(
      createRequest(JSON.stringify(draftBody({ cutoffAt: hoursFromNow(6 * 24), windowStart: hoursFromNow(7 * 24), windowEnd: hoursFromNow(7 * 24 + 2) }))),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.cutoffAt).toMatch(/5 days/i);
  });

  /**
   * **`maxQty` cannot exceed the dish's real `batchYield`.**
   *
   * This is the rule that used to be checked against `Number.MAX_SAFE_INTEGER`
   * because the dish had not been read — the exact reason `collectDraftFieldErrors`
   * exists. The assertion names the yield, so a route that stopped reading the dish
   * and fell back to a sentinel would fail this test rather than pass it.
   */
  it('refuses a maxQty above the dish\'s batch yield, and names the yield', async () => {
    const response = await createDraftRoute(
      createRequest(JSON.stringify(draftBody({ minQty: 5, maxQty: BATCH_YIELD + 1 }))),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.maxQty).toContain(String(BATCH_YIELD));
  });

  it('refuses a minimum above the maximum', async () => {
    const response = await createDraftRoute(
      createRequest(JSON.stringify(draftBody({ minQty: 10, maxQty: 5 }))),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(Object.keys(body.fieldErrors)).toContain('minQty');
  });

  /**
   * A negative price is refused, and this was **not** true before this suite.
   *
   * `dealPriceCents` is an `Int`, `parseDraftInput` only checked `.int()`, and
   * `collectDraftFieldErrors` deliberately skips price (a draft may be
   * unprofitable) — so `-5000` was stored. Probed and confirmed against the real
   * route. Publishing such a drop is refused, so no diner was charged; the fix is
   * `.min(0)` on the schema, and the test pins the boundary in both directions.
   */
  it('refuses a negative price but still allows zero', async () => {
    const negative = await createDraftRoute(
      createRequest(JSON.stringify(draftBody({ dealPriceCents: -5000 }))),
    );
    expect(negative.status).toBe(422);
    const body = (await negative.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.dealPriceCents).toMatch(/negative/i);

    /**
     * Zero is still allowed, deliberately. `DropForm` initialises an untouched
     * price to `0` and `PATCH` sends the whole body, so a `.positive()` bound
     * would refuse a merchant on a field they never edited. The distinction the
     * schema draws is **placeholder vs corruption**.
     */
    const zero = await makeDraft({ dealPriceCents: 0 });
    expect(zero.dealPriceCents).toBe(0);
  });

  /**
   * The same whitespace-name defect as the items schema, on `title`.
   *
   * Both schemas had `.min(1)` before the `.trim()` in their mappers, so `'   '`
   * validated and was then stored as `''`. Fixed in both; tested in both, because
   * they are two files that can drift apart again independently.
   */
  it('refuses a whitespace-only title instead of storing an empty one', async () => {
    const response = await createDraftRoute(
      createRequest(JSON.stringify(draftBody({ title: '   ' }))),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.title).toMatch(/title/i);
  });

  /**
   * A dish outside the caller's scope is a 404, and it is a 404 rather than a 422
   * **even though the window is also invalid** — `collectDraftFieldErrors` looks up
   * the dish, and the write refuses it. The distinction matters: a 422 names fields
   * on a resource the caller cannot see.
   */
  it('refuses a draft pointing at another merchant\'s dish', async () => {
    const response = await createDraftRoute(
      createRequest(JSON.stringify(draftBody({ menuItemId: otherItemId }))),
    );
    expect(response.status).toBe(404);

    // Nothing was created.
    const strays = await prisma.drop.count({ where: { menuItemId: otherItemId } });
    expect(strays).toBe(0);
  });
});

describe('edit: the same policy, and 409 once published', () => {
  /**
   * **`PATCH` re-runs the policy checks, so a valid draft cannot be edited into an
   * invalid one.**
   *
   * Create a valid draft, then move the cutoff after the window opens. Before
   * `collectDraftFieldErrors` was shared, this PATCH succeeded and the merchant
   * discovered the problem when they pressed Publish — possibly days later, with
   * the drop already announced.
   */
  it('refuses to edit a valid draft into an impossible window', async () => {
    const drop = await makeDraft();

    const response = await patchDropRoute(
      patchRequest(
        JSON.stringify(draftBody({ cutoffAt: hoursFromNow(49), windowStart: hoursFromNow(48) })),
        drop.id,
      ),
      { params: Promise.resolve({ id: drop.id }) },
    );
    expect(response.status).toBe(422);

    // And nothing was written: a refused edit must not be a partial one.
    const stored = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.id },
      select: { cutoffAt: true, status: true },
    });
    expect(stored.status).toBe('DRAFT');
    // Still the original coherent cutoff, not the rejected one.
    expect(stored.cutoffAt.getTime()).toBeLessThan(Date.now() + 30 * MS_PER_HOUR);
  });

  /**
   * **Editing a published drop is a 409, not a 422, and the difference is the
   * point.**
   *
   * The body is perfectly valid — that is what makes 422 a lie about where the
   * problem is. No different body would be accepted, because the obstacle is the
   * drop's *state*. A client that retries a 422 with corrected fields would loop
   * forever here.
   *
   * `updateDraft` throws `AppError.conflict`, which `errorResponse` maps to 409.
   * The assertion is on the status, because `rejects.toThrow(/already live/)` in
   * the unit suite would pass against a 422 — which is precisely how the publish
   * path shipped `NOT_DRAFT` as a 422 for months.
   */
  it('refuses to edit a published drop with 409', async () => {
    const drop = await makeDraft();

    // Publish it out of band, so this suite does not depend on the publish route's
    // Stripe onboarding seam. The state is what matters, not how it arrived.
    await prisma.drop.update({
      where: { id: drop.id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        guardrailSnapshot: { minViablePriceCents: 1112 },
      },
    });

    const response = await patchDropRoute(
      patchRequest(JSON.stringify(draftBody({ title: `${PREFIX} rewritten live` })), drop.id),
      { params: Promise.resolve({ id: drop.id }) },
    );

    expect(response.status).toBe(409);
    expect(response.status).not.toBe(422);

    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/already live/i);

    // The live drop's terms are untouched — this is the whole reason for the
    // refusal, so it is asserted rather than assumed.
    const stored = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.id },
      select: { title: true, dealPriceCents: true, guardrailSnapshot: true },
    });
    expect(stored.title).toBe(drop.title);
    expect(stored.dealPriceCents).toBe(drop.dealPriceCents);
    expect(stored.guardrailSnapshot).toEqual({ minViablePriceCents: 1112 });
  });

  it('edits a draft and returns it', async () => {
    const drop = await makeDraft();

    const response = await patchDropRoute(
      patchRequest(
        JSON.stringify(draftBody({ title: `${PREFIX} renamed drop`, dealPriceCents: 1250 })),
        drop.id,
      ),
      { params: Promise.resolve({ id: drop.id }) },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as DropBody;
    expect(body.drop.title).toBe(`${PREFIX} renamed drop`);
    expect(body.drop.dealPriceCents).toBe(1250);
    // Still a draft: editing is not publishing.
    expect(body.drop.status).toBe('DRAFT');
    expect(body.drop.publishedAt).toBeNull();
  });

  /**
   * Ownership before parsing, on this route too: a foreign id with a malformed
   * body must be 404, never a 422 that confirms the id resolved.
   */
  it('answers 404 for a foreign drop even with an invalid body', async () => {
    const foreign = await prisma.drop.create({
      data: {
        merchantId: otherMerchantId,
        menuItemId: otherItemId,
        publicCode: `${PREFIX}OTH${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        title: `${PREFIX} foreign drop`,
        dealPriceCents: 1500,
        minQty: 2,
        maxQty: 5,
        maxPerCustomer: 4,
        windowStart: new Date(Date.now() + 48 * MS_PER_HOUR),
        windowEnd: new Date(Date.now() + 50 * MS_PER_HOUR),
        cutoffAt: new Date(Date.now() + 24 * MS_PER_HOUR),
        status: 'DRAFT',
        guardrailSnapshot: {},
      },
      select: { id: true },
    });

    const response = await patchDropRoute(
      patchRequest(JSON.stringify({ title: '', dealPriceCents: -1 }), foreign.id),
      { params: Promise.resolve({ id: foreign.id }) },
    );
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).not.toBe('VALIDATION');
  });

  /**
   * **The scope filter is symmetric**, and only testing one direction would not
   * say so.
   *
   * The test above signs in as the owner and reaches for another merchant's dish.
   * This one signs in as that merchant and reaches back for the owner's draft — the
   * direction that catches a filter written as `merchantId: merchantIds[0]`, which
   * passes whenever the caller happens to be the first merchant in the table.
   */
  it('answers 404 when the other tenant reaches for this merchant\'s draft', async () => {
    const mine = await makeDraft();

    currentSession = sessionFor(otherOwnerUserId);

    const read = await getDropRoute(
      new NextRequest(`http://localhost:3000/api/merchant/drops/${mine.id}`),
      { params: Promise.resolve({ id: mine.id }) },
    );
    expect(read.status).toBe(404);

    const write = await patchDropRoute(
      patchRequest(JSON.stringify(draftBody({ title: 'taken over' })), mine.id),
      { params: Promise.resolve({ id: mine.id }) },
    );
    expect(write.status).toBe(404);

    const stored = await prisma.drop.findUniqueOrThrow({
      where: { id: mine.id },
      select: { title: true, status: true },
    });
    expect(stored.title).toBe(mine.title);
    expect(stored.status).toBe('DRAFT');
  });

  it('answers 404 for a drop that does not exist at all', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const response = await patchDropRoute(
      patchRequest(JSON.stringify(draftBody()), missing),
      { params: Promise.resolve({ id: missing }) },
    );
    expect(response.status).toBe(404);
  });
});

describe('reads are scoped', () => {
  it('returns the caller\'s own draft on GET', async () => {
    const drop = await makeDraft();

    const response = await getDropRoute(
      new NextRequest(`http://localhost:3000/api/merchant/drops/${drop.id}`),
      { params: Promise.resolve({ id: drop.id }) },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as DropBody;
    expect(body.drop.id).toBe(drop.id);
    expect(body.drop.merchantId).toBe(merchantId);
  });

  /**
   * A GET is a read, so the write gate must not apply — an impersonating admin is
   * *supposed* to be able to look. This is the control for the 403 test below: if
   * both were refused, the read gate would be indistinguishable from a broken one.
   */
  it('allows an impersonating admin to read, and refuses to let them write', async () => {
    const drop = await makeDraft();

    currentSession = {
      ...newImpersonationSession({
        merchantUserId: ownerUserId,
        actorUserId: ownerUserId,
        auditId: '88888888-8888-4888-8888-888888888888',
      }),
    };

    const read = await getDropRoute(
      new NextRequest(`http://localhost:3000/api/merchant/drops/${drop.id}`),
      { params: Promise.resolve({ id: drop.id }) },
    );
    expect(read.status).toBe(200);

    const write = await patchDropRoute(
      patchRequest(JSON.stringify(draftBody({ title: `${PREFIX} by an admin` })), drop.id),
      { params: Promise.resolve({ id: drop.id }) },
    );
    expect(write.status).toBe(403);

    // FR-904's read-only rule, enforced — and the drop is unchanged.
    const stored = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.id },
      select: { title: true },
    });
    expect(stored.title).toBe(drop.title);
  });

  it('refuses an anonymous caller with 401', async () => {
    currentSession = null;
    const response = await createDraftRoute(createRequest(JSON.stringify(draftBody())));
    expect(response.status).toBe(401);
  });

  it('refuses a non-merchant role', async () => {
    currentSession = { ...sessionFor(ownerUserId), role: 'ORGANISER' };
    const response = await createDraftRoute(createRequest(JSON.stringify(draftBody())));
    expect(response.status).not.toBe(201);
  });
});
