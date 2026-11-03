import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';
import {
  ADMIN_COMMISSION_CSV_COLUMNS,
  toAdminCsv,
  type AdminCommissionCsvRow,
} from '@/lib/organisers/commission';

import { adminCommissionRollupFor, commissionStatementFor } from '../commission';

/**
 * The admin roll-up — the P1 half of FR-804, against real Postgres.
 *
 * > Admin variant `GET /api/admin/commission?month=YYYY-MM`: one row per organiser
 * > for the whole month … the human doing e-transfers works from one file, not
 * > fifteen. — `docs/specs/FR-804-…md`
 *
 * ## What these tests protect
 *
 *   1. **The admin figure equals the organiser's own figure.** This is the whole reason
 *      the roll-up calls `commissionStatementFor` instead of aggregating in SQL. A
 *      second implementation would drift silently, because the organiser never sees the
 *      admin's number and nothing would compare them. Asserted per organiser, not on the
 *      total, so a drift cannot cancel itself out.
 *   2. **Two organisers on one drop are not double-credited.** The `dropId`-join defect
 *      (AC8) is invisible in a single-organiser test, and it is *more* dangerous in the
 *      admin view: a shared drop would be paid twice out of one transfer run, and the
 *      grand total would look plausible while being wrong.
 *   3. **Every organiser appears, including the ones who earned nothing.** An
 *      activity-filtered roster quietly does not pay someone whose attribution broke.
 *      That is unobservable in a file that simply omits a name.
 *   4. **The CSV's total equals the sum of its rows.** AC5 at the roster level: the
 *      number an operator reads must equal what a spreadsheet gives them by adding the
 *      column, or the file is not payable from.
 *   5. **No diner PII reaches the file.** FR-805 protects diners; an organiser's own
 *      email is the counterparty detail the operator needs, and the test asserts the
 *      boundary in *both* directions so "no PII" cannot be satisfied by emitting nothing.
 *
 * ## Why the month is 2026-05, and why the assertions are structural
 *
 * `adminCommissionRollupFor` reads **every** organiser that exists, and this suite runs
 * against a database other suites also write to. A month nobody else uses keeps the
 * money figures exact, and every structural assertion is written against the specific
 * profile ids this file created rather than against `rows.length`, so the suite cannot
 * become a count of whatever else happens to be in the database.
 */

