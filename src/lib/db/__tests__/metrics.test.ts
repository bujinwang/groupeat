import 'dotenv/config';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DropStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { countAnalyticsEvents } from '@/lib/analytics/read-counts';
import { createDraft, markPublished } from '@/lib/db/drops';
import { createItem } from '@/lib/db/items';
import { loadNorthStarMetrics } from '@/lib/db/metrics';
import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, buildGuardrailSnapshot } from '@/lib/guardrail';

/**
 * `src/lib/db/metrics.ts` — the four reads that produce `NorthStarFacts`.
 *
 * ## Why this file exists
 *
 * The module executed **zero** statements across the whole suite before it. Its
 * only referrer, `src/app/(admin)/admin/metrics/__tests__/page.test.ts`, does
 *
 *     vi.mock('@/lib/db/metrics', () => ({ loadNorthStarMetrics: async () => metrics.current }));
 *
 * so the page's rendering was tested against a literal while the four queries
 * that supply it were never run once. The arithmetic in `lib/metrics/north-star.ts`
 * is separately tested; the gap was precisely the translation of rows into
 * `NorthStarFacts`, where every `where`, `orderBy` and `select` clause is a
 * definition of a metric that nothing could falsify.
 *
 * ## What each test pins
 *
 * Every assertion below names a **query clause**, not an arithmetic identity, and
 * each fixture is built so that dropping the clause yields a different number
 * rather than a coincidentally equal one:
 *
 *   - the decided-status `in` list (a leaked `DRAFT`/`CANCELLED` moves the denominator
 *     from 5 to 6, and moves the fill median off a value chosen to be insensitive to
 *     nothing else);
 *   - the participant `select` feeding the `EVER_AUTHORISED` filter — 9 authorised
 *     units against 200 declined/pending ones on one drop, so a missing filter reads
 *     23.2 instead of 1.0;
 *   - `orderBy: { publishedAt: 'asc' }, take: 1`, pinned by a merchant with two
 *     publishes two and five hours after their `createdAt`;
 *   - `publishedAt: { not: null }`, pinned by a merchant whose only drop is a draft;
 *   - `shareLinks: { some: {} }` against `publishedAt: { not: null }`, as a ratio;
 *   - `order: { isNot: null }` on the captured-participant read;
 *   - the analytics sink read, including its missing-file branch.
 *
 * ## What is mocked
 *
 * Nothing. That is the entire point: the previous file's failure mode was a mock
 * that made a module look tested. The only substitution is the analytics sink
 * path, which `resolveAnalyticsPath` documents as an environment override and
 * which is set to a throwaway temp file so the assertions do not depend on
 * whatever this machine has appended to `var/analytics/events.jsonl`.
 *
 * ## Isolation
 *
 * Each `describe` builds its own world and deletes it, because every one of these
 * queries is unscoped — `prisma.drop.findMany({ where: { status: … } })` reads
 * every drop in the database, not a merchant's. Two describes sharing a database
 * would make each other's medians and denominators wrong, which is exactly the
 * kind of cross-test coupling that produces a "flaky" suite nobody can explain.
 * The file therefore runs sequentially (the config already sets
 * `fileParallelism: false`) and leaves the thirteen counted tables at zero.
 */

const PREFIX = `nstar-${Date.now().toString(36)}`;
const HOUR = 60 * 60 * 1000;
const ISO = () => new Date().toISOString();

/** A fixed instant so `medianHoursToFirstPublish` is arithmetic, not a race. */
const T0 = new Date('2026-10-01T00:00:00.000Z');

/**
 * Every row this file creates, so teardown can delete it in FK order.
 *
 * Ids rather than `deleteMany({ where: { … } })` scoped by merchant: a bug in the
 * scope predicate would silently delete nothing and report a clean teardown. An
 * explicit id list can only be wrong by being empty, which the residue gate sees.
 */
const merchantIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];
const organiserProfileIds: string[] = [];
const dropIds: string[] = [];

