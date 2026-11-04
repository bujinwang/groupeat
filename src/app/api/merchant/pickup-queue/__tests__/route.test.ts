import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * The counter's two JSON endpoints — FR-604, and the one asymmetry in the merchant surface.
 *
 * > `GET /api/staff/drops/:id/manifest` — PRD-v1.md:873, built as
 * > `GET /api/merchant/pickup-queue/:id` because there is no `STAFF` role in the schema.
 *
 * ## Why these two routes are worth testing when nothing calls them
 *
 * They have **no client caller**: `/merchant/pickup` calls `listCounterDrops` and
 * `loadManifest` directly as a server component, which is the same arrangement
 * `POST /api/organiser/drops/:id/share` has with its form. That is not a reason to leave
 * them dark. They are *reachable* — the app router serves them, require only a merchant
 * session, and return every diner's name and phone tail for a drop. An endpoint nobody
 * exercises is exactly where the gate and the serialisation drift, because nothing
 * compares them to the function the page uses.
 *
 * So the payload assertions here are made **against `listCounterDrops` and `loadManifest`
 * field by field**, not against literals. A literal would pass while the route and the
 * page disagreed, and the whole risk of a second entry point is that it is *almost* the
 * same product.
 *
 * ## What is real
 *
 * The real `requireMerchant`, the real Prisma client, real Postgres. Only two
 * replacements: `server-only` (it throws outside an RSC graph, as in five other files
 * here) and `@/lib/auth/session`, whose `getSession` reads a cookie jar that does not
 * exist under Vitest. `@/lib/auth/authorize` itself is imported for real, so the role
 * check and the impersonation rule are the shipped code rather than a look-alike.
 *
 * ## The asymmetry this file pins, and why it is not an oversight
 *
 * Every other route under `/api/merchant` that accepts a body calls
 * `requireMerchantWrite()`. These two call `requireMerchant()`, and that is correct:
 * reading is what impersonation is *for*. `impersonation-readonly.test.ts` walks this
 * tree and exempts them by name for exactly this reason — it looks at the exported verbs,
 * and `GET` is not among the mutating ones. The test below states the read-write split
 * from the other side, so a future author reading only those two files cannot conclude
 * that the exemption was an accident.
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

type MockSession = {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword: boolean;
  impersonation?: { actorUserId: string; auditId: string; expiresAt: number };
};

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { listCounterDrops, loadManifest } = await import('@/lib/redemption/manifest');