const PREFIX = `adm${Date.now().toString(36).slice(-5)}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const DEAL_PRICE = 1200;
const HOUR = 60 * 60 * 1000;

/**
 * A month no other suite touches, so the roster's money figures are only ours.
 *
 * Far enough from `Date.now()` that no order created by another suite lands here, and
 * a real month so `commissionPeriodFor` resolves it without special-casing.
 */
const MONTH = '2026-05';
/** 2026-05-14 12:00 MDT — unambiguously inside `MONTH` in Edmonton. */
const CAPTURED_AT = new Date('2026-05-14T18:00:00Z');
/** 2026-05-20 12:00 MDT — same month, one week later. */
const CAPTURED_AT_LATER = new Date('2026-05-20T18:00:00Z');

let merchantId = '';
let itemId = '';

const organiserProfileIds: string[] = [];
const organiserUserIds: string[] = [];
const customerIds: string[] = [];

let userSeq = 0;
let customerSeq = 0;

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

async function newCustomer(): Promise<string> {
  customerSeq += 1;
  const customer = await prisma.customer.create({
    // A distinctly recognisable number, so the FR-805 assertion can look for it.
    data: { phone: `+1780557${String(customerSeq).padStart(4, '0')}` },
    select: { id: true },
  });
  customerIds.push(customer.id);
  return customer.id;
}

async function newDrop(): Promise<string> {
  return fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    maxQty: 200,
    status: 'CAPTURED',
    cutoffAt: new Date(Date.now() - 2 * HOUR),
    windowStart: new Date('2026-05-21T19:00:00Z'),
    windowEnd: new Date('2026-05-21T21:00:00Z'),
  });
}

async function shareLinkFor(dropId: string, organiserProfileId: string): Promise<string> {
  const link = await prisma.shareLink.create({
    data: {
      token: randomBytes(16).toString('base64url'),
      dropId,
      merchantId,
      organiserId: organiserProfileId,
    },
    select: { id: true },
  });
  return link.id;
}

async function join(args: {
  dropId: string;
  shareLinkId: string | null;
  qty: number;
  capturedAt: Date;
  refundedCents?: number;
  /** Defaults to the drop's deal price. Overridden to build an exact net figure. */
  unitPriceCents?: number;
}): Promise<void> {
  const refundedCents = args.refundedCents ?? 0;
  const unitPriceCents = args.unitPriceCents ?? DEAL_PRICE;
  const customerId = await newCustomer();
  const subtotalCents = args.qty * unitPriceCents;

  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId,
      qty: args.qty,
      shareLinkId: args.shareLinkId,
      amountCents: subtotalCents,
      platformFeeCents: 0,
      authStatus: 'AUTHORIZED',
      chargeStatus: refundedCents > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED',
    },
    select: { id: true },
  });

  await prisma.order.create({
    data: {
      dropId: args.dropId,
      participantId: participant.id,
      qty: args.qty,
      unitPriceCents,
      subtotalCents,
      platformFeeCents: 0,
      refundedCents,
      createdAt: args.capturedAt,
    },
    select: { id: true },
  });
}

/** The roll-up row for one profile, or `undefined` if the roster omitted them. */
async function rowFor(profileId: string) {
  const rollup = await adminCommissionRollupFor({ monthKey: MONTH });
  return { rollup, row: rollup.rows.find((candidate) => candidate.organiserProfileId === profileId) };
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await prisma.shareLink
    .deleteMany({ where: { organiserId: { in: organiserProfileIds } } })
    .catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: organiserUserIds } } }).catch(() => undefined);
  await fx.cleanup();
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => undefined);
});

describe('adminCommissionRollupFor — the roster', () => {
  it('reports the same figure the organiser sees on their own statement', async () => {
    // Two organisers, different rates, different amounts: if the roll-up ever
    // re-implemented the arithmetic, one of these would catch it.
    const alice = await newOrganiser('alice', 5);
    const bob = await newOrganiser('bob', 7.5);

    const dropA = await newDrop();
    const linkA = await shareLinkFor(dropA, alice);
    await join({ dropId: dropA, shareLinkId: linkA, qty: 2, capturedAt: CAPTURED_AT, refundedCents: 600 });

    const dropB = await newDrop();
    const linkB = await shareLinkFor(dropB, bob);
    await join({ dropId: dropB, shareLinkId: linkB, qty: 10, capturedAt: CAPTURED_AT });

    const { row: aliceRow } = await rowFor(alice);
    const { row: bobRow } = await rowFor(bob);

    const aliceStatement = await commissionStatementFor({
      organiserProfileId: alice,
      monthKey: MONTH,
    });
    const bobStatement = await commissionStatementFor({ organiserProfileId: bob, monthKey: MONTH });

    // Per organiser, not on the total: two drifting figures could cancel out.
    expect(aliceRow?.totals).toEqual(aliceStatement?.totals);
    expect(bobRow?.totals).toEqual(bobStatement?.totals);

    // And the arithmetic is the one the spec names: 1800 @ 5% = 90; 12000 @ 7.5% = 900.
    expect(aliceRow?.totals.commissionCents).toBe(90);
    expect(bobRow?.totals.commissionCents).toBe(900);
    expect(aliceRow?.commissionBasisPoints).toBe(500);
    expect(bobRow?.commissionBasisPoints).toBe(750);
  });

  it('does not credit two organisers on one drop with the whole drop', async () => {
    // AC8's defect, at the roster level. Joining orders to links on `dropId` gives both
    // organisers every participant: each would be paid the full 20 units here, and the
    // grand total would look entirely plausible.
    const carol = await newOrganiser('carol', 5);
    const dave = await newOrganiser('dave', 5);
    const drop = await newDrop();
    const carolLink = await shareLinkFor(drop, carol);
    const daveLink = await shareLinkFor(drop, dave);

    // 10 units on Carol's link, 4 on Dave's, 3 through no link at all.
    await join({ dropId: drop, shareLinkId: carolLink, qty: 10, capturedAt: CAPTURED_AT });
    await join({ dropId: drop, shareLinkId: daveLink, qty: 4, capturedAt: CAPTURED_AT });
    await join({ dropId: drop, shareLinkId: null, qty: 3, capturedAt: CAPTURED_AT });

    const { row: carolRow } = await rowFor(carol);
    const { row: daveRow } = await rowFor(dave);

    expect(carolRow?.totals.units).toBe(10);
    expect(daveRow?.totals.units).toBe(4);
    // Not 17 each, and not 14 between them — the unattributed 3 belongs to nobody.
    expect((carolRow?.totals.units ?? 0) + (daveRow?.totals.units ?? 0)).toBe(14);
  });

  it('lists an organiser who earned nothing, with zero lines rather than a missing row', async () => {
    // The failure this prevents: an organiser whose attribution broke disappears from an
    // activity-filtered roster and is quietly unpaid. Nobody notices from a file that
    // omits a name.
    const erin = await newOrganiser('erin', 5);

    const { row } = await rowFor(erin);

    expect(row).toBeDefined();
    expect(row?.lineCount).toBe(0);
    expect(row?.totals.commissionCents).toBe(0);
    // And the email is there, because this row exists to be payable or explained.
    expect(row?.organiserEmail).toBe(`${PREFIX}-erin-${userSeq}@example.test`);
  });

  it('omits a drop that took no money, but keeps one that was fully refunded', async () => {
    // AC9 at the roster level: a link nobody joined is noise; a force-failed drop is a
    // row with `0` so the organiser can see why it paid nothing.
    const frank = await newOrganiser('frank', 5);

    const quiet = await newDrop();
    await shareLinkFor(quiet, frank);

    const failed = await newDrop();
    const failedLink = await shareLinkFor(failed, frank);
    await join({
      dropId: failed,
      shareLinkId: failedLink,
      qty: 20,
      capturedAt: CAPTURED_AT,
      // A force-fail refunds every order in full.
      refundedCents: 20 * DEAL_PRICE,
    });

    const { row } = await rowFor(frank);

    expect(row?.lineCount).toBe(1);
    expect(row?.lines[0]?.refundedCents).toBe(24000);
    expect(row?.lines[0]?.netCapturedCents).toBe(0);
    expect(row?.totals.commissionCents).toBe(0);
    // The gross is still visible: "paid nothing" must be explainable.
    expect(row?.totals.grossCapturedCents).toBe(24000);
  });

  it('sums the roster total from the rounded per-organiser figures', async () => {
    // AC5 with more than one organiser: each figure is a sum of rounded lines, and the
    // grand total is a sum of those. A grand total computed by rounding the summed base
    // would differ, and would not match the column an operator adds up.
    const grace = await newOrganiser('grace', 5);
    const drop = await newDrop();
    const link = await shareLinkFor(drop, grace);
    // 1 × $18.10 = 1810 net: 5% = 90.5 -> 91.
    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 1,
      capturedAt: CAPTURED_AT,
      unitPriceCents: 1810,
    });
    const second = await newDrop();
    const secondLink = await shareLinkFor(second, grace);
    await join({
      dropId: second,
      shareLinkId: secondLink,
      qty: 1,
      capturedAt: CAPTURED_AT_LATER,
      unitPriceCents: 1810,
    });

    const { rollup, row } = await rowFor(grace);

    expect(row?.totals.commissionCents).toBe(182);
    // The grand total must be at least this organiser's figure, and must equal the sum
    // of the roster's rows exactly — the property, independent of what else is in the
    // database.
    const summed = rollup.rows.reduce((total, candidate) => total + candidate.totals.commissionCents, 0);
    expect(rollup.totals.commissionCents).toBe(summed);
    expect(rollup.totals.units).toBe(
      rollup.rows.reduce((total, candidate) => total + candidate.totals.units, 0),
    );
  });

  it('reads the month in Edmonton, not UTC', async () => {
    // May is MDT (UTC-6), so the last half hour of May is 2026-06-01T05:30Z =
    // 2026-05-31 23:30 local. A UTC-naive roster filter would call this June, and the
    // organiser would lose a line from a month they worked -- the same seven-hour defect
    // the pure module exists to prevent, one layer up.
    //
    // Note the offset is -6 here and -7 in the spec's AC6 example: that one is February.
    // Using the winter offset for a summer month is the mistake this test originally
    // made, and it is the same class of error as the bug.
    const heidi = await newOrganiser('heidi', 5);
    const drop = await newDrop();
    const link = await shareLinkFor(drop, heidi);
    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 1,
      capturedAt: new Date('2026-06-01T05:30:00Z'),
    });

    const { row } = await rowFor(heidi);
    expect(row?.totals.units).toBe(1);

    // And the control: half an hour later is June, so this is a boundary and not a
    // month that happens to contain everything.
    await join({
      dropId: drop,
      shareLinkId: link,
      qty: 1,
      capturedAt: new Date('2026-06-01T06:30:00Z'),
    });
    const { row: stillMay } = await rowFor(heidi);
    expect(stillMay?.totals.units).toBe(1);
  });

  it('reports the period it resolved, so the caller can print it', async () => {
    const rollup = await adminCommissionRollupFor({ monthKey: MONTH });
    expect(rollup.monthKey).toBe(MONTH);
    // Half-open: May 1 00:00 MDT to June 1 00:00 MDT.
    expect(rollup.periodFrom.toISOString()).toBe('2026-05-01T06:00:00.000Z');
    expect(rollup.periodTo.toISOString()).toBe('2026-06-01T06:00:00.000Z');
  });
});

describe('toAdminCsv', () => {
  /** Two rows and a total, built by hand so the serialiser is tested apart from the DB. */
  function sample(): { rows: AdminCommissionCsvRow[]; totals: Parameters<typeof toAdminCsv>[0]['totals'] } {
    const line = {
      dropId: 'drop-1',
      merchant: 'Kaffa Roasters',
      drop: 'Tuesday lunch bowl',
      pickupDate: '2026-05-21',
      units: 10,
      grossCapturedCents: 12000,
      refundedCents: 0,
      netCapturedCents: 12000,
      commissionBasisPoints: 500,
      commissionCents: 600,
      dropStatus: 'CAPTURED' as const,
    };
    return {
      rows: [
        {
          organiserName: 'Alice Chen',
          organiserEmail: 'alice@example.test',
          organiserSlug: 'alice-chen',
          line,
        },
        {
          organiserName: 'Bob Okafor',
          organiserEmail: 'bob@example.test',
          organiserSlug: 'bob-okafor',
          line: { ...line, dropId: 'drop-2', drop: 'Friday bowls', commissionCents: 300, netCapturedCents: 6000, grossCapturedCents: 6000, units: 5 },
        },
      ],
      totals: {
        units: 15,
        grossCapturedCents: 18000,
        refundedCents: 0,
        netCapturedCents: 18000,
        commissionCents: 900,
      },
    };
  }

  it('writes the declared header, so the test asserts the contract and not a copy', () => {
    const csv = toAdminCsv(sample());
    expect(csv.split('\n')[0]).toBe(ADMIN_COMMISSION_CSV_COLUMNS.join(','));
  });

  it('leads with the organiser, because that is the row the operator pays', () => {
    const firstDataRow = toAdminCsv(sample()).split('\n')[1];
    expect(firstDataRow?.startsWith('Alice Chen,alice@example.test,alice-chen,')).toBe(true);
  });

  it('ends with a labelled TOTAL row whose column equals the sum of the rows', () => {
    const csv = toAdminCsv(sample());
    const lines = csv.trimEnd().split('\n');
    const totalRow = lines[lines.length - 1];
    expect(totalRow?.startsWith('TOTAL,')).toBe(true);

    const commissionIndex = ADMIN_COMMISSION_CSV_COLUMNS.indexOf('commission_cents');
    const dataRows = lines.slice(1, -1);
    const summed = dataRows.reduce(
      (total, row) => total + Number(row.split(',')[commissionIndex]),
      0,
    );

    // The property AC5 exists for, at the file level: what a spreadsheet gives you by
    // adding the column must equal the number printed in the total row.
    expect(Number(totalRow?.split(',')[commissionIndex])).toBe(summed);
    expect(summed).toBe(900);
  });

  it('leaves the rate blank in the TOTAL row, because the rates differ', () => {
    const csv = toAdminCsv(sample());
    const totalRow = csv.trimEnd().split('\n').pop() ?? '';
    const pctIndex = ADMIN_COMMISSION_CSV_COLUMNS.indexOf('commission_pct');
    // A `5.00` here would be one number standing for a set that is not all 5.00.
    expect(totalRow.split(',')[pctIndex]).toBe('');
  });

  it('quotes a name containing a comma, so the columns do not shift', () => {
    const { rows, totals } = sample();
    const csv = toAdminCsv({
      rows: [{ ...rows[0]!, organiserName: 'Chen, Alice' }],
      totals,
    });
    const dataRow = csv.split('\n')[1] ?? '';
    expect(dataRow.startsWith('"Chen, Alice",')).toBe(true);
  });

  it('carries the organiser email but never a diner email or phone', () => {
    const csv = toAdminCsv(sample());
    // The counterparty detail the operator needs to send money...
    expect(csv).toContain('alice@example.test');
    // ...and nothing that could be a diner. The fixture has no diner fields at all,
    // which is the structural guarantee; this asserts the type did not grow one.
    expect(csv).not.toMatch(/\+1\d{10}/);
  });
});
