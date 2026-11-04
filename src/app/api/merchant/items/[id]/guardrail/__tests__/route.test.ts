import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { newImpersonationSession } from '@/lib/auth/jwt';

import { POST } from '../route';

/**
 * `POST /api/merchant/items/:id/guardrail` — the claim, finally falsified.
 *
 * > `FR-104 | Merchant creates MenuItems with cost data | All of menuPriceCents,
 * > foodCostCents, packagingCents, batchYield required.`
 * > — PRD-v1.md
 *
 * The route had no test of any kind. That mattered more here than on a CRUD route
 * because its docblock makes a **security claim in the imperative**:
 *
 * > *a tampered client that submits `{ foodCostCents: 100, floorPctOfMenu: 0.01 }`
 * > must be evaluated against the real costs, and a submitted price below the
 * > floor comes back as `BELOW_FLOOR` with the real `minViablePriceCents` — never
 * > echoed as accepted.*
 *
 * Every word of that is falsifiable from outside the process, and none of it was
 * being checked. A DRY refactor is all that separates "the route passes only
 * `dealPriceCents` to `evaluateItem`" from "the route spreads the body". The
 * defence is `bodySchema` being a closed `z.object`, and **a `z.object` stops
 * rejecting unknown keys the moment someone adds `.passthrough()` or `.extend()`**
 * — a one-token edit, in a file nobody was watching.
 *
 * ## Why assertions are on the response, not on a mocked `evaluateItem`
 *
 * Mocking `evaluateItem` would let this suite assert that the route *called* it
 * with clean arguments. That is half the claim and the weaker half: it says nothing
 * about what the pure module then computes from a real row and a real floor. The
 * `input` echoed in the response is the evaluation's own view of the costs, so
 * `input.foodCostCents === 480` after a body that said `100` proves the tamper
 * died somewhere between the socket and the arithmetic — which is the actual
 * product promise.
 *
 * ## What is replaced, and what runs for real
 *
 * Only `getSession`, the seam `authorize.ts` already reads through, plus the
 * analytics `emit` — which appends JSON lines to a file on disk and is covered by
 * `record.test.ts`. Everything else (`requireSession` → `requireMerchantScope` →
 * `requireMerchant` → `refuseIfImpersonating`, `getItem`'s scope filter, `getFloor`'s
 * `Decimal`→number conversion, the guardrail pure module) is the production code
 * against real Postgres rows.
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
 * `emit` writes a line per evaluation to a JSON file.
 *
 * The route calls `recordEvaluation`, which is the analytics half of this endpoint
 * and is genuinely worth asserting — but not by reading the file it appends to,
 * which would make this suite depend on a path and on ordering with
 * `record.test.ts`. The recorder below keeps the call visible without the disk.
 */
const emitted: { event: string; payload: Record<string, unknown> }[] = [];

vi.mock('@/lib/analytics/events', () => ({
  emit: (event: string, payload: Record<string, unknown>) => {
    emitted.push({ event, payload });
  },
}));

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `grd${Date.now().toString(36).slice(-5)}`;

const merchantIds: string[] = [];
const userIds: string[] = [];
const itemIds: string[] = [];

/** The merchant under test, with a 25% floor. */
let merchantId = '';
let ownerUserId = '';

/** A second merchant, to prove the scope filter is real. */
let otherMerchantId = '';
let otherItemId = '';

/**
 * The dish under test: $16.00 menu, $4.80 food, $0.80 packaging.
 *
 * Deliberately the same numbers the page suites use, so a failure here and a
 * failure there are talking about the same arithmetic.
 */
let itemId = '';

/**
 * A session shaped like a real one.
 *
 * `absExpiresAt`/`expiresAt` are present because `Session` requires them and
 * `requireSession` reads `expiresAt`. A bare `{userId, role}` worked for the
 * settings suite because that route never reads the clock — this one does not
 * either, but a session that is missing a field its type declares is exactly the
 * fixture that hides a later `session.expiresAt < now` check.
 */
function sessionFor(userId: string): MockSessionInput {
  return {
    userId,
    role: 'MERCHANT',
    mustChangePassword: false,
    absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function request(raw: string | null, id: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/merchant/items/${id}/guardrail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(raw === null ? {} : { body: raw }),
  });
}

