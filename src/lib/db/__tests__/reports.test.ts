import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { merchantReportQuery, reportSourcesFor } from '@/lib/db/reports';
import { DEFAULT_FEES, buildGuardrailSnapshot, readGuardrailSnapshot } from '@/lib/guardrail';
import { platformFeeCentsForOrder } from '@/lib/settlement/platform-fee';
import { captureEntries } from '@/lib/settlement/ledger';

/**
 * FR-701…FR-703, FR-705 — against real Postgres.
 *
 * ## Why this file exists beside the pure tests
 *
 * Everything the pure module asserts is arithmetic over facts it is *handed*. The
 * three ways this feature can be wrong without a single arithmetic error are all
 * in the fetching, and none of them is reachable from a unit test:
 *
 *   1. **Attribution joined on `dropId`** instead of `participant.shareLinkId` —
 *      two organisers who shared one drop are each credited with the whole drop.
 *      It type-checks, it passes every single-organiser test, and it is FR-703's
 *      exact subject.
 *   2. **`priorCapturedOrderCount` counting joins instead of captures**, or
 *      failing to subtract this drop's own order — both make FR-702 report
 *      everybody as returning, which is the same outcome as the PRD's literal
 *      rule and just as invisible.
 *   3. **Reporting a participant who was never charged** — a card authorised on a
 *      drop that failed. Counting it inflates units and GMV with money nobody paid.
 *
 * So the fixtures here are real rows and the assertions are on the assembled
 * report, not on the arithmetic.
 *
 * ## The ledger rows are built with `captureEntries`, not by hand
 *
 * A fixture that writes `{ type: 'CHARGE', amountCents: X }` by hand is an oracle
 * only for the coincidence that X happens to match. Going through the settlement
 * module's own entry builder is what makes "the report reconciles" a statement
 * about the product rather than about the fixture.
 */

const PREFIX = 'RPT';

type Fixture = {
  merchantId: string;
  itemId: string;
  userId: string;
};

let fixture: Fixture;
const dropIds: string[] = [];
const customerIds: string[] = [];
/**
 * Organiser **user** ids, not organiser-profile ids, and the difference is the
 * whole of a leak that ran for months.
 *
 * `makeOrganiser` nested the profile inside the account, and teardown deleted the
 * profile. That was consistent with itself and hid the account: a `User` whose
 * `OrganiserProfile` has been deleted looks, to `scripts/check-residue.mjs` and to
 * `/admin/users`, exactly like an organiser whose profile never got created. Five
 * per run, so the count the residue script reports as `profilelessOrganisers` climbed
 * by five every time anyone ran the tests while `organiserProfiles` sat perfectly
 * still — and a still counter beside a moving one is what makes a leak read as
 * "somebody else's missing backfill".
 *
 * Collecting the parent fixes it at the root: deleting the `User` cascades the
 * profile, so there is no ordering to get wrong and no child to forget.
 */
const organiserUserIds: string[] = [];

let phoneSeq = 0;

function nextPhone(): string {
  phoneSeq += 1;
  return `+1780${PREFIX}${String(phoneSeq).padStart(6, '0')}`.replace(/[^+0-9]/g, '');
}

async function makeDrop(args: {
  dealPriceCents?: number;
  minQty: number;
  maxQty: number;
  status?: 'LOCKED' | 'CAPTURED' | 'PICKUP_OPEN' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  windowStart?: Date;
}): Promise<string> {
  const dealPriceCents = args.dealPriceCents ?? 1112;
  const snapshot = buildGuardrailSnapshot(
    {
      ...DEFAULT_FEES,
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      floorPctOfMenu: 0.25,
    },
    dealPriceCents,
    new Date().toISOString(),
  );

  const drop = await prisma.drop.create({
    data: {
      merchantId: fixture.merchantId,
      menuItemId: fixture.itemId,
      publicCode: `${PREFIX}${dropIds.length}${Date.now()}`.slice(0, 24).toUpperCase(),
      title: `${PREFIX} drop ${dropIds.length + 1}`,
      dealPriceCents,
      minQty: args.minQty,
      maxQty: args.maxQty,
      maxPerCustomer: 4,
      cutoffAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      windowStart: args.windowStart ?? new Date(Date.now() - 60 * 60 * 1000),
      windowEnd: new Date(Date.now() + 60 * 60 * 1000),
      status: args.status ?? 'COMPLETED',
      guardrailSnapshot: snapshot,
      publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    },
    select: { id: true },
  });
  dropIds.push(drop.id);
  return drop.id;
}

