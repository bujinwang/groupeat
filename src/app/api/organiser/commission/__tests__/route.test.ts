import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { scopedCounts } from '@/lib/testing/scoped-counts';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';
import { organiserSlug } from '@/lib/organisers/commission';

/**
 * `GET /api/organiser/commission` — FR-804's export, end to end.
 *
 * ## What is mocked and what is not
 *
 * Only `@/lib/auth/authorize`, and only because it imports `server-only`, which throws
 * outside a React Server Component graph — the same note as every other route test in
 * this repo. Everything else is real: the route, `commissionStatementFor`, Prisma and
 * Postgres. So the CSV below is produced by the query the page uses, and the assertion
 * that its column sums equal the statement's totals is an assertion about the real
 * pipeline rather than about a mock's return value.
 *
 * ## What the route's own decisions are
 *
 *   - 401 with no session, 403 for the wrong role, 403 for an ORGANISER whose account
 *     has no profile (a known real state, FR-906 — not a 404, because the endpoint
 *     exists and their account is unfinished);
 *   - `text/csv` with an `attachment` filename that names the organiser and the month,
 *     because the file is the record of what was paid;
 *   - a malformed `?month=` is a **400 on the CSV path** and a reported fallback on the
 *     JSON path. Handing somebody a file labelled `2026-03` while quietly substituting
 *     a different month would corrupt the one artefact that matters;
 *   - an unknown `?format=` is a 400 rather than a silent default, because `?format=CSV`
 *     silently returning JSON is how a script breaks in production and not in a browser.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('@/lib/auth/authorize', async () => {
  const { AppError } = await import('@/lib/errors');
  return {
    requireSession: async (): Promise<MockSession> => {
      if (!sessionState.session) {
        throw AppError.unauthorized();
      }
      return sessionState.session;
    },
    requireRole: (session: MockSession | null, roles: readonly string[]): MockSession => {
      if (!session) {
        throw AppError.unauthorized();
      }
      if (!roles.includes(session.role)) {
        throw AppError.forbidden();
      }
      return session;
    },
  };
});

const PREFIX = `cr${Date.now().toString(36).slice(-5)}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const MARCH = new Date('2026-03-15T18:00:00Z');
const HOUR = 60 * 60 * 1000;

const ROUTE_URL = 'http://localhost/api/organiser/commission';

let merchantId = '';
let itemId = '';
let organiserProfileId = '';
let organiserUserId = '';
let profilelessUserId = '';

const customerIds: string[] = [];

/** RFC 4180 row parsing, so the assertions see what a spreadsheet sees. */
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const char = row.charAt(index);
    if (quoted) {
      if (char === '"' && row.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

async function callRoute(query: string): Promise<Response> {
  const route = await import('@/app/api/organiser/commission/route');
  return route.GET(new NextRequest(`${ROUTE_URL}${query}`, { method: 'GET' }));
}

let customerSeq = 0;

async function joinWithOrder(args: {
  dropId: string;
  shareLinkId: string;
  qty: number;
  unitPriceCents: number;
  capturedAt: Date;
  refundedCents?: number;
}): Promise<void> {
  customerSeq += 1;
  const customer = await prisma.customer.create({
    data: { phone: `+1780557${String(customerSeq).padStart(4, '0')}` },
    select: { id: true },
  });
  customerIds.push(customer.id);

  const refundedCents = args.refundedCents ?? 0;
  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId: customer.id,
      qty: args.qty,
      shareLinkId: args.shareLinkId,
      amountCents: args.qty * args.unitPriceCents,
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
      unitPriceCents: args.unitPriceCents,
      subtotalCents: args.qty * args.unitPriceCents,
      platformFeeCents: 0,
      refundedCents,
      createdAt: args.capturedAt,
    },
  });
}