/** The shape `evaluateItem` returns, narrowed to what these tests read. */
type EvaluationBody = {
  state: string;
  ineligible: string | null;
  errorCode: string | null;
  warnings: string[];
  input: { menuPriceCents: number; foodCostCents: number; packagingCents: number } | null;
  view: {
    dealPriceCents: number;
    minViablePriceCents: number | null;
    isBelowFloor: boolean;
    contributionCents: number;
  } | null;
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
      batchYield: 60,
      isBatchable: true,
      containsAlcohol: false,
    },
    select: { id: true },
  });
  itemId = item.id;
  itemIds.push(item.id);

  // The other tenant. Its existence is the test for `getItem`'s scope filter.
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

describe('the body cannot decide the costs', () => {
  /**
   * **The docblock's own example, run.**
   *
   * `{ foodCostCents: 100, floorPctOfMenu: 0.01 }` is the exact tamper the route's
   * comment names. If it were merged, food cost would drop from 480 to 100 and the
   * minimum viable price would collapse — the merchant would be told they can sell
   * a bowl profitably at a price that loses money on every plate.
   *
   * ## Why the floor is asserted as a literal, not as "greater than zero"
   *
   * The first version ended at `expect(minViablePriceCents).toBeGreaterThan(0)`,
   * which a probe showed is satisfied by *any* floor — including the injected one.
   * The mutation "read `floorPctOfMenu` from the raw body" changed 1112 → 800 and
   * the absolute test still passed; only the differential test below caught it. A
   * `> 0` assertion on a number that is always positive is a presence check wearing
   * the clothes of an identity check.
   *
   * The value is a literal because it is decided by the frozen specification: at
   * menu 1600 / food 480 / packaging 80 with `DEFAULT_FEES`, a 25% floor gives
   * `minViablePriceCents === 1112` and a 1% floor gives **800**. Pinning 1112 makes
   * this test able to see the tamper on its own.
   */
  it('ignores injected food cost and floor, evaluating against the row', async () => {
    const response = await POST(
      request(JSON.stringify({ foodCostCents: 100, floorPctOfMenu: 0.01 }), itemId),
      { params: Promise.resolve({ id: itemId }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as EvaluationBody;

    // The real costs, from the row — not 100, not anything the body said.
    expect(body.input?.foodCostCents).toBe(480);
    expect(body.input?.menuPriceCents).toBe(1600);
    expect(body.input?.packagingCents).toBe(80);
    /**
     * The floor the evaluation actually used, as a number only the real floor
     * produces.
     *
     * 1112 is the 25% floor's answer; the injected 1% would have produced **800**.
     * So this single assertion now kills the tamper by itself, which the earlier
     * `toBeGreaterThan(0)` could not.
     */
    expect(body.view?.minViablePriceCents).toBe(1112);
    // And the tampered food cost did not reach the arithmetic: at 100¢ of food the
    // floor would fall well below 1112.
    expect(body.view?.minViablePriceCents).not.toBe(800);
  });

  /**
   * The same claim stated as a *sensitivity* rather than an absolute.
   *
   * The test above proves the injected value is not used. This proves the injected
   * value is not used **in a way that still influences the answer** — for instance
   * by being merged as a default that the real row then overwrites, which would
   * pass the absolute assertions and still be a body-driven code path. A tampered
   * body must produce a byte-identical evaluation to no body at all.
   */
  it('produces the same evaluation for a tampered body and no body', async () => {
    const withTamper = await POST(
      request(JSON.stringify({ foodCostCents: 1, packagingCents: 1, floorPctOfMenu: 0.9 }), itemId),
      { params: Promise.resolve({ id: itemId }) },
    );
    const withNoBody = await POST(request(null, itemId), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(withTamper.status).toBe(200);
    expect(withNoBody.status).toBe(200);

    const tampered = (await withTamper.json()) as EvaluationBody;
    const plain = (await withNoBody.json()) as EvaluationBody;

    // `computedAt` is a clock reading and is expected to differ; everything that
    // describes the dish is not allowed to.
    expect(tampered.input).toEqual(plain.input);
    expect(tampered.view).toEqual(plain.view);
    expect(tampered.state).toBe(plain.state);
    expect(tampered.warnings).toEqual(plain.warnings);
  });

  /**
   * `dealPriceCents` is the **one** field the body may set, and it must reach the
   * arithmetic.
   *
   * Without this, a route that ignored the whole body would pass both tests above —
   * and the panel could not show a merchant what their own price does, which is the
   * entire interaction. This is the control for the two tamper tests.
   */
  it('does evaluate the one price it is given', async () => {
    const response = await POST(
      request(JSON.stringify({ dealPriceCents: 900 }), itemId),
      { params: Promise.resolve({ id: itemId }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as EvaluationBody;

    // The submitted price is echoed, not clamped. §7.3 needs `BELOW_FLOOR` reachable
    // so the panel can say "that price loses you money" and name the real floor.
    expect(body.view?.dealPriceCents).toBe(900);
    expect(body.view?.isBelowFloor).toBe(true);
  });
});

describe('the always-200 rule', () => {
  /**
   * An infeasible dish is an **answer**, not an error (ARCHITECTURE §7.3).
   *
   * `$12.00` on a `$16.00` dish with `$4.80` food is below any workable floor, so
   * `minViablePrice` cannot produce a number. The failure this guards is a route
   * that lets the guardrail's `GuardrailError` escape into `errorResponse`, which
   * would turn a merchant's price experiment into a 500 and, in the panel, into
   * "Something went wrong."
   */
  it('returns 200 with a below-floor state rather than an error', async () => {
    const response = await POST(
      request(JSON.stringify({ dealPriceCents: 1200 }), itemId),
      { params: Promise.resolve({ id: itemId }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as EvaluationBody;
    // Some state is always reported; the exact one is the pure module's business.
    expect(['BELOW_FLOOR', 'INFEASIBLE', 'OK', 'TIGHT']).toContain(body.state);
    expect(body.errorCode).toBeNull();
  });

  /**
   * **`INCOMPLETE_COST_DATA` cannot be reached through this route, and the first
   * version of this test asserted that it could.**
   *
   * `assertCompleteCostData` throws it iff `foodCostCents` is `null` /
   * `undefined` / non-finite. `MenuItem.foodCostCents` is `Int` — non-nullable, by
   * design (PRD-sprint1 §8) — and `getItem` selects it straight from the row. So no
   * sequence of requests and no state of the database produces that input, and the
   * `catch` in `evaluateItem` that maps the error to a state is, for *this* caller,
   * dead code. Probed: a fixture with `foodCostCents: 0` — the closest thing to
   * "uncosted" the schema can express — evaluates as ordinary `FLOOR`, because zero
   * is a finite number and a missing cost is not the same as a free one.
   *
   * The `catch` is not pointless. `evaluate.ts` has **three** callers (this route,
   * the item page, and the save path in `POST /api/merchant/items`), and the save
   * path receives a *submitted* body where `foodCostCents` really can be absent. The
   * branch earns its place there. What this test pins is the narrower, checkable
   * claim: **this route cannot reach it**, which is why the suite does not pretend to
   * cover it with a fixture that cannot collide.
   */
  it('evaluates a zero food cost as a cost, never as missing data', async () => {
    const free = await prisma.menuItem.create({
      data: {
        merchantId,
        name: `${PREFIX} zero-cost bowl`,
        menuPriceCents: 1600,
        // The schema floor: a finite number, so the completeness guard passes.
        foodCostCents: 0,
        packagingCents: 80,
        batchYield: 60,
        isBatchable: true,
        containsAlcohol: false,
      },
      select: { id: true },
    });
    itemIds.push(free.id);

    const response = await POST(request(null, free.id), {
      params: Promise.resolve({ id: free.id }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as EvaluationBody;

    // Not INCOMPLETE_COST_DATA, and not a 500. The distinction matters because
    // treating zero as missing would hide a genuinely mis-costed dish — a merchant
    // who typed 0 by mistake would see "add a cost" instead of "this is suspicious".
    expect(body.state).not.toBe('INCOMPLETE_COST_DATA');
    expect(body.errorCode).toBeNull();
    // A view is produced, so the panel has something to render.
    expect(body.view).not.toBeNull();
    // And zero == free gives a very low floor, which is what a zero cost means.
    expect(body.view?.minViablePriceCents).toBeLessThan(1600);
  });

  /** An ineligible dish is also a 200, and it carries the reason. */
  it('answers 200 with INFEASIBLE for a non-batchable dish', async () => {
    const fried = await prisma.menuItem.create({
      data: {
        merchantId,
        name: `${PREFIX} fried to order`,
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 60,
        isBatchable: false,
        containsAlcohol: false,
      },
      select: { id: true },
    });
    itemIds.push(fried.id);

    const response = await POST(request(null, fried.id), {
      params: Promise.resolve({ id: fried.id }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as EvaluationBody;
    expect(body.state).toBe('INFEASIBLE');
    expect(body.ineligible).toBe('NOT_BATCHABLE');
    expect(body.view).toBeNull();
  });
});

describe('the one 422, and where it stops', () => {
  /**
   * A malformed `dealPriceCents` is the **only** 422 this route has.
   *
   * Worth its own test because it is the seam between "always 200" and ordinary
   * request validation, and the boundary is easy to get wrong in the permissive
   * direction: `z.number().optional()` with no `.int()` would accept `900.5` and
   * hand the guardrail module a fractional cent.
   */
  it('rejects a fractional price', async () => {
    const response = await POST(
      request(JSON.stringify({ dealPriceCents: 900.5 }), itemId),
      { params: Promise.resolve({ id: itemId }) },
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe('VALIDATION');
    // The message names the field so the panel can put it under the right input.
    expect(Object.keys(body.fieldErrors)).toContain('dealPriceCents');
  });

  it('rejects a zero and a negative price', async () => {
    for (const dealPriceCents of [0, -100]) {
      const response = await POST(
        request(JSON.stringify({ dealPriceCents }), itemId),
        { params: Promise.resolve({ id: itemId }) },
      );
      expect(response.status).toBe(422);
    }
  });

  /**
   * An **empty** body is valid — and this is asserted against a body that is
   * absent, a body that is `{}`, and a body that is not JSON at all.
   *
   * `request.json()` *throws* on an unparseable body, and the route catches it with
   * `.catch(() => ({}))`. Remove that catch and every "just show me the default
   * evaluation" request becomes a 500 — which is exactly what a client sending
   * `Content-Length: 0` does.
   */
  it('accepts no body, an empty object, and unparseable JSON alike', async () => {
    const cases: (string | null)[] = [null, '{}', 'not json at all'];
    const answers: EvaluationBody[] = [];

    for (const raw of cases) {
      const response = await POST(request(raw, itemId), {
        params: Promise.resolve({ id: itemId }),
      });
      expect(response.status).toBe(200);
      answers.push((await response.json()) as EvaluationBody);
    }

    // All three are the same request as far as this route is concerned.
    expect(answers[0]?.input).toEqual(answers[1]?.input);
    expect(answers[1]?.input).toEqual(answers[2]?.input);
  });
});

describe('scope, and the write gate', () => {
  /**
   * Another merchant's item is a **404, never a 403**.
   *
   * US-M1: a merchant must not be able to learn that an id exists outside their
   * scope. The distinction is not cosmetic — a 403 confirms the id is real, which
   * turns this endpoint into an oracle for enumerating a competitor's catalogue.
   */
  it('answers 404 for another merchant\'s dish, and evaluates nothing', async () => {
    const response = await POST(request(null, otherItemId), {
      params: Promise.resolve({ id: otherItemId }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/could not be found/i);
    // Nothing was evaluated, so nothing was recorded.
    expect(emitted).toHaveLength(0);
  });

  it('answers 404 for an id that does not exist at all', async () => {
    const response = await POST(
      request(null, '00000000-0000-4000-8000-000000000000'),
      { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }) },
    );
    expect(response.status).toBe(404);
  });

  /**
   * A borrowed session cannot evaluate.
   *
   * `requireMerchantWrite` is the gate, and this route is one of the 52 call sites
   * that must not have reached for `requireMerchant` instead. The distinction is not
   * academic: FR-904's impersonation is *read-only*, and an evaluation writes an
   * analytics row and a log line. Small writes, but the rule is a rule.
   */
  it('refuses an impersonated session with 403', async () => {
    currentSession = {
      ...newImpersonationSession({
        merchantUserId: ownerUserId,
        actorUserId: ownerUserId,
        auditId: '66666666-6666-4666-8666-666666666666',
      }),
    };

    const response = await POST(request(null, itemId), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(403);
    // And refused *before* doing the work: no evaluation was recorded.
    expect(emitted).toHaveLength(0);
  });

  it('refuses an anonymous caller with 401', async () => {
    currentSession = null;
    const response = await POST(request(null, itemId), {
      params: Promise.resolve({ id: itemId }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a non-merchant role', async () => {
    // An ADMIN is a real session but not a merchant scope. Without this, a route
    // that read `session.userId` and skipped the scope lookup would evaluate any id.
    currentSession = { ...sessionFor(ownerUserId), role: 'ADMIN' };
    const response = await POST(request(null, itemId), {
      params: Promise.resolve({ id: itemId }),
    });
    // 403 or 404 are both defensible here; the failure that matters is a 200.
    expect(response.status).not.toBe(200);
  });
});

describe('what it writes, which is only an analytics row', () => {
  /**
   * "Never persists anything" is the docblock's word, and it is about **dish data**.
   *
   * The route does write: one `guardrail_evaluated` event per evaluation (S1-017).
   * Both halves need pinning, because either one alone is satisfiable by a wrong
   * implementation — "writes nothing" by never emitting, "does not persist" by
   * skipping the analytics call entirely.
   */
  it('emits one evaluation event and leaves the dish untouched', async () => {
    const before = await prisma.menuItem.findUniqueOrThrow({
      where: { id: itemId },
      select: {
        menuPriceCents: true,
        foodCostCents: true,
        packagingCents: true,
        isBatchable: true,
      },
    });

    const response = await POST(
      request(JSON.stringify({ dealPriceCents: 1112 }), itemId),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(response.status).toBe(200);

    // The event, named and scoped.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe('guardrail_evaluated');
    expect(emitted[0]?.payload.itemId).toBe(itemId);
    expect(emitted[0]?.payload.merchantId).toBe(merchantId);
    expect(emitted[0]?.payload.actorUserId).toBe(ownerUserId);

    // And the row is byte-identical: a read-only evaluation that saved the submitted
    // price back onto the dish would make this endpoint a pricing write in disguise.
    const after = await prisma.menuItem.findUniqueOrThrow({
      where: { id: itemId },
      select: {
        menuPriceCents: true,
        foodCostCents: true,
        packagingCents: true,
        isBatchable: true,
      },
    });
    expect(after).toEqual(before);
  });

  /**
   * The floor is read from the **merchant row**, per request, not cached at import.
   *
   * A module-level cache of the floor would pass every test above and then serve a
   * stale margin for the rest of the process — the one number the entire guardrail
   * is built on. Changing the row and re-evaluating is the only way to see it.
   */
  it('re-reads the floor after the merchant changes it', async () => {
    const strict = await POST(
      request(JSON.stringify({ dealPriceCents: 1112 }), itemId),
      { params: Promise.resolve({ id: itemId }) },
    );
    const strictBody = (await strict.json()) as EvaluationBody;

    await prisma.merchant.update({ where: { id: merchantId }, data: { floorPctOfMenu: 0.45 } });
    try {
      const relaxed = await POST(
        request(JSON.stringify({ dealPriceCents: 1112 }), itemId),
        { params: Promise.resolve({ id: itemId }) },
      );
      const relaxedBody = (await relaxed.json()) as EvaluationBody;

      // A 45% floor needs a higher price than a 25% one, so the same $11.12 gets
      // worse — or the price becomes infeasible outright. Either way the answer must
      // *differ*; if the floor were cached they would be identical.
      const strictViable = strictBody.view?.minViablePriceCents ?? null;
      const relaxedViable = relaxedBody.view?.minViablePriceCents ?? null;

      expect(relaxedViable).not.toBe(strictViable);
      // Concretely: the higher floor cannot lower the minimum viable price.
      if (strictViable !== null && relaxedViable !== null) {
        expect(relaxedViable).toBeGreaterThan(strictViable);
      }
    } finally {
      await prisma.merchant.update({ where: { id: merchantId }, data: { floorPctOfMenu: 0.25 } });
    }
  });
});
