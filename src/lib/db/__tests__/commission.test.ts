import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';
import { commissionCentsFor, toCsv } from '@/lib/organisers/commission';

import {
  commissionMonthsFor,
  commissionStatementFor,
  currentCommissionMonthKey,
  resolveCommissionMonth,
} from '../commission';

/**
 * FR-804's statement against real Postgres.
 *
 * ## What these tests protect, and why each one has a plausible wrong implementation
 *
 *   - **AC1/AC3** — the base is `subtotalCents − refundedCents`. Reading `subtotalCents`
 *     passes every test that never refunds anything, which is most of them.
 *   - **AC2** — a force-failed drop nets zero and pays zero. This is the same bug as
 *     AC1 at full amplitude: a gross implementation pays 2400 for a drop that never
 *     happened.
 *   - **AC7** — attribution walks `Order → DropParticipant.shareLinkId → ShareLink`.
 *     `shareLinkId IS NULL` belongs to nobody, and a participant with no `Order` was
 *     authorised but never captured.
 *   - **AC8** — two organisers on one drop each get their own line. Joining on `dropId`
 *     instead of `shareLinkId` gives both of them the whole drop, and nothing else in
 *     this repository notices.
 *   - **AC9** — presence is decided by activity: a link nobody joined is absent, a link
 *     whose orders netted zero is present.
 *   - **AC10** — FR-805. The row type has no field for a phone number; the test asserts
 *     the serialised rows and the CSV bytes anyway, against a customer whose phone,
 *     email and name are really in the database.
 *   - **AC11/AC12** — the same month rendered twice is byte-identical, and neither a
 *     render nor an export writes a row.
 *
 * ## Why every test gets its own organiser
 *
 * A statement is "everything this organiser did in this month", so two tests sharing an
 * organiser and a month would see each other's drops. Separate organisers make each
 * test's month genuinely empty apart from its own fixtures, which is also what lets the
 * month-boundary tests pin a fixed instant instead of `Date.now()`.
 */

