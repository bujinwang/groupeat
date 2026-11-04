import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createItem } from '@/lib/db/items';
import { prisma } from '@/lib/db/prisma';

import { POST } from '../route';

/**
 * `POST /api/merchant/ai/deal-builder` — §9.2's five-question interview.
 *
 * ## What this file is for, given that all three layers are already tested
 *
 * `plan.test.ts` proves the arithmetic, `deal-builder.test.ts` proves the
 * orchestration, and `schema.test.ts`/`copy-lint.test.ts` prove the model contract.
 * What none of them can see is the **body → orchestration** seam, and there are
 * three specific things on it:
 *
 *   1. **`quietStart` must carry an offset.** This is the whole subject of
 *      `lib/ai/input.ts`, which until now had **no test file that named it** — the
 *      schema's `ISO_WITH_OFFSET` refinement was reached only through whatever
 *      fixtures happened to exist elsewhere. The failure it prevents is
 *      `new Date("2026-11-05T14:00")`, parsed in the *server's* zone: right on a
 *      developer's Mac in Edmonton, six or seven hours wrong in a UTC container,
 *      and only visible on the deal page after the drop was created.
 *   2. **A 422 must name the field, not just refuse.** The client renders
 *      `fieldErrors` under each input; a 422 with an empty object is a form that
 *      says "Check your answers." and marks nothing.
 *   3. **A refusal about the dish is a 422, not a 500.** `buildDealProposals`
 *      throws `AppError`s for an ineligible dish (alcohol) and for a quiet slot the
 *      planner refuses. Those are facts about the merchant's input and must reach
 *      them as sentences; only a genuine bug may be a 500.
 *
 * ## The model is absent, deliberately
 *
 * No `AI_API_KEY` is set, so `buildDealProposals` resolves
 * `createUnavailablePort('no_key')` and `source` is `'planner'`. That is not a
 * shortcut — it is the state every deployment without a key is in, and §9.5 says
 * that state must still produce three usable proposals. The happy path asserted
 * here is therefore the *keyless* happy path, which is the one that has to work
 * before anyone buys a key.
 *
 * ## What is replaced
 *
 * `getSession` and the logger. `requireMerchantWrite`, `parseDealBuilderInput`,
 * `loadEligibleDish`'s real dish read, `getFloor`, `planProposals`, the copy
 * linter, and the `AiDraft` write are all production code against real rows.
 */

vi.mock('server-only', () => ({}));

const logLines = vi.hoisted(() => [] as { event: string; fields: Record<string, unknown> }[]);

vi.mock('@/lib/logging/logger', () => ({
  logger: {
    info: (event: string, fields: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    warn: () => undefined,
    error: () => undefined,
  },
}));

type MockSessionInput = {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword: boolean;
  absoluteExpiresAt: number;
  expiresAt: number;
  impersonation?: { actorUserId: string; auditId: string; expiresAt: number };
};

let currentSession: MockSessionInput | null = null;

vi.mock('@/lib/auth/session', async () => {
  const jwt = await import('@/lib/auth/jwt');
  return {
    getSession: async () => currentSession,
    roleHome: jwt.roleHome,
    newSession: jwt.newSession,
  };
});

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

/** The orchestration resolves `real-port` lazily; make sure it stays keyless. */
const savedAiKey = process.env.AI_API_KEY;

const PREFIX = `dbld${Date.now().toString(36).slice(-5)}`;
const URL = 'http://localhost:3000/api/merchant/ai/deal-builder';
const HOUR = 60 * 60 * 1000;

const merchantIds: string[] = [];
const userIds: string[] = [];

let merchantId = '';
let ownerUserId = '';
/** A normal dish: $16.00 menu, $4.80 food, $0.80 packaging, batch 30. */
let itemId = '';
/** An alcohol dish, refused by FR-104 before planning ever runs. */
let alcoholItemId = '';
/** Another tenant's dish, to prove the scope filter is real. */
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

/** Two days out at 21:00Z, with the `Z` offset the schema requires. */
function quietStartIso(hoursFromNow = 48): string {
  const date = new Date(Date.now() + hoursFromNow * HOUR);
  date.setUTCHours(21, 0, 0, 0);
  return date.toISOString();
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    menuItemId: itemId,
    quietStart: quietStartIso(),
    intent: 'EITHER',
    maxQty: 20,
    ...overrides,
  };
}

function post(raw: string | null): NextRequest {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(raw === null ? {} : { body: raw }),
  });
}

type FieldErrorBody = {
  error: string;
  message: string;
  fieldErrors: Record<string, string>;
};

