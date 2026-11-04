import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { newImpersonationSession } from '@/lib/auth/jwt';

import { POST as createItemRoute } from '../route';
import { GET as getItemRoute, PATCH as patchItemRoute } from '../[id]/route';

/**
 * `POST /api/merchant/items` and `PATCH /api/merchant/items/:id` — the two routes
 * through which a merchant's cost data enters the system.
 *
 * > `FR-104 | Merchant creates MenuItems with cost data | All of menuPriceCents,
 * > foodCostCents, packagingCents, batchYield required.`
 * > — PRD-v1.md
 *
 * FR-104 is the requirement the **entire guardrail** is a consumer of. Every
 * margin, every `minViablePriceCents`, every publish refusal downstream is
 * arithmetic over these four numbers. If a body can arrive with a missing cost, a
 * negative cost, or a cost that exceeds the price, then the guardrail is not
 * protecting money — it is formatting an answer about numbers that were never
 * true. So this suite is mostly about what the body may **not** do.
 *
 * ## The three claims under test
 *
 *   1. **The cost invariant is enforced at the write, not at the publish.** The
 *      same `validateItemCosts` the browser form runs is re-run here (AC-9, A-1).
 *      A merchant cannot save `foodCost + packaging >= menuPrice` and discover the
 *      problem days later, on a draft they have already announced.
 *   2. **The body cannot decide who owns the row.** `merchantId`, `id`,
 *      `archivedAt` and `photoUrl` are not in the schema. Zod strips unknown keys,
 *      so a body that names them is silently ignored rather than obeyed — and the
 *      tests below assert the *stored* row, because "the response did not echo it"
 *      is compatible with "the database stored it".
 *   3. **A foreign id is a 404, and ownership is checked before the body is
 *      parsed.** The second half is the interesting one: if a foreign id with a
 *      malformed body returned 422, the error shape would confirm the id exists.
 *
 * ## What is replaced
 *
 * `getSession` (the seam `authorize.ts` reads through) and the analytics `emit`.
 * Nothing else. The scope lookup, `getItem`'s `merchantId: { in: ... }` filter,
 * `getFloor`'s `Decimal`→number conversion, `createItem`/`updateItem`, the Zod
 * schemas and the guardrail arithmetic are all production code against real rows.
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

const PREFIX = `itm${Date.now().toString(36).slice(-5)}`;

const merchantIds: string[] = [];
const userIds: string[] = [];

/** The merchant under test, floor 25%. */
let merchantId = '';
let ownerUserId = '';

/** A second tenant, to prove the scope filter and the 404-not-403 rule are real. */
let otherMerchantId = '';
let otherOwnerUserId = '';
let otherItemId = '';

function sessionFor(userId: string): MockSessionInput {
  return {
    userId,
    role: 'MERCHANT',
    mustChangePassword: false,
    absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

/** A valid create body: $16.00 menu, $4.80 food, $0.80 packaging. */
function itemBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${PREFIX} noodle bowl`,
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 60,
    ...overrides,
  };
}

function request(raw: string | null, path = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/merchant/items${path}`, {
    method: path === '' ? 'POST' : 'PATCH',
    headers: { 'content-type': 'application/json' },
    ...(raw === null ? {} : { body: raw }),
  });
}

type ItemBody = {
  item: {
    id: string;
    merchantId: string;
    name: string;
    menuPriceCents: number;
    foodCostCents: number;
    packagingCents: number;
    batchYield: number;
    containsAlcohol: boolean;
    archivedAt: string | null;
  };
  evaluation?: {
    state: string;
    view: { minViablePriceCents: number | null } | null;
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
});

beforeEach(() => {
  currentSession = sessionFor(ownerUserId);
  emitted.length = 0;
});

