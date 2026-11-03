import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';
import {
  COMMISSION_CSV_COLUMNS,
  commissionCentsFor,
  toCsv,
  type CommissionLineRow,
} from '@/lib/organisers/commission';

import { commissionStatementFor } from '../commission';

/**
 * Independent verification of FR-804's query, against real Postgres.
 *
 * ## Why this file exists beside the engineer's
 *
 * The engineer's suite proves each silent bug by mutating the source and watching a
 * named assertion fail. That is a good proof that the assertion is load-bearing. It is
 * not a proof that the assertion encodes the *right* number, because the same author
 * wrote both. So each test here builds data where the wrong implementation yields a
 * specific, different figure, and asserts the right one — independently derived from
 * the spec text rather than from the implementation.
 *
 * Three of them are the silent class:
 *
 *   1. **Attribution.** Two organisers share one drop. A `dropId` join credits each of
 *      them with all 20 participants; the correct answer is 12 and 8. A null
 *      `shareLinkId` belongs to nobody, and it must not leak into either statement.
 *   2. **The base.** A gross base pays 2400 for a force-failed drop that kept nothing.
 *      One line carrying a partial refund and a full refund must read gross 4800,
 *      refunded 3000, net 1800, commission 90.
 *   3. **Rounding.** Two lines at 1810 are 91 + 91 = 182. Rounding the summed base is
 *      181, and ops pays from a CSV whose column must add up.
 *
 * Plus FR-805 (P0) with a customer whose phone, email and name QA controls, and AC12's
 * "no writes" as a row-count snapshot around a render and an export.
 *
 * ## Every test gets its own organiser
 *
 * A statement is "everything this organiser did in this month". Sharing an organiser
 * between tests makes each one see its neighbours' drops, and the assertion that a
 * statement has exactly one line becomes a statement about test ordering.
 */