const PREFIX = `pq${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const HOUR = 60 * 60 * 1000;
const DEAL_PRICE = 1200;

const LIST_URL = 'http://localhost/api/merchant/pickup-queue';

let merchantId = '';
let otherMerchantId = '';
let itemId = '';
let otherItemId = '';
let ownerUserId = '';
/** An owner of both merchants — the only fixture that distinguishes a scope from its first id. */
let dualMemberUserId = '';

/**
 * The drops this file cares about, keyed so an assertion names intent, not an index.
 *
 * The key union is load-bearing rather than cosmetic: `Record<string, string>` is an
 * index signature, so `noUncheckedIndexedAccess` makes every `drops.open` a
 * `string | undefined` and every call site needs a non-null assertion. A finite key
 * union is a mapped type with required keys, so the value is a `string` — and a typo in
 * a key is a type error instead of a silently `undefined` drop id.
 */
type DropKey =
  | 'open'
  | 'captured'
  | 'justInside'
  | 'justOutside'
  | 'failed'
  | 'draft'
  | 'overRedeemed'
  | 'foreign';

const drops = {} as Record<DropKey, string>;

type ListPayload = {
  drops: {
    id: string;
    title: string;
    status: string;
    windowStart: string;
    windowEnd: string;
    outstanding: number;
  }[];
};

type ManifestPayload = {
  dropId: string;
  title: string;
  status: string;
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  summary: {
    orders: number;
    plates: number;
    collected: number;
    outstanding: number;
    fullyCollectedOrders: number;
  };
  rows: {
    participantId: string;
    name: string | null;
    phoneLast4: string;
    qty: number;
    redeemedQty: number;
    redeemedAt: string | null;
  }[];
};

async function callList(): Promise<Response> {
  const route = await import('@/app/api/merchant/pickup-queue/route');
  return route.GET(new NextRequest(LIST_URL, { method: 'GET' }));
}

async function callManifest(id: string): Promise<Response> {
  const route = await import('@/app/api/merchant/pickup-queue/[id]/route');
  return route.GET(new NextRequest(`${LIST_URL}/${id}`, { method: 'GET' }), {
    params: Promise.resolve({ id }),
  });
}

/** Marks a participant as collected, which is the only thing `outstanding` reads. */
async function collect(participantId: string, qty: number): Promise<void> {
  await prisma.dropParticipant.update({
    where: { id: participantId },
    data: { redeemedQty: qty, redeemedAt: new Date('2026-11-01T19:30:00.000Z') },
  });
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  otherMerchantId = await fx.merchant(`acct_${PREFIX}_other`);
  itemId = await fx.item(merchantId);
  otherItemId = await fx.item(otherMerchantId);

  const owner = await prisma.user.findFirstOrThrow({
    where: { merchantUsers: { some: { merchantId } } },
    select: { id: true },
  });
  ownerUserId = owner.id;

  const at = (hours: number): Date => new Date(Date.now() + hours * HOUR);

  // The list's happy path: open now, one order of three plates with one collected.
  drops.open = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'PICKUP_OPEN',
    windowStart: at(-1),
    windowEnd: at(1),
  });
  const openParticipant = await fx.participant({
    dropId: drops.open,
    qty: 3,
    chargeStatus: 'CAPTURED',
  });
  await collect(openParticipant, 1);
  await fx.participant({ dropId: drops.open, qty: 2, chargeStatus: 'CAPTURED' });

  // A name on one diner, so the PII assertions have a real value to search for. Without
  // it `not.toContain(customer.name)` would be asserting against `null` and could not
  // fail — the fixtures generate phone numbers but deliberately do not invent names.
  const firstCustomer = await prisma.dropParticipant.findUniqueOrThrow({
    where: { id: openParticipant },
    select: { customerId: true },
  });
  await prisma.customer.update({
    where: { id: firstCustomer.customerId },
    data: { name: `${PREFIX} Whitfield` },
  });

  // `CAPTURED`: settlement finished, the counter window has not opened yet. In the list
  // on purpose — a merchant opening the screen early should see the drop waiting.
  drops.captured = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'CAPTURED',
    windowStart: at(2),
    windowEnd: at(3),
  });

  // The 12-hour boundary, from both sides. These two are the only fixtures that can see
  // the constant moved: everything else lives hours away from the edge.
  drops.justInside = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'COMPLETED',
    windowStart: at(-14),
    windowEnd: at(-11),
  });
  drops.justOutside = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'COMPLETED',
    windowStart: at(-14),
    windowEnd: at(-13),
  });

  // A status the *list* excludes and the *manifest* does not. See the test that names it.
  //
  // Its window is thirteen hours ago on purpose. The first draft had it at `now`, which
  // made the test pass for the wrong reason: it was absent from the list because the
  // *window* filter excluded it, so the status filter could have been widened to include
  // `FAILED` and nothing would have noticed. Found by a mutation probe that survived.
  drops.failed = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'FAILED',
    windowStart: at(-14),
    windowEnd: at(-13),
  });

  // A `DRAFT` drop, which is not work at a counter by any reading. Same lesson as above:
  // outside the window, so the status filter is the only thing that can exclude it.
  drops.draft = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'DRAFT',
    windowStart: at(-14),
    windowEnd: at(-13),
  });

  // `redeemedQty` above `qty`, which no legitimate path produces and a data fix could.
  // The list must answer "zero left", not "-2 left". Nothing else in this file has a row
  // like this, so the floor in `listCounterDrops` was unasserted until a probe survived.
  drops.overRedeemed = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'COMPLETED',
    windowStart: at(-14),
    windowEnd: at(-11),
  });
  const overRedeemed = await fx.participant({
    dropId: drops.overRedeemed,
    qty: 2,
    chargeStatus: 'CAPTURED',
  });
  await prisma.dropParticipant.update({
    where: { id: overRedeemed },
    data: { redeemedQty: 4, redeemedAt: new Date('2026-11-01T19:45:00.000Z') },
  });

  // Another merchant's drop, open right now. If it appears in the list, the scope filter
  // is wrong; if its manifest is readable, the scope filter is absent.
  drops.foreign = await fx.drop({
    merchantId: otherMerchantId,
    menuItemId: otherItemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'PICKUP_OPEN',
    windowStart: at(-1),
    windowEnd: at(1),
  });

  // A user who is an OWNER of **both** merchants. This is the only fixture that can tell a
  // membership test from a first-element test: `merchantIds` comes back ordered by id, so
  // a filter written `merchantIds[0]` shows this caller one merchant's drops and silently
  // hides the other's. Two separate owners cannot see it — each of them has exactly one
  // id, and `[0]` is that id.
  const both = await prisma.user.create({
    data: {
      email: `${PREFIX}-both@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
      merchantUsers: { create: [{ merchantId, role: 'OWNER' }, { merchantId: otherMerchantId, role: 'OWNER' }] },
    },
    select: { id: true },
  });
  dualMemberUserId = both.id;
});