type ProposalBody = {
  proposals: {
    archetype: string;
    menuItemId: string;
    dealPriceCents: number;
    menuPriceCents: number;
    minViablePriceCents: number;
    discountPct: number;
    minQty: number;
    maxQty: number;
    windowStart: string;
    windowEnd: string;
    cutoffAt: string;
    title: string;
    description: string;
    rationale: string;
    shareMessage: string;
  }[];
  source: string;
  promptVersion: string;
  notes: string[];
  copyRejected: unknown[];
  aiDraftId: string | null;
};

beforeAll(async () => {
  delete process.env.AI_API_KEY;

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
      timezone: 'America/Edmonton',
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantId = merchant.id;
  merchantIds.push(merchant.id);

  const item = await createItem([merchant.id], {
    name: `${PREFIX} noodle bowl`,
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

  const alcohol = await createItem([merchant.id], {
    name: `${PREFIX} beer`,
    description: null,
    menuPriceCents: 900,
    foodCostCents: 300,
    packagingCents: 0,
    batchYield: 24,
    prepMinutes: 1,
    isBatchable: true,
    containsAlcohol: true,
    category: 'Drinks',
  });
  alcoholItemId = alcohol.id;

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
      slug: `${PREFIX}-other-slug`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      users: { create: { userId: otherOwner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantIds.push(otherMerchant.id);

  const other = await createItem([otherMerchant.id], {
    name: `${PREFIX} other bowl`,
    description: null,
    menuPriceCents: 2000,
    foodCostCents: 500,
    packagingCents: 100,
    batchYield: 40,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });
  otherItemId = other.id;
});

beforeEach(() => {
  currentSession = sessionFor(ownerUserId);
  logLines.length = 0;
  delete process.env.AI_API_KEY;
});

afterAll(async () => {
  if (savedAiKey !== undefined) {
    process.env.AI_API_KEY = savedAiKey;
  }
  if (merchantIds.length > 0) {
    await prisma.aiDraft
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
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

describe('the happy path, with no model key', () => {
  it('answers 200 with three proposals, planned rather than generated', async () => {
    const response = await POST(post(JSON.stringify(body())));
    expect(response.status).toBe(200);

    const result = (await response.json()) as ProposalBody;

    // §9.5's keyless requirement: the merchant still gets usable output. If this
    // ever becomes an error the feature is dead without a purchased key.
    expect(result.proposals).toHaveLength(3);
    expect(result.source).toBe('planner');
    expect(result.copyRejected).toEqual([]);
  });

  it('returns every field the client reads, and no placeholder price', async () => {
    /**
     * Asserted field by field against `PlannedProposal` rather than against a
     * literal, because the failure this catches is a *drift*: `DealBuilder.tsx`
     * builds a `POST /api/merchant/drops` body out of these values, so a missing
     * `maxPerCustomer` becomes `undefined` in a draft body and a 422 the merchant
     * cannot explain from the screen they are looking at.
     */
    const result = (await (await POST(post(JSON.stringify(body())))).json()) as ProposalBody;
    const keys = Object.keys(result.proposals[0] ?? {}).sort();

    expect(keys).toEqual(
      [
        'archetype',
        'cutoffAt',
        'dealPriceCents',
        'description',
        'discountPct',
        'isThinDiscount',
        'maxPerCustomer',
        'maxQty',
        'menuItemId',
        'menuPriceCents',
        'minQty',
        'minViablePriceCents',
        'rationale',
        'shareMessage',
        'title',
        'windowEnd',
        'windowStart',
      ].sort(),
    );
  });

  it('prices every proposal from the merchant\'s own floor, never above menu', async () => {
    // The guardrail's one hard rule. A proposal at or above `menuPriceCents` is
    // not a deal, and one below `minViablePriceCents` loses money on every plate.
    const result = (await (await POST(post(JSON.stringify(body())))).json()) as ProposalBody;

    for (const proposal of result.proposals) {
      expect(proposal.menuItemId).toBe(itemId);
      expect(proposal.dealPriceCents).toBeGreaterThanOrEqual(proposal.minViablePriceCents);
      expect(proposal.dealPriceCents).toBeLessThan(proposal.menuPriceCents);
      expect(proposal.discountPct).toBeGreaterThan(0);
      // The Competition Act claim: the discount shown must be the discount.
      expect(proposal.discountPct).toBeCloseTo(
        (proposal.menuPriceCents - proposal.dealPriceCents) / proposal.menuPriceCents,
        5,
      );
    }
  });

  it('writes one AiDraft audit row for the request', async () => {
    // PRD-v1 §9.1.3. The row is the only record that the merchant was shown a
    // suggestion before they accepted it, which is what an "the AI told me to
    // price it there" conversation needs.
    const before = await prisma.aiDraft.count({ where: { merchantId } });
    await POST(post(JSON.stringify(body())));
    const after = await prisma.aiDraft.count({ where: { merchantId } });
    expect(after - before).toBe(1);
  });

  it('does not create a drop — planning is not publishing', async () => {
    /**
     * The route's docblock is explicit: it writes an `AiDraft` and nothing else.
     * A probe inserting `createDraft` here would give the merchant three live
     * drops they never chose, and every other assertion in this file would still
     * pass.
     */
    const before = await prisma.drop.count({ where: { merchantId } });
    await POST(post(JSON.stringify(body())));
    expect(await prisma.drop.count({ where: { merchantId } })).toBe(before);
  });
});

describe('quietStart must carry an offset', () => {
  it('refuses a local-time string, naming the field and the reason', async () => {
    /**
     * The single most valuable assertion in this file.
     *
     * `2026-11-05T14:00` parses fine — `new Date` treats it as the *server's*
     * local time. On a developer's Mac in Edmonton that is accidentally correct,
     * which is why this defect cannot be reproduced locally. The refusal exists
     * because the browser sends `toISOString()` and anything else is a client bug
     * that must surface as a form error rather than as a drop six hours off.
     */
    const response = await POST(
      post(JSON.stringify(body({ quietStart: '2026-11-05T14:00' }))),
    );
    expect(response.status).toBe(422);

    const result = (await response.json()) as FieldErrorBody;
    expect(result.fieldErrors.quietStart).toContain('timezone');
  });

  it('accepts a Z offset and a numeric offset alike', async () => {
    // `toISOString()` produces `Z`; a hand-written body may carry `-07:00`. Both
    // are unambiguous, and refusing the second would break any client that
    // formats its own instants.
    const zulu = await POST(post(JSON.stringify(body({ quietStart: quietStartIso() }))));
    expect(zulu.status).toBe(200);

    const offset = new Date(Date.now() + 48 * HOUR).toISOString().replace('Z', '-07:00');
    const numeric = await POST(post(JSON.stringify(body({ quietStart: offset }))));
    expect(numeric.status).toBe(200);
  });

  it('refuses a string that is not a date at all, with a different sentence', async () => {
    // Two refinements, two messages, and the order matters: an unparseable value
    // fails the first and never reaches the offset check, so the merchant is told
    // to pick a time rather than to reload the page.
    const response = await POST(post(JSON.stringify(body({ quietStart: 'next tuesday' }))));
    expect(response.status).toBe(422);

    const result = (await response.json()) as FieldErrorBody;
    expect(result.fieldErrors.quietStart).toContain('Pick a day and time');
    expect(result.fieldErrors.quietStart).not.toContain('timezone');
  });
});

describe('the body schema', () => {
  const cases: { label: string; body: Record<string, unknown>; field: string }[] = [
    { label: 'no dish', body: { menuItemId: '' }, field: 'menuItemId' },
    { label: 'an unknown intent', body: { intent: 'MAKE_MONEY' }, field: 'intent' },
    { label: 'maxQty of zero', body: { maxQty: 0 }, field: 'maxQty' },
    { label: 'maxQty above one batch', body: { maxQty: 201 }, field: 'maxQty' },
    { label: 'a fractional maxQty', body: { maxQty: 12.5 }, field: 'maxQty' },
    { label: 'maxQty as a string', body: { maxQty: '20' }, field: 'maxQty' },
  ];

  for (const { label, body: overrides, field } of cases) {
    it(`refuses ${label}, naming ${field}`, async () => {
      const response = await POST(post(JSON.stringify({ ...body(), ...overrides })));
      expect(response.status).toBe(422);

      const result = (await response.json()) as FieldErrorBody;
      expect(result.error).toBe('VALIDATION');
      expect(Object.keys(result.fieldErrors)).toContain(field);
      // A named field with an empty message is still an unmarked form.
      expect(result.fieldErrors[field]?.length ?? 0).toBeGreaterThan(0);
    });
  }

  it('accepts the maxQty boundary at 1 and 200', async () => {
    // Without this, `.max(199)` and `.min(2)` both pass every refusal above.
    for (const qty of [1, 200]) {
      const response = await POST(post(JSON.stringify(body({ maxQty: qty }))));
      expect(response.status, `maxQty ${qty}`).toBe(200);
    }
  });

  it('refuses a body that is not JSON', async () => {
    const response = await POST(post('not json'));
    expect(response.status).toBe(422);
    const result = (await response.json()) as FieldErrorBody;
    expect(result.error).toBe('VALIDATION');
  });

  it('logs the refusal, with the actor and the field count', async () => {
    // The `drop.validation_failed` event is what tells us a form is being
    // rejected — the only signal that a client and this schema have diverged.
    await POST(post(JSON.stringify(body({ maxQty: 0, intent: 'NOPE' }))));

    const refusal = logLines.find((line) => line.event === 'drop.validation_failed');
    expect(refusal).toBeDefined();
    expect(refusal?.fields.actorId).toBe(ownerUserId);
    expect(refusal?.fields.merchantId).toBe(merchantId);
    expect(refusal?.fields.issueCount).toBe(2);
  });

  it('does not log a validation failure on success', async () => {
    // A `drop.validation_failed` on every call would make the metric useless —
    // and it would hide the divergent client the event exists to reveal.
    await POST(post(JSON.stringify(body())));
    expect(logLines.some((line) => line.event === 'drop.validation_failed')).toBe(false);
  });
});

describe('refusals about the dish are 422s, not 500s', () => {
  it('refuses an alcohol dish before planning, naming the dish', async () => {
    // FR-104 / AGLC: alcohol can never be in a drop. The route checks it as well
    // as the new-drop page because this route takes an id from the body, so a
    // hand-built request bypasses the page entirely.
    const response = await POST(post(JSON.stringify(body({ menuItemId: alcoholItemId }))));
    expect(response.status).toBe(422);

    const result = (await response.json()) as FieldErrorBody;
    expect(result.error).toBe('VALIDATION');
    expect(Object.keys(result.fieldErrors)).toContain('menuItemId');
  });

  it('answers 404 for another merchant\'s dish, not 403', async () => {
    // US-M1. A 403 would confirm the id exists; a 404 does not.
    const response = await POST(post(JSON.stringify(body({ menuItemId: otherItemId }))));
    expect(response.status).toBe(404);
  });

  it('answers 404 for a dish id that does not exist', async () => {
    const response = await POST(
      post(JSON.stringify(body({ menuItemId: '00000000-0000-4000-8000-000000000000' }))),
    );
    expect(response.status).toBe(404);
  });

  it('answers 422, not 500, for a quiet slot the planner refuses', async () => {
    /**
     * The planner's refusal here is `WINDOW_TOO_FAR` — *the named quiet slot is
     * past the five-day authorisation window* (§8.3), not "in the past". The
     * first version of this test used a slot 48 h ago and got a 200, because the
     * planner does not refuse a past slot: only the five-day ceiling is a
     * refusal. Written down because the mistake is easy to repeat, and because
     * "the past is refused" would be a *different* product rule.
     *
     * What matters is that the refusal reaches the client as a `fieldErrors`
     * entry on `quietStart` with a 422 rather than as a 500 telling them to
     * retry something that cannot succeed.
     */
    const tooFar = new Date(Date.now() + 9 * 24 * HOUR).toISOString();
    const response = await POST(post(JSON.stringify(body({ quietStart: tooFar }))));

    expect(response.status).toBe(422);
    const result = (await response.json()) as FieldErrorBody;
    expect(Object.keys(result.fieldErrors)).toContain('quietStart');
  });

  it('accepts a slot comfortably inside the five-day window', async () => {
    // The boundary in the other direction: without it, a planner that refused
    // *everything* would pass the test above.
    const response = await POST(post(JSON.stringify(body({ quietStart: quietStartIso(48) }))));
    expect(response.status).toBe(200);
  });
});

describe('authorisation', () => {
  it('refuses an anonymous caller with 401 before touching the body', async () => {
    currentSession = null;
    const response = await POST(post('not json'));
    // 401, not 422: a caller who is not signed in must not learn anything about
    // the schema.
    expect(response.status).toBe(401);
  });

  it('refuses a non-merchant role with 403', async () => {
    currentSession = { ...sessionFor(ownerUserId), role: 'ORGANISER' };
    const response = await POST(post(JSON.stringify(body())));
    expect(response.status).toBe(403);
  });

  it('refuses an impersonating admin, and writes no AiDraft row', async () => {
    /**
     * FR-904. Planning is a write (the audit row), so the read-only rule applies.
     * The second assertion is the one that matters: a refusal that still wrote the
     * row would leave a record of a merchant being shown suggestions they never
     * asked for.
     */
    const jwt = await import('@/lib/auth/jwt');
    currentSession = jwt.newImpersonationSession({
      merchantUserId: ownerUserId,
      actorUserId: '00000000-0000-4000-8000-000000000001',
      auditId: '00000000-0000-4000-8000-000000000002',
    }) as MockSessionInput;

    const before = await prisma.aiDraft.count({ where: { merchantId } });
    const response = await POST(post(JSON.stringify(body())));
    expect(response.status).toBe(403);
    expect(await prisma.aiDraft.count({ where: { merchantId } })).toBe(before);
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

    const response = await POST(post(JSON.stringify(body())));
    expect(response.status).toBe(404);
  });
});
