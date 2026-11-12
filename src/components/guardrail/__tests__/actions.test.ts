import 'dotenv/config';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `previewFloorAction` — the INFEASIBLE escape hatch's preview (Q-6).
 *
 * ## Why this file exists
 *
 * The action's only caller is `FloorEscapeHatch.tsx`, a `'use client'` component with
 * hooks. `environment: 'node'` means no test can render it, so before this file the
 * action executed **zero statements** in a 2 764-test suite. It was not *believed* to
 * be dead; it was measured dead. A server action is a public endpoint, and an endpoint
 * nothing executes is an endpoint whose four return paths are all unverified.
 *
 * ## What is mocked, and what is therefore actually under test
 *
 * Three seams, the same three every authorisation test in this repo replaces:
 * `server-only` (a build marker), `next/cache` (there is no router cache to revalidate)
 * and `getSession` (there is no cookie jar). `requireMerchant` itself is real, so the
 * scope list the action filters by is resolved from real `MerchantUser` rows — which is
 * what makes the foreign-dish test below a test of *the action*, not of a stub.
 *
 * Everything else is real: `findItem`, `getFloor` (including the `Decimal` → `number`
 * conversion), `evaluateItem`, `roundHalfUp`. The arithmetic is the thing being wired,
 * and hard-coding its output here would only assert that a literal equals itself.
 *
 * ## The rounding order, which is the subtlest thing in the function
 *
 * `const candidatePct = Math.round(args.candidatePct)` runs **before** the 1–100 range
 * check. So `0.6` becomes `1` and is accepted, `0.4` becomes `0` and is refused, and
 * `100.4` becomes `100` and is accepted while `100.6` becomes `101` and is refused. All
 * four are asserted, because a refactor that validated first would keep every other
 * test in this file green.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sessionState: {
  session: { userId: string; role: string; mustChangePassword: boolean } | null;
} = { session: null };

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { previewFloorAction } = await import('@/components/guardrail/actions');
const { createItem, findItem } = await import('@/lib/db/items');
const { evaluateItem } = await import('@/lib/items/evaluate');
const { roundHalfUp } = await import('@/lib/guardrail');
const { AppError } = await import('@/lib/errors');

type PreviewOk = { ok: true; candidatePct: number; minViablePriceCents: number; keepCents: number; currentFloorCents: number };
type FloorPreview = PreviewOk | { ok: false; message: string };

/** `asserts` so the success branch below is narrowed by the compiler, not by a cast. */
function assertOk(result: FloorPreview): asserts result is PreviewOk {
  expect(result.ok).toBe(true);
}

const PREFIX = `flooract${Date.now().toString(36).slice(-5)}`;