beforeEach(() => {
  sessionState.session = { userId: ownerUserId, role: 'MERCHANT', mustChangePassword: false };
  logLines.length = 0;
});

afterAll(async () => {
  // No `.catch(() => undefined)` here, and by tenant rather than by an id list: this file
  // expects several writes to be *refused*, so under a mutant the writes happen and no
  // pushed id would name them. See the Teardown section of AGENTS.md.
  //
  // `ledgerEntry` is deleted by `dropId` and not through the `drop` relation, because
  // `LedgerEntry` has no relation to `Drop` — the column is a plain string on purpose
  // (design §5), so the ledger survives its drop. `where: { drop: … }` is a validation
  // error, which is exactly what the first draft of this teardown did.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  await step(() =>
    prisma.ledgerEntry.deleteMany({ where: { dropId: { in: Object.values(drops) } } }),
  );
  await step(() => prisma.drop.deleteMany({ where: { merchantId: { in: [merchantId, otherMerchantId] } } }));
  await step(() => prisma.customer.deleteMany({ where: { phone: { startsWith: '+1555' } } }));
  await step(() => prisma.menuItem.deleteMany({ where: { id: { in: [itemId, otherItemId] } } }));
  await step(() => prisma.merchant.deleteMany({ where: { id: { in: [merchantId, otherMerchantId] } } }));
  await step(() => prisma.user.deleteMany({ where: { email: { contains: PREFIX } } }));
  await step(() => fx.cleanup());

  vi.resetModules();

  if (failures.length > 0) {
    throw new AggregateError(failures, `teardown left the database dirty (${failures.length} step(s) failed)`);
  }
});