/** One drop, two orders, one of them partly refunded — the numbers AC1 and AC3 describe. */
async function seedMarch(): Promise<void> {
  const drop = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 2400,
    minQty: 1,
    maxQty: 40,
    status: 'CAPTURED',
    cutoffAt: new Date(Date.now() - 2 * HOUR),
    windowStart: new Date('2026-03-05T19:00:00Z'),
    windowEnd: new Date('2026-03-05T21:00:00Z'),
  });
  const link = await prisma.shareLink.create({
    data: {
      token: randomBytes(16).toString('base64url'),
      dropId: drop,
      merchantId,
      organiserId: organiserProfileId,
    },
    select: { id: true },
  });

  await joinWithOrder({
    dropId: drop,
    shareLinkId: link.id,
    qty: 2,
    unitPriceCents: 2400,
    capturedAt: MARCH,
    refundedCents: 600,
  });
  await joinWithOrder({
    dropId: drop,
    shareLinkId: link.id,
    qty: 1,
    unitPriceCents: 2400,
    capturedAt: MARCH,
  });
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);

  const organiserUser = await prisma.user.create({
    data: {
      email: `${PREFIX}-csv@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  organiserUserId = organiserUser.id;

  const profile = await prisma.organiserProfile.create({
    data: { userId: organiserUserId, displayName: `${PREFIX} Csv Organiser`, commissionPct: 5 },
    select: { id: true },
  });
  organiserProfileId = profile.id;

  // The FR-906 account: signs in, right role, no profile behind it.
  const profileless = await prisma.user.create({
    data: {
      email: `${PREFIX}-bare@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  profilelessUserId = profileless.id;

  await seedMarch();
});

beforeEach(() => {
  sessionState.session = {
    userId: organiserUserId,
    role: 'ORGANISER',
    mustChangePassword: false,
  };
});

afterAll(async () => {
  await prisma.shareLink
    .deleteMany({ where: { organiserId: organiserProfileId } })
    .catch(() => undefined);
  await prisma.organiserProfile
    .deleteMany({ where: { userId: organiserUserId } })
    .catch(() => undefined);
  await prisma.user
    .deleteMany({ where: { id: { in: [organiserUserId, profilelessUserId] } } })
    .catch(() => undefined);
  await fx.cleanup();
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => undefined);
  vi.resetModules();
});

describe('GET /api/organiser/commission — authorisation', () => {
  it('answers 401 with no session', async () => {
    sessionState.session = null;
    const response = await callRoute('?month=2026-03&format=csv');

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.not.toContain('gross_captured_cents');
  });

  it('answers 403 for a role that is not ORGANISER', async () => {
    sessionState.session = { userId: organiserUserId, role: 'MERCHANT', mustChangePassword: false };
    const response = await callRoute('?month=2026-03');

    expect(response.status).toBe(403);
  });

  it('answers 403, not 404, for an organiser whose account has no profile', async () => {
    // The endpoint exists; their account is unfinished. A 404 would tell them the
    // feature does not exist, which is the opposite of the useful answer.
    sessionState.session = { userId: profilelessUserId, role: 'ORGANISER', mustChangePassword: false };
    const response = await callRoute('?month=2026-03');
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(403);
    expect(body.message).toMatch(/organiser profile/i);
  });
});