const PREFIX = `cv${Date.now().toString(36).slice(-5)}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const HOUR = 60 * 60 * 1000;
const DEAL_PRICE = 1200;

/** 2026-02-15 11:00 MST — unambiguously February in Edmonton, in both tz databases. */
const FEBRUARY = new Date('2026-02-15T18:00:00Z');

let merchantId = '';
let itemId = '';

const organiserProfileIds: string[] = [];
const organiserUserIds: string[] = [];
const customerIds: string[] = [];
const dropIds: string[] = [];

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

/** A diner with no PII set — enough for the attribution and money tests. */
async function newCustomer(): Promise<string> {
  customerSeq += 1;
  const customer = await prisma.customer.create({
    data: { phone: `+1780557${String(customerSeq).padStart(4, '0')}` },
    select: { id: true },
  });
  customerIds.push(customer.id);
  return customer.id;
}

/**
 * A diner whose phone, email and name QA chooses.
 *
 * The point is that a leak is unmistakable: the tokens below appear nowhere else in the
 * database, so a substring match in a serialised row or a CSV byte stream is proof and
 * not coincidence.
 */
async function newIdentifiableCustomer(args: {
  phone: string;
  email: string;
  name: string;
}): Promise<string> {
  const customer = await prisma.customer.create({
    data: { phone: args.phone, email: args.email, name: args.name },
    select: { id: true },
  });
  customerIds.push(customer.id);
  return customer.id;
}

async function newDrop(args: { status?: 'CAPTURED' | 'FAILED'; title?: string } = {}): Promise<string> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    maxQty: 500,
    status: args.status ?? 'CAPTURED',
    cutoffAt: new Date(Date.now() - 2 * HOUR),
    windowStart: new Date('2026-03-05T19:00:00Z'),
    windowEnd: new Date('2026-03-05T21:00:00Z'),
  });
  dropIds.push(dropId);

  if (args.title !== undefined) {
    // `settlementFixtures.drop` names the drop after the prefix; the CSV tests need a
    // title with a comma in it, so it is overwritten here rather than forked.
    await prisma.drop.update({ where: { id: dropId }, data: { title: args.title } });
  }

  return dropId;
}

/** The organiser's link for a drop, created the way the organiser page creates one. */
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

/**
 * A join, and the order capture writes for it.
 *
 * `shareLinkId: null` is the diner who arrived through a plain link: no organiser is
 * credited, and the row must appear in nobody's statement.
 */
async function join(args: {
  dropId: string;
  shareLinkId: string | null;
  qty: number;
  capturedAt?: Date;
  unitPriceCents?: number;
  refundedCents?: number;
  customerId?: string;
}): Promise<{ participantId: string; orderId: string }> {
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
      chargeStatus: refundedCents > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED',
    },
    select: { id: true },
  });

  const order = await prisma.order.create({
    data: {
      dropId: args.dropId,
      participantId: participant.id,
      qty: args.qty,
      unitPriceCents,
      // Copied from the participant exactly as `settle.ts` does at capture.
      subtotalCents: args.qty * unitPriceCents,
      platformFeeCents: 0,
      refundedCents,
      createdAt: args.capturedAt ?? FEBRUARY,
    },
    select: { id: true },
  });

  return { participantId: participant.id, orderId: order.id };
}

/** Minimal RFC 4180 parser, quote-aware. Duplicated here so this file stands alone. */
function parseCsvDocument(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < csv.length) {
    const char = csv.charAt(index);
    if (quoted) {
      if (char === '"' && csv.charAt(index + 1) === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
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

describe('verification — attribution (the dropId-join trap)', () => {
  it('AC8: two organisers on one drop see 12 and 8 units, never 20', async () => {
    const organiserA = await newOrganiser('attr-a');
    const organiserB = await newOrganiser('attr-b');

    // One drop, two links — the state `@@unique([dropId, organiserId])` permits and the
    // state a `dropId` join cannot tell apart.
    const drop = await newDrop();
    const linkA = await shareLinkFor(drop, organiserA);
    const linkB = await shareLinkFor(drop, organiserB);

    // 12 diners through A's link, 8 through B's. Each order is 1 unit.
    for (let index = 0; index < 12; index += 1) {
      await join({ dropId: drop, shareLinkId: linkA, qty: 1 });
    }
    for (let index = 0; index < 8; index += 1) {
      await join({ dropId: drop, shareLinkId: linkB, qty: 1 });
    }

    const statementA = await commissionStatementFor({ organiserProfileId: organiserA, monthKey: '2026-02' });
    const statementB = await commissionStatementFor({ organiserProfileId: organiserB, monthKey: '2026-02' });

    expect(statementA?.lines).toHaveLength(1);
    expect(statementB?.lines).toHaveLength(1);

    // A sees only A's 12. A `dropId` join gives A all 20, and nothing else notices.
    expect(statementA?.lines[0]?.units).toBe(12);
    expect(statementA?.totals.units).toBe(12);
    expect(statementA?.totals.units).not.toBe(20);

    // B sees only B's 8.
    expect(statementB?.lines[0]?.units).toBe(8);
    expect(statementB?.totals.units).toBe(8);
    expect(statementB?.totals.units).not.toBe(20);

    // Money follows units: A's gross is 12 × 1200, B's is 8 × 1200.
    expect(statementA?.lines[0]?.grossCapturedCents).toBe(12 * DEAL_PRICE);
    expect(statementB?.lines[0]?.grossCapturedCents).toBe(8 * DEAL_PRICE);
  });

  it('AC7: a participant with shareLinkId = null appears in neither statement', async () => {
    const organiserA = await newOrganiser('null-a');
    const organiserB = await newOrganiser('null-b');

    const drop = await newDrop();
    const linkA = await shareLinkFor(drop, organiserA);
    const linkB = await shareLinkFor(drop, organiserB);

    await join({ dropId: drop, shareLinkId: linkA, qty: 2 });
    await join({ dropId: drop, shareLinkId: linkB, qty: 3 });

    // Two diners who arrived through a plain link. They have real captured orders, so
    // they are money in the drop — and they belong to no organiser.
    await join({ dropId: drop, shareLinkId: null, qty: 5 });
    await join({ dropId: drop, shareLinkId: null, qty: 7 });

    const statementA = await commissionStatementFor({ organiserProfileId: organiserA, monthKey: '2026-02' });
    const statementB = await commissionStatementFor({ organiserProfileId: organiserB, monthKey: '2026-02' });

    expect(statementA?.totals.units).toBe(2);
    expect(statementB?.totals.units).toBe(3);

    // The null-link diners (12 units, 14400 cents) are in neither.
    for (const statement of [statementA, statementB]) {
      expect(statement?.totals.units).not.toBe(14);
      expect(statement?.totals.grossCapturedCents).not.toBe(14 * DEAL_PRICE);
    }
    expect((statementA?.totals.units ?? 0) + (statementB?.totals.units ?? 0)).toBe(5);
  });
});

describe('verification — the base is net (the gross trap)', () => {
  it('one line, one partial refund and one full refund: gross 4800, refunded 3000, net 1800, commission 90', async () => {
    const organiser = await newOrganiser('base');
    const drop = await newDrop({ status: 'FAILED' });
    const link = await shareLinkFor(drop, organiser);

    // Order 1: captured 2400, refunded 600 — the partial refund of FR-903.
    await join({ dropId: drop, shareLinkId: link, qty: 1, unitPriceCents: 2400, refundedCents: 600 });
    // Order 2: captured 2400, refunded 2400 — force-fail style, nothing kept.
    await join({ dropId: drop, shareLinkId: link, qty: 1, unitPriceCents: 2400, refundedCents: 2400 });

    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-02' });
    expect(statement?.lines).toHaveLength(1);

    const line = statement?.lines[0] as CommissionLineRow;
    expect(line.grossCapturedCents).toBe(4800);
    expect(line.refundedCents).toBe(3000);
    expect(line.netCapturedCents).toBe(1800);
    // 5.00% of 1800. A gross base gives roundHalfUp(4800 × 500 / 10000) = 240.
    expect(line.commissionBasisPoints).toBe(500);
    expect(line.commissionCents).toBe(90);
    // Computed from the same inputs rather than hardcoded, so a change to the formula
    // cannot make this comparison vacuous: this is the number a gross base produces.
    expect(line.commissionCents).not.toBe(commissionCentsFor(4800, 500));
    expect(line.commissionCents).not.toBe(240);
    // And the net is not the gross, which is the same bug stated as a column.
    expect(line.netCapturedCents).not.toBe(line.grossCapturedCents);

    // The total agrees with the line, because the total is the sum of rounded lines.
    expect(statement?.totals.grossCapturedCents).toBe(4800);
    expect(statement?.totals.refundedCents).toBe(3000);
    expect(statement?.totals.netCapturedCents).toBe(1800);
    expect(statement?.totals.commissionCents).toBe(90);

    // AC2 in the same shape at full amplitude: a fully refunded line still shows units.
    expect(line.units).toBe(2);
    expect(line.dropStatus).toBe('FAILED');
  });
});

describe('verification — rounding (the sum-then-round trap)', () => {
  it('AC5: two lines netting 1810 each total 182, and the CSV column adds up to it', async () => {
    const organiser = await newOrganiser('round');

    // Two different drops, so two ShareLinks and therefore two lines. 1810 each:
    // 5% is 90.5, half-up makes each line 91, and 91 + 91 = 182. Rounding the summed
    // base gives roundHalfUp(3620 × 500 / 10000) = 181.
    const firstDrop = await newDrop({ title: 'first drop' });
    const secondDrop = await newDrop({ title: 'second drop' });
    const firstLink = await shareLinkFor(firstDrop, organiser);
    const secondLink = await shareLinkFor(secondDrop, organiser);

    await join({ dropId: firstDrop, shareLinkId: firstLink, qty: 1, unitPriceCents: 1810 });
    await join({ dropId: secondDrop, shareLinkId: secondLink, qty: 1, unitPriceCents: 1810 });

    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-02' });
    expect(statement?.lines).toHaveLength(2);

    const commissions = statement?.lines.map((line) => line.commissionCents).sort((a, b) => a - b);
    expect(commissions).toEqual([91, 91]);

    expect(statement?.totals.netCapturedCents).toBe(3620);
    expect(statement?.totals.commissionCents).toBe(182);
    expect(statement?.totals.commissionCents).not.toBe(181);
    // The sum-then-round answer, computed from the same base rather than hardcoded.
    expect(statement?.totals.commissionCents).not.toBe(
      commissionCentsFor(statement?.totals.netCapturedCents ?? 0, 500),
    );

    // Parse the printed values back: ops pays from this file, and the column a human
    // sums in a spreadsheet must equal the total the screen prints.
    const rows = parseCsvDocument(toCsv(statement?.lines ?? []));
    expect(rows).toHaveLength(3); // header + two lines
    const commissionColumn = COMMISSION_CSV_COLUMNS.indexOf('commission_cents');
    const printedSum = rows
      .slice(1)
      .reduce((sum, row) => sum + Number(row[commissionColumn]), 0);
    expect(printedSum).toBe(182);
    expect(printedSum).toBe(statement?.totals.commissionCents);
  });
});

describe('verification — AC10 privacy (P0)', () => {
  it('carries no E.164 phone, no last four, no email and no customer name — in the rows or the CSV bytes', async () => {
    const organiser = await newOrganiser('privacy');

    // A drop whose title and merchant are also distinctive, so a leak of *any* string
    // from the participant side is separable from the permitted drop metadata.
    const drop = await newDrop({ title: 'privacy probe drop' });
    const link = await shareLinkFor(drop, organiser);

    // Tokens chosen so a match cannot be coincidence. The last four are the part of a
    // phone number a careless `slice(-4)` would surface in a masked column. The digits
    // are derived from the run's prefix, because `Customer.phone` is unique and a
    // hardcoded value makes the test fail on its second run rather than on a defect.
    const digits = Date.now().toString().slice(-6);
    const phone = `+1780${digits}9001`;
    const lastFour = '9001';
    const email = `qa-privacy-probe-${PREFIX}@example.test`;
    const name = 'Zebediah Qatestworthy';

    const customerId = await newIdentifiableCustomer({ phone, email, name });
    await join({ dropId: drop, shareLinkId: link, qty: 2, customerId });

    // The PII really is in the database — otherwise this test proves nothing.
    const stored = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { phone: true, email: true, name: true },
    });
    expect(stored.phone).toBe(phone);
    expect(stored.email).toBe(email);
    expect(stored.name).toBe(name);

    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-02' });
    expect(statement).not.toBeNull();

    const serialisedRows = JSON.stringify(statement?.lines);
    const serialisedTotals = JSON.stringify(statement?.totals);
    const csv = toCsv(statement?.lines ?? []);

    for (const [label, haystack] of [
      ['serialised rows', serialisedRows],
      ['serialised totals', serialisedTotals],
      ['CSV bytes', csv],
    ] as const) {
      expect(haystack, `${label} leaked the phone in E.164`).not.toContain(phone);
      expect(haystack, `${label} leaked the phone last four`).not.toContain(lastFour);
      expect(haystack, `${label} leaked the email`).not.toContain(email);
      expect(haystack, `${label} leaked the customer name`).not.toContain(name);
      // The name split into parts, in case a row carried a first name only.
      expect(haystack, `${label} leaked a name part`).not.toContain('Zebediah');
    }

    // The permitted drop metadata *is* present, which proves the assertions above are
    // not passing because the statement came back empty.
    expect(csv).toContain('privacy probe drop');
  });

  it('carries no Order.id, paymentIntentId, stripeChargeId or redemptionCode in the CSV bytes', async () => {
    const organiser = await newOrganiser('ids');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);

    const { orderId } = await join({ dropId: drop, shareLinkId: link, qty: 2 });

    // Give the order and its participant the identifiers FR-805 forbids leaking.
    const paymentIntentId = `${PREFIX}_pi_probe`;
    const stripeChargeId = `${PREFIX}_ch_probe`;
    const redemptionCode = `${PREFIX}_redeem_probe`;
    await prisma.order.update({
      where: { id: orderId },
      data: { stripeChargeId },
    });
    await prisma.dropParticipant.updateMany({
      where: { dropId: drop },
      data: { paymentIntentId, redemptionCode },
    });

    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-02' });
    const csv = toCsv(statement?.lines ?? []);
    const serialised = JSON.stringify(statement?.lines);

    for (const [label, haystack] of [
      ['CSV bytes', csv],
      ['serialised rows', serialised],
    ] as const) {
      expect(haystack, `${label} leaked Order.id`).not.toContain(orderId);
      expect(haystack, `${label} leaked paymentIntentId`).not.toContain(paymentIntentId);
      expect(haystack, `${label} leaked stripeChargeId`).not.toContain(stripeChargeId);
      expect(haystack, `${label} leaked redemptionCode`).not.toContain(redemptionCode);
    }

    // The row type has no field for them, so the assertion is structural too.
    const rowKeys = Object.keys(statement?.lines[0] ?? {}).sort();
    expect(rowKeys).toEqual([
      'commissionBasisPoints',
      'commissionCents',
      'drop',
      'dropId',
      'dropStatus',
      'grossCapturedCents',
      'merchant',
      'netCapturedCents',
      'pickupDate',
      'refundedCents',
      'units',
    ]);
  });
});

describe('verification — AC12, rendering and exporting write nothing', () => {
  it('leaves Order, LedgerEntry, Drop, AuditLog and ShareLink.clicks unchanged', async () => {
    const organiser = await newOrganiser('nowrite');
    const drop = await newDrop();
    const link = await shareLinkFor(drop, organiser);
    await join({ dropId: drop, shareLinkId: link, qty: 2 });

    // Seed a ledger row so the count is non-zero and a deletion is as visible as an
    // insertion. `AuditLog` is deliberately *not* seeded: this repo's
    // `audit-append-only.test.ts` proves `lib/audit/log.ts` is the only permitted
    // writer, so a test that called `prisma.auditLog.create` would itself be the
    // violation the guard exists to catch — and an audit row cannot be deleted
    // afterwards. The assertion AC12 makes is about *change*, and 0 → 0 is that
    // assertion; a delete path would be caught by the append-only guard instead.
    await prisma.ledgerEntry.create({
      data: { dropId: drop, type: 'CHARGE', amountCents: 2400, note: 'qa probe' },
    });

    async function snapshot() {
      const [orders, ledger, drops, audit, links] = await Promise.all([
        prisma.order.count(),
        prisma.ledgerEntry.count(),
        prisma.drop.count(),
        prisma.auditLog.count(),
        prisma.shareLink.findMany({ select: { id: true, clicks: true }, orderBy: { id: 'asc' } }),
      ]);
      return { orders, ledger, drops, audit, links };
    }

    const before = await snapshot();

    // The render: exactly what the page does.
    const statement = await commissionStatementFor({ organiserProfileId: organiser, monthKey: '2026-02' });
    expect(statement).not.toBeNull();

    // The export: exactly what the route does.
    const csv = toCsv(statement?.lines ?? []);
    expect(csv.length).toBeGreaterThan(0);

    const after = await snapshot();

    expect(after.orders).toBe(before.orders);
    expect(after.ledger).toBe(before.ledger);
    expect(after.drops).toBe(before.drops);
    expect(after.audit).toBe(before.audit);
    // `clicks` is the one mutable column on the path; the statement must not touch it.
    // Reading the *page* would not either — clicks increment in `resolveShareToken`,
    // which is the public drop route, not this one.
    expect(after.links).toEqual(before.links);
  });
});