describe('GET /api/merchant/pickup-queue — authorisation', () => {
  it('answers 401 with no session, and names no drop', async () => {
    sessionState.session = null;
    const response = await callList();

    expect(response.status).toBe(401);
    const text = await response.text();
    // The refusal must not be a partial success. Titles are the cheapest thing to leak.
    expect(text).not.toContain('pq');
    expect(text).not.toContain('"drops"');
  });

  it('answers 403 for an ORGANISER session', async () => {
    sessionState.session = { userId: ownerUserId, role: 'ORGANISER', mustChangePassword: false };
    expect((await callList()).status).toBe(403);
  });

  it('answers 403 for an ADMIN session, which has its own drop list', async () => {
    sessionState.session = { userId: ownerUserId, role: 'ADMIN', mustChangePassword: false };
    expect((await callList()).status).toBe(403);
  });

  it('answers 200 with an empty list for a merchant who owns nothing', async () => {
    // The route's docblock claims this shape: "there is no resource here to be
    // forbidden from". A 404 would be wrong twice over — it would tell a user with a
    // stale membership that the feature does not exist.
    const stranger = await prisma.user.create({
      data: {
        email: `${PREFIX}-stranger@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });

    sessionState.session = { userId: stranger.id, role: 'MERCHANT', mustChangePassword: false };
    const response = await callList();
    const body = (await response.json()) as ListPayload;

    expect(response.status).toBe(200);
    expect(body.drops).toEqual([]);

    await prisma.user.delete({ where: { id: stranger.id } });
  });

  it('lets a borrowed session read, which is the whole point of impersonation', async () => {
    // The asymmetry with every write route under `/api/merchant`: those call
    // `requireMerchantWrite()`, and this one must not. A support engineer answering "why
    // is this bag not ready" needs the list; `refuseIfImpersonating` would answer with a
    // 403 and no reason. Pinned here so nobody "fixes" the inconsistency.
    sessionState.session = {
      userId: ownerUserId,
      role: 'MERCHANT',
      mustChangePassword: false,
      impersonation: { actorUserId: 'admin-1', auditId: 'audit-1', expiresAt: 0 },
    };

    expect((await callList()).status).toBe(200);
  });
});

describe('GET /api/merchant/pickup-queue — the payload', () => {
  it('is the same rows the pickup page renders', async () => {
    const expected = await listCounterDrops([merchantId], new Date());
    const body = (await (await callList()).json()) as ListPayload;

    const actualOpen = body.drops.find((drop) => drop.id === drops.open);
    const expectedOpen = expected.find((drop) => drop.id === drops.open);

    expect(actualOpen).toBeDefined();
    expect(expectedOpen).toBeDefined();

    // Field by field against the function, not against literals. This is the assertion
    // that a change to `listCounterDrops` cannot reach the page and miss the route.
    expect(actualOpen?.title).toBe(expectedOpen?.title);
    expect(actualOpen?.status).toBe(expectedOpen?.status);
    expect(actualOpen?.outstanding).toBe(expectedOpen?.outstanding);
    expect(actualOpen?.windowStart).toBe(expectedOpen?.windowStart.toISOString());
    expect(actualOpen?.windowEnd).toBe(expectedOpen?.windowEnd.toISOString());
  });

  it('serialises both windows as ISO strings, not as dates or local times', async () => {
    const body = (await (await callList()).json()) as ListPayload;
    const row = body.drops.find((drop) => drop.id === drops.open);

    // The docblock claims the contract is explicit "so a client never has to guess at a
    // locale". An ISO 8601 UTC string with milliseconds is the only thing that survives
    // a client in another zone reading it.
    expect(row?.windowStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row?.windowEnd).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(row!.windowStart).toISOString()).toBe(row?.windowStart);
  });

  it('reports plates outstanding rather than plates sold', async () => {
    // Five plates across two orders, one collected: the screen must open on 4, not on 5
    // and not on 2. A screen that says "5 orders" when four bags are gone is a screen a
    // staff member stops trusting, which the query's own comment says.
    const body = (await (await callList()).json()) as ListPayload;
    const row = body.drops.find((drop) => drop.id === drops.open);

    expect(row?.outstanding).toBe(4);
  });

  it('sends exactly the six fields the contract names, and no more', async () => {
    // **This test is the reason the route projects at all, and it says so out loud.**
    //
    // `listCounterDrops` already returns exactly these six fields with `windowStart` and
    // `windowEnd` as `Date`s. `NextResponse.json()` serialises a `Date` to an ISO string
    // by itself. So `drops: drops.map(...)` in the route is *observably* a no-op: replacing
    // it with a bare `drops,` leaves all 34 other tests passing, and a probe confirmed
    // that. Comparing values cannot tell the two apart because there is nothing to tell.
    //
    // What the projection buys is a **boundary that cannot widen silently**. Today the
    // query selects nothing extra; the day someone adds `customer: { phone }` to it for a
    // new screen, the map is what keeps that off the wire, and this test is what keeps the
    // map honest. So the assertion is on the key set — which a bare `drops,` passes today
    // and fails the moment the query grows — and the honest statement of its current
    // strength is in PROGRESS.md rather than dressed up as a killed mutant.
    const body = (await (await callList()).json()) as ListPayload;
    const row = body.drops.find((drop) => drop.id === drops.open);

    expect(Object.keys(row!).sort()).toEqual(
      ['id', 'outstanding', 'status', 'title', 'windowEnd', 'windowStart'].sort(),
    );

    // And no `Date` instance survives into the response, which is the property the
    // docblock defends: whatever shape a client receives, it is JSON scalars.
    expect(row?.windowStart).toEqual(expect.any(String));
    expect(row?.windowEnd).toEqual(expect.any(String));
  });

  it('includes a CAPTURED drop, because the window may already be open', async () => {
    const body = (await (await callList()).json()) as ListPayload;
    expect(body.drops.map((drop) => drop.id)).toContain(drops.captured);
  });
});

describe('GET /api/merchant/pickup-queue — scope and the window', () => {
  it('omits another merchant\u2019s drop and still shows its own', async () => {
    // Both halves in one test: proving the foreign drop is absent says nothing if the
    // filter also excluded everything, and this database is shared.
    const body = (await (await callList()).json()) as ListPayload;
    const ids = body.drops.map((drop) => drop.id);

    expect(ids).not.toContain(drops.foreign);
    expect(ids).toContain(drops.open);
  });

  it('shows each merchant only their own', async () => {
    const otherOwner = await prisma.user.findFirstOrThrow({
      where: { merchantUsers: { some: { merchantId: otherMerchantId } } },
      select: { id: true },
    });

    sessionState.session = { userId: otherOwner.id, role: 'MERCHANT', mustChangePassword: false };
    const body = (await (await callList()).json()) as ListPayload;
    const ids = body.drops.map((drop) => drop.id);

    expect(ids).toContain(drops.foreign);
    expect(ids).not.toContain(drops.open);
  });

  it('shows a caller who owns two merchants the drops of both', async () => {
    // **The test that tells a membership test from a first-element test**, and the two
    // single-merchant tests above cannot do it: each of those callers has exactly one
    // merchant id, so `merchantIds[0]` and `merchantId: { in: merchantIds }` give the
    // same answer for both. Only a caller who owns two can see the difference, and the
    // list comes back ordered by id, so which one `[0]` picks is not even stable.
    //
    // Found by a mutation probe that survived the first draft of this file — the
    // "symmetric direction" test above looks like it covers this and does not.
    sessionState.session = { userId: dualMemberUserId, role: 'MERCHANT', mustChangePassword: false };
    const body = (await (await callList()).json()) as ListPayload;
    const ids = body.drops.map((drop) => drop.id);

    expect(ids).toContain(drops.open);
    expect(ids).toContain(drops.foreign);
  });

  it('keeps a drop that ended eleven hours ago and drops one that ended thirteen hours ago', async () => {
    // The 12-hour constant, tested from both sides within an hour of it. Everything else
    // in this file lives far from the edge, so without this pair the constant could be
    // changed to any value between 3 and 100 hours and every other assertion would hold.
    const body = (await (await callList()).json()) as ListPayload;
    const ids = body.drops.map((drop) => drop.id);

    expect(ids).toContain(drops.justInside);
    expect(ids).not.toContain(drops.justOutside);
  });

  it('omits a DRAFT drop, which is not work at a counter', async () => {
    const body = (await (await callList()).json()) as ListPayload;
    expect(body.drops.map((drop) => drop.id)).not.toContain(drops.draft);
  });

  it('keeps a DRAFT drop out because of its status, not because of its window', async () => {
    // **The fixture above could not see the status filter at all.** Those two drops sit
    // thirteen hours back, so the window filter excludes them and the status filter could
    // be widened to include `DRAFT` and `FAILED` with every assertion above still green —
    // a mutation probe did exactly that and survived. The correction is a *second* drop in
    // each excluded status whose window is open right now, so status is the only thing
    // that can exclude it.
    //
    // This is the general shape of a fixture gap: two rules both exclude a row, and a
    // fixture that violates both cannot say which one did it.
    const at = (hours: number): Date => new Date(Date.now() + hours * HOUR);

    const draftNow = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 1,
      status: 'DRAFT',
      windowStart: at(-1),
      windowEnd: at(1),
    });
    const failedNow = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 1,
      status: 'FAILED',
      windowStart: at(-1),
      windowEnd: at(1),
    });

    try {
      const body = (await (await callList()).json()) as ListPayload;
      const ids = body.drops.map((drop) => drop.id);

      expect(ids).not.toContain(draftNow);
      expect(ids).not.toContain(failedNow);
      // And the window is not what did it: `drops.open` is in the same window and present.
      expect(ids).toContain(drops.open);
    } finally {
      await prisma.drop.deleteMany({ where: { id: { in: [draftNow, failedNow] } } });
    }
  });

  it('reports zero left for a row whose redeemedQty is above its qty', async () => {
    // A data fix can leave `redeemedQty` above `qty`, and "−2 plates left" reads as a bug
    // to a staff member — worse than saying zero, which is what the floor in
    // `listCounterDrops` is for. Nothing else in this file has such a row, so the floor
    // was unasserted until a mutation probe survived by deleting it. `summariseManifest`
    // does **not** floor its own `plates - collected`, so the two disagree on purpose:
    // the header reports the data error, the picker does not.
    const body = (await (await callList()).json()) as ListPayload;
    const row = body.drops.find((drop) => drop.id === drops.overRedeemed);

    expect(row).toBeDefined();
    expect(row?.outstanding).toBe(0);
    expect(row?.outstanding).not.toBe(-2);
  });
});

describe('GET /api/merchant/pickup-queue/:id — authorisation', () => {
  it('answers 401 with no session', async () => {
    sessionState.session = null;
    const response = await callManifest(drops.open);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('"rows"');
  });

  it.each(['ORGANISER', 'ADMIN'] as const)('answers 403 for a %s session', async (role) => {
    sessionState.session = { userId: ownerUserId, role, mustChangePassword: false };
    expect((await callManifest(drops.open)).status).toBe(403);
  });

  it('answers 404, not 403, for another merchant\u2019s drop', async () => {
    // US-M1. A 403 would confirm the id exists, which is the one thing a merchant must
    // not be able to learn about another merchant's drop.
    expect((await callManifest(drops.foreign)).status).toBe(404);
  });

  it('gives a foreign id and an invented id the same answer, word for word', async () => {
    // The stronger form of the rule above. A 404 with a distinguishing message — "that
    // drop belongs to another merchant" — is a 403 wearing a 404's status code, and the
    // difference is only observable by comparing the two bodies.
    const foreign = await callManifest(drops.foreign);
    const invented = await callManifest('00000000-0000-4000-8000-000000000000');

    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(await foreign.json()).toEqual(await invented.json());
  });

  it('answers 404 for a merchant who owns nothing at all', async () => {
    const stranger = await prisma.user.create({
      data: {
        email: `${PREFIX}-nobody@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });

    sessionState.session = { userId: stranger.id, role: 'MERCHANT', mustChangePassword: false };
    // The empty-scope short circuit in `loadManifest`, which must be a decision and not
    // a query with an empty `in` list — Prisma returns nothing for that, which is the
    // right answer by accident.
    expect((await callManifest(drops.open)).status).toBe(404);

    await prisma.user.delete({ where: { id: stranger.id } });
  });

  it('lets a borrowed session read the manifest', async () => {
    sessionState.session = {
      userId: ownerUserId,
      role: 'MERCHANT',
      mustChangePassword: false,
      impersonation: { actorUserId: 'admin-1', auditId: 'audit-1', expiresAt: 0 },
    };

    expect((await callManifest(drops.open)).status).toBe(200);
  });
});

describe('GET /api/merchant/pickup-queue/:id — the payload', () => {
  it('is the same manifest the pickup page renders', async () => {
    const expected = await loadManifest([merchantId], drops.open);
    const body = (await (await callManifest(drops.open)).json()) as ManifestPayload;

    expect(body.dropId).toBe(expected.dropId);
    expect(body.title).toBe(expected.title);
    expect(body.status).toBe(expected.status);
    expect(body.timeZone).toBe(expected.timeZone);
    expect(body.windowStart).toBe(expected.windowStart.toISOString());
    expect(body.windowEnd).toBe(expected.windowEnd.toISOString());
    expect(body.summary).toEqual(expected.summary);
    expect(body.rows).toHaveLength(expected.rows.length);
  });

  it('serialises redeemedAt as ISO when it is set and null when it is not', async () => {
    const body = (await (await callManifest(drops.open)).json()) as ManifestPayload;

    const collected = body.rows.filter((row) => row.redeemedQty > 0);
    const waiting = body.rows.filter((row) => row.redeemedQty === 0);

    expect(collected.length).toBeGreaterThan(0);
    expect(waiting.length).toBeGreaterThan(0);
    expect(collected.every((row) => row.redeemedAt !== null)).toBe(true);
    // A `null` must be `null`, not the string "null" and not an absent key: a client
    // reading `row.redeemedAt` gets `undefined` for the absent case and formats it as
    // "Invalid Date".
    expect(waiting.every((row) => row.redeemedAt === null)).toBe(true);
    // **`typeof` and not just "looks like a date".** Passing the raw `Date` through, or
    // the bare column, produces an ISO string after `JSON.stringify` anyway — so the
    // `.toISOString()` in the route can be deleted and every value assertion above still
    // passes. What changes is the *type* leaving this function, and that is what a
    // handler test can see. Found by a probe that survived on the value form alone.
    expect(collected.every((row) => typeof row.redeemedAt === 'string')).toBe(true);
    expect(collected.every((row) => new Date(row.redeemedAt!).toISOString() === row.redeemedAt)).toBe(true);
  });

  it('sends exactly the six row fields the contract names, so the redaction cannot be widened', async () => {
    // The FR-805 test below searches the serialised body for a phone number. That catches
    // a leak of a *known* value; it cannot catch a `select` that starts returning
    // something not yet in the database as a formatted string, and it gives no reason for
    // the map to exist at all — a bare `NextResponse.json(manifest)` would pass it. This
    // is the assertion that makes the route's explicit projection load-bearing.
    const body = (await (await callManifest(drops.open)).json()) as ManifestPayload;

    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['name', 'participantId', 'phoneLast4', 'qty', 'redeemedAt', 'redeemedQty'].sort(),
      );
    }
    // And the envelope, so a field added beside `rows` — a `merchant`, a `menuItem` — is a
    // failing test rather than a silent widening.
    expect(Object.keys(body).sort()).toEqual(
      ['dropId', 'rows', 'status', 'summary', 'timeZone', 'title', 'windowEnd', 'windowStart'].sort(),
    );
  });

  it('keeps the rows in the order the query put them in', async () => {
    const expected = await loadManifest([merchantId], drops.open);
    const body = (await (await callManifest(drops.open)).json()) as ManifestPayload;

    expect(body.rows.map((row) => row.participantId)).toEqual(expected.rows.map((row) => row.participantId));
  });

  it('puts the outstanding order first even though its diner sorts last by name', async () => {
    // **The fixture has to make the two orderings disagree, or this proves nothing.** The
    // first draft of the test above compared the route's order to the query's, and a
    // `[...rows].sort(byName)` added to the route survived it — because the collected
    // diner happens to be created first *and* named earlier, so `createdAt` order,
    // name order and outstanding-first order all agreed. Deleting the `orderBy` survived
    // for the same reason.
    //
    // Here the collected order is named to sort first ("Aaa…") and the outstanding one to
    // sort last ("Zzz…"), so every ordering disagrees with every other. Outstanding-first
    // is the only one that puts the waiting diner at the top, which is what a staff member
    // working down the list needs.
    await prisma.customer.updateMany({
      where: { participants: { some: { dropId: drops.open, redeemedQty: { gt: 0 } } } },
      data: { name: `${PREFIX} Aaa Collected` },
    });
    await prisma.customer.updateMany({
      where: { participants: { some: { dropId: drops.open, redeemedQty: 0 } } },
      data: { name: `${PREFIX} Zzz Waiting` },
    });

    const body = (await (await callManifest(drops.open)).json()) as ManifestPayload;

    expect(body.rows[0]?.name).toBe(`${PREFIX} Zzz Waiting`);
    expect(body.rows[0]?.redeemedQty).toBe(0);
    expect(body.rows[1]?.name).toBe(`${PREFIX} Aaa Collected`);
    // And it is genuinely the outstanding-first rule rather than an accident of insertion
    // order: the waiting diner was created *second*.
    expect(body.rows[0]?.participantId).not.toBe(
      (await loadManifest([merchantId], drops.open)).rows.find((row) => row.redeemedQty > 0)?.participantId,
    );
  });

  it('includes the summary the header prints', async () => {
    const body = (await (await callManifest(drops.open)).json()) as ManifestPayload;

    // Five plates, two orders, one collected: the counts disagree on purpose, and the
    // header needs both.
    expect(body.summary).toEqual({
      orders: 2,
      plates: 5,
      collected: 1,
      outstanding: 4,
      fullyCollectedOrders: 0,
    });
  });

  it('shows a FAILED drop, which the list does not — deliberately, and in opposite directions', async () => {
    // The two endpoints disagree about status, and both are right. `listCounterDrops`
    // filters to what is plausibly at a counter, so a failed drop is not offered as work.
    // `loadManifest` refuses to over-restrict, because a diner may call to ask about a
    // drop that failed and a read that answers "not found" gets worked around with a
    // spreadsheet.
    //
    // This is the assertion that stops the two being made "consistent" later: someone
    // tidying up would naturally give the manifest the list's status filter, and it
    // would look like a fix.
    const list = (await (await callList()).json()) as ListPayload;
    expect(list.drops.map((drop) => drop.id)).not.toContain(drops.failed);

    const manifest = await callManifest(drops.failed);
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as ManifestPayload).status).toBe('FAILED');
  });
});

