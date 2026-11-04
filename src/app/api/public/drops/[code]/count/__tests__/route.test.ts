import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDraft, markPublished } from '@/lib/db/drops';
import { createItem } from '@/lib/db/items';
import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, buildGuardrailSnapshot } from '@/lib/guardrail';
import { getPublicDrop } from '@/lib/public/public-drops';
import { headlineFor, resolveDropView } from '@/lib/public/drop-view';

import { GET } from '../route';

/**
 * `GET /api/public/drops/:code/count` — FR-303's poll target.
 *
 * > `FR-303 | Live count on the deal page | … | Polls every 15 s`
 * > — PRD-v1.md
 *
 * ## Why a route test when `drop-view.ts` and `public-drops.ts` are each tested
 *
 * Because the route is the only place those two meet, and the meeting is where a
 * shape error lives. `resolveDropView` returning a correct `DropView` and
 * `getPublicDrop` returning a correct `PublicDrop` are both necessary and neither
 * is sufficient: the route picks nine fields out of the view and renames nothing,
 * and the browser reads those names literally —
 *
 *     if (body.view.offerPhase !== snapshot.offerPhase) { router.refresh(); }
 *     setSnapshot(body.view);
 *
 * — so a view property that is computed correctly and then *omitted* from the
 * payload does not fail anywhere. `CountPoller` sees `undefined !== 'OPEN'` on
 * every single tick and calls `router.refresh()` twice a minute for the whole
 * life of a drop. Nothing in the suite would have caught that before this file,
 * because `CountPoller` is a client component and there is no client test runner
 * here.
 *
 * ## The three claims, and what falsifies each
 *
 *   1. **It does not leak participants.** The response is asserted to be exactly
 *      one `view` key with exactly nine keys, by `toEqual` on the whole object
 *      rather than by spot-checks. A field added to
 *      `PublicDrop`→`DropView`→response by a well-meaning refactor shows up here
 *      as a failure rather than as a privacy incident. This is the assertion the
 *      file exists for; everything else is scaffolding around it.
 *   2. **Only live authorisations count.** A `VOIDED` row is a released hold, not
 *      a claimed plate. Proven by a fixture with both, so a `reduce` that lost its
 *      `where` clause on `authStatus` reports 12 instead of 7.
 *   3. **The sentence is the server's.** `headline` is asserted against
 *      `headlineFor(resolveDropView(…))` computed in the test from the same rows —
 *      and then *also* against a literal, because the first assertion is satisfied
 *      by a route that imports the function and the second is not satisfied by a
 *      route that invents its own wording.
 *
 * ## What is not mocked
 *
 * Nothing: there is no session, no gate, and no side effect. `getPublicDrop` is
 * the real scoped query and `resolveDropView` is the real arithmetic, both against
 * real rows. The only thing replaced by the harness is the clock, and it is not
 * replaced — the fixture windows are relative to `Date.now()` so the assertions
 * hold whenever they run.
 */

const PREFIX = `count-${Date.now()}`;
const HOUR = 60 * 60 * 1000;

type Timing = { cutoffAt: Date; windowStart: Date; windowEnd: Date };

function timing(offsetHours = 24): Timing {
  const now = Date.now();
  return {
    cutoffAt: new Date(now + offsetHours * HOUR),
    windowStart: new Date(now + (offsetHours + 2) * HOUR),
    windowEnd: new Date(now + (offsetHours + 4) * HOUR),
  };
}

/** A monotonic customer phone suffix. `@unique` on `phone`; see AGENTS.md. */
let customerSeq = 0;
function nextPhone(): string {
  customerSeq += 1;
  return `+1403555${String(customerSeq).padStart(4, '0')}`;
}

async function makeCustomer(name: string): Promise<string> {
  const customer = await prisma.customer.create({
    data: { phone: nextPhone(), name },
    select: { id: true },
  });
  return customer.id;
}

const merchantIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];

/**
 * There is deliberately no `merchantId` here. Every assertion in this file is
 * about what an unauthenticated caller sees, and the merchant id never appears in
 * the response — so a binding for it would be a value nothing could use. The
 * merchant is tracked only through `merchantIds`, which the teardown needs.
 */