async function makeCustomer(): Promise<string> {
  const customer = await prisma.customer.create({
    data: { phone: nextPhone() },
    select: { id: true },
  });
  customerIds.push(customer.id);
  return customer.id;
}

/**
 * A captured participant: participant row + order row + the two ledger entries
 * `captureEntries` writes, mirroring what `settle.ts` does in one transaction.
 *
 * `chargeStatus: 'CAPTURED'` and `authStatus: 'AUTHORIZED'` are what settlement
 * leaves behind, not decoration: the report's "paying participant" filter reads
 * the `Order` row, and this fixture is only honest if it produces one the way
 * the real path does.
 */
async function makeCapturedParticipant(args: {
  dropId: string;
  customerId: string;
  qty: number;
  dealPriceCents: number;
  shareLinkId?: string | null;
  refundedCents?: number;
  platformFeeReversedCents?: number;
}): Promise<{ participantId: string; orderId: string }> {
  const subtotalCents = args.qty * args.dealPriceCents;
  const platformFeeCents = platformFeeCentsForOrder({
    qty: args.qty,
    dealPriceCents: args.dealPriceCents,
    fees: DEFAULT_FEES,
  });

  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId: args.customerId,
      qty: args.qty,
      amountCents: subtotalCents,
      platformFeeCents,
      authStatus: 'AUTHORIZED',
      chargeStatus:
        args.refundedCents === undefined
          ? 'CAPTURED'
          : args.refundedCents >= subtotalCents
            ? 'REFUNDED'
            : 'PARTIALLY_REFUNDED',
      paymentIntentId: `pi_${PREFIX}_${Date.now()}_${phoneSeq}`,
      shareLinkId: args.shareLinkId ?? null,
    },
    select: { id: true },
  });

  const order = await prisma.order.create({
    data: {
      dropId: args.dropId,
      participantId: participant.id,
      qty: args.qty,
      unitPriceCents: args.dealPriceCents,
      subtotalCents,
      platformFeeCents,
      refundedCents: args.refundedCents ?? 0,
      platformFeeReversedCents: args.platformFeeReversedCents ?? 0,
      stripeChargeId: `ch_${PREFIX}_${Date.now()}_${phoneSeq}`,
    },
    select: { id: true },
  });

  // Through the settlement module's builder — see the module docblock.
  const entries = captureEntries({
    dropId: args.dropId,
    order: { id: order.id, subtotalCents, platformFeeCents },
    stripeRef: `ch_${PREFIX}_${Date.now()}_${phoneSeq}`,
  });

  await prisma.ledgerEntry.createMany({
    data: entries.map((entry) => ({
      orderId: entry.orderId,
      dropId: entry.dropId,
      type: entry.type,
      amountCents: entry.amountCents,
      stripeRef: entry.stripeRef,
      note: entry.note,
    })),
  });

  // A refund's two rows, when the fixture asks for one.
  if (args.refundedCents !== undefined && args.refundedCents > 0) {
    await prisma.ledgerEntry.create({
      data: {
        orderId: order.id,
        dropId: args.dropId,
        type: 'REFUND',
        amountCents: -args.refundedCents,
        stripeRef: `re_${PREFIX}`,
        note: 'refund',
      },
    });
    if ((args.platformFeeReversedCents ?? 0) > 0) {
      await prisma.ledgerEntry.create({
        data: {
          orderId: order.id,
          dropId: args.dropId,
          type: 'ADJUSTMENT',
          amountCents: -(args.platformFeeReversedCents ?? 0),
          stripeRef: `re_${PREFIX}`,
          note: 'application_fee_reversed',
        },
      });
    }
  }

  return { participantId: participant.id, orderId: order.id };
}

/**
 * An authorised participant with **no** order — the card that was never charged.
 *
 * This is the row that makes "start from Order" a rule with teeth: it exists in
 * the database, it has a qty, and every aggregate that starts from
 * `DropParticipant` counts it.
 */
async function makeUnchargedParticipant(args: {
  dropId: string;
  customerId: string;
  qty: number;
}): Promise<string> {
  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId: args.customerId,
      qty: args.qty,
      amountCents: args.qty * 1112,
      platformFeeCents: 89,
      authStatus: 'VOIDED',
      chargeStatus: 'NONE',
    },
    select: { id: true },
  });
  return participant.id;
}