describe('GET /api/merchant/pickup-queue/:id — FR-805', () => {
  it('carries no full phone number, only the last four digits', async () => {
    const response = await callManifest(drops.open);
    const text = await response.text();

    // Looked up from the database, not hardcoded: the fixture's number is generated, and
    // an assertion against a literal would be an assertion about the fixture.
    const { phone } = await prisma.customer.findFirstOrThrow({
      where: { participants: { some: { dropId: drops.open } } },
      select: { phone: true },
    });

    expect(text).not.toContain(phone);
    // And the last four ARE present, so the assertion above is about redaction rather
    // than about the row being missing.
    expect(text).toContain(phone.slice(-4));

    const body = JSON.parse(text) as ManifestPayload;
    for (const row of body.rows) {
      expect(row.phoneLast4).toMatch(/^\d{4}$/);
    }
  });

  it('has no field that could hold a number even if a value were wrong', async () => {
    const body = (await (await callManifest(drops.open)).json()) as ManifestPayload;

    // Stronger than a value check: the row shape is asserted, so a future `phone: string`
    // added to the route fails here rather than in a review nobody had time for.
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['name', 'participantId', 'phoneLast4', 'qty', 'redeemedAt', 'redeemedQty'].sort(),
      );
    }
    expect(JSON.stringify(body)).not.toContain('"phone"');
  });
});

