import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDraft, getDrop, markPublished } from '@/lib/db/drops';
import { prisma } from '@/lib/db/prisma';
import { publishDrop, reviewForPublish } from '@/lib/drops/publish';
import {
  DEFAULT_FLOOR_PCT,
  buildGuardrailSnapshot,
  readGuardrailSnapshot,
  sameSnapshotMoney,
} from '@/lib/guardrail';
import { AppError } from '@/lib/errors';

/**
 * FR-207 — the publish path, against a real database.
 *
 * The assertions that matter are the refusals. A publish path is easy to write
 * and easy to get wrong in one direction only: it lets something through. So
 * every test here tries to publish something that should be stopped, and checks
 * that it was — and that nothing was written.
 *
 * `payoutsReady: true` is passed explicitly in most cases so the Stripe gate
 * does not mask the rule under test. The gate has its own test.
 */

const PREFIX = 'publish-test-';
const NOW = new Date('2026-11-05T12:00:00-07:00');

let merchantId: string;
let otherMerchantId: string;
let goodItemId: string;
let alcoholItemId: string;
let nonBatchableItemId: string;
let implausibleItemId: string;

function at(offsetDays: number): Date {
  return new Date(NOW.getTime() + offsetDays * 24 * 60 * 60 * 1000);
}

/** A draft shaped to pass every rule, so each test can change one field. */
function draftBody(itemId: string, overrides: Record<string, unknown> = {}) {
  return {
    menuItemId: itemId,
    title: 'Beef Bowl Thursday',
    description: 'A batch of the flagship bowl.',
    heroImageUrl: null,
    // Vector A's floor: minViablePrice is 1112, so 1112 is the boundary.
    dealPriceCents: 1112,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    windowStart: at(4),
    windowEnd: new Date(at(4).getTime() + 2 * 60 * 60 * 1000),
    cutoffAt: at(3),
    aiRationale: null,
    ...overrides,
  };
}

beforeAll(async () => {
  const stamp = Date.now();
  const [merchant, other] = await Promise.all([
    prisma.merchant.create({
      data: {
        name: 'Publish Test',
        slug: `${PREFIX}${stamp}`,
        status: 'PENDING',
        floorPctOfMenu: DEFAULT_FLOOR_PCT,
      },
      select: { id: true },
    }),
    prisma.merchant.create({
      data: {
        name: 'Publish Test Other',
        slug: `${PREFIX}other-${stamp}`,
        status: 'PENDING',
        floorPctOfMenu: DEFAULT_FLOOR_PCT,
      },
      select: { id: true },
    }),
  ]);
  merchantId = merchant.id;
  otherMerchantId = other.id;

  const [good, alcohol, nonBatchable, implausible] = await Promise.all([
    // Vector A exactly: menu 1600, food 480, packing 80, floor 0.25.
    prisma.menuItem.create({
      data: {
        merchantId,
        name: 'Beef Bowl',
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 30,
      },
      select: { id: true },
    }),
    prisma.menuItem.create({
      data: {
        merchantId,
        name: 'Beer',
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 30,
        containsAlcohol: true,
      },
      select: { id: true },
    }),
    prisma.menuItem.create({
      data: {
        merchantId,
        name: 'Not Batchable',
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 30,
        isBatchable: false,
      },
      select: { id: true },
    }),
    prisma.menuItem.create({
      data: {
        merchantId,
        name: 'Impossible',
        // PRD-v1 §7.4 vector D: menu 900, food 850, packing 30.
        //
        // Cost data is *valid* (930 < 900? no — 880 < 900, so valid), but no
        // deal price can clear a 25% floor. Deliberately NOT food 880 + packing
        // 30, which would sum above the menu price and be caught by
        // `validateItemCosts` as COST_EXCEEDS_PRICE instead — a different
        // refusal, testing a different branch.
        menuPriceCents: 900,
        foodCostCents: 850,
        packagingCents: 30,
        batchYield: 30,
      },
      select: { id: true },
    }),
  ]);

  goodItemId = good.id;
  alcoholItemId = alcohol.id;
  nonBatchableItemId = nonBatchable.id;
  implausibleItemId = implausible.id;
});