const PREFIX = `cm${Date.now().toString(36).slice(-5)}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const DEAL_PRICE = 1200;
const HOUR = 60 * 60 * 1000;

/** 2026-02-15 11:00 MST — unambiguously February in Edmonton. */
const FEBRUARY = new Date('2026-02-15T18:00:00Z');
/** 2026-03-15 12:00 MDT — unambiguously March, after the 03-08 transition. */
const MARCH = new Date('2026-03-15T18:00:00Z');
/** AC6: 2026-02-28 23:30 MST. A UTC-naive filter puts this in March. */
const LAST_HALF_HOUR_OF_FEBRUARY = new Date('2026-03-01T06:30:00Z');

let merchantId = '';
let itemId = '';

const organiserProfileIds: string[] = [];
const organiserUserIds: string[] = [];
const customerIds: string[] = [];

let userSeq = 0;
let customerSeq = 0;

/** An organiser with a profile, tracked for teardown. */
async function newOrganiser(tag: string, commissionPct = 5): Promise<string> {
  userSeq += 1;
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}-${userSeq}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  organiserUserIds.push(user.id);

  const profile = await prisma.organiserProfile.create({
    data: { userId: user.id, displayName: `${PREFIX} ${tag}`, commissionPct },
    select: { id: true },
  });
  organiserProfileIds.push(profile.id);
  return profile.id;
}

/** A diner. Unique phone per call, because `Customer.phone` is unique. */
async function newCustomer(): Promise<string> {
  customerSeq += 1;
  const customer = await prisma.customer.create({
    data: { phone: `+1780556${String(customerSeq).padStart(4, '0')}` },
    select: { id: true },
  });
  customerIds.push(customer.id);
  return customer.id;
}

/** A drop with a pickup window a day after the given capture instant. */
async function newDrop(args: {
  status?: 'PUBLISHED' | 'CAPTURED' | 'FAILED' | 'COMPLETED';
  windowStart?: Date;
} = {}): Promise<string> {
  return fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    maxQty: 200,
    status: args.status ?? 'CAPTURED',
    cutoffAt: new Date(Date.now() - 2 * HOUR),
    windowStart: args.windowStart ?? new Date('2026-03-05T19:00:00Z'),
    windowEnd: args.windowStart ? new Date(args.windowStart.getTime() + HOUR) : new Date('2026-03-05T21:00:00Z'),
  });
}

/** The organiser's link for a drop, created the way the organiser page creates one. */
async function shareLinkFor(dropId: string, organiserProfileId: string): Promise<string> {
  const link = await prisma.shareLink.create({
    data: {
      // A real 22-character base64url token, so the fixture cannot produce a row
      // production would reject.
      token: randomBytes(16).toString('base64url'),
      dropId,
      merchantId,
      organiserId: organiserProfileId,
    },
    select: { id: true },
  });
  return link.id;
}

/**
 * A join, and optionally the order that capture writes for it.
 *
 * `captured: false` is the state AC7 names explicitly: the card was authorised and the
 * capture never happened, so there is a `DropParticipant` and no `Order`. A statement
 * that starts from participants counts that person; one that starts from orders does
 * not.
 */
async function join(args: {
  dropId: string;
  shareLinkId: string | null;
  qty: number;
  capturedAt: Date;
  unitPriceCents?: number;
  refundedCents?: number;
  captured?: boolean;
  customerId?: string;
}): Promise<{ participantId: string; orderId: string | null }> {
  const unitPriceCents = args.unitPriceCents ?? DEAL_PRICE;
  const customerId = args.customerId ?? (await newCustomer());
  const refundedCents = args.refundedCents ?? 0;

  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId,
      qty: args.qty,
      shareLinkId: args.shareLinkId,
      amountCents: args.qty * unitPriceCents,
      platformFeeCents: 0,
      authStatus: 'AUTHORIZED',
      chargeStatus: args.captured === false ? 'NONE' : refundedCents > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED',
    },
    select: { id: true },
  });

  if (args.captured === false) {
    return { participantId: participant.id, orderId: null };
  }

  const order = await prisma.order.create({
    data: {
      dropId: args.dropId,
      participantId: participant.id,
      qty: args.qty,
      unitPriceCents,
      // Copied from the participant exactly as `settle.ts` does at capture.
      subtotalCents: args.qty * unitPriceCents,
      // Commission never reads the platform fee; settlement owns that column.
      platformFeeCents: 0,
      refundedCents,
      createdAt: args.capturedAt,
    },
    select: { id: true },
  });

  return { participantId: participant.id, orderId: order.id };
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  // `ShareLink` has no cascade from `OrganiserProfile` or `Merchant`, so it goes first.
  await prisma.shareLink
    .deleteMany({ where: { organiserId: { in: organiserProfileIds } } })
    .catch(() => undefined);
  // Deleting the user cascades the profile.
  await prisma.user.deleteMany({ where: { id: { in: organiserUserIds } } }).catch(() => undefined);
  // Drops cascade participants and orders.
  await fx.cleanup();
  // Only now are the participants gone, so the customers are unreferenced.
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => undefined);
});

describe('commissionStatementFor — the base', () => {
  it('AC1: $24.00 captured with $6.00 refunded pays 90, not 120', async () => {
    const organiser = await newOrganiser('ac1');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);
    await join({ dropId: drop, shareLinkId: link, qty: 2, capturedAt: FEBRUARY, refundedCents: 600 });

    const statement = await commissionStatementFor({
      organiserProfileId: organiser,
      monthKey: '2026-02',
    });

    expect(statement).not.toBeNull();
    expect(statement?.lines).toHaveLength(1);

    const line = statement?.lines[0];
    expect(line?.grossCapturedCents).toBe(2400);
    expect(line?.refundedCents).toBe(600);
    expect(line?.netCapturedCents).toBe(1800);
    expect(line?.commissionCents).toBe(90);
    // 5% of gross. The number a `subtotalCents` base produces.
    expect(line?.commissionCents).not.toBe(commissionCentsFor(2400, 500));
    expect(statement?.totals.commissionCents).toBe(90);
  });

  it('AC2: a force-failed drop shows gross 48000, net 0, commission 0', async () => {
    const organiser = await newOrganiser('ac2');
    const drop = await newDrop({ status: 'FAILED' });
    const link = await shareLinkFor(drop, organiser);

    // 20 × $24.00, every card captured and every card refunded.
    for (let index = 0; index < 20; index += 1) {
      await join({
        dropId: drop,
        shareLinkId: link,
        qty: 1,
        capturedAt: MARCH,
        unitPriceCents: 2400,
        refundedCents: 2400,
      });
    }

    const statement = await commissionStatementFor({
      organiserProfileId: organiser,
      monthKey: '2026-03',
    });

    // Present, not absent: the organiser worked this drop and the row is what stops
    // "why did this pay nothing" becoming a support ticket.
    expect(statement?.lines).toHaveLength(1);
    const line = statement?.lines[0];
    expect(line?.units).toBe(20);
    expect(line?.grossCapturedCents).toBe(48_000);
    expect(line?.refundedCents).toBe(48_000);
    expect(line?.netCapturedCents).toBe(0);
    expect(line?.commissionCents).toBe(0);
    expect(line?.dropStatus).toBe('FAILED');
    // What a gross-based implementation pays for a drop that never happened.
    expect(commissionCentsFor(48_000, 500)).toBe(2400);
  });

  it('AC3: a partial refund of one diner moves the base by exactly that refund', async () => {
    const organiser = await newOrganiser('ac3');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);

    for (let index = 0; index < 9; index += 1) {
      await join({
        dropId: drop,
        shareLinkId: link,
        qty: 1,
        capturedAt: MARCH,
        unitPriceCents: 2400,
      });
    }
    // The tenth diner, refunded $6.00 of their $24.00.
    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 1,
      capturedAt: MARCH,
      unitPriceCents: 2400,
      refundedCents: 600,
    });

    const statement = await commissionStatementFor({
      organiserProfileId: organiser,
      monthKey: '2026-03',
    });

    const line = statement?.lines[0];
    expect(line?.units).toBe(10);
    expect(line?.grossCapturedCents).toBe(24_000);
    expect(line?.refundedCents).toBe(600);
    expect(line?.netCapturedCents).toBe(23_400);
    expect(line?.commissionCents).toBe(1170);
    // The gross figure, and the difference a $6.00 refund makes to a 5% commission.
    expect(commissionCentsFor(24_000, 500)).toBe(1200);
  });

  it('follows the organiser’s own rate rather than a hard-coded 5%', async () => {
    const organiser = await newOrganiser('rate', 7.5);
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);
    await join({ dropId: drop, shareLinkId: link, qty: 10, capturedAt: MARCH, unitPriceCents: 1000 });

    const statement = await commissionStatementFor({
      organiserProfileId: organiser,
      monthKey: '2026-03',
    });

    expect(statement?.commissionBasisPoints).toBe(750);
    expect(statement?.lines[0]?.commissionCents).toBe(750);
    expect(statement?.lines[0]?.commissionBasisPoints).toBe(750);
  });
});

describe('commissionStatementFor — the month is Edmonton’s', () => {
  it('AC6: 2026-03-01T06:30:00Z lands in February, not March', async () => {
    const organiser = await newOrganiser('ac6');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);
    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 1,
      capturedAt: LAST_HALF_HOUR_OF_FEBRUARY,
      unitPriceCents: 2400,
    });

    const february = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-02' });
    const march = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' });

    expect(february?.lines).toHaveLength(1);
    expect(february?.totals.grossCapturedCents).toBe(2400);
    expect(march?.lines).toHaveLength(0);
    expect(march?.totals.grossCapturedCents).toBe(0);
  });

  it('excludes an order captured before the period and one after it', async () => {
    const organiser = await newOrganiser('bounds');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);

    // One second before March opens in Edmonton, and one second after April opens.
    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 1,
      capturedAt: new Date('2026-03-01T06:59:59Z'),
      unitPriceCents: 1000,
    });
    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 1,
      capturedAt: new Date('2026-04-01T06:00:01Z'),
      unitPriceCents: 1000,
    });
    // And one inside it.
    await join({ dropId: drop, shareLinkId: link, qty: 1, capturedAt: MARCH, unitPriceCents: 1000 });

    const march = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' });
    expect(march?.lines[0]?.units).toBe(1);
  });
});

describe('commissionStatementFor — attribution', () => {
  it('AC7: 30 joins, 20 on this organiser’s link, and one never captured', async () => {
    const organiser = await newOrganiser('ac7');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);

    for (let index = 0; index < 20; index += 1) {
      await join({ dropId: drop, shareLinkId: link, qty: 1, capturedAt: MARCH, unitPriceCents: 1000 });
    }
    for (let index = 0; index < 10; index += 1) {
      // A plain link: `shareLinkId IS NULL`, which belongs to nobody.
      await join({ dropId: drop, shareLinkId: null, qty: 1, capturedAt: MARCH, unitPriceCents: 1000 });
    }
    // Authorised, never captured. No `Order` exists, so this must contribute nothing —
    // and it must not make the statement think the drop had 21 units.
    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 5,
      capturedAt: MARCH,
      unitPriceCents: 1000,
      captured: false,
    });

    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' });

    expect(statement?.lines).toHaveLength(1);
    expect(statement?.lines[0]?.units).toBe(20);
    expect(statement?.totals.grossCapturedCents).toBe(20_000);
    // Neither 30 nor 25: the null-share joins are nobody's and the uncaptured one is
    // not money.
    expect(statement?.totals.grossCapturedCents).not.toBe(30_000);
    expect(statement?.totals.grossCapturedCents).not.toBe(25_000);
  });

  it('AC8: two organisers on one drop get 12 and 8, neither 20', async () => {
    const first = await newOrganiser('ac8a');
    const second = await newOrganiser('ac8b');
    const drop = await newDrop();
    const firstLink = await shareLinkFor(drop, first);
    const secondLink = await shareLinkFor(drop, second);

    for (let index = 0; index < 12; index += 1) {
      await join({ dropId: drop, shareLinkId: firstLink, qty: 1, capturedAt: MARCH, unitPriceCents: 1000 });
    }
    for (let index = 0; index < 8; index += 1) {
      await join({ dropId: drop, shareLinkId: secondLink, qty: 1, capturedAt: MARCH, unitPriceCents: 1000 });
    }

    const firstStatement = await commissionStatementFor({ organiserProfileId: first, monthKey: '2026-03' });
    const secondStatement = await commissionStatementFor({ organiserProfileId: second, monthKey: '2026-03' });

    expect(firstStatement?.lines).toHaveLength(1);
    expect(firstStatement?.lines[0]?.units).toBe(12);
    expect(firstStatement?.lines[0]?.grossCapturedCents).toBe(12_000);
    expect(firstStatement?.totals.commissionCents).toBe(600);

    expect(secondStatement?.lines).toHaveLength(1);
    expect(secondStatement?.lines[0]?.units).toBe(8);
    expect(secondStatement?.lines[0]?.grossCapturedCents).toBe(8_000);
    expect(secondStatement?.totals.commissionCents).toBe(400);

    // The `dropId` join: both organisers credited with the whole drop.
    expect(firstStatement?.totals.grossCapturedCents).not.toBe(20_000);
    expect(secondStatement?.totals.grossCapturedCents).not.toBe(20_000);
  });

  it('AC9: a link nobody joined is absent, a link that netted zero is present', async () => {
    const organiser = await newOrganiser('ac9');
    const quietDrop = await newDrop();
    const failedDrop = await newDrop({ status: 'FAILED' });
    const quietLink = await shareLinkFor(quietDrop, organiser);
    const failedLink = await shareLinkFor(failedDrop, organiser);

    // The quiet link has a token, a click and no participant at all.
    await prisma.shareLink.update({ where: { id: quietLink }, data: { clicks: 40 } });
    // The failed link captured and refunded everyone.
    await join({
      dropId: failedDrop,
      shareLinkId: failedLink,
      qty: 4,
      capturedAt: MARCH,
      unitPriceCents: 1000,
      refundedCents: 4000,
    });

    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' });

    expect(statement?.lines).toHaveLength(1);
    expect(statement?.lines[0]?.dropId).toBe(failedDrop);
    expect(statement?.lines[0]?.commissionCents).toBe(0);
    expect(statement?.lines.map((line) => line.dropId)).not.toContain(quietDrop);
  });

  it('returns null for an organiser profile that does not exist', async () => {
    expect(
      await commissionStatementFor({
        organiserProfileId: '00000000-0000-0000-0000-000000000000',
        monthKey: '2026-03',
      }),
    ).toBeNull();
  });

  it('refuses a malformed month rather than answering about a different one', async () => {
    const organiser = await newOrganiser('bad-month');
    await expect(
      commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-3' }),
    ).rejects.toThrow(/YYYY-MM/);
  });
});

describe('commissionStatementFor — integrity', () => {
  it('fails loudly, naming the order, when refunds exceed the charge', async () => {
    const organiser = await newOrganiser('integrity');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);

    const broken = await join({
      dropId: drop,
      shareLinkId: link,
      qty: 1,
      capturedAt: MARCH,
      unitPriceCents: 2400,
    });
    // Written straight past the service layer, which is the only way this state can
    // exist — and therefore the state a clamp would silently paper over.
    await prisma.order.update({
      where: { id: broken.orderId ?? '' },
      data: { refundedCents: 2401 },
    });

    await expect(
      commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' }),
    ).rejects.toThrow(new RegExp(broken.orderId ?? 'no-order-id'));
  });
});

describe('commissionStatementFor — determinism and silence', () => {
  it('AC11: the same organiser and month render byte-identically twice', async () => {
    const organiser = await newOrganiser('ac11');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);
    await join({ dropId: drop, shareLinkId: link, qty: 3, capturedAt: MARCH, refundedCents: 300 });

    const first = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' });
    const second = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' });

    expect(JSON.stringify(second?.lines)).toBe(JSON.stringify(first?.lines));
    expect(JSON.stringify(second?.totals)).toBe(JSON.stringify(first?.totals));
    expect(toCsv(second?.lines ?? [])).toBe(toCsv(first?.lines ?? []));
    // And the period bounds are identical, which is what makes the query the same query.
    expect(second?.periodFrom.getTime()).toBe(first?.periodFrom.getTime());
    expect(second?.periodTo.getTime()).toBe(first?.periodTo.getTime());
  });

  it('AC12: rendering the statement and building the CSV writes nothing', async () => {
    const organiser = await newOrganiser('ac12');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);
    await join({ dropId: drop, shareLinkId: link, qty: 2, capturedAt: MARCH, refundedCents: 200 });

    const before = await writeCounts();
    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' });
    toCsv(statement?.lines ?? []);
    await commissionMonthsFor(organiser);
    const after = await writeCounts();

    expect(after).toEqual(before);
  });
});

describe('FR-805 — no participant PII in the rows or the bytes', () => {
  it('AC10: carries no phone, no phone suffix, no email and no customer name', async () => {
    const organiser = await newOrganiser('ac10');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);

    // A real diner, with a real phone number, email and name in the database — so the
    // assertion below is against data that exists, not against an empty column.
    const customer = await prisma.customer.create({
      data: {
        phone: '+17805553947',
        email: `${PREFIX}-private@diner.test`,
        name: 'Marguerite Okonkwo',
      },
      select: { id: true },
    });
    customerIds.push(customer.id);

    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 2,
      capturedAt: MARCH,
      customerId: customer.id,
    });

    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-03' });
    const serialised = JSON.stringify(statement?.lines);
    const csv = toCsv(statement?.lines ?? []);

    // The statement really did include this diner's money, so the absence below is not
    // the absence of a row.
    expect(statement?.lines).toHaveLength(1);
    expect(statement?.lines[0]?.units).toBe(2);

    for (const secret of [
      '+17805553947',
      '3947',
      `${PREFIX}-private@diner.test`,
      'Marguerite Okonkwo',
    ]) {
      expect(serialised).not.toContain(secret);
      expect(csv).not.toContain(secret);
    }

    // And nothing order-level or participant-level either: FR-805 forbids those ids in
    // any form, not only the ones a test thought of.
    const order = await prisma.order.findFirstOrThrow({
      where: { dropId: drop },
      select: { id: true, participantId: true },
    });
    expect(serialised).not.toContain(order.id);
    expect(serialised).not.toContain(order.participantId);
  });
});

describe('commissionMonthsFor', () => {
  it('lists only the months with attributed activity, newest first', async () => {
    const organiser = await newOrganiser('months');
    const februaryDrop = await newDrop();
    const marchDrop = await newDrop();
    const februaryLink = await shareLinkFor(februaryDrop, organiser);
    const marchLink = await shareLinkFor(marchDrop, organiser);
    const quietDrop = await newDrop();
    await shareLinkFor(quietDrop, organiser);

    await join({ dropId: februaryDrop, shareLinkId: februaryLink, qty: 1, capturedAt: FEBRUARY });
    await join({ dropId: marchDrop, shareLinkId: marchLink, qty: 1, capturedAt: MARCH });

    expect(await commissionMonthsFor(organiser)).toEqual(['2026-03', '2026-02']);
  });

  it('returns an empty list for an organiser with no activity, not an error', async () => {
    const organiser = await newOrganiser('no-activity');
    expect(await commissionMonthsFor(organiser)).toEqual([]);
  });
});

describe('resolveCommissionMonth and currentCommissionMonthKey', () => {
  it('applies a valid month and reports nothing ignored', () => {
    expect(resolveCommissionMonth('2026-03')).toEqual({
      monthKey: '2026-03',
      requested: '2026-03',
      ignored: false,
    });
  });

  it('falls back to the current month and says the request was ignored', () => {
    const resolved = resolveCommissionMonth('nonsense');
    expect(resolved.monthKey).toBe(currentCommissionMonthKey());
    expect(resolved.requested).toBe('nonsense');
    expect(resolved.ignored).toBe(true);
  });

  it('treats an absent month as "current", not as a mistake', () => {
    const resolved = resolveCommissionMonth(null);
    expect(resolved.monthKey).toBe(currentCommissionMonthKey());
    expect(resolved.requested).toBeNull();
    expect(resolved.ignored).toBe(false);
  });

  it('resolves the current month in Edmonton, from an explicit instant', () => {
    // 2026-03-01T06:30Z is 28 February in Edmonton, so the "current month" is February
    // even though a UTC clock says March. Same defect as AC6, on the default path.
    expect(currentCommissionMonthKey(new Date('2026-03-01T06:30:00Z'))).toBe('2026-02');
    expect(currentCommissionMonthKey(new Date('2026-03-01T07:30:00Z'))).toBe('2026-03');
  });
});

/** Row counts for AC12. Global, which is safe here: the suite runs one file at a time. */
async function writeCounts(): Promise<Record<string, number>> {
  const [orders, ledgerEntries, drops, auditLogs, participants] = await Promise.all([
    prisma.order.count(),
    prisma.ledgerEntry.count(),
    prisma.drop.count(),
    prisma.auditLog.count(),
    prisma.dropParticipant.count(),
  ]);
  return { orders, ledgerEntries, drops, auditLogs, participants };
}