describe('GET /api/merchant/pickup-queue/:id — the log line', () => {
  it('records one manifest view with the counts the header shows', async () => {
    await callManifest(drops.open);

    const views = logLines.filter((line) => line.event === 'redemption.manifest_viewed');
    expect(views).toHaveLength(1);

    // Counts, so "how many counters are being opened, and on what" is answerable without
    // reading rows. Matched against the query's own summary rather than literals.
    const expected = await loadManifest([merchantId], drops.open);
    expect(views[0]?.fields.dropId).toBe(drops.open);
    expect(views[0]?.fields.orders).toBe(expected.summary.orders);
    expect(views[0]?.fields.plates).toBe(expected.summary.plates);
  });

  it('puts no diner\u2019s name or phone in the log line', async () => {
    // The event map permits `dropId`, `merchantId`, `orders` and `plates` — no name and no
    // phone. That is a type-level guarantee today; this walks the actual values so a
    // future field carrying a row cannot slip through as `string`.
    const customer = await prisma.customer.findFirstOrThrow({
      where: { participants: { some: { dropId: drops.open } }, name: { not: null } },
      select: { phone: true, name: true },
    });

    await callManifest(drops.open);

    const everything = JSON.stringify(logLines);
    expect(everything).not.toContain(customer.phone);
    expect(everything).not.toContain(customer.name!);
    expect(everything).not.toContain(customer.phone.slice(-4));
  });

  it('logs nothing when the manifest was refused', async () => {
    // A 404 that still logged `manifest_viewed` would make the metric mean "someone asked"
    // rather than "someone looked", and the difference is the whole reason the event
    // exists.
    await callManifest(drops.foreign);
    expect(logLines.filter((line) => line.event === 'redemption.manifest_viewed')).toHaveLength(0);
  });
});

describe('both endpoints — writes nothing', () => {
  it('leaves every row type untouched across repeated calls', async () => {
    const counts = async (): Promise<Record<string, number>> => ({
      drops: await prisma.drop.count(),
      participants: await prisma.dropParticipant.count(),
      customers: await prisma.customer.count(),
      shareLinks: await prisma.shareLink.count(),
      audits: await prisma.auditLog.count(),
    });

    const before = await counts();
    await callList();
    await callList();
    await callManifest(drops.open);
    await callManifest(drops.open);

    // These are the endpoints a counter screen polls. A write hidden behind one would fire
    // on every poll — the same class of defect the organiser drops route records.
    expect(await counts()).toEqual(before);
  });
});