let itemId = '';
let guardrailSnapshot: unknown;

/** 10 claimed plates across 7 units, plus 5 released holds that must not count. */
let liveCode = '';
/** A `DRAFT` — must be invisible, exactly as if the code did not exist. */
let draftCode = '';
/** A drop whose threshold is met and whose batch is nearly full. */
let scarceCode = '';
/** A `CANCELLED` drop that did capture money — the `hadCaptures` sentence. */
let cancelledCode = '';

function request(code: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/public/drops/${code}/count`);
}

function context(code: string): { params: Promise<{ code: string }> } {
  return { params: Promise.resolve({ code }) };
}

async function call(code: string): Promise<Response> {
  return GET(request(code), context(code));
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  userIds.push(user.id);

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} kitchen`,
      slug: `${PREFIX}-slug`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      pickupAddress: '2915 10 Ave NE, Calgary',
      pickupInstructions: 'Side door.',
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
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

  guardrailSnapshot = buildGuardrailSnapshot(
    {
      ...DEFAULT_FEES,
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      floorPctOfMenu: 0.25,
    },
    1310,
    new Date().toISOString(),
  );

  // ---- the main drop: minQty 8, maxQty 30, cutoff comfortably ahead --------
  const live = await createDraft([merchant.id], {
    menuItemId: itemId,
    title: `${PREFIX} lunch`,
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 8,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });
  liveCode = live.publicCode;
  await markPublished({
    id: live.id,
    publishedAt: new Date(),
    guardrailSnapshot: guardrailSnapshot as object,
  });

  // 4 + 3 = 7 authorised units ...
  const first = await makeCustomer('A');
  const second = await makeCustomer('B');
  customerIds.push(first, second);
  await prisma.dropParticipant.createMany({
    data: [
      {
        dropId: live.id,
        customerId: first,
        qty: 4,
        amountCents: 5240,
        platformFeeCents: 52,
        authStatus: 'AUTHORIZED',
        chargeStatus: 'NONE',
      },
      {
        dropId: live.id,
        customerId: second,
        qty: 3,
        amountCents: 3930,
        platformFeeCents: 39,
        authStatus: 'AUTHORIZED',
        chargeStatus: 'NONE',
      },
    ],
  });

  // ... and 5 units that were held and released. If the route (via
  // `getPublicDrop`) ever counts these, joinedQty is 12 and the threshold
  // appears met when it is not — the drop would look confirmed while a diner
  // was still the difference between running and not running.
  const third = await makeCustomer('C');
  customerIds.push(third);
  await prisma.dropParticipant.create({
    data: {
      dropId: live.id,
      customerId: third,
      qty: 5,
      amountCents: 6550,
      platformFeeCents: 65,
      authStatus: 'VOIDED',
      chargeStatus: 'NONE',
    },
  });

  // ---- a draft: must be indistinguishable from a code that does not exist --
  const draft = await createDraft([merchant.id], {
    menuItemId: itemId,
    title: `${PREFIX} unpublished`,
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 8,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });
  draftCode = draft.publicCode;

  // ---- scarcity: 27 of 30 claimed, so 3 left of a 30 batch ----------------
  const scarce = await createDraft([merchant.id], {
    menuItemId: itemId,
    title: `${PREFIX} scarce`,
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 27,
    aiRationale: null,
    ...timing(),
  });
  scarceCode = scarce.publicCode;
  await markPublished({
    id: scarce.id,
    publishedAt: new Date(),
    guardrailSnapshot: guardrailSnapshot as object,
  });
  const bulk = await makeCustomer('D');
  customerIds.push(bulk);
  await prisma.dropParticipant.create({
    data: {
      dropId: scarce.id,
      customerId: bulk,
      qty: 27,
      amountCents: 35370,
      platformFeeCents: 353,
      authStatus: 'AUTHORIZED',
      chargeStatus: 'CAPTURED',
    },
  });

  // ---- cancelled after capture: the `hadCaptures` branch of the sentence ---
  const cancelled = await createDraft([merchant.id], {
    menuItemId: itemId,
    title: `${PREFIX} called off`,
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 8,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });
  cancelledCode = cancelled.publicCode;
  await markPublished({
    id: cancelled.id,
    publishedAt: new Date(),
    guardrailSnapshot: guardrailSnapshot as object,
  });
  const diner = await makeCustomer('E');
  customerIds.push(diner);
  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: cancelled.id,
      customerId: diner,
      qty: 2,
      amountCents: 2620,
      platformFeeCents: 26,
      authStatus: 'AUTHORIZED',
      chargeStatus: 'CAPTURED',
    },
    select: { id: true },
  });
  // The `Order` row is what makes `hadCaptures` true. Written directly rather
  // than through settlement, because this file is about the *sentence* a diner
  // reads after the fact, not about how the fact came to be.
  await prisma.order.create({
    data: {
      // `Order` is 1:1 with the participant (D-5), and carries no merchant or
      // customer column of its own — it reaches both through the participant.
      dropId: cancelled.id,
      participantId: participant.id,
      qty: 2,
      unitPriceCents: 1310,
      subtotalCents: 2620,
      platformFeeCents: 26,
    },
    select: { id: true },
  });
  await prisma.drop.update({
    where: { id: cancelled.id },
    data: { status: 'CANCELLED' },
  });
});

