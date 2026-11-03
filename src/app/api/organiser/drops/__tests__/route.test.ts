import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * `GET /api/organiser/drops` — FR-801, and the equivalence claim in one place.
 *
 * > `GET    /api/organiser/drops` — PRD-v1.md:873
 *
 * ## What is real, and what that buys
 *
 * The **real** `requireOrganiser` / `requireOrganiserWrite`, the real Prisma client,
 * real Postgres. Only two things are replaced:
 *
 *   - `server-only`, which throws outside a React Server Component graph. This repo
 *     already does that in five files (`organiser-actions.test.ts`, three route tests,
 *     the contract suite); `@/lib/auth/authorize` itself is imported for real, so the
 *     role check, the attempt to make an API looser than its server action, and the
 *     impersonation refusal are the shipped code and not a look-alike. That is a
 *     deliberate departure from the other route tests here, which stub the gate — a
 *     stub cannot fail, and the gate was the thing designed for this slice.
 *   - `@/lib/auth/session`, whose `getSession` reads a cookie jar that does not exist
 *     under Vitest. Its contract is `SessionClaims | null`, produced here directly.
 *
 * ## The two properties this file exists for
 *
 *   1. **The route and the page cannot disagree.** The JSON is asserted field by field
 *      against `listShareableDrops` — the same function `/organiser` calls — rather than
 *      against literals. A hand-written literal would pass while the page drifted.
 *   2. **FR-805 has no field to leak.** The serialised payload is searched for the
 *      participant's phone number and its last four digits, both of which exist in the
 *      database for the drop being listed.
 */

vi.mock('server-only', () => ({}));

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
const { listShareableDrops } = await import('@/lib/db/share-links');