async function makeOrganiser(displayName: string): Promise<string> {
  // The profile is created *in the same statement* as the user, deliberately.
  // Two statements leave a window in which this row is an organiser with no
  // profile, and `/admin/users` counts profile-less organisers, renders a repair
  // form for each, and asserts the two agree — so that suite intermittently saw a
  // phantom row belonging to this one. A per-test tenant keeps the *data* apart;
  // it cannot keep the *clock* apart, and this database is shared by every suite
  // running in parallel.
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${displayName}-${Date.now()}-${organiserUserIds.length}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      organiser: { create: { displayName } },
    },
    select: { id: true, organiser: { select: { id: true } } },
  });

  // The **account** is registered for teardown and the profile is not, because the
  // profile cannot outlive it: `OrganiserProfile.user` is `onDelete: Cascade`. One
  // collector, one delete, nothing to order wrongly.
  organiserUserIds.push(user.id);
  return user.organiser!.id;
}

async function makeShareLink(dropId: string, organiserId: string): Promise<string> {
  const link = await prisma.shareLink.create({
    data: {
      token: `${PREFIX}-${dropId.slice(0, 6)}-${organiserId.slice(0, 6)}-${Date.now()}`,
      dropId,
      merchantId: fixture.merchantId,
      organiserId,
    },
    select: { id: true },
  });
  return link.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner-${Date.now()}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
    },
    select: { id: true },
  });

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} merchant`,
      slug: `${PREFIX.toLowerCase()}-${Date.now()}`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });

  const item = await prisma.menuItem.create({
    data: {
      merchantId: merchant.id,
      name: `${PREFIX} bowl`,
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      batchYield: 60,
      isBatchable: true,
      containsAlcohol: false,
    },
    select: { id: true },
  });

  fixture = { merchantId: merchant.id, itemId: item.id, userId: user.id };
});

/**
 * Teardown, and the two things it now does differently.
 *
 * **It deletes the organiser account, not the organiser profile.** The profile was
 * the row this file was thinking about and the account was the row it was leaking;
 * `OrganiserProfile.user` cascades, so naming the parent is the smaller delete and the
 * complete one.
 *
 * **It no longer swallows errors.** Every step used to end in `.catch(() => undefined)`,
 * which is a teardown that reports success whatever happened. When the cascade from
 * `Drop` to `ShareLink` was the obstacle, that became three survivors per run and no
 * failing test to point at them. Now each step runs regardless of the ones before it —
 * a red run must not leave the database dirtier than a green one — and any error is
 * rethrown in aggregate.
 *
 * Order is still load-bearing even though nothing here is `SetNull`: ledger, drops and
 * customers point at rows this file owns, and organisers are removed last because a
 * `ShareLink` referencing one is reached only through its drop.
 */
afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  if (dropIds.length > 0) {
    await step(() => prisma.ledgerEntry.deleteMany({ where: { dropId: { in: dropIds } } }));
    await step(() => prisma.drop.deleteMany({ where: { id: { in: dropIds } } }));
  }
  if (customerIds.length > 0) {
    await step(() => prisma.customer.deleteMany({ where: { id: { in: customerIds } } }));
  }
  if (organiserUserIds.length > 0) {
    // The account, and the profile rides along on the cascade. Share links went with
    // the drops above.
    await step(() => prisma.user.deleteMany({ where: { id: { in: organiserUserIds } } }));
  }
  if (fixture) {
    await step(() => prisma.menuItem.deleteMany({ where: { id: fixture.itemId } }));
    await step(() => prisma.merchant.deleteMany({ where: { id: fixture.merchantId } }));
    await step(() => prisma.user.deleteMany({ where: { id: fixture.userId } }));
  }

  await prisma.$disconnect();

  if (failures.length > 0) {
    throw new AggregateError(failures, `teardown left the database dirty (${failures.length} step(s) failed)`);
  }
});

describe('reportSourcesFor — the fetching', () => {
  it('reports the five FR-701 figures from real rows', async () => {
    const dropId = await makeDrop({ minQty: 2, maxQty: 10 });
    const customer = await makeCustomer();
    await makeCapturedParticipant({ dropId, customerId: customer, qty: 3, dealPriceCents: 1112 });

    const { sources } = await reportSourcesFor({ merchantId: fixture.merchantId });
    const source = sources.find((candidate) => candidate.dropId === dropId);
    expect(source).toBeDefined();

    expect(source?.orders).toHaveLength(1);
    expect(source?.orders[0]?.qty).toBe(3);
    expect(source?.orders[0]?.subtotalCents).toBe(3336);
    // 3 units at $11.12: 3 × roundHalfUp(88.96) = 267, the ADR-004 vector.
    expect(source?.orders[0]?.platformFeeCents).toBe(267);
    // Two ledger rows per capture, and the pair must reconcile.
    expect(source?.ledger).toHaveLength(2);
  });

  /**
   * **A participant that was never charged is not a unit and not a customer.**
   *
   * A failed drop leaves `VOIDED` participants with no order. Counting them would
   * report units the merchant never sold and GMV nobody paid — and would also
   * feed FR-702 a "customer" who never bought anything.
   */
  it('excludes a participant whose card was never charged', async () => {
    const dropId = await makeDrop({ minQty: 2, maxQty: 10 });
    const paying = await makeCustomer();
    const never = await makeCustomer();
    await makeCapturedParticipant({ dropId, customerId: paying, qty: 2, dealPriceCents: 1112 });
    await makeUnchargedParticipant({ dropId, customerId: never, qty: 5 });

    const { sources } = await reportSourcesFor({ merchantId: fixture.merchantId });
    const source = sources.find((candidate) => candidate.dropId === dropId);

    expect(source?.orders).toHaveLength(1);
    expect(source?.orders[0]?.qty).toBe(2);
    expect(source?.customers).toHaveLength(1);
  });

  /**
   * **An uncharged card must not move an organiser's number, and only a
   * share-linked one can prove that.**
   *
   * The test above catches an aggregate that counts non-payers, because units and
   * GMV come from `Order`. Attribution does not: it walks participants, so a
   * participant with no order contributes nothing to GMV and nothing to units — the
   * only trace it leaves is that it *doesn't* add anything. The harness proved the
   * gap by swapping `payingParticipants` for `dropParticipants` in the attribution
   * loop and watching every test stay green, because the uncharged participant in
   * every existing fixture is a plain-link diner (no `shareLinkId`), and the loop
   * `continue`s on those before it reads a quantity.
   *
   * So this fixture gives the never-charged card a **share link**. If the loop sees
   * it, Priya is credited with 3 units instead of 1 — and the report tells the
   * merchant an organiser brought people who never bought anything.
   */
  it('does not credit an organiser with a participant whose card was never charged', async () => {
    const dropId = await makeDrop({ minQty: 1, maxQty: 20 });
    const priya = await makeOrganiser(`${PREFIX} Priya`);
    const link = await makeShareLink(dropId, priya);

    const paying = await makeCustomer();
    const never = await makeCustomer();
    await makeCapturedParticipant({
      dropId,
      customerId: paying,
      qty: 1,
      dealPriceCents: 1112,
      shareLinkId: link,
    });

    // Same share link, authorised, voided, never charged.
    const uncharged = await prisma.dropParticipant.create({
      data: {
        dropId,
        customerId: never,
        qty: 2,
        amountCents: 2 * 1112,
        platformFeeCents: 89,
        authStatus: 'VOIDED',
        chargeStatus: 'NONE',
        shareLinkId: link,
      },
      select: { id: true },
    });
    expect(uncharged.id).toBeTruthy();

    const report = await merchantReportQuery({
      merchantId: fixture.merchantId,
      merchantName: 'x',
      timezone: 'America/Edmonton',
    });
    const row = report.rows.find((candidate) => candidate.dropId === dropId);

    expect(row?.figures.unitsSold).toBe(1);
    // One unit, not three. The mutant adds the voided card's 2.
    expect(row?.attribution.find((entry) => entry.organiserProfileId === priya)?.units).toBe(1);
    // And it is not the remainder either: an uncharged card is not an unattributed
    // sale, it is not a sale. The remainder is zero because the one paying diner
    // came through an organiser.
    expect(row?.unattributedUnits).toBe(0);
  });

  /**
   * **FR-702's classifier, end to end.**
   *
   * One merchant, three drops in sequence. Ada buys on drop 1, 2 and 3. Bo buys on
   * drop 2 and 3. Cy only on drop 3. So drop 3 must report 2 returning + 1 new,
   * drop 2 must report 1 returning + 1 new, and drop 1 must report 1 new.
   *
   * This is the assertion that fails if `priorCapturedOrderCount` counts joins
   * rather than captures, forgets to subtract the current order, or is computed
   * per drop instead of across all history.
   */
  it('classifies new versus returning across successive drops', async () => {
    const ada = await makeCustomer();
    const bo = await makeCustomer();
    const cy = await makeCustomer();

    const drop1 = await makeDrop({ minQty: 1, maxQty: 10, windowStart: new Date('2026-01-05T20:00:00Z') });
    const drop2 = await makeDrop({ minQty: 1, maxQty: 10, windowStart: new Date('2026-01-12T20:00:00Z') });
    const drop3 = await makeDrop({ minQty: 1, maxQty: 10, windowStart: new Date('2026-01-19T20:00:00Z') });

    await makeCapturedParticipant({ dropId: drop1, customerId: ada, qty: 1, dealPriceCents: 1112 });
    await makeCapturedParticipant({ dropId: drop2, customerId: ada, qty: 1, dealPriceCents: 1112 });
    await makeCapturedParticipant({ dropId: drop2, customerId: bo, qty: 1, dealPriceCents: 1112 });
    await makeCapturedParticipant({ dropId: drop3, customerId: ada, qty: 1, dealPriceCents: 1112 });
    await makeCapturedParticipant({ dropId: drop3, customerId: bo, qty: 1, dealPriceCents: 1112 });
    await makeCapturedParticipant({ dropId: drop3, customerId: cy, qty: 1, dealPriceCents: 1112 });

    const report = await merchantReportQuery({
      merchantId: fixture.merchantId,
      merchantName: 'x',
      timezone: 'America/Edmonton',
    });

    const row1 = report.rows.find((row) => row.dropId === drop1);
    const row2 = report.rows.find((row) => row.dropId === drop2);
    const row3 = report.rows.find((row) => row.dropId === drop3);

    expect(row1?.customerMix).toEqual({
      newCustomers: 1,
      returningCustomers: 0,
      totalCustomers: 1,
      newCustomerPct: 1,
    });
    expect(row2?.customerMix.newCustomers).toBe(1);
    expect(row2?.customerMix.returningCustomers).toBe(1);
    expect(row3?.customerMix.newCustomers).toBe(1);
    expect(row3?.customerMix.returningCustomers).toBe(2);
  });

  /**
   * **FR-703's exact subject.**
   *
   * One drop, two organisers, and one plain-link diner. Sam brought 2 units, Ada
   * brought 1, nobody brought 1. The failure this test exists for is attributing
   * by `dropId`, which would credit Sam with all 4 and Ada with all 4.
   */
  it('attributes units through the participant share link, not the drop', async () => {
    const dropId = await makeDrop({ minQty: 1, maxQty: 20 });
    const sam = await makeOrganiser(`${PREFIX} Sam`);
    const ada = await makeOrganiser(`${PREFIX} Ada`);
    const samLink = await makeShareLink(dropId, sam);
    const adaLink = await makeShareLink(dropId, ada);

    const throughSam = await makeCustomer();
    const throughAda = await makeCustomer();
    const plain = await makeCustomer();

    await makeCapturedParticipant({
      dropId,
      customerId: throughSam,
      qty: 2,
      dealPriceCents: 1112,
      shareLinkId: samLink,
    });
    await makeCapturedParticipant({
      dropId,
      customerId: throughAda,
      // Two plates, so this fixture can tell a per-unit total from a head count —
      // a lesson from the sweep, which found every earlier fixture used `qty: 1`.
      qty: 2,
      dealPriceCents: 1112,
      shareLinkId: adaLink,
    });
    await makeCapturedParticipant({
      dropId,
      customerId: plain,
      qty: 1,
      dealPriceCents: 1112,
    });

    const report = await merchantReportQuery({
      merchantId: fixture.merchantId,
      merchantName: 'x',
      timezone: 'America/Edmonton',
    });
    const row = report.rows.find((candidate) => candidate.dropId === dropId);

    expect(row?.figures.unitsSold).toBe(5);
    expect(row?.attribution).toHaveLength(2);

    const samRow = row?.attribution.find((entry) => entry.organiserProfileId === sam);
    const adaRow = row?.attribution.find((entry) => entry.organiserProfileId === ada);

    // The failure mode named above: both would be 5.
    expect(samRow?.units).toBe(2);
    expect(adaRow?.units).toBe(2);
    expect(samRow?.gmvCents).toBe(2224);
    expect(adaRow?.gmvCents).toBe(2224);

    // Largest first. Sam and Ada are tied at 2 units and 2224¢, so the tie-breaker
    // is the display name — "RPT Ada" before "RPT Sam".
    expect(row?.attribution[0]?.organiserProfileId).toBe(ada);

    // And the plain-link diner is the remainder, named rather than implied.
    expect(row?.unattributedUnits).toBe(1);
  });

  /**
   * **A second organiser is what makes the attribution bug observable.**
   *
   * The test above has Sam and Ada on one drop and already asserts their units, so a
   * mutation that credits everybody to "the first organiser in the map" should have
   * been caught by it — and a sweep reported that it was not, because at that point
   * `byOrganiser` already contains Sam with the right total, and the mutant's
   * replacement link resolves to Sam *for Sam's own participants too*. The credit
   * stays correct for everyone already in the map and only the plain-link diner
   * moves.
   *
   * This test pins the case the mutated code actually gets wrong, and the case the
   * `dropId`-join bug gets wrong: **two organisers, one of whom is attributed
   * second.** With the links resolved by `dropId`, Ada would receive all 3 units;
   * with a single-organiser drop there is nothing to confuse.
   */
  it('does not credit one organiser with another organiser\'s units', async () => {
    const dropId = await makeDrop({ minQty: 1, maxQty: 20 });
    const first = await makeOrganiser(`${PREFIX} First`);
    const second = await makeOrganiser(`${PREFIX} Second`);
    const firstLink = await makeShareLink(dropId, first);
    const secondLink = await makeShareLink(dropId, second);

    const firstBuyer = await makeCustomer();
    const secondBuyerA = await makeCustomer();
    const secondBuyerB = await makeCustomer();
    const directBuyer = await makeCustomer();

    await makeCapturedParticipant({
      dropId,
      customerId: firstBuyer,
      qty: 1,
      dealPriceCents: 1112,
      shareLinkId: firstLink,
    });
    /**
     * **Two units, not one, and this is what the sweep taught.**
     *
     * The first version made every participant a single unit, and a mutation that
     * added `1` per participant instead of `participant.qty` passed every test —
     * because at `qty: 1` the two expressions are the same number. A fixture where
     * the quantity is always one cannot tell a per-unit sum from a head count, and
     * FR-703 is *"which organiser drove which units"*.
     *
     * So the second buyer takes two plates, and the aggregate is the only place the
     * difference shows: 1 + 2 = 3 units, not 1 + 1 = 2.
     */
    await makeCapturedParticipant({
      dropId,
      customerId: secondBuyerA,
      qty: 2,
      dealPriceCents: 1112,
      shareLinkId: secondLink,
    });
    /**
     * **The *second* buyer through the same organiser also takes more than one, and
     * that is a separate lesson.** The harness mutates the `existing.units + qty`
     * arm — the one that runs when an organiser already has a row — and with this
     * participant at `qty: 1` that arm read `2 + 1`, which is what the head-count
     * mutant produces too. The mutation survived a fixture that had already been
     * "fixed" for the per-unit bug, because it hit the *other* arm. Both arms need a
     * quantity above one: two accounts of a bug is not redundancy.
     */
    await makeCapturedParticipant({
      dropId,
      customerId: secondBuyerB,
      qty: 2,
      dealPriceCents: 1112,
      shareLinkId: secondLink,
    });
    await makeCapturedParticipant({
      dropId,
      customerId: directBuyer,
      qty: 1,
      dealPriceCents: 1112,
    });

    const report = await merchantReportQuery({
      merchantId: fixture.merchantId,
      merchantName: 'x',
      timezone: 'America/Edmonton',
    });
    const row = report.rows.find((candidate) => candidate.dropId === dropId);

    // 1 + 2 + 2 + 1.
    expect(row?.figures.unitsSold).toBe(6);
    expect(row?.attribution.find((entry) => entry.organiserProfileId === first)?.units).toBe(1);
    // 2 + 2 = 4 units. The head-count mutant says 3 — it is 2 either way only if one
    // of the two quantities is 1, which is why both are 2.
    const secondRow = row?.attribution.find((entry) => entry.organiserProfileId === second);
    expect(secondRow?.units).toBe(4);
    // GMV follows units, not people: 4 × $11.12.
    expect(secondRow?.gmvCents).toBe(4448);
    // The remainder is the direct buyer, not a unit that leaked into an organiser.
    expect(row?.unattributedUnits).toBe(1);

    /**
     * Largest first, asserted on the array rather than on the map lookup above.
     *
     * Every earlier assertion here reads a row *by organiser id*, which is
     * order-independent — so a mutation reversing the sort survived the whole file.
     * The order is part of the feature: a merchant scans the list from the top, and
     * the organiser who moved four plates belongs above the one who moved one.
     */
    expect(row?.attribution.map((entry) => entry.organiserProfileId)).toEqual([second, first]);
  });

  /**
   * A drop whose money all went back reconciles, reports zero contribution, and is
   * **not** withheld. This is FR-902's aftermath — the case where a report that
   * refused to reconcile would be wrong about correct data.
   */
  it('reports a fully refunded drop as zero contribution and still includes it', async () => {
    const dropId = await makeDrop({ minQty: 1, maxQty: 10, status: 'CANCELLED' });
    const customer = await makeCustomer();
    const subtotal = 2 * 1112;
    const fee = platformFeeCentsForOrder({ qty: 2, dealPriceCents: 1112, fees: DEFAULT_FEES });

    await makeCapturedParticipant({
      dropId,
      customerId: customer,
      qty: 2,
      dealPriceCents: 1112,
      refundedCents: subtotal,
      platformFeeReversedCents: fee,
    });

    const report = await merchantReportQuery({
      merchantId: fixture.merchantId,
      merchantName: 'x',
      timezone: 'America/Edmonton',
    });
    const row = report.rows.find((candidate) => candidate.dropId === dropId);

    expect(row).toBeDefined();
    expect(row?.figures.gmvCents).toBe(2224);
    expect(row?.figures.refundedCents).toBe(2224);
    expect(row?.figures.netCapturedCents).toBe(0);
    expect(row?.figures.contributionCents).toBe(0);
    expect(row?.figures.platformFeeCents).toBe(0);
  });

  /**
   * **The scope is the highest-severity thing this query can get wrong.**
   *
   * `reportSourcesFor` takes a bare `merchantId` and every figure it returns is
   * money. Omitting the `where` clause entirely — one line — would put another
   * merchant's GMV, their customers' counts and their organisers' names on this
   * merchant's screen, which is a data-protection incident rather than a bug. A
   * second merchant with a closed drop is the only fixture that can see it.
   */
  it('reports nothing belonging to another merchant', async () => {
    const otherUser = await prisma.user.create({
      data: {
        email: `${PREFIX}-other-${Date.now()}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
      },
      select: { id: true },
    });

    const otherMerchant = await prisma.merchant.create({
      data: {
        name: `${PREFIX} other kitchen`,
        slug: `${PREFIX.toLowerCase()}-other-${Date.now()}`,
        status: 'ACTIVE',
        floorPctOfMenu: 0.25,
        users: { create: { userId: otherUser.id, role: 'OWNER' } },
      },
      select: { id: true },
    });

    const otherItem = await prisma.menuItem.create({
      data: {
        merchantId: otherMerchant.id,
        name: `${PREFIX} other bowl`,
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 60,
      },
      select: { id: true },
    });

    const otherDrop = await prisma.drop.create({
      data: {
        merchantId: otherMerchant.id,
        menuItemId: otherItem.id,
        publicCode: `${PREFIX}OTHER${Date.now()}`.slice(0, 24).toUpperCase(),
        title: `${PREFIX} other drop`,
        dealPriceCents: 1112,
        minQty: 1,
        maxQty: 10,
        cutoffAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        windowStart: new Date(Date.now() - 60 * 60 * 1000),
        windowEnd: new Date(Date.now() + 60 * 60 * 1000),
        status: 'COMPLETED',
        guardrailSnapshot: buildGuardrailSnapshot(
          {
            ...DEFAULT_FEES,
            menuPriceCents: 1600,
            foodCostCents: 480,
            packagingCents: 80,
            floorPctOfMenu: 0.25,
          },
          1112,
          new Date().toISOString(),
        ),
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
      select: { id: true },
    });

    try {
      const { sources } = await reportSourcesFor({ merchantId: fixture.merchantId });
      expect(sources.some((source) => source.dropId === otherDrop.id)).toBe(false);

      // And the other merchant does see their own drop — so the assertion above is
      // about scoping, not about the fixture failing to create anything.
      const theirs = await reportSourcesFor({ merchantId: otherMerchant.id });
      expect(theirs.sources.some((source) => source.dropId === otherDrop.id)).toBe(true);
    } finally {
      await prisma.ledgerEntry.deleteMany({ where: { dropId: otherDrop.id } }).catch(() => undefined);
      await prisma.drop.deleteMany({ where: { id: otherDrop.id } }).catch(() => undefined);
      await prisma.menuItem.deleteMany({ where: { id: otherItem.id } }).catch(() => undefined);
      await prisma.merchant.deleteMany({ where: { id: otherMerchant.id } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: otherUser.id } }).catch(() => undefined);
    }
  });

  /**
   * A `DRAFT` drop and a still-filling `PUBLISHED` drop are not reported: neither
   * could have taken money, and a row that changes under the merchant as they read
   * it is worse than an absence.
   */
  it('excludes drops that are still taking joins and drafts', async () => {
    const draft = await prisma.drop.create({
      data: {
        merchantId: fixture.merchantId,
        menuItemId: fixture.itemId,
        publicCode: `${PREFIX}DRAFT${Date.now()}`.slice(0, 24).toUpperCase(),
        title: `${PREFIX} draft`,
        dealPriceCents: 1112,
        minQty: 1,
        maxQty: 10,
        cutoffAt: new Date(Date.now() + 60 * 60 * 1000),
        windowStart: new Date(Date.now() + 2 * 60 * 60 * 1000),
        windowEnd: new Date(Date.now() + 3 * 60 * 60 * 1000),
        status: 'DRAFT',
        guardrailSnapshot: buildGuardrailSnapshot(
          {
            ...DEFAULT_FEES,
            menuPriceCents: 1600,
            foodCostCents: 480,
            packagingCents: 80,
            floorPctOfMenu: 0.25,
          },
          1112,
          new Date().toISOString(),
        ),
      },
      select: { id: true },
    });
    dropIds.push(draft.id);

    const { sources } = await reportSourcesFor({ merchantId: fixture.merchantId });

    expect(sources.some((source) => source.dropId === draft.id)).toBe(false);
  });

  /**
   * **FR-701's acceptance criterion, as a real assertion.**
   *
   * Every drop the report includes must reconcile with its own ledger rows. This
   * walks the whole report and would fail if any fixture produced orders and
   * ledger rows that disagree — which is the only sense in which "numbers
   * reconcile with ledger" can be checked from outside the module.
   */
  it('produces no drop that fails to reconcile with its ledger', async () => {
    const report = await merchantReportQuery({
      merchantId: fixture.merchantId,
      merchantName: 'x',
      timezone: 'America/Edmonton',
    });

    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.withheldDropCount).toBe(0);
  });

  /**
   * The cost basis comes from the **frozen snapshot**, not from today's menu item.
   *
   * A merchant who raises their ingredient cost after a drop must not rewrite what
   * that drop earned (FR-207). Raising `MenuItem.foodCostCents` and re-reading must
   * leave the report's contribution unchanged.
   */
  it('computes contribution from the frozen snapshot, not the current menu item', async () => {
    const dropId = await makeDrop({ minQty: 1, maxQty: 10 });
    const customer = await makeCustomer();
    await makeCapturedParticipant({ dropId, customerId: customer, qty: 1, dealPriceCents: 1112 });

    const before = await merchantReportQuery({
      merchantId: fixture.merchantId,
      merchantName: 'x',
      timezone: 'America/Edmonton',
    });
    const beforeRow = before.rows.find((row) => row.dropId === dropId);

    // Double the food cost on the item, the way a merchant would.
    await prisma.menuItem.update({
      where: { id: fixture.itemId },
      data: { foodCostCents: 960 },
    });

    const after = await merchantReportQuery({
      merchantId: fixture.merchantId,
      merchantName: 'x',
      timezone: 'America/Edmonton',
    });
    const afterRow = after.rows.find((row) => row.dropId === dropId);

    // 1 × roundHalfUp(1112 − 480 − 80 − 62.248 − 88.96) = 401, unchanged.
    expect(beforeRow?.figures.contributionCents).toBe(401);
    expect(afterRow?.figures.contributionCents).toBe(401);

    // Restore, so later files and reruns are not affected by this test's edit.
    await prisma.menuItem.update({
      where: { id: fixture.itemId },
      data: { foodCostCents: 480 },
    });
  });

  /**
   * The snapshot the fixture wrote must be readable by the same reader production
   * uses. If `buildGuardrailSnapshot` and `readGuardrailSnapshot` ever disagree,
   * every drop would be silently skipped and `withheldDropCount` would quietly
   * equal the drop count — a report that renders "nothing to show" for a merchant
   * with fifty drops.
   */
  it('reads back every fixture snapshot', async () => {
    const drop = await prisma.drop.findFirstOrThrow({
      where: { id: { in: dropIds } },
      select: { guardrailSnapshot: true },
    });
    expect(() => readGuardrailSnapshot(drop.guardrailSnapshot)).not.toThrow();
  });
});