let customerSeq = 0;

/**
 * `.env` sets `ANALYTICS_LOG_PATH` to the real sink, which on this machine holds
 * tens of thousands of events. Left alone, `joinConversion` would be a number
 * that changes every time anybody runs the app, and the assertion "a sink with no
 * events reads as zero" would be untestable. Overridden for the file and restored
 * afterwards; `countAnalyticsEvents`' explicit `path` argument is used where the
 * file wants a second, different sink.
 *
 * `createDraft` writes `drop_created` lines here as a side effect. They are not
 * `deal_page_viewed` or `join_authorised`, so the counts asserted below are
 * unaffected — but the file is not empty, which is why the missing-file branch is
 * proved against a path that was never created rather than against this one.
 */
const ORIGINAL_ANALYTICS_PATH = process.env.ANALYTICS_LOG_PATH;
let sinkDir = '';
let emptySink = '';

const guardrailSnapshot = buildGuardrailSnapshot(
  {
    ...DEFAULT_FEES,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    floorPctOfMenu: 0.25,
  },
  1310,
  ISO(),
);

type World = { merchantId: string; menuItemId: string };

function timing(offsetHours = 24): { cutoffAt: Date; windowStart: Date; windowEnd: Date } {
  const now = Date.now();
  return {
    cutoffAt: new Date(now + offsetHours * HOUR),
    windowStart: new Date(now + (offsetHours + 2) * HOUR),
    windowEnd: new Date(now + (offsetHours + 4) * HOUR),
  };
}