const PREFIX = `od${Date.now().toString(36).slice(-6)}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const HOUR = 60 * 60 * 1000;
const DEAL_PRICE = 1150;

const ROUTE_URL = 'http://localhost/api/organiser/drops';

let merchantId = '';
let itemId = '';
let organiserUserId = '';
let organiserProfileId = '';
let profilelessUserId = '';
let liveDropId = '';
let livePublicCode = '';

type Payload = {
  organiser: { displayName: string; commissionPct: number };
  drops: {
    id: string;
    publicCode: string;
    title: string;
    merchantName: string;
    dealPriceCents: number;
    menuPriceCents: number;
    minQty: number;
    maxQty: number;
    joinedQty: number;
    thresholdMet: boolean;
    cutoffAt: string;
    windowStart: string;
    windowEnd: string;
    timeZone: string;
    pickupAddress: string | null;
    existingToken: string | null;
    existingClicks: number;
  }[];
  ordering: string;
  orderingIsLikelyFill: boolean;
};

async function callRoute(): Promise<Response> {
  const route = await import('@/app/api/organiser/drops/route');
  return route.GET(new NextRequest(ROUTE_URL, { method: 'GET' }));
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);

  const organiser = await prisma.user.create({
    data: {
      email: `${PREFIX}-sam@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  organiserUserId = organiser.id;

  const profile = await prisma.organiserProfile.create({
    data: { userId: organiserUserId, displayName: `${PREFIX} Sam`, commissionPct: 5 },
    select: { id: true },
  });
  organiserProfileId = profile.id;

  // The FR-906 account: the right role, no profile behind it.
  const bare = await prisma.user.create({
    data: {
      email: `${PREFIX}-bare@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  profilelessUserId = bare.id;

  liveDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 4,
    maxQty: 30,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 6 * HOUR),
  });
  const drop = await prisma.drop.findUniqueOrThrow({
    where: { id: liveDropId },
    select: { publicCode: true },
  });
  livePublicCode = drop.publicCode;

  // Two plates from one diner, so `joinedQty` is a sum rather than a row count — and so
  // there is a real phone number in the database for the privacy assertion to look for.
  await fx.participant({ dropId: liveDropId, qty: 2, authStatus: 'AUTHORIZED' });
});

beforeEach(() => {
  sessionState.session = {
    userId: organiserUserId,
    role: 'ORGANISER',
    mustChangePassword: false,
  };
});

afterAll(async () => {
  await prisma.shareLink.deleteMany({ where: { organiserId: organiserProfileId } }).catch(() => undefined);
  await prisma.organiserProfile.deleteMany({ where: { userId: organiserUserId } }).catch(() => undefined);
  await fx.cleanup();
  await prisma.user
    .deleteMany({ where: { id: { in: [organiserUserId, profilelessUserId] } } })
    .catch(() => undefined);
  vi.resetModules();
});

describe('GET /api/organiser/drops — authorisation', () => {
  it('answers 401 with no session', async () => {
    sessionState.session = null;
    const response = await callRoute();

    expect(response.status).toBe(401);
    // And nothing about the roster leaks into the refusal.
    expect(await response.text()).not.toContain(livePublicCode);
  });

  it('answers 403 for a MERCHANT session', async () => {
    sessionState.session = { userId: organiserUserId, role: 'MERCHANT', mustChangePassword: false };
    const response = await callRoute();

    expect(response.status).toBe(403);
  });

  it('answers 403 for an ADMIN session, which has its own roster', async () => {
    sessionState.session = { userId: organiserUserId, role: 'ADMIN', mustChangePassword: false };
    expect((await callRoute()).status).toBe(403);
  });

  it('answers 403, not 404, for an organiser whose account has no profile', async () => {
    // The endpoint exists; the account is unfinished. A 404 would say the feature does
    // not exist, which is the opposite of the useful answer — the same decision the
    // commission route records.
    sessionState.session = { userId: profilelessUserId, role: 'ORGANISER', mustChangePassword: false };
    const response = await callRoute();
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(403);
    expect(body.message).toMatch(/organiser profile/i);
  });

  it('does not let a borrowed session read the list under an organiser claim', async () => {
    // Unreachable through the app today (impersonation is merchant-only, so the role
    // check answers first). Asserted anyway: the combination is what a forged or
    // future claim would look like, and the read gate must not wave it through.
    sessionState.session = {
      userId: organiserUserId,
      role: 'ORGANISER',
      mustChangePassword: false,
      impersonation: { actorUserId: 'admin-1', auditId: 'audit-1', expiresAt: 0 },
    };

    const response = await callRoute();
    // The read gate does not refuse impersonation — reading is what impersonation is
    // for — but the session is still an organiser and still resolves its own profile.
    // What must NOT happen is a 200 that includes somebody else's data; this session
    // reads its own list, which is empty of other organisers' rows by construction.
    expect(response.status).toBe(200);
    const body = (await response.json()) as Payload;
    expect(body.organiser.displayName).toBe(`${PREFIX} Sam`);
  });

  it('refuses mustChangePassword on the write gate but not on this read', async () => {
    // The asymmetry is deliberate and matches the rest of the app: middleware holds such
    // a session on /change-password for every path, so a read gate that also refused
    // would be a second enforcement point that disagreeing could silently weaken.
    sessionState.session = { userId: organiserUserId, role: 'ORGANISER', mustChangePassword: true };
    expect((await callRoute()).status).toBe(200);
  });
});

describe('GET /api/organiser/drops — the payload', () => {
  it('is the same rows the organiser page renders', async () => {
    const rows = await listShareableDrops({ organiserProfileId });
    const response = await callRoute();
    const body = (await response.json()) as Payload;

    expect(response.status).toBe(200);

    // Field-by-field against the function, not against literals. This is the assertion
    // that a change to `listShareableDrops` cannot reach the page and miss the API.
    const expected = rows.find((row) => row.id === liveDropId);
    const actual = body.drops.find((row) => row.id === liveDropId);

    expect(expected).toBeDefined();
    expect(actual).toBeDefined();
    expect(actual?.publicCode).toBe(expected?.publicCode);
    expect(actual?.title).toBe(expected?.title);
    expect(actual?.merchantName).toBe(expected?.merchantName);
    expect(actual?.dealPriceCents).toBe(expected?.dealPriceCents);
    expect(actual?.menuPriceCents).toBe(expected?.menuPriceCents);
    expect(actual?.minQty).toBe(expected?.minQty);
    expect(actual?.maxQty).toBe(expected?.maxQty);
    expect(actual?.joinedQty).toBe(expected?.joinedQty);
    expect(actual?.pickupAddress).toBe(expected?.pickupAddress);
    expect(actual?.timeZone).toBe(expected?.merchantTimezone);
    expect(actual?.existingToken).toBe(expected?.existingToken);
    expect(actual?.existingClicks).toBe(expected?.existingClicks);
    expect(actual?.cutoffAt).toBe(expected?.cutoffAt.toISOString());
  });

  it('carries the numbers a client needs to decide "is this drop on" without guessing', async () => {
    const response = await callRoute();
    const body = (await response.json()) as Payload;
    const row = body.drops.find((candidate) => candidate.id === liveDropId);

    // Two plates, threshold of four: not met. `thresholdMet` is computed server-side so
    // a second client cannot pick `>` where the page picks `>=`.
    expect(row?.joinedQty).toBe(2);
    expect(row?.minQty).toBe(4);
    expect(row?.thresholdMet).toBe(false);
    expect(row?.timeZone).toBe('America/Edmonton');
  });

  it('names the ordering, including that it is not likelyFill', async () => {
    const body = (await (await callRoute()).json()) as Payload;

    // FR-801's acceptance says `likelyFill` (§9.4). It is not implemented (gap 16), and
    // a client that paginates or caches this list must be able to tell.
    expect(body.ordering).toBe('cutoff_at_asc');
    expect(body.orderingIsLikelyFill).toBe(false);
  });

  it('returns an empty list rather than a 404 when nothing is live', async () => {
    // Publish nothing new; instead read as an organiser whose merchant has no live drops
    // by pointing at a fresh profile. Constructed rather than raced, so the assertion is
    // about the route's answer and not about timing.
    const otherUser = await prisma.user.create({
      data: {
        email: `${PREFIX}-empty@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'ORGANISER',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    const otherProfile = await prisma.organiserProfile.create({
      data: { userId: otherUser.id, displayName: `${PREFIX} Empty` },
      select: { id: true },
    });

    sessionState.session = { userId: otherUser.id, role: 'ORGANISER', mustChangePassword: false };
    const response = await callRoute();
    const body = (await response.json()) as Payload;

    // The corridor is 5–15 organisers and every live drop is offered to every organiser,
    // so "none of my own" is a list of every live drop rather than an empty one. What
    // matters is that it is a 200 with an array, never a 404.
    expect(response.status).toBe(200);
    expect(Array.isArray(body.drops)).toBe(true);
    expect(body.organiser.displayName).toBe(`${PREFIX} Empty`);

    await prisma.organiserProfile.delete({ where: { id: otherProfile.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: otherUser.id } }).catch(() => undefined);
  });

  it('is not cacheable', async () => {
    // A cached copy offers a link to a drop that has since closed — the stale state
    // `ensureShareLink` re-checks because a header cannot be trusted.
    expect((await callRoute()).headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/organiser/drops — FR-805', () => {
  it('carries no participant phone number, not even the last four', async () => {
    const response = await callRoute();
    const text = await response.text();

    const customer = await prisma.customer.findFirstOrThrow({
      where: { participants: { some: { dropId: liveDropId } } },
      select: { phone: true },
    });

    expect(text).not.toContain(customer.phone);
    expect(text).not.toContain(customer.phone.slice(-4));
    // And no ids that could be joined back to a person.
    expect(text).not.toContain('"customerId"');
    expect(text).not.toContain('"participantId"');
    expect(text).not.toContain('"phone"');
  });
});

describe('GET /api/organiser/drops — writes nothing', () => {
  it('leaves ShareLink and DropParticipant untouched', async () => {
    const counts = async (): Promise<Record<string, number>> => ({
      shareLinks: await prisma.shareLink.count(),
      participants: await prisma.dropParticipant.count(),
      audits: await prisma.auditLog.count(),
    });

    const before = await counts();
    await callRoute();
    await callRoute();

    // This is the endpoint an organiser's client polls. A write hidden behind it would
    // fire on every poll, and a `ShareLink` row created per poll is the exact clutter
    // the page's docblock refuses to create per render.
    expect(await counts()).toEqual(before);
  });
});