afterAll(async () => {
  await prisma.drop.deleteMany({
    where: { merchantId: { in: [merchantId, otherMerchantId].filter(Boolean) } },
  });
  await prisma.menuItem.deleteMany({
    where: { merchantId: { in: [merchantId, otherMerchantId].filter(Boolean) } },
  });
  await prisma.merchant.deleteMany({
    where: { id: { in: [merchantId, otherMerchantId].filter(Boolean) } },
  });
  await prisma.$disconnect();
});

describe('createDraft', () => {
  it('creates a DRAFT with an empty snapshot and a well-formed public code', async () => {
    const drop = await createDraft([merchantId], draftBody(goodItemId));

    expect(drop.status).toBe('DRAFT');
    expect(drop.publishedAt).toBeNull();
    expect(drop.publicCode).toMatch(/^[A-Z2-9]{8}$/);
    // The snapshot must be empty until publish: a placeholder object would be a
    // false claim about when the maths was frozen.
    expect(drop.guardrailSnapshot).toEqual({});
  });

  it('refuses a dish belonging to another merchant', async () => {
    await expect(
      createDraft([otherMerchantId], draftBody(goodItemId)),
    ).rejects.toThrow(AppError);

    // And nothing was created.
    const count = await prisma.drop.count({ where: { merchantId: otherMerchantId } });
    expect(count).toBe(0);
  });

  it('gives every draft a distinct public code', async () => {
    const [a, b, c] = await Promise.all([
      createDraft([merchantId], draftBody(goodItemId)),
      createDraft([merchantId], draftBody(goodItemId)),
      createDraft([merchantId], draftBody(goodItemId)),
    ]);

    expect(new Set([a.publicCode, b.publicCode, c.publicCode]).size).toBe(3);
  });
});

describe('publishDrop · the happy path', () => {
  it('publishes once, freezes a readable snapshot, and stamps publishedAt', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));

    const { drop, snapshot } = await publishDrop({
      merchantIds: [merchantId],
      dropId: draft.id,
      actorId: 'test-actor',
      now: NOW,
      payoutsReady: true,
    });

    expect(drop.status).toBe('PUBLISHED');
    expect(drop.publishedAt?.toISOString()).toBe(NOW.toISOString());

    // The snapshot went through the database's `jsonb` column and came back
    // readable — the round trip is the thing that would break on a Date or a Map.
    //
    // Compared with `sameSnapshotMoney`, NOT `toEqual`: `jsonb` stores numbers as
    // `numeric`, so `400.79200000000003` reads back as `400.792`. Strict equality
    // against the in-memory snapshot fails on the 14th decimal place, and a
    // reconciliation job built on `===` would alert on every drop forever.
    const stored = readGuardrailSnapshot(drop.guardrailSnapshot);
    expect(sameSnapshotMoney(stored, snapshot)).toBe(true);
    expect(stored.version).toBe(1);
    expect(stored.result.dealPriceCents).toBe(1112);
    expect(stored.result.minViablePriceCents).toBe(1112);
    expect(stored.input.foodCostCents).toBe(480);

    // And the normalisation is real, not hypothetical:
    expect(stored.result.netContributionCents).not.toBe(snapshot.result.netContributionCents);
    expect(stored.result.netContributionCents).toBeCloseTo(400.792, 12);
  });

  it('freezes the fee constants that were in force, not the current ones', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));
    const { snapshot } = await publishDrop({
      merchantIds: [merchantId],
      dropId: draft.id,
      actorId: 'test-actor',
      now: NOW,
      payoutsReady: true,
    });

    expect(snapshot.input.stripePct).toBe(0.029);
    expect(snapshot.input.platformFeePct).toBe(0.08);
  });

  it('survives an item price change afterwards — the snapshot is immutable', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));
    const { drop } = await publishDrop({
      merchantIds: [merchantId],
      dropId: draft.id,
      actorId: 'test-actor',
      now: NOW,
      payoutsReady: true,
    });

    const before = readGuardrailSnapshot(drop.guardrailSnapshot);

    // The merchant edits the dish next month.
    await prisma.menuItem.update({
      where: { id: goodItemId },
      data: { foodCostCents: 900 },
    });

    const after = await getDrop([merchantId], draft.id);
    // Both sides have been through `jsonb`, so this comparison is exact.
    expect(readGuardrailSnapshot(after.guardrailSnapshot)).toEqual(before);

    // Restore, so later tests see vector A's numbers.
    await prisma.menuItem.update({
      where: { id: goodItemId },
      data: { foodCostCents: 480 },
    });
  });
});