/** The merchant we act as. Its floor is 0.30 — deliberately not the 0.25 default. */
const CURRENT_FLOOR_PCT = 0.3;
let merchantId = '';
let ownerId = '';
let itemId = '';
/** A dish belonging to a merchant this session cannot reach. */
let foreignItemId = '';
const userIds: string[] = [];
const merchantIds: string[] = [];

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  ownerId = user.id;
  userIds.push(user.id);

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} kitchen`,
      slug: `${PREFIX}-slug`,
      status: 'ACTIVE',
      // Not `DEFAULT_FLOOR_PCT`. At 0.30 the current floor is 480¢ on a 1 600¢ dish;
      // the candidate used in the happy path (25%) keeps 401¢. Picking the default
      // would make `currentFloorCents` and `keepCents` collide for a 25% candidate and
      // the "they are different numbers" assertion would be vacuous.
      floorPctOfMenu: CURRENT_FLOOR_PCT,
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantId = merchant.id;
  merchantIds.push(merchant.id);

  const item = await createItem([merchant.id], {
    name: `${PREFIX} beef bowl`,
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });
  itemId = item.id;

  // A second merchant with its own dish. No user: the point is that *our* session
  // cannot reach it, so the row that matters is the `MerchantUser` we do not create.
  const foreign = await prisma.merchant.create({
    data: {
      name: `${PREFIX} rivals`,
      slug: `${PREFIX}-rivals`,
      status: 'ACTIVE',
      floorPctOfMenu: CURRENT_FLOOR_PCT,
    },
    select: { id: true },
  });
  merchantIds.push(foreign.id);
  const foreignItem = await createItem([foreign.id], {
    name: `${PREFIX} rival bowl`,
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });
  foreignItemId = foreignItem.id;
});

beforeEach(() => {
  sessionState.session = { userId: ownerId, role: 'MERCHANT', mustChangePassword: false };
});

afterAll(async () => {
  // By tenant, in FK order. This file writes none of Order / DropParticipant /
  // ShareLink / Drop / Customer / OrganiserProfile, but the residue gate counts all
  // thirteen tables and only `auditLogs` may be non-zero, so every one is cleared
  // explicitly rather than assumed empty.
  if (merchantIds.length > 0) {
    await prisma.order
      .deleteMany({ where: { drop: { merchantId: { in: merchantIds } } } })
      .catch(() => undefined);
    await prisma.dropParticipant
      .deleteMany({ where: { drop: { merchantId: { in: merchantIds } } } })
      .catch(() => undefined);
    await prisma.shareLink
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
    await prisma.drop
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
    await prisma.menuItem
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
    await prisma.merchantUser
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('previewFloorAction — a floor that works', () => {
  it('reports the numbers evaluateItem produces for the same dish and floor', async () => {
    const result = await previewFloorAction({ itemId, candidatePct: 25 });
    assertOk(result);

    /**
     * Recomputed, not hard-coded. The claim is "the action wires `evaluateItem` and
     * `roundHalfUp` together correctly"; a literal like `1112` would also pass for a
     * refactor that returned the right cents by coincidence, and would fail for a
     * correct refactor that changed the fixture. This assertion is false for any
     * action that assembles its own arithmetic.
     */
    const item = await findItem([merchantId], itemId);
    expect(item).not.toBeNull();
    const evaluation = evaluateItem({ item: item!, floorPctOfMenu: 25 / 100 });
    expect(evaluation.view).not.toBeNull();

    expect(result.candidatePct).toBe(25);
    expect(result.minViablePriceCents).toBe(evaluation.view!.minViablePriceCents);
    expect(result.keepCents).toBe(evaluation.view!.breakdown.netContributionCents);
    // 1 112¢ and 401¢ — pinned as literals too, so a change to `evaluateItem` itself
    // cannot silently redefine what this test accepted.
    expect(result.minViablePriceCents).toBe(1112);
    expect(result.keepCents).toBe(401);
  });

  it('reports the merchant’s saved floor as a money figure, distinct from the candidate', async () => {
    const result = await previewFloorAction({ itemId, candidatePct: 25 });
    assertOk(result);

    // The item costs 1 600¢ and the saved floor is 30%, so the current floor is 480¢.
    // Asserted as the expression rather than the number: `roundHalfUp(menu × pct)` is
    // the contract, and a wrong expression (a raw `Math.floor`, a percent of a
    // percent) is exactly the mutation this is here to catch.
    expect(result.currentFloorCents).toBe(roundHalfUp(1600 * CURRENT_FLOOR_PCT));
    expect(result.currentFloorCents).toBe(480);

    // The fixture guard. If these ever coincide the two assertions above stop
    // distinguishing "the floor" from "what the merchant keeps" and a swap of the two
    // fields would pass.
    expect(result.currentFloorCents).not.toBe(result.keepCents);
  });
});

describe('previewFloorAction — what it refuses', () => {
  it('refuses a dish id that does not exist', async () => {
    const result = await previewFloorAction({ itemId: `${PREFIX}-no-such-item`, candidatePct: 25 });

    expect(result).toEqual({ ok: false, message: 'That dish could not be found.' });
  });

  it('refuses another merchant’s dish with the same sentence as an unknown one', async () => {
    /**
     * `findItem` is scoped, and it has its own tests for that. What this asserts is
     * that the *action* passes the caller's scope through instead of resolving the item
     * by id alone — the failure mode being a preview that quotes real margins on a
     * competitor's dish. The body is compared to the unknown-dish body rather than to a
     * literal so the requirement stated is "indistinguishable", which is also what keeps
     * the id from being enumerable.
     */
    const foreign = await previewFloorAction({ itemId: foreignItemId, candidatePct: 25 });
    const missing = await previewFloorAction({ itemId: `${PREFIX}-no-such-item`, candidatePct: 25 });

    expect(foreign).toEqual({ ok: false, message: 'That dish could not be found.' });
    expect(foreign).toEqual(missing);
  });

  it('refuses a candidate that rounds below 1%, and accepts one that rounds up to it', async () => {
    // 0.4 → 0. Out of range.
    const below = await previewFloorAction({ itemId, candidatePct: 0.4 });
    expect(below).toEqual({ ok: false, message: 'Choose a minimum between 1% and 100%.' });

    /**
     * 0.6 → 1, and 1 is in range. This is the lower boundary *inclusive* plus the
     * rounding-before-validation order in one assertion: validating first would refuse
     * both, and the happy-path test above would not notice.
     */
    const above = await previewFloorAction({ itemId, candidatePct: 0.6 });
    assertOk(above);
    expect(above.candidatePct).toBe(1);
  });

  it('accepts 100.4 and refuses 100.6, because 100 is the inclusive ceiling', async () => {
    /**
     * `Math.round(100.4) === 100`, `Math.round(100.6) === 101`.
     *
     * At a 100% floor no dish can ever clear it — `contributionAt(menuPrice)` is
     * `menuPrice − costs − fees`, strictly less than `menuPrice`, which is the floor
     * itself — so "accepted" here cannot mean `ok: true`. What it means, and what is
     * asserted, is that 100.4 **clears the range gate** and reaches the feasibility
     * path, whose sentence names the post-rounding 100. A `> 100` → `>= 100` style
     * off-by-one, or a `>= 101`, produces the range sentence instead and fails below.
     */
    const justInside = await previewFloorAction({ itemId, candidatePct: 100.4 });
    expect(justInside.ok).toBe(false);
    if (justInside.ok) throw new Error('unreachable: the type narrows above');
    expect(justInside.message).toBe(
      "At a 100% minimum this dish still can't be a deal. A cheaper ingredient cost is the other way out.",
    );

    const justOutside = await previewFloorAction({ itemId, candidatePct: 100.6 });
    expect(justOutside).toEqual({
      ok: false,
      message: 'Choose a minimum between 1% and 100%.',
    });
  });

  it('says the dish still cannot be a deal when the floor is too high, naming the rounded percent', async () => {
    // 59.6 → 60, and at a 60% floor (960¢ of a 1 600¢ dish) the scan finds no price.
    const result = await previewFloorAction({ itemId, candidatePct: 59.6 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable: the type narrows above');
    expect(result.message).toBe(
      "At a 60% minimum this dish still can't be a deal. A cheaper ingredient cost is the other way out.",
    );
    // The sentence must quote the percent the evaluation actually used, not the raw
    // argument — a caller who typed 59.6 must not be told about a floor of 59.6%.
    expect(result.message).toContain('60%');
    expect(result.message).not.toContain('59.6');
  });
});

describe('previewFloorAction — the gate', () => {
  it('rejects without a session, before touching the item', async () => {
    sessionState.session = null;

    /**
     * `requireMerchant` → `requireSession` → `AppError.unauthorized()`, a 401 whose
     * public message is the generic sign-in sentence. Asserted against the real error
     * class rather than a guessed shape, so a change to the gate surfaces here rather
     * than as a test that happens to still match `{ status: 401 }`.
     */
    const call = previewFloorAction({ itemId, candidatePct: 25 });

    await expect(call).rejects.toBeInstanceOf(AppError);
    await expect(call).rejects.toMatchObject({
      status: 401,
      publicMessage: 'Please sign in to continue.',
    });
  });
});