describe('GET /api/organiser/commission?format=csv', () => {
  it('returns a text/csv attachment named for the organiser and the month', async () => {
    const response = await callRoute('?month=2026-03&format=csv');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="groupeat-commission-${organiserSlug(`${PREFIX} Csv Organiser`)}-2026-03.csv"`,
    );
    // The figure moves when a refund lands; a cached download is a stale record.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('parses to the same numbers the page shows', async () => {
    const { commissionStatementFor } = await import('@/lib/db/commission');
    const statement = await commissionStatementFor({
      organiserProfileId,
      monthKey: '2026-03',
    });

    const response = await callRoute('?month=2026-03&format=csv');
    const rows = (await response.text()).trimEnd().split('\n');
    const header = parseCsvRow(rows[0] ?? '');
    const body = rows.slice(1).map(parseCsvRow);

    const column = (name: string): number => {
      const index = header.indexOf(name);
      expect(index).toBeGreaterThanOrEqual(0);
      return body.reduce((sum, row) => sum + Number(row[index]), 0);
    };

    // The page prints the statement's totals; the file must add up to them.
    expect(body).toHaveLength(statement?.lines.length ?? 0);
    expect(column('gross_captured_cents')).toBe(statement?.totals.grossCapturedCents);
    expect(column('refunded_cents')).toBe(statement?.totals.refundedCents);
    expect(column('net_captured_cents')).toBe(statement?.totals.netCapturedCents);
    expect(column('commission_cents')).toBe(statement?.totals.commissionCents);
    expect(column('units')).toBe(statement?.totals.units);

    // And the actual figures, so the test fails with a number rather than with a
    // comparison of two undefineds: 2 × $24.00 + 1 × $24.00 charged, $6.00 back, 5% of
    // the $66.00 kept.
    expect(column('gross_captured_cents')).toBe(7200);
    expect(column('refunded_cents')).toBe(600);
    expect(column('net_captured_cents')).toBe(6600);
    expect(column('commission_cents')).toBe(330);
    expect(column('units')).toBe(3);
  });

  it('carries no dollar sign and no thousands separator in commission_dollars', async () => {
    const response = await callRoute('?month=2026-03&format=csv');
    const text = await response.text();
    const rows = text.trimEnd().split('\n').map(parseCsvRow);
    const index = rows[0]?.indexOf('commission_dollars') ?? -1;

    expect(index).toBeGreaterThanOrEqual(0);
    expect(text).not.toContain('$');
    for (const row of rows.slice(1)) {
      expect(row[index]).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('is ASCII, so the charset header is a truthful superset', async () => {
    const response = await callRoute('?month=2026-03&format=csv');
    const text = await response.text();
    expect(text).toMatch(/^[\x09\x0A\x0D\x20-\x7E]*$/);
  });

  it('refuses a malformed month instead of exporting a different one', async () => {
    const response = await callRoute('?month=2026-3&format=csv');
    const body = (await response.json()) as { message: string };

    // A file labelled 2026-03 whose figures are a different month's would corrupt the
    // record of what was paid. Nothing is downloaded.
    expect(response.status).toBe(400);
    expect(body.message).toMatch(/YYYY-MM/);
  });

  it('exports the current month when no month is named', async () => {
    const { currentCommissionMonthKey } = await import('@/lib/db/commission');
    const response = await callRoute('?format=csv');
    const header = (await response.text()).split('\n')[0];

    // Header-only is correct here: the fixtures are in 2026-02/03, and "now" is not.
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(
      `-${currentCommissionMonthKey()}.csv`,
    );
    expect(header).toContain('commission_dollars');
  });

  it('emits a header-only file for a month with no activity', async () => {
    const response = await callRoute('?month=2026-02&format=csv');
    const rows = (await response.text()).trimEnd().split('\n');

    // A zero-byte download looks like a failed export.
    expect(response.status).toBe(200);
    expect(rows).toHaveLength(1);
  });
});

describe('GET /api/organiser/commission — JSON', () => {
  it('returns the lines and totals the CSV serialises', async () => {
    const response = await callRoute('?month=2026-03');
    const body = (await response.json()) as {
      month: string;
      lines: { dropId: string; commissionCents: number }[];
      totals: { commissionCents: number; netCapturedCents: number };
      commissionPct: string;
      liveQuery: boolean;
      period: { timeZone: string; from: string; to: string };
    };

    expect(response.status).toBe(200);
    expect(body.month).toBe('2026-03');
    expect(body.commissionPct).toBe('5.00');
    expect(body.totals.commissionCents).toBe(330);
    expect(body.totals.netCapturedCents).toBe(6600);
    expect(body.lines).toHaveLength(1);

    // The statement is recomputed, not frozen — a caller that stores this JSON needs to
    // know that before it becomes a settlement record.
    expect(body.liveQuery).toBe(true);
    expect(body.period.timeZone).toBe('America/Edmonton');
    expect(body.period.from).toBe('2026-03-01T07:00:00.000Z');
    expect(body.period.to).toBe('2026-04-01T06:00:00.000Z');
  });

  it('names the month it ignored rather than answering silently', async () => {
    const { currentCommissionMonthKey } = await import('@/lib/db/commission');
    const response = await callRoute('?month=nonsense');
    const body = (await response.json()) as {
      month: string;
      requestedMonth: string | null;
      monthIgnored: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.month).toBe(currentCommissionMonthKey());
    expect(body.requestedMonth).toBe('nonsense');
    expect(body.monthIgnored).toBe(true);
  });

  it('reports no ignored month when none was asked for', async () => {
    const response = await callRoute('');
    const body = (await response.json()) as { requestedMonth: null; monthIgnored: boolean };

    expect(body.requestedMonth).toBeNull();
    expect(body.monthIgnored).toBe(false);
  });

  it('refuses an unknown format rather than silently choosing one', async () => {
    const response = await callRoute('?month=2026-03&format=CSV');
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(400);
    expect(body.message).toMatch(/format=csv/);
  });

  it('carries no participant PII on the wire either', async () => {
    const response = await callRoute('?month=2026-03');
    const text = await response.text();
    const customer = await prisma.customer.findFirstOrThrow({
      where: { phone: { startsWith: '+1780557' } },
      select: { phone: true },
    });

    expect(text).not.toContain(customer.phone);
    expect(text).not.toContain(customer.phone.slice(-4));
    // No order ids, no participant ids: FR-805 forbids those in any form.
    expect(text).not.toContain('"orderId"');
    expect(text).not.toContain('"participantId"');
  });
});

describe('GET /api/organiser/commission — writes nothing', () => {
  it('AC12: an export and a JSON read leave every table untouched', async () => {
    const counts = async (): Promise<Record<string, number>> => {
      const c = await scopedCounts(prisma, fx.scope(), ['orders', 'ledger', 'drops', 'audits']);
      return { orders: c.orders, ledgerEntries: c.ledger, drops: c.drops, auditLogs: c.audits };
    };

    const before = await counts();
    await callRoute('?month=2026-03&format=csv');
    await callRoute('?month=2026-03');
    expect(await counts()).toEqual(before);
  });
});