async function makeWorld(label: string, createdAt?: Date): Promise<World> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${label}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  userIds.push(user.id);

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} ${label}`,
      slug: `${PREFIX}-${label}`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      pickupAddress: '2915 10 Ave NE, Calgary',
      pickupInstructions: 'Side door.',
      users: { create: { userId: user.id, role: 'OWNER' } },
      ...(createdAt === undefined ? {} : { createdAt }),
    },
    select: { id: true },
  });
  merchantIds.push(merchant.id);

  const item = await createItem([merchant.id], {
    name: `${PREFIX} bowl`,
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 60,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });

  return { merchantId: merchant.id, menuItemId: item.id };
}

/**
 * A drop in a chosen terminal state.
 *
 * `markPublished` is used when a `publishedAt` is wanted, because it is the one
 * transition the repository permits and it is what a real publish does. The
 * status is then written directly: this file is about what the reads make of a
 * row, not about how the row came to be, and driving five statuses through
 * settlement would need Stripe.
 */
async function makeDrop(
  world: World,
  spec: { code: string; minQty: number; status?: DropStatus; publishedAt?: Date },
): Promise<string> {
  const draft = await createDraft([world.merchantId], {
    menuItemId: world.menuItemId,
    title: `${PREFIX} ${spec.code}`,
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: spec.minQty,
    maxQty: 500,
    maxPerCustomer: 500,
    aiRationale: null,
    ...timing(),
  });
  dropIds.push(draft.id);

  // `Drop.publicCode` is generated by `createDraft`; overwritten with the run's
  // prefix so a leaked row names its file, as AGENTS.md asks of every unique text.
  await prisma.drop.update({
    where: { id: draft.id },
    data: { publicCode: `${PREFIX}-${spec.code}` },
  });

  if (spec.publishedAt !== undefined) {
    await markPublished({
      id: draft.id,
      publishedAt: spec.publishedAt,
      guardrailSnapshot: guardrailSnapshot as object,
    });
  }

  const status = spec.status;
  if (status !== undefined && (status !== 'PUBLISHED' || spec.publishedAt === undefined)) {
    await prisma.drop.update({ where: { id: draft.id }, data: { status } });
  }

  return draft.id;
}

/**
 * Customers are phone-keyed and `phone` is `@unique`, so the suffix must be
 * numeric — `+1` plus the last seven digits of the clock plus a sequence is the
 * prefix in the only alphabet the column accepts.
 */
async function makeCustomer(label: string, seq: number): Promise<string> {
  const customer = await prisma.customer.create({
    data: {
      phone: `+1403${String(Date.now()).slice(-7)}${String(seq).padStart(2, '0')}`,
      name: `${PREFIX} ${label}`,
    },
    select: { id: true },
  });
  customerIds.push(customer.id);
  return customer.id;
}

/** One participant. `qty` and the two money columns are the only required ones. */
async function addParticipant(args: {
  dropId: string;
  customerId: string;
  qty: number;
  authStatus: 'PENDING' | 'AUTHORIZED' | 'FAILED' | 'VOIDED' | 'EXPIRED';
  chargeStatus?: 'NONE' | 'CAPTURED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED';
  redeemedQty?: number;
}): Promise<string> {
  const row = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId: args.customerId,
      qty: args.qty,
      amountCents: args.qty * 1310,
      platformFeeCents: args.qty * 13,
      authStatus: args.authStatus,
      chargeStatus: args.chargeStatus ?? 'NONE',
      redeemedQty: args.redeemedQty ?? 0,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Deletes this file's world in FK order, and fails loudly.
 *
 * Every step runs even if an earlier one throws, and the errors are rethrown
 * together: a teardown that stops at the first failure leaves a *failing* run
 * dirtier than a passing one, which is the worst possible coupling between a bug
 * and a leak.
 */
async function teardown(): Promise<void> {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  if (dropIds.length > 0) {
    const scope = { in: [...dropIds] };
    await step(() => prisma.redemptionScan.deleteMany({ where: { participant: { dropId: scope } } }));
    await step(() => prisma.order.deleteMany({ where: { dropId: scope } }));
    await step(() => prisma.dropParticipant.deleteMany({ where: { dropId: scope } }));
    await step(() => prisma.shareLink.deleteMany({ where: { dropId: scope } }));
    // `LedgerEntry` has no relation at all — bare nullable ids — so it can only be
    // found by the column itself.
    await step(() => prisma.ledgerEntry.deleteMany({ where: { dropId: scope } }));
    await step(() => prisma.drop.deleteMany({ where: { id: scope } }));
  }
  if (merchantIds.length > 0) {
    await step(() => prisma.menuItem.deleteMany({ where: { merchantId: { in: [...merchantIds] } } }));
    await step(() => prisma.merchant.deleteMany({ where: { id: { in: [...merchantIds] } } }));
  }
  if (customerIds.length > 0) {
    await step(() => prisma.customer.deleteMany({ where: { id: { in: [...customerIds] } } }));
  }
  if (organiserProfileIds.length > 0) {
    await step(() =>
      prisma.organiserProfile.deleteMany({ where: { id: { in: [...organiserProfileIds] } } }),
    );
  }
  if (userIds.length > 0) {
    await step(() => prisma.user.deleteMany({ where: { id: { in: [...userIds] } } }));
  }

  merchantIds.length = 0;
  userIds.length = 0;
  customerIds.length = 0;
  organiserProfileIds.length = 0;
  dropIds.length = 0;

  if (failures.length > 0) {
    throw failures[0];
  }
}

beforeAll(async () => {
  sinkDir = await mkdtemp(join(tmpdir(), `${PREFIX}-sink-`));
  emptySink = join(sinkDir, 'empty.jsonl');
  process.env.ANALYTICS_LOG_PATH = emptySink;
});

afterAll(async () => {
  await prisma.$disconnect();
  if (ORIGINAL_ANALYTICS_PATH === undefined) {
    delete process.env.ANALYTICS_LOG_PATH;
  } else {
    process.env.ANALYTICS_LOG_PATH = ORIGINAL_ANALYTICS_PATH;
  }
  if (sinkDir.length > 0) {
    await rm(sinkDir, { recursive: true, force: true });
  }
});

describe('loadNorthStarMetrics — which drops are "decided"', () => {
  beforeAll(async () => {
    const world = await makeWorld('decided');

    /**
     * Five decided drops whose fill rates are 0.5 … 0.9, so the median is 0.7 —
     * the middle value, untouched by any single membership change *within* the
     * list. The three undecided drops are given a fill rate of 0.05, deliberately
     * outside the decided range: if one leaks into the query it becomes one of the
     * sort's early values and the median drops to 0.65.
     */
    const decided: { code: string; status: DropStatus; qty: number }[] = [
      { code: 'locked', status: 'LOCKED', qty: 10 },
      { code: 'captured', status: 'CAPTURED', qty: 12 },
      { code: 'pickup-open', status: 'PICKUP_OPEN', qty: 14 },
      { code: 'completed', status: 'COMPLETED', qty: 16 },
      // `FAILED` is a decision — the threshold was missed — but not a hit.
      { code: 'failed', status: 'FAILED', qty: 18 },
    ];
    for (const spec of decided) {
      customerSeq += 1;
      const dropId = await makeDrop(world, {
        code: spec.code,
        minQty: 20,
        status: spec.status,
        publishedAt: new Date(Date.now() - 3 * HOUR),
      });
      const customerId = await makeCustomer(spec.code, customerSeq);
      await addParticipant({
        dropId,
        customerId,
        qty: spec.qty,
        authStatus: 'AUTHORIZED',
        chargeStatus: 'CAPTURED',
      });
    }

    const undecided: { code: string; status: DropStatus }[] = [
      // A draft is not a decision, and a live drop has not had its cutoff.
      { code: 'draft', status: 'DRAFT' },
      { code: 'published', status: 'PUBLISHED' },
      // A cancellation is the merchant's decision, not a demand outcome (ADR-004).
      { code: 'cancelled', status: 'CANCELLED' },
    ];
    for (const spec of undecided) {
      customerSeq += 1;
      const dropId = await makeDrop(world, { code: spec.code, minQty: 20, status: spec.status });
      const customerId = await makeCustomer(spec.code, customerSeq);
      await addParticipant({ dropId, customerId, qty: 1, authStatus: 'AUTHORIZED' });
    }
  });

  afterAll(teardown);

  it('counts LOCKED, CAPTURED, PICKUP_OPEN, COMPLETED and FAILED — and nothing else', async () => {
    // The fixture itself is asserted first: a silently failed create would make
    // every assertion below true of a smaller world.
    expect(await prisma.drop.count({ where: { merchantId: { in: [...merchantIds] } } })).toBe(8);

    const metrics = await loadNorthStarMetrics();

    /**
     * 4 hits of 5. Dropping `'FAILED'` from the `in` list gives 4 of 4; adding
     * `'PUBLISHED'`, `'DRAFT'` or `'CANCELLED'` gives 4 of 6, 7 or 8. The
     * numerator alone cannot tell the last two from the first, which is why the
     * denominator is asserted separately and with a message.
     */
    expect(metrics.thresholdHitRate).toEqual({ numerator: 4, denominator: 5, value: 0.8 });
    expect(
      metrics.thresholdHitRate.denominator,
      'a DRAFT, PUBLISHED or CANCELLED drop reached the decided-drops query',
    ).toBe(5);
    expect(
      metrics.thresholdHitRate.numerator,
      'a hit status was dropped from (or a miss added to) HIT_STATUSES',
    ).toBe(4);
  });

  it('derives the fill median from exactly those five drops', async () => {
    const metrics = await loadNorthStarMetrics();

    // 10/20, 12/20, 14/20, 16/20, 18/20 → median 14/20. One leaked 1/20 gives 0.65.
    expect(
      metrics.medianFillRate,
      'a non-decided drop contributed a fill rate',
    ).toBeCloseTo(0.7, 10);
  });

  it('reports null, not zero, for a merchant that has never published', async () => {
    const metrics = await loadNorthStarMetrics();

    // The only merchant in this world published five drops inside *this* describe
    // … but with `publishedAt` set on the decided ones, so this must NOT be null.
    // It is the next test that proves the null case; here the point is that a
    // merchant with drops does contribute.
    expect(metrics.medianHoursToFirstPublish).not.toBeNull();
  });
});

describe('loadNorthStarMetrics — which participants count toward fill', () => {
  beforeAll(async () => {
    const world = await makeWorld('fill');
    const dropId = await makeDrop(world, {
      code: 'fill',
      minQty: 9,
      status: 'FAILED',
      publishedAt: new Date(Date.now() - 3 * HOUR),
    });

    /**
     * One drop, five participants, and a threshold of 9.
     *
     *   4 AUTHORIZED  ← an authorised hold that survived
     *   3 VOIDED      ← a real join, released when the drop failed
     *   2 EXPIRED     ← a real join, the hold lapsed
     *   100 FAILED    ← the card was declined; this person never joined
     *   100 PENDING   ← no authorisation ever came back
     *
     * The ever-authorised total is exactly 9, so the fill rate is exactly 1.0. If
     * the `EVER_AUTHORISED` filter is lost — the single most destructive possible
     * edit to `north-star.ts`'s reading of these rows — the same fixture reads
     * 209/9 ≈ 23.2. There is no rounding, no tolerance, and no other drop in this
     * world to hide behind.
     */
    const rows: {
      label: string;
      qty: number;
      authStatus: 'AUTHORIZED' | 'VOIDED' | 'EXPIRED' | 'FAILED' | 'PENDING';
    }[] = [
      { label: 'auth', qty: 4, authStatus: 'AUTHORIZED' },
      { label: 'void', qty: 3, authStatus: 'VOIDED' },
      { label: 'exp', qty: 2, authStatus: 'EXPIRED' },
      { label: 'failed', qty: 100, authStatus: 'FAILED' },
      { label: 'pending', qty: 100, authStatus: 'PENDING' },
    ];
    for (const row of rows) {
      customerSeq += 1;
      const customerId = await makeCustomer(`fill-${row.label}`, customerSeq);
      await addParticipant({
        dropId,
        customerId,
        qty: row.qty,
        authStatus: row.authStatus,
      });
    }
  });

  afterAll(teardown);

  it('sums AUTHORIZED, VOIDED and EXPIRED and ignores FAILED and PENDING', async () => {
    expect(await prisma.dropParticipant.count({ where: { dropId: { in: [...dropIds] } } })).toBe(5);

    const metrics = await loadNorthStarMetrics();

    expect(
      metrics.medianFillRate,
      'fill counted a declined or never-authorised participant: 209 units instead of 9',
    ).toBe(1);
    // The drop is the only decided one, so the median is that drop's rate alone.
    expect(metrics.thresholdHitRate).toEqual({ numerator: 0, denominator: 1, value: 0 });
  });
});

describe('loadNorthStarMetrics — a merchant’s first publish', () => {
  beforeAll(async () => {
    const publisher = await makeWorld('first-publish', T0);
    // Published twice, five hours and two hours after signup. The query takes one
    // row (`orderBy publishedAt asc, take 1`), so the answer is 2, not 5 and not
    // 3.5 — a `desc` and a missing `take` each produce a different number.
    //
    // **Inserted earliest-first, and that ordering is load-bearing.** The two writes
    // are separate transactions, so between them the database holds a merchant whose
    // only publish is the late one — which reads as 5, a number this test rejects.
    // Publishing `late` first therefore leaves a window in which a *concurrent*
    // `loadNorthStarMetrics()` sees the wrong answer. That is not hypothetical: it
    // happened, twice, while another suite was running against the same database, and
    // the failure looked exactly like a `desc` regression. Ascending order makes every
    // intermediate state a prefix of the final answer, so the window is harmless.
    //
    // The general rule for this file: when a fixture is read by an unscoped query,
    // write the rows in the order that keeps each partial state *also* correct.
    await makeDrop(publisher, {
      code: 'early',
      minQty: 10,
      publishedAt: new Date(T0.getTime() + 2 * HOUR),
    });
    await makeDrop(publisher, {
      code: 'late',
      minQty: 10,
      publishedAt: new Date(T0.getTime() + 5 * HOUR),
    });

    const drafter = await makeWorld('draft-only', T0);
    // Created at the same instant, never published. It must contribute **nothing**
    // rather than a zero: the median of {2} is 2, while the median of {2, 0} is 1.
    await makeDrop(drafter, { code: 'unpublished', minQty: 10, status: 'DRAFT' });
  });

  afterAll(teardown);

  it('takes the earliest publish, and skips a merchant that never published', async () => {
    const metrics = await loadNorthStarMetrics();

    expect(
      metrics.medianHoursToFirstPublish,
      'a `desc` order would report 5; counting the draft-only merchant as 0 would report 1',
    ).toBe(2);
  });

  it('counts only drops with a publishedAt, not a status', async () => {
    const metrics = await loadNorthStarMetrics();

    // Two publishes, one draft. A `status: 'PUBLISHED'` predicate would also say 2
    // here — the draft is a DRAFT — so this asserts the published-drop read agrees
    // with the first-publish read. See the share-link file below for the ratio.
    expect(metrics.organiserShareRate).toEqual({ numerator: 0, denominator: 2, value: 0 });
  });
});

describe('loadNorthStarMetrics — organiser share coverage', () => {
  beforeAll(async () => {
    const world = await makeWorld('share');

    const first = await makeDrop(world, {
      code: 'shared',
      minQty: 10,
      publishedAt: new Date(Date.now() - 4 * HOUR),
    });
    await makeDrop(world, {
      code: 'unshared',
      minQty: 10,
      publishedAt: new Date(Date.now() - 4 * HOUR),
    });

    const organiserUser = async (label: string): Promise<string> => {
      const user = await prisma.user.create({
        data: {
          email: `${PREFIX}-${label}@example.test`,
          passwordHash: 'not-a-real-hash',
          role: 'ORGANISER',
          mustChangePassword: true,
        },
        select: { id: true },
      });
      userIds.push(user.id);
      const profile = await prisma.organiserProfile.create({
        data: { userId: user.id, displayName: `${PREFIX} ${label}`, commissionPct: 5 },
        select: { id: true },
      });
      organiserProfileIds.push(profile.id);
      return profile.id;
    };

    // `ShareLink.organiserId` is a real FK to `OrganiserProfile`, so the row cannot
    // be made by writing the link alone.
    const firstOrganiser = await organiserUser('organiser-a');
    const secondOrganiser = await organiserUser('organiser-b');

    await prisma.shareLink.create({
      data: {
        token: `${PREFIX}-token-a`,
        dropId: first,
        merchantId: world.merchantId,
        organiserId: firstOrganiser,
      },
    });
    // A second link on the *same* drop, from a different organiser. The numerator
    // is distinct drops, not links: two links to one drop is still one drop shared.
    await prisma.shareLink.create({
      data: {
        token: `${PREFIX}-token-b`,
        dropId: first,
        merchantId: world.merchantId,
        organiserId: secondOrganiser,
      },
    });
  });

  afterAll(teardown);

  it('divides distinct shared drops by distinct published drops', async () => {
    expect(await prisma.shareLink.count({ where: { dropId: { in: [...dropIds] } } })).toBe(2);

    const metrics = await loadNorthStarMetrics();

    expect(
      metrics.organiserShareRate,
      'one of two published drops carries a link; counting links instead of drops gives 2/2',
    ).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });
});

describe('loadNorthStarMetrics — captured participants only', () => {
  beforeAll(async () => {
    const world = await makeWorld('captured');
    const dropId = await makeDrop(world, {
      code: 'captured',
      minQty: 3,
      status: 'CAPTURED',
      publishedAt: new Date(Date.now() - 4 * HOUR),
    });

    customerSeq += 1;
    const buyer = await makeCustomer('buyer', customerSeq);
    const buyerParticipant = await addParticipant({
      dropId,
      customerId: buyer,
      qty: 3,
      authStatus: 'AUTHORIZED',
      chargeStatus: 'CAPTURED',
      redeemedQty: 2,
    });
    await prisma.order.create({
      data: {
        dropId,
        participantId: buyerParticipant,
        qty: 3,
        unitPriceCents: 1310,
        subtotalCents: 3930,
        platformFeeCents: 39,
      },
    });

    customerSeq += 1;
    const orderless = await makeCustomer('orderless', customerSeq);
    // Authorised, never charged, no `Order`. A real join attempt, not a customer —
    // and 4 units that must not reach the redemption or new-customer denominators.
    await addParticipant({
      dropId,
      customerId: orderless,
      qty: 4,
      authStatus: 'AUTHORIZED',
      chargeStatus: 'NONE',
    });
  });

  afterAll(teardown);

  it('reads orders and redemption qty through the Order relation', async () => {
    const metrics = await loadNorthStarMetrics();

    // 2 redeemed of 3 captured. Without `where: { order: { isNot: null } }` the
    // denominator is 7, because the orderless 4 units are a participant row too.
    expect(
      metrics.redemptionRate,
      'an orderless participant reached the captured-participant read',
    ).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });

    expect(metrics.newCustomerShare, 'the orderless participant was counted as an order').toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(metrics.repeatParticipantRate).toEqual({ numerator: 0, denominator: 1, value: 0 });
  });
});

describe('loadNorthStarMetrics — the analytics sink', () => {
  it('reads zero conversion rather than failing when the sink has no window events', async () => {
    const metrics = await loadNorthStarMetrics();

    // The file exists (the fixtures above appended `drop_created` lines to it) and
    // holds no `deal_page_viewed` or `join_authorised`. Zero counts, and a null
    // rate — "not measured" is a different answer from "0% converted".
    expect(metrics.joinConversion).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(metrics.thresholdHitRate.value).toBeNull();
  });

  it('returns zeros, not a throw, for a sink file that was never written', async () => {
    /**
     * The catch branch in `read-counts.ts`. Reached here through the explicit
     * `path` argument because the loader takes no path — the cold-start state is
     * a missing file, and an admin page that 500s on its first visit is the bug
     * this branch exists to prevent.
     */
    const counts = await countAnalyticsEvents([
      'deal_page_viewed',
      'join_authorised',
    ], join(sinkDir, 'never-written.jsonl'));

    expect(counts).toEqual({ deal_page_viewed: 0, join_authorised: 0 });
  });

  it('turns real sink lines into a conversion ratio', async () => {
    const fixture = join(sinkDir, 'with-events.jsonl');
    await writeFile(
      fixture,
      [
        JSON.stringify({ event: 'deal_page_viewed', payload: { dropId: 'x' }, at: ISO() }),
        JSON.stringify({ event: 'join_authorised', payload: { dropId: 'x' }, at: ISO() }),
        JSON.stringify({ event: 'deal_page_viewed', payload: { dropId: 'y' }, at: ISO() }),
        // A half-written line: the reader must skip it rather than throw.
        '{"event": "deal_page_viewed"',
      ].join('\n') + '\n',
      'utf8',
    );

    // Asserted twice: the reader's own count, and the loader's ratio. The first
    // pins the parse; the second pins the field mapping (`deal_page_viewed` →
    // `dealPageViewed`) that only `metrics.ts` performs.
    expect(await countAnalyticsEvents(['deal_page_viewed', 'join_authorised'], fixture)).toEqual({
      deal_page_viewed: 2,
      join_authorised: 1,
    });

    const previous = process.env.ANALYTICS_LOG_PATH;
    process.env.ANALYTICS_LOG_PATH = fixture;
    try {
      const metrics = await loadNorthStarMetrics();
      expect(metrics.joinConversion).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    } finally {
      process.env.ANALYTICS_LOG_PATH = previous;
    }
  });
});