describe('publishDrop · refuses what loses money', () => {
  it('refuses a price one cent below the floor', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId, { dealPriceCents: 1111 }));

    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toThrow(/lowest price that still works is \$11\.12/);

    // Still a draft, with no snapshot written.
    const after = await getDrop([merchantId], draft.id);
    expect(after.status).toBe('DRAFT');
    expect(after.guardrailSnapshot).toEqual({});
  });

  it('accepts exactly the floor price', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId, { dealPriceCents: 1112 }));

    const { drop } = await publishDrop({
      merchantIds: [merchantId],
      dropId: draft.id,
      actorId: 'test-actor',
      now: NOW,
      payoutsReady: true,
    });
    expect(drop.status).toBe('PUBLISHED');
  });

  it('refuses a price above the menu price', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId, { dealPriceCents: 1700 }));

    // A "deal" above the menu price would also break the Competition Act
    // requirement that a discount be real.
    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toThrow(/cheaper than the menu price/);
  });

  it('refuses an infeasible dish and says no price works', async () => {
    const draft = await createDraft([merchantId], draftBody(implausibleItemId, { dealPriceCents: 800 }));

    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toThrow(/No price clears your minimum margin/);
  });

  it('refuses an item containing alcohol — the AGLC hard block', async () => {
    const draft = await createDraft([merchantId], draftBody(alcoholItemId));

    // The refusal names the reason, not just "cannot be a drop": a merchant who
    // sells beer needs to know it is the alcohol, not the dish.
    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toThrow(/contains alcohol/);
  });

  it('refuses a non-batchable item', async () => {
    const draft = await createDraft([merchantId], draftBody(nonBatchableItemId));

    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toThrow(/not batchable/);
  });

  it('refuses a maxQty above the dish batch yield', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId, { minQty: 25, maxQty: 40 }));

    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toThrow(/30/);
  });

  it('refuses a cutoff beyond the authorisation window', async () => {
    const draft = await createDraft(
      [merchantId],
      draftBody(goodItemId, {
        cutoffAt: at(9),
        windowStart: at(10),
        windowEnd: new Date(at(10).getTime() + 2 * 60 * 60 * 1000),
      }),
    );

    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toThrow(/within 5 days/);
  });

  it('refuses when payouts are not ready, with a 409 rather than a 422', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));

    // 409, not 422: the merchant's numbers are fine; the account is not set up.
    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: false,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const after = await getDrop([merchantId], draft.id);
    expect(after.status).toBe('DRAFT');
  });

  it('reports the price problem before the payouts problem', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId, { dealPriceCents: 900 }));

    // Both are wrong. The merchant should hear about their own number first —
    // a Stripe account is not something they can fix in this moment.
    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: false,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a drop that is already published', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));
    await publishDrop({
      merchantIds: [merchantId],
      dropId: draft.id,
      actorId: 'test-actor',
      now: NOW,
      payoutsReady: true,
    });

    await expect(
      publishDrop({
        merchantIds: [merchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toThrow(/already been published/);
  });

  it('refuses a drop outside the caller scope, as a 404 not a 403', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));

    // A 403 would confirm that someone else's drop exists (US-M1).
    await expect(
      publishDrop({
        merchantIds: [otherMerchantId],
        dropId: draft.id,
        actorId: 'test-actor',
        now: NOW,
        payoutsReady: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('markPublished · concurrency', () => {  it('lets exactly one of two racing publishes win', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));
    const snapshot = buildGuardrailSnapshot(
      {
        platformFeePct: 0.08,
        platformFeeFloorCents: 60,
        platformFeeCapCents: 200,
        stripePct: 0.029,
        stripeFixedCents: 30,
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        floorPctOfMenu: 0.25,
      },
      1112,
      NOW.toISOString(),
    );

    const results = await Promise.allSettled([
      markPublished({ id: draft.id, publishedAt: NOW, guardrailSnapshot: snapshot }),
      markPublished({ id: draft.id, publishedAt: NOW, guardrailSnapshot: snapshot }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    // The `status: 'DRAFT'` predicate in the WHERE clause is what makes this
    // hold: the second update matches zero rows rather than overwriting a
    // snapshot that is supposed to be immutable.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe('reviewForPublish', () => {
  it('returns the refusals without writing anything', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId, { dealPriceCents: 1000 }));

    const review = await reviewForPublish({ drop: draft, now: NOW });

    expect(review.refusals).toHaveLength(1);
    expect(review.refusals[0]?.reason).toBe('PRICE_BELOW_FLOOR');
    // A preview that wrote would flip status from a GET.
    const after = await getDrop([merchantId], draft.id);
    expect(after.status).toBe('DRAFT');
    expect(after.guardrailSnapshot).toEqual({});
  });

  it('returns no refusals and a usable input for a sound draft', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));
    const review = await reviewForPublish({ drop: draft, now: NOW });

    expect(review.refusals).toEqual([]);
    expect(review.input).not.toBeNull();
    // The floor must have come through `toPct`, or every comparison is false and
    // the whole guardrail returns null silently.
    expect(review.input?.floorPctOfMenu).toBe(0.25);
  });
});