afterAll(async () => {
  // By tenant, and in FK order. `Order` → `DropParticipant` is a real relation
  // (D-5) but not a cascade, and `DropParticipant` → `Drop` *is* a cascade, so
  // orders are deleted explicitly before the drops take their participants with
  // them. Deleting only the drop would fail on the `Order.participantId` FK.
  if (merchantIds.length > 0) {
    await prisma.order
      .deleteMany({ where: { drop: { merchantId: { in: merchantIds } } } })
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
  if (customerIds.length > 0) {
    await prisma.customer
      .deleteMany({ where: { id: { in: customerIds } } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
});

type CountResponse = {
  view: {
    headline: string;
    joinedQty: number;
    minQty: number;
    maxQty: number;
    remainingQty: number;
    progress: number;
    showScarcity: boolean;
    offerPhase: string;
    canJoin: boolean;
  };
};

describe('GET /api/public/drops/:code/count — the payload', () => {
  it('answers 200 with exactly the keys CountPoller reads, and no others', async () => {
    const response = await call(liveCode);
    expect(response.status).toBe(200);

    const body = (await response.json()) as CountResponse;

    /**
     * `toEqual` on the whole object, not `toEqual(expect.objectContaining(...))`.
     *
     * The difference is the whole privacy claim. `objectContaining` passes when
     * the response carries `participants: [...]` alongside the view — which is
     * exactly what a future refactor that returned `PublicDrop` directly would
     * do, because `PublicDrop` is ~20 fields and the route narrows it to nine.
     * A participant list on a public, unauthenticated, enumerable-by-phone-number
     * endpoint is a privacy incident; this assertion is the only thing standing
     * between the current narrowing and that.
     */
    expect(Object.keys(body)).toEqual(['view']);
    expect(Object.keys(body.view).sort()).toEqual(
      [
        'canJoin',
        'headline',
        'joinedQty',
        'maxQty',
        'minQty',
        'offerPhase',
        'progress',
        'remainingQty',
        'showScarcity',
      ].sort(),
    );
  });

  it('counts only AUTHORIZED participants', async () => {
    const response = await call(liveCode);
    const body = (await response.json()) as CountResponse;

    // 4 + 3 authorised; the `VOIDED` 5 must not be here.
    expect(body.view.joinedQty).toBe(7);
    expect(body.view.remainingQty).toBe(23);
    // 7/8 — the threshold is *not* met, and `>=` vs `>` in `resolveDropView`
    // is the difference between "still open" and "confirmed".
    expect(body.view.progress).toBeCloseTo(0.875, 5);
    expect(body.view.offerPhase).toBe('OPEN');
  });

  it('reports the scarcity flag only near the ceiling', async () => {
    const body = (await (await call(liveCode)).json()) as CountResponse;
    // 23 left of 30 is 76% — not scarce.
    expect(body.view.showScarcity).toBe(false);

    const scarce = (await (await call(scarceCode)).json()) as CountResponse;
    // 3 left of 30 is 10%, below FR-304's 20% threshold.
    expect(scarce.view.remainingQty).toBe(3);
    expect(scarce.view.showScarcity).toBe(true);
    // Threshold met (27 >= 20), so it is confirmed *and* still joinable:
    // ADR-003 keeps taking joins up to maxQty.
    expect(scarce.view.offerPhase).toBe('CONFIRMED');
    expect(scarce.view.canJoin).toBe(true);
  });

  it('builds the sentence with the same function the page uses', async () => {
    const body = (await (await call(liveCode)).json()) as CountResponse;

    /**
     * Asserted twice, on purpose, and the two assertions are not redundant.
     *
     * Against the recomputation: proves the route did not invent a sentence of
     * its own, which is the drift the route's own docblock is written against
     * ("there would be two definitions of 'Confirmed — 22 orders', and they would
     * drift the first time somebody edited one"). This holds under any edit to
     * `headlineFor`, including a wrong one.
     *
     * Against the literal: proves `headlineFor` was not itself changed to
     * something wrong in the same commit, which the first assertion cannot see.
     * The literal is the sentence a diner currently reads.
     */
    const row = await getPublicDrop(liveCode);
    expect(row).not.toBeNull();
    const recomputed = headlineFor(
      resolveDropView({
        status: row!.status,
        minQty: row!.minQty,
        maxQty: row!.maxQty,
        cutoffAt: row!.cutoffAt,
        windowStart: row!.windowStart,
        windowEnd: row!.windowEnd,
        joinedQty: row!.joinedQty,
        now: new Date(),
        hadCaptures: row!.hadCaptures,
      }),
      8,
    );
    expect(body.view.headline).toBe(recomputed);
    expect(body.view.headline).toBe('7 of 8 orders in.');
  });

  it('distinguishes a cancelled drop that took money from one that did not', async () => {
    /**
     * FR-306 and `headlineFor` make a **monetary claim** in this branch
     * ("refunded in full"). It is only true because `forceFailDrop` refunds
     * before writing the status. This fixture has the `Order` row, so it lands in
     * the refunded arm — and a route that dropped `hadCaptures` from the
     * `resolveDropView` call would produce the "nobody was charged" sentence
     * about a drop whose diners were charged.
     */
    const body = (await (await call(cancelledCode)).json()) as CountResponse;

    expect(body.view.offerPhase).toBe('CANCELLED');
    expect(body.view.headline).toBe(
      'This drop was cancelled by the restaurant. Everyone who paid has been refunded in full.',
    );
    expect(body.view.canJoin).toBe(false);
  });
});

describe('GET /api/public/drops/:code/count — what it refuses', () => {
  it('answers 404 for a code that does not exist', async () => {
    const response = await call(`${PREFIX}-no-such-code`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'NOT_FOUND',
      message: 'That drop could not be found.',
    });
  });

  it('answers 404 for a DRAFT, identically to a code that does not exist', async () => {
    /**
     * The body is compared to the unknown-code body rather than to a literal, so
     * the assertion is "these two are indistinguishable" — which is the actual
     * requirement. Two different messages would let a caller enumerate drafts by
     * probing codes, and the route's docblock says exactly why that distinction
     * belongs to the merchant rather than to the public.
     */
    const draft = await call(draftCode);
    const missing = await call(`${PREFIX}-no-such-code`);

    expect(draft.status).toBe(404);
    expect(draft.status).toBe(missing.status);
    expect(await draft.json()).toEqual(await missing.json());
  });

  it('marks the response no-store, because a cached count is a wrong count', async () => {
    const response = await call(liveCode);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not require a session', async () => {
    // There is no cookie jar in this file and no `getSession` mock: if the route
    // acquired a gate, this call would be a 401 rather than a 200.
    const response = await call(liveCode);
    expect(response.status).toBe(200);
  });
});
