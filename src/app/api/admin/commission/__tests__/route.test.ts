import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';
import { ADMIN_COMMISSION_CSV_COLUMNS } from '@/lib/organisers/commission';

/**
 * `GET /api/admin/commission` — the P1 half of FR-804, end to end.
 *
 * ## What is mocked and what is not
 *
 * Only `@/lib/auth/authorize`, because it imports `server-only`, which throws outside a
 * React Server Component graph — the same note as every route test in this repo.
 * Everything else is real: the route, `adminCommissionRollupFor`,
 * `commissionStatementFor`, Prisma and Postgres.
 *
 * ## What the route's own decisions are
 *
 *   - 401 with no session; 403 for an ORGANISER or MERCHANT session. An organiser must
 *     not be able to read the whole roster: that would show them every other
 *     organiser's earnings, which the spec's privacy boundary rules out alongside diner
 *     PII (it is competitive information, not PII, and still not theirs).
 *   - `format` defaults to JSON, and `?format=CSV` is a 400 rather than a silent
 *     default — a script that asks for a file and quietly gets JSON is a script that
 *     breaks in production and not in a browser.
 *   - A malformed `?month=` is a **400 on the CSV path**. The export is the record of
 *     what was transferred, so a file labelled with a month whose figures are another
 *     month's corrupts the one artefact that matters.
 *   - The file's `commission_cents` column sums to the total row, which is AC5 at the
 *     roster level and the only reason the file is payable from.
 *
 * ## The month
 *
 * 2026-06, which no other suite uses, so the roster's figures are only this file's.
 * Every structural assertion is written against the profile ids created here rather
 * than against `rows.length`, because the roll-up lists every organiser in the
 * database.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('@/lib/auth/authorize', async () => {
  const { AppError } = await import('@/lib/errors');
  return {
    requireAdmin: async (): Promise<MockSession> => {
      if (!sessionState.session) {
        throw AppError.unauthorized();
      }
      if (sessionState.session.role !== 'ADMIN') {
        throw AppError.forbidden();
      }
      return sessionState.session;
    },
  };
});

const PREFIX = `acr${Date.now().toString(36).slice(-5)}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const MONTH = '2026-06';
const CAPTURED_AT = new Date('2026-06-15T18:00:00Z');
const DEAL_PRICE = 1200;
const HOUR = 60 * 60 * 1000;

const ROUTE_URL = 'http://localhost/api/admin/commission';

let merchantId = '';
let itemId = '';
let adminUserId = '';

const organiserProfileIds: string[] = [];
const organiserUserIds: string[] = [];
const customerIds: string[] = [];

let customerSeq = 0;

async function newOrganiser(tag: string, commissionPct = 5): Promise<string> {
  organiserUserIds.push('');
  const index = organiserUserIds.length - 1;

  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  organiserUserIds[index] = user.id;

  const profile = await prisma.organiserProfile.create({
    data: { userId: user.id, displayName: `${PREFIX} ${tag}`, commissionPct },
    select: { id: true },
  });
  organiserProfileIds.push(profile.id);
  return profile.id;
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
    windowStart: new Date('2026-06-18T19:00:00Z'),
    windowEnd: new Date('2026-06-18T21:00:00Z'),
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
  shareLinkId: string;
  qty: number;
  capturedAt?: Date;
}): Promise<void> {
  customerSeq += 1;
  const customer = await prisma.customer.create({
    data: { phone: `+1780559${String(customerSeq).padStart(4, '0')}` },
    select: { id: true },
  });
  customerIds.push(customer.id);

  const subtotalCents = args.qty * DEAL_PRICE;

  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId: customer.id,
      qty: args.qty,
      shareLinkId: args.shareLinkId,
      amountCents: subtotalCents,
      platformFeeCents: 0,
      authStatus: 'AUTHORIZED',
      chargeStatus: 'CAPTURED',
    },
    select: { id: true },
  });

  await prisma.order.create({
    data: {
      dropId: args.dropId,
      participantId: participant.id,
      qty: args.qty,
      unitPriceCents: DEAL_PRICE,
      subtotalCents,
      platformFeeCents: 0,
      refundedCents: 0,
      createdAt: args.capturedAt ?? CAPTURED_AT,
    },
    select: { id: true },
  });
}

function get(query: string): Promise<Response> {
  return route(new NextRequest(`${ROUTE_URL}${query}`));
}

// Imported after the mock factory is declared, so `vi.mock` applies.
const { GET: route } = await import('../route');

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);

  const admin = await prisma.user.create({
    data: {
      email: `${PREFIX}-admin@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ADMIN',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  adminUserId = admin.id;

  // One organiser with activity, in the month under test.
  const alice = await newOrganiser('alice', 5);
  const drop = await newDrop();
  const link = await shareLinkFor(drop, alice);
  await join({ dropId: drop, shareLinkId: link, qty: 2 });

  // A second organiser with nothing at all, so the roster's "zero" row is exercised
  // through the route as well as through the query.
  await newOrganiser('quiet', 6);
});

beforeEach(() => {
  sessionState.session = { userId: adminUserId, role: 'ADMIN', mustChangePassword: false };
});

afterAll(async () => {
  await prisma.shareLink
    .deleteMany({ where: { organiserId: { in: organiserProfileIds } } })
    .catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: organiserUserIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: adminUserId } }).catch(() => undefined);
  await fx.cleanup();
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => undefined);
});

describe('GET /api/admin/commission — authorisation', () => {
  it('is 401 with no session', async () => {
    sessionState.session = null;
    expect((await get(`?month=${MONTH}`)).status).toBe(401);
  });

  it('refuses an ORGANISER, so one organiser cannot read the whole roster', async () => {
    // 403, not a filtered 200: this endpoint is the roster. An organiser reading it
    // would see every other organiser's earnings, which the spec rules out for the same
    // competitive reasons it rules out drop-level totals.
    sessionState.session = {
      userId: organiserUserIds[0] ?? 'x',
      role: 'ORGANISER',
      mustChangePassword: false,
    };
    expect((await get(`?month=${MONTH}`)).status).toBe(403);
  });

  it('refuses a MERCHANT', async () => {
    sessionState.session = { userId: 'merchant-user', role: 'MERCHANT', mustChangePassword: false };
    expect((await get(`?month=${MONTH}`)).status).toBe(403);
  });
});

describe('GET /api/admin/commission — the JSON view', () => {
  it('lists every organiser, with email, rate and figure', async () => {
    const response = await get(`?month=${MONTH}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      month: string;
      organisers: {
        organiserProfileId: string;
        organiserName: string;
        organiserEmail: string;
        commissionPct: string;
        lineCount: number;
        totals: { units: number; commissionCents: number };
      }[];
      totals: { commissionCents: number };
      liveQuery: boolean;
    };

    expect(body.month).toBe(MONTH);
    expect(body.liveQuery).toBe(true);

    const alice = body.organisers.find((row) => row.organiserProfileId === organiserProfileIds[0]);
    expect(alice).toBeDefined();
    // 2 × $12.00 = 2400 @ 5% = 120.
    expect(alice?.totals.units).toBe(2);
    expect(alice?.totals.commissionCents).toBe(120);
    expect(alice?.commissionPct).toBe('5.00');
    expect(alice?.organiserEmail).toBe(`${PREFIX}-alice@example.test`);

    // The zero-activity organiser is present rather than omitted.
    const quiet = body.organisers.find((row) => row.organiserProfileId === organiserProfileIds[1]);
    expect(quiet).toBeDefined();
    expect(quiet?.lineCount).toBe(0);
    expect(quiet?.totals.commissionCents).toBe(0);
  });

  it('does not leak per-line rows into the JSON, because that is the CSV grain', async () => {
    const response = await get(`?month=${MONTH}`);
    const body = (await response.json()) as { organisers: Record<string, unknown>[] };
    for (const row of body.organisers) {
      expect(row).not.toHaveProperty('lines');
    }
  });

  it('falls back to the current month and says so, rather than erroring', async () => {
    const response = await get('?month=nonsense');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      month: string;
      requestedMonth: string | null;
      monthIgnored: boolean;
    };
    expect(body.requestedMonth).toBe('nonsense');
    expect(body.monthIgnored).toBe(true);
    // A month we can read, chosen for them — the JSON path is inspectable, so a
    // fallback here is visible rather than silent.
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('rejects an unknown format instead of silently defaulting', async () => {
    const response = await get(`?month=${MONTH}&format=CSV`);
    expect(response.status).toBe(400);
  });
});

describe('GET /api/admin/commission — the CSV', () => {
  it('serves a downloadable file named for the month', async () => {
    const response = await get(`?month=${MONTH}&format=csv`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="groupeat-commission-all-${MONTH}.csv"`,
    );
    // The figure moves when a refund lands; a cached copy is a stale payment record.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('writes the declared header and one row per line, with a TOTAL row', async () => {
    const response = await get(`?month=${MONTH}&format=csv`);
    const csv = await response.text();
    const lines = csv.trimEnd().split('\n');

    expect(lines[0]).toBe(ADMIN_COMMISSION_CSV_COLUMNS.join(','));
    // Alice has one drop; the quiet organiser contributes no line, so one data row.
    expect(lines).toHaveLength(3);
    expect(lines[lines.length - 1]?.startsWith('TOTAL,')).toBe(true);
  });

  it('has a commission_cents column that sums to the printed total', async () => {
    // AC5 at the roster level, and the only reason this file is payable from: the
    // number the operator reads must equal what a spreadsheet gives them.
    const response = await get(`?month=${MONTH}&format=csv`);
    const csv = await response.text();
    const lines = csv.trimEnd().split('\n');

    const commissionIndex = ADMIN_COMMISSION_CSV_COLUMNS.indexOf('commission_cents');
    const dataRows = lines.slice(1, -1);
    const summed = dataRows.reduce(
      (total, row) => total + Number(row.split(',')[commissionIndex]),
      0,
    );
    const printed = Number(lines[lines.length - 1]?.split(',')[commissionIndex]);

    expect(printed).toBe(summed);
    // And it agrees with the JSON, which is the same roll-up object.
    const json = (await (await get(`?month=${MONTH}`)).json()) as {
      totals: { commissionCents: number };
    };
    expect(printed).toBe(json.totals.commissionCents);
  });

  it('carries each organiser email, and no diner phone number', async () => {
    const csv = await (await get(`?month=${MONTH}&format=csv`)).text();
    expect(csv).toContain(`${PREFIX}-alice@example.test`);
    // The fixture's diners all have +1780559xxxx numbers. FR-805 protects diners; an
    // organiser's own email is the counterparty detail the operator pays to.
    expect(csv).not.toMatch(/\+1780\d{7}/);
  });

  it('is 400 on a malformed month, and downloads nothing', async () => {
    const response = await get('?month=nonsense&format=csv');
    expect(response.status).toBe(400);
    // A `content-disposition` here would mean a file was offered despite the refusal.
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('writes no rows — a download is not an event', async () => {
    // AC12 at this level: no payout row, no audit entry, nothing advanced.
    const before = {
      orders: await prisma.order.count(),
      participants: await prisma.dropParticipant.count(),
      audit: await prisma.auditLog.count(),
    };

    await get(`?month=${MONTH}&format=csv`);
    await get(`?month=${MONTH}`);

    expect(await prisma.order.count()).toBe(before.orders);
    expect(await prisma.dropParticipant.count()).toBe(before.participants);
    expect(await prisma.auditLog.count()).toBe(before.audit);
  });
});