afterAll(async () => {
  /**
   * Cleanup is **by tenant**, not by an id list.
   *
   * Tests in this file deliberately POST bodies they expect to be refused, and do
   * not register an id because a correct implementation creates nothing. Under a
   * mutation probe one of those calls succeeds, and the row it wrote would stay
   * behind if cleanup only knew about registered ids. That is not hypothetical — it
   * is what left 14 `DRAFT` drops in the dev database during this slice's sweep,
   * which then failed an unrelated admin suite that asserts the table holds none.
   *
   * Scoping the delete to this suite's own merchants keeps cleanup correct
   * regardless of which assertions passed.
   */
  if (merchantIds.length > 0) {
    await prisma.drop
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
    await prisma.menuItem
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('create: the cost invariant is the point', () => {
  /** The happy path, because every refusal below is only meaningful against it. */
  it('creates a dish and returns its id with an evaluation', async () => {
    const response = await createItemRoute(request(JSON.stringify(itemBody())));
    expect(response.status).toBe(201);

    const body = (await response.json()) as ItemBody;

    expect(body.item.name).toBe(`${PREFIX} noodle bowl`);
    expect(body.item.merchantId).toBe(merchantId);
    // The evaluation travels with the item so the panel needs no second round trip.
    expect(body.evaluation).toBeDefined();
    // $16.00 menu / $4.80 food / $0.80 packaging at a 25% floor.
    expect(body.evaluation?.view?.minViablePriceCents).toBe(1112);
  });

  /**
   * **FR-104's four required fields, one at a time.**
   *
   * Each is asserted separately rather than in a loop with a joined message,
   * because the failure this guards is a schema that requires three of the four —
   * exactly what happens when someone adds a new cost field and forgets the
   * `.positive()`/presence pairing.
   */
  it('refuses a missing cost field, naming it', async () => {
    for (const field of ['menuPriceCents', 'foodCostCents', 'packagingCents', 'batchYield']) {
      const body = itemBody();
      delete body[field];

      const response = await createItemRoute(request(JSON.stringify(body)));
      expect(response.status, `${field} missing should be a 422`).toBe(422);

      const payload = (await response.json()) as { fieldErrors: Record<string, string> };
      expect(Object.keys(payload.fieldErrors)).toContain(field);
    }
  });

  /**
   * `foodCost + packaging >= menuPrice` is the P0 invariant (PRD-sprint1 §7.4).
   *
   * The boundary is tested at the exact cent because the comparison is `>=`:
   * `1520 + 80 === 1600` must be refused, and `1519 + 80 === 1599` must be
   * accepted. An off-by-one here is a `>` where `>=` belongs, and it would let a
   * dish through on which the merchant makes precisely nothing.
   */
  it('refuses a cost that equals the menu price, and accepts one cent less', async () => {
    const atTheLine = await createItemRoute(
      request(JSON.stringify(itemBody({ foodCostCents: 1520 }))),
    );
    expect(atTheLine.status).toBe(422);
    const payload = (await atTheLine.json()) as { fieldErrors: Record<string, string> };
    expect(payload.fieldErrors.foodCostCents).toMatch(/cost more than the dish sells for/i);

    const oneCentUnder = await createItemRoute(
      request(JSON.stringify(itemBody({ foodCostCents: 1519 }))),
    );
    expect(oneCentUnder.status).toBe(201);
  });

  it('refuses a negative cost and a negative or zero menu price', async () => {
    const negative = await createItemRoute(
      request(JSON.stringify(itemBody({ foodCostCents: -1 }))),
    );
    expect(negative.status).toBe(422);

    for (const menuPriceCents of [0, -1]) {
      const response = await createItemRoute(
        request(JSON.stringify(itemBody({ menuPriceCents }))),
      );
      expect(response.status, `menuPriceCents=${menuPriceCents} should be a 422`).toBe(422);
    }
  });

  /**
   * A **whitespace-only name is not a name.**
   *
   * This was a real defect, found by probing the parser rather than by reading it.
   * `.min(1)` ran *before* the `.trim()` in the mapper, so `'   '` satisfied the
   * length check and was then trimmed to `''` — a dish stored with a blank name,
   * which is a row no screen can render and no search can find. The fix moves
   * `.trim()` into the schema so it runs before `.min(1)`.
   *
   * The assertion is on the **400-level refusal**, not on a stored `''`, because
   * refusing at the write is the only answer that keeps the table clean.
   */
  it('refuses a whitespace-only name instead of storing an empty one', async () => {
    const response = await createItemRoute(request(JSON.stringify(itemBody({ name: '   ' }))));
    expect(response.status).toBe(422);

    const payload = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(payload.fieldErrors.name).toMatch(/name/i);
  });

  /**
   * The body may set a name, and it may set **nothing else about identity**.
   *
   * `merchantId` is the field worth naming: `createItem` takes it from
   * `merchantIds[0]`, which comes from the session, so a body that supplies one is
   * either ignored or a cross-tenant write. The assertion is on the **stored row**,
   * not the response: `z.object` strips unknown keys, so the response could look
   * clean while a spread further down wrote the body's value. Probed — adding
   * `merchantId` to the body leaves it in the other merchant's kitchen only if the
   * route spreads; this pins that it does not.
   */
  it('ignores a body-supplied merchantId, id, and archivedAt', async () => {
    const response = await createItemRoute(
      request(
        JSON.stringify(
          itemBody({
            merchantId: otherMerchantId,
            id: '00000000-0000-4000-8000-000000000001',
            archivedAt: '2020-01-01T00:00:00.000Z',
            photoUrl: 'https://evil.example/x.png',
          }),
        ),
      ),
    );
    expect(response.status).toBe(201);

    const created = (await response.json()) as ItemBody;

    // Read the row back, not the response.
    const stored = await prisma.menuItem.findUniqueOrThrow({
      where: { id: created.item.id },
      select: {
        merchantId: true,
        archivedAt: true,
        photoUrl: true,
        id: true,
      },
    });

    expect(stored.merchantId).toBe(merchantId);
    expect(stored.merchantId).not.toBe(otherMerchantId);
    // The id the body wanted is not the id the row got.
    expect(stored.id).not.toBe('00000000-0000-4000-8000-000000000001');
    // Not archived: a body cannot hide a new dish from its own list.
    expect(stored.archivedAt).toBeNull();
    expect(stored.photoUrl).toBeNull();
  });

  /** A body that is not JSON at all is a 422, not a 500. */
  it('answers 422 for a body that cannot be parsed', async () => {
    for (const raw of ['not json at all', '', '[]']) {
      const response = await createItemRoute(request(raw));
      expect(response.status, `raw=${JSON.stringify(raw)}`).toBe(422);
    }
  });
});

describe('update: the same predicate, and the alcohol trail', () => {
  let editableId = '';

  beforeAll(async () => {
    const item = await prisma.menuItem.create({
      data: {
        merchantId,
        name: `${PREFIX} editable bowl`,
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 60,
        isBatchable: true,
        containsAlcohol: false,
      },
      select: { id: true },
    });
    editableId = item.id;
  });

  it('updates the dish and re-evaluates it', async () => {
    const response = await patchItemRoute(
      request(JSON.stringify(itemBody({ name: `${PREFIX} renamed`, foodCostCents: 400 })), `/${editableId}`),
      { params: Promise.resolve({ id: editableId }) },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as ItemBody;
    expect(body.item.name).toBe(`${PREFIX} renamed`);
    expect(body.item.foodCostCents).toBe(400);
    expect(body.evaluation).toBeDefined();
  });

  /** PATCH runs the identical invariant the POST does. */
  it('refuses the cost invariant on update too', async () => {
    const response = await patchItemRoute(
      request(JSON.stringify(itemBody({ foodCostCents: 1600, packagingCents: 0 })), `/${editableId}`),
      { params: Promise.resolve({ id: editableId }) },
    );
    expect(response.status).toBe(422);

    // And the row is unchanged — a rejected update must not be a partial one.
    const stored = await prisma.menuItem.findUniqueOrThrow({
      where: { id: editableId },
      select: { foodCostCents: true, packagingCents: true },
    });
    expect(stored).toEqual({ foodCostCents: 400, packagingCents: 80 });
  });

  /**
   * **S1-025: the alcohol-flag transition is recorded in both directions.**
   *
   * The flag matters because an alcohol-containing dish cannot be a drop (AGLC),
   * and liquor liability sits with the merchant — so the audit trail has to say
   * who cleared it and when, before the first incident rather than after it.
   *
   * Both directions are exercised because the guard is `from === to` (an early
   * return), and a one-directional test passes against an implementation that only
   * records `false → true`.
   */
  it('records an alcohol flag change going up and coming back down', async () => {
    emitted.length = 0;

    const on = await patchItemRoute(
      request(JSON.stringify(itemBody({ name: `${PREFIX} editable bowl`, containsAlcohol: true })), `/${editableId}`),
      { params: Promise.resolve({ id: editableId }) },
    );
    expect(on.status).toBe(200);
    const up = emitted.filter((entry) => entry.event === 'item_alcohol_flag_changed');
    expect(up).toHaveLength(1);
    expect(up[0]?.payload.from).toBe(false);
    expect(up[0]?.payload.to).toBe(true);
    expect(up[0]?.payload.itemId).toBe(editableId);
    expect(up[0]?.payload.actorUserId).toBe(ownerUserId);

    emitted.length = 0;

    const off = await patchItemRoute(
      request(JSON.stringify(itemBody({ name: `${PREFIX} edible bowl`, containsAlcohol: false })), `/${editableId}`),
      { params: Promise.resolve({ id: editableId }) },
    );
    expect(off.status).toBe(200);
    const down = emitted.filter((entry) => entry.event === 'item_alcohol_flag_changed');
    expect(down).toHaveLength(1);
    expect(down[0]?.payload.from).toBe(true);
    expect(down[0]?.payload.to).toBe(false);
  });

  /**
   * An unchanged flag is **not** a transition, and must not be recorded.
   *
   * Without this, `recordAlcoholFlagChange` could drop its `from === to` guard and
   * every save would write an audit row. The table would fill with non-events, and
   * the one row that matters — the actual flip — would be invisible in the noise.
   */
  it('records nothing when the flag does not move', async () => {
    emitted.length = 0;
    const response = await patchItemRoute(
      request(JSON.stringify(itemBody({ name: `${PREFIX} edible bowl`, containsAlcohol: false })), `/${editableId}`),
      { params: Promise.resolve({ id: editableId }) },
    );
    expect(response.status).toBe(200);
    expect(emitted.filter((entry) => entry.event === 'item_alcohol_flag_changed')).toHaveLength(0);
  });
});

describe('scope: foreign ids are 404, and ownership precedes parsing', () => {
  /**
   * **The scope filter is symmetric**, and testing only one direction would not
   * say so.
   *
   * The tests above sign in as merchant A and reach for B's dish. This one signs in
   * as B and reaches for A's — the same code path, but the direction that catches a
   * filter written as `merchantId: merchantIds[0]` (a single-value comparison that
   * happens to pass when the first merchant is the one under test) rather than
   * `{ in: merchantIds }`.
   */
  it('answers 404 when the other tenant reaches for this merchant\'s dish', async () => {
    const mine = await prisma.menuItem.create({
      data: {
        merchantId,
        name: `${PREFIX} mine only`,
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 60,
        isBatchable: true,
        containsAlcohol: false,
      },
      select: { id: true },
    });

    currentSession = sessionFor(otherOwnerUserId);

    const read = await getItemRoute(
      new NextRequest(`http://localhost:3000/api/merchant/items/${mine.id}`),
      { params: Promise.resolve({ id: mine.id }) },
    );
    expect(read.status).toBe(404);

    const write = await patchItemRoute(
      request(JSON.stringify(itemBody({ name: 'taken over' })), `/${mine.id}`),
      { params: Promise.resolve({ id: mine.id }) },
    );
    expect(write.status).toBe(404);

    // Untouched, from either direction.
    const stored = await prisma.menuItem.findUniqueOrThrow({
      where: { id: mine.id },
      select: { name: true },
    });
    expect(stored.name).toBe(`${PREFIX} mine only`);
  });

  it('answers 404 for another merchant\'s dish on read', async () => {
    const response = await getItemRoute(
      new NextRequest(`http://localhost:3000/api/merchant/items/${otherItemId}`),
      { params: Promise.resolve({ id: otherItemId }) },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/could not be found/i);
  });

  it('answers 404 for another merchant\'s dish on write, and changes nothing', async () => {
    const before = await prisma.menuItem.findUniqueOrThrow({
      where: { id: otherItemId },
      select: { name: true, foodCostCents: true },
    });

    const response = await patchItemRoute(
      request(JSON.stringify(itemBody({ name: 'hijacked' })), `/${otherItemId}`),
      { params: Promise.resolve({ id: otherItemId }) },
    );
    expect(response.status).toBe(404);
    // The distinction from a 403 is the point: a 403 confirms the id exists.
    expect(response.status).not.toBe(403);

    const after = await prisma.menuItem.findUniqueOrThrow({
      where: { id: otherItemId },
      select: { name: true, foodCostCents: true },
    });
    expect(after).toEqual(before);
  });

  /**
   * **Ownership is checked before the body is parsed**, and this is the test that
   * says so.
   *
   * A foreign id *with a malformed body* must still be a 404. If the route parsed
   * first, the answer would be 422 with a `fieldErrors` map — which tells the
   * caller that the id resolved to a real resource, turning the endpoint into an
   * oracle for enumerating a competitor's catalogue one field at a time.
   */
  it('answers 404 for a foreign id even when the body is also invalid', async () => {
    const response = await patchItemRoute(
      request(JSON.stringify({ name: '', menuPriceCents: -1 }), `/${otherItemId}`),
      { params: Promise.resolve({ id: otherItemId }) },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    // Not 'VALIDATION' — a 422 here would leak that the id is real.
    expect(body.error).not.toBe('VALIDATION');
  });

  it('answers 404 for an id that does not exist at all', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const response = await patchItemRoute(
      request(JSON.stringify(itemBody()), `/${missing}`),
      { params: Promise.resolve({ id: missing }) },
    );
    expect(response.status).toBe(404);
  });
});

describe('the write gate', () => {
  it('refuses an impersonated session with 403', async () => {
    currentSession = {
      ...newImpersonationSession({
        merchantUserId: ownerUserId,
        actorUserId: ownerUserId,
        auditId: '77777777-7777-4777-8777-777777777777',
      }),
    };

    const response = await createItemRoute(request(JSON.stringify(itemBody())));
    expect(response.status).toBe(403);
    // Refused before the write: nothing was recorded either.
    expect(emitted).toHaveLength(0);
  });

  it('refuses an anonymous caller with 401', async () => {
    currentSession = null;
    const response = await createItemRoute(request(JSON.stringify(itemBody())));
    expect(response.status).toBe(401);
  });

  it('refuses a non-merchant role', async () => {
    currentSession = { ...sessionFor(ownerUserId), role: 'ADMIN' };
    const response = await createItemRoute(request(JSON.stringify(itemBody())));
    expect(response.status).not.toBe(201);
  });

  /**
   * A merchant session that resolves to **no** merchant rows has an empty scope,
   * and `primaryMerchantId` refuses it rather than defaulting to the first merchant
   * in the table. That default is the shape of a cross-tenant bug, so it gets a
   * test of its own.
   */
  it('refuses a merchant account with no merchant row', async () => {
    const orphan = await prisma.user.create({
      data: {
        email: `${PREFIX}-orphan@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    userIds.push(orphan.id);

    // Counted before and after, so the assertion is a *difference* rather than a
    // quantity that earlier tests in this file also contribute to. Comparing a
    // number to itself would pass against any implementation.
    const countItems = (): Promise<number> =>
      prisma.menuItem.count({ where: { merchantId: { in: [merchantId, otherMerchantId] } } });

    const before = await countItems();

    currentSession = sessionFor(orphan.id);
    const response = await createItemRoute(request(JSON.stringify(itemBody())));
    expect(response.status).toBe(404);

    // An empty scope means nothing was written anywhere — not "written under the
    // first merchant in the table", which is the bug this pins.
    expect(await countItems()).toBe(before);
  });
});