describe('the jsonb round trip (why sameSnapshotMoney exists)', () => {
  it('normalises float noise, so a stored snapshot is never strictly equal to its source', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));
    const { drop, snapshot } = await publishDrop({
      merchantIds: [merchantId],
      dropId: draft.id,
      actorId: 'test-actor',
      now: NOW,
      payoutsReady: true,
    });

    const stored = readGuardrailSnapshot(drop.guardrailSnapshot);

    // `Drop.guardrailSnapshot` is `jsonb`, which stores numbers as `numeric`.
    // `400.79200000000003` is written and `400.792` is read back. This is the
    // exact reason `sameSnapshotMoney` exists — a reconciliation built on `===`
    // would alert on every drop, forever, about 3e-14 of a cent.
    expect(snapshot.result.netContributionCents).toBe(400.79200000000003);
    expect(stored.result.netContributionCents).toBe(400.792);
    expect(stored.result.netContributionCents).not.toBe(snapshot.result.netContributionCents);

    // Same money, by the measure that matters.
    expect(sameSnapshotMoney(stored, snapshot)).toBe(true);
    expect(
      Math.abs(stored.result.netContributionCents - snapshot.result.netContributionCents),
    ).toBeLessThan(1e-9);
  });

  it('sameSnapshotMoney still catches a real difference', async () => {
    const draft = await createDraft([merchantId], draftBody(goodItemId));
    const { snapshot } = await publishDrop({
      merchantIds: [merchantId],
      dropId: draft.id,
      actorId: 'test-actor',
      now: NOW,
      payoutsReady: true,
    });

    // A tolerance that cannot distinguish a cent would be worthless. One cent is
    // ten orders of magnitude above the float noise.
    const altered = {
      ...snapshot,
      result: { ...snapshot.result, netContributionCents: snapshot.result.netContributionCents + 1 },
    };
    expect(sameSnapshotMoney(altered, snapshot)).toBe(false);

    const wrongInput = {
      ...snapshot,
      input: { ...snapshot.input, foodCostCents: snapshot.input.foodCostCents + 1 },
    };
    // Inputs are compared exactly: a different input is a different calculation,
    // not a rounding artefact.
    expect(sameSnapshotMoney(wrongInput, snapshot)).toBe(false);
  });
});
