import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/commission` rendered — gap 12(f), against real Postgres.
 *
 * ## Why a page test exists when the query already has 30
 *
 * `src/lib/db/__tests__/commission.test.ts` proves the arithmetic. None of it proves
 * that a human opening `/commission` sees the arithmetic. Between the two there is the
 * page: which branch it takes, what the month selector links to, and the one paragraph
 * that carries a decision the database cannot express.
 *
 * The paragraph is the reason this file matters most. There is no `CommissionPayout`
 * table, so the statement recomputes on every open and **a refund landing in April
 * restates March**. The consequence — someone pays from a stale export and never
 * notices they overpaid — is not prevented by any assertion in the query test, because
 * the query is correct either way. It is prevented by four sentences of copy on the
 * page, and until now nothing in this repo had ever confirmed those sentences reach a
 * screen. `docs/PROGRESS.md` gap 12(f) is exactly that admission.
 *
 * ## How a page is rendered without a browser
 *
 * The page is an `async` function returning an element tree. Calling it and serialising
 * the tree runs every branch, executes the real queries, and produces the HTML a
 * browser receives as its initial payload. `src/lib/testing/render.ts` holds the
 * mechanics and states the boundary — client components are not hydrated, so this
 * proves what *renders*, not what *responds*.
 *
 * ## What is mocked, and what that leaves real
 *
 * Two modules, both for the same reason as every other test here: `server-only` throws
 * outside a React Server Component graph, and `@/lib/auth/session` reads a cookie jar
 * that does not exist. Everything else is real — including `@/lib/auth/authorize`,
 * which means the CSV assertions below go through the genuine `requireSession` and
 * `requireRole` gates rather than a stand-in.
 *
 * ## The numbers are chosen so that "sum of rounded lines" and "rate × total" differ
 *
 * Both March drops net **2152 cents**. Five percent is 107.6, which rounds to **108**,
 * so the month totals 216 and the page prints **$2.16**. An implementation that
 * applied 5% to the month's net (4304 cents → 215.2 → **215**) would print **$2.15**.
 * That one-cent gap is the AC5 property — the property that makes the exported
 * `commission_cents` column add up to the payable figure — and it is asserted here on
 * the *page*, tieing the printed total to the file the page offers. With round prices
 * (1200, 2400) the two implementations agree and the assertion would prove nothing.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { settlementFixtures } = await import('@/lib/settlement/__tests__/settlement-fixtures');
const { currentCommissionMonthKey } = await import('@/lib/db/commission');
const { COMMISSION_CSV_COLUMNS } = await import('@/lib/organisers/commission');

const PREFIX = `cp${Date.now().toString(36).slice(-5)}`;
const fx = settlementFixtures(PREFIX);

const HOUR = 60 * 60 * 1000;
const DEAL_PRICE = 1200;
const NINETY_PERCENT = 248;

/** 2026-03-10 12:00 MDT and 2026-03-12 12:00 MDT — both unambiguously March. */
const MARCH_FIRST = new Date('2026-03-10T18:00:00Z');
const MARCH_SECOND = new Date('2026-03-12T18:00:00Z');
/** 2026-02-10 11:00 MST. Only here so the month selector has two months to offer. */
const FEBRUARY = new Date('2026-02-10T18:00:00Z');

let merchantId = '';
let itemId = '';
let organiserUserId = '';
let organiserProfileId = '';
/** An `ORGANISER` with no `OrganiserProfile` — FR-906's known, real state. */
let profilelessUserId = '';

const customerIds: string[] = [];
let customerSeq = 0;

/** A diner whose phone, email and name are really in the database. FR-805's subject. */
const PRIVATE_NAME = 'Marguerite Okonkwo';
const PRIVATE_EMAIL = `${PREFIX}-private@diner.test`;
const PRIVATE_PHONE_SUFFIX = '3947';

async function newCustomer(): Promise<string> {
  customerSeq += 1;
  const customer = await prisma.customer.create({
    data: {
      // Random, because a phone number left behind by a previous run must not collide
      // with this one: `Customer.phone` is unique and the suite runs against a shared
      // database.
      phone: `+1780${randomBytes(5).toString('hex')}${customerSeq}`,
      email: PRIVATE_EMAIL,
      name: PRIVATE_NAME,
    },
    select: { id: true },
  });
  customerIds.push(customer.id);
  return customer.id;
}

/**
 * A captured order, exactly as capture writes one.
 *
 * `subtotalCents` is copied from the participant rather than recomputed, and
 * `refundedCents` is the cumulative column — the statement's base is
 * `subtotalCents − refundedCents`, so a fixture that only sets the first would describe
 * a month with no refunds and the `—` assertions below would be untested.
 */
async function join(args: {
  dropId: string;
  shareLinkId: string;
  qty: number;
  capturedAt: Date;
  refundedCents?: number;
}): Promise<void> {
  const refundedCents = args.refundedCents ?? 0;
  const subtotalCents = args.qty * DEAL_PRICE;

  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId: await newCustomer(),
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
      unitPriceCents: DEAL_PRICE,
      subtotalCents,
      platformFeeCents: 0,
      refundedCents,
      createdAt: args.capturedAt,
    },
  });
}

/** A captured drop with a pickup window a day after `windowStart`. */
async function newDrop(windowStart: Date): Promise<string> {
  return fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    maxQty: 200,
    status: 'CAPTURED',
    cutoffAt: new Date(Date.now() - 2 * HOUR),
    windowStart,
    windowEnd: new Date(windowStart.getTime() + 2 * HOUR),
  });
}

async function shareLinkFor(dropId: string): Promise<string> {
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

let marchDropA = '';
let marchDropB = '';

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);

  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-sam@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  organiserUserId = user.id;

  const profile = await prisma.organiserProfile.create({
    data: { userId: user.id, displayName: `${PREFIX} Sam`, commissionPct: 5 },
    select: { id: true },
  });
  organiserProfileId = profile.id;

  // FR-906: an account that signs in as an organiser and has nothing behind it.
  const profileless = await prisma.user.create({
    data: {
      email: `${PREFIX}-unfinished@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  profilelessUserId = profileless.id;

  // Two March drops, each netting 2152 — see the docblock on why the price and the
  // refund are these numbers and not round ones.
  marchDropA = await newDrop(new Date('2026-03-11T19:00:00Z'));
  marchDropB = await newDrop(new Date('2026-03-13T19:00:00Z'));
  await join({
    dropId: marchDropA,
    shareLinkId: await shareLinkFor(marchDropA),
    qty: 2,
    capturedAt: MARCH_FIRST,
    refundedCents: NINETY_PERCENT,
  });
  await join({
    dropId: marchDropB,
    shareLinkId: await shareLinkFor(marchDropB),
    qty: 2,
    capturedAt: MARCH_SECOND,
    refundedCents: NINETY_PERCENT,
  });

  // February exists only so the selector has a second real month. One line, unreduced,
  // so a test that accidentally reads February's figures would see different numbers.
  const februaryDrop = await newDrop(new Date('2026-02-11T19:00:00Z'));
  await join({
    dropId: februaryDrop,
    shareLinkId: await shareLinkFor(februaryDrop),
    qty: 3,
    capturedAt: FEBRUARY,
  });

  sessionState.session = { userId: organiserUserId, role: 'ORGANISER', mustChangePassword: false };
});

afterAll(async () => {
  // `ShareLink` has no cascade from `OrganiserProfile`, so it goes first.
  await prisma.shareLink.deleteMany({ where: { organiserId: organiserProfileId } }).catch(() => undefined);
  await prisma.user
    .deleteMany({ where: { id: { in: [organiserUserId, profilelessUserId] } } })
    .catch(() => undefined);
  // Drops cascade participants and orders.
  await fx.cleanup();
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => undefined);
});

/** Render the real page with the given `searchParams`. */
async function render(params: { month?: string | string[] }): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(organiser)/commission/page');
  const html = await renderToHtml(
    await page.default({ searchParams: Promise.resolve(params) }),
  );
  return { html, text: textOf(html) };
}

describe('/commission — the month being viewed', () => {
  it('renders March’s two drops, with the footer the lines add up to', async () => {
    const { text } = await render({ month: '2026-03' });

    // The heading names the month, so a wrong month is visible rather than plausible.
    expect(text).toContain('2026-03 · what you earned');
    // Two rows, not one: the statement groups by `ShareLink`, and each drop has its own.
    expect(text).toContain('2 drops');

    // Both drop titles render, which is what proves the query ran and the rows are the
    // organiser's own.
    expect(text).toContain(`${PREFIX} drop`);
    // Charged, refunded, kept and commission, per line and in the footer.
    for (const amount of ['$24.00', '$2.48', '$21.52', '$2.16']) {
      expect(text).toContain(amount);
    }
    // The footer restates the rate the figures were computed at.
    expect(text).toContain('Total (5.00%)');
    // Units: 2 + 2.
    expect(text).toContain('Total (5.00%) 4');
  });

  it('prints the summed-line total in both the headline and the footer', async () => {
    const { text } = await render({ month: '2026-03' });

    // Twice, and only twice: once as the headline figure and once in the footer's
    // Commission column. Asserting "appears" is not enough here — a page whose footer
    // agrees with its lines but whose headline applies the rate to the month's net
    // still contains `$2.16`, and one whose footer sums gross still contains the
    // per-line `$21.52`. Probed: with the headline changed to
    // `net × rate` the earlier assertions all passed, and so did they with the
    // footer's Kept column changed to gross. Counting is what closes both.
    expect(countOf(text, '$2.16')).toBe(2);
    // 4304 × 5% = 215.2 → 215. The one-number implementation's headline.
    expect(text).not.toContain('$2.15');
    // The Kept column: per line 2152, footer 4304. Once, so a footer that summed gross
    // instead ($48.00) is the only way this count reaches zero.
    expect(countOf(text, '$43.04')).toBe(1);
    // And the Refunded column: per line 248, footer 496.
    expect(countOf(text, '$4.96')).toBe(1);
    // `$48.00` is *expected* here and is not a defect — it is the footer's Charged
    // column, 2400 + 2400. Asserted positively so nobody "fixes" the page to hide it.
    expect(countOf(text, '$48.00')).toBe(1);
  });

  it('does not offer a month after the current one', async () => {
    const current = currentCommissionMonthKey();
    const { html } = await render({});

    expect(hrefsOf(html)).toContain(`/commission?month=${current}`);
    // A future month is always empty, so a "next" link to one invites the organiser to
    // conclude their commission was cancelled.
    const [year, month] = current.split('-').map(Number) as [number, number];
    const nextKey = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}`;
    expect(hrefsOf(html)).not.toContain(`/commission?month=${nextKey}`);
  });

  it('steps back and forward with the month in the query string', async () => {
    const { html } = await render({ month: '2026-03' });
    const hrefs = hrefsOf(html);

    expect(hrefs).toContain('/commission?month=2026-02');
    expect(hrefs).toContain('/commission?month=2026-04');
    // The month being viewed is always in the selector, so it is always linkable back.
    expect(hrefs).toContain('/commission?month=2026-03');
    // And the months with real activity are the ones offered.
    expect(hrefs).toContain('/commission?month=2026-02');
  });
});

describe('/commission — the restatement sentence', () => {
  it('says the figures are live, in words, above the table', async () => {
    const { html, text } = await render({ month: '2026-03' });

    // The whole sentence, because the point is that a reader cannot mis-take it for a
    // frozen invoice. Asserting "current as of right now" alone would pass on a page
    // that said "not current as of right now".
    expect(text).toContain(
      'These figures are current as of right now, not a frozen invoice.',
    );
    // The consequence, named: a late refund moves an already-paid month.
    expect(text).toContain('if you re-open March after an April refund, March is smaller');
    // And what the record actually is.
    expect(text).toContain('that download is the record of what was transferred');

    // Above the table: someone reading the numbers cannot get past it first. It sits
    // under the headline figure by design — the figure is what they came for, and a
    // caveat they scroll past is a caveat that was not read.
    const sentenceAt = html.indexOf('current as of right now');
    const tableAt = html.indexOf('<table');
    expect(sentenceAt).toBeGreaterThan(-1);
    expect(tableAt).toBeGreaterThan(-1);
    expect(sentenceAt).toBeLessThan(tableAt);
  });
});

describe('/commission — a month with no activity', () => {
  it('says so in a sentence rather than rendering an empty table', async () => {
    const { html, text } = await render({ month: '2026-05' });

    expect(text).toContain('Nothing was charged on your links in 2026-05.');
    // The distinction matters: an empty table looks like a rendering failure, and a
    // sentence explains why the number is zero.
    expect(text).toContain('a drop that failed pays nothing');
    expect(html).not.toContain('<table');
    // Still the month that was asked for, and still downloadable — an empty export is
    // a legitimate answer and a missing link would look like a broken page.
    expect(text).toContain('2026-05 · what you earned');
    expect(hrefsOf(html)).toContain('/api/organiser/commission?month=2026-05&format=csv');
    expect(text).toContain('$0.00');
  });

  it('still offers the empty month in the selector it was reached from', async () => {
    const { html } = await render({ month: '2026-05' });
    // A link to an empty month must show the empty month it names, not silently jump
    // to the nearest month that has activity.
    expect(hrefsOf(html)).toContain('/commission?month=2026-05');
  });
});

describe('/commission — an unreadable ?month=', () => {
  it('names the month it could not read instead of silently showing another', async () => {
    const current = currentCommissionMonthKey();
    const { text } = await render({ month: 'nonsense' });

    expect(text).toContain(
      `That month was not a month we can read (nonsense), so this is ${current}.`,
    );
  });

  it('treats a repeated ?month= as unreadable, not as absent', async () => {
    const current = currentCommissionMonthKey();
    const { text } = await render({ month: ['2026-03', '2026-04'] });

    // The variant that broke. Absent means "the current month", which is the right
    // answer to a question nobody asked — so an array must not be normalised into it,
    // or the organiser gets a figure with no note attached.
    expect(text).toContain(
      `That month was not a month we can read (2026-03,2026-04), so this is ${current}.`,
    );
    // And it did not quietly answer about March, which is what a first-element-wins
    // implementation would have done.
    expect(text).not.toContain('2026-03 · what you earned');
  });

  it('names a malformed month that is nearly valid', async () => {
    const current = currentCommissionMonthKey();
    // `2026-3` is the shape a hand-edited URL takes, and the one a lenient parser
    // accepts.
    const { text } = await render({ month: '2026-3' });
    expect(text).toContain(
      `That month was not a month we can read (2026-3), so this is ${current}.`,
    );
  });
});

describe('/commission — the CSV the page offers', () => {
  it('links the download to the month being viewed', async () => {
    const { html, text } = await render({ month: '2026-03' });

    expect(hrefsOf(html)).toContain('/api/organiser/commission?month=2026-03&format=csv');
    expect(text).toContain('Download 2026-03 as CSV');
    // `download` is what makes "exportable" true in a browser rather than a page of
    // text; a server component cannot set `Content-Disposition`.
    expect(html).toContain('download');
  });

  it('produces a file whose commission column sums to the total the page printed', async () => {
    const { text } = await render({ month: '2026-03' });

    const route = await import('@/app/api/organiser/commission/route');
    const response = await route.GET(
      new NextRequest('http://localhost/api/organiser/commission?month=2026-03&format=csv'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const rows = (await response.text()).trim().split('\n');
    const header = (rows[0] ?? '').split(',');
    const column = header.indexOf('commission_cents');
    expect(column).toBeGreaterThan(-1);
    expect(header).toEqual([...COMMISSION_CSV_COLUMNS]);

    const total = rows
      .slice(1)
      .reduce((sum, row) => sum + Number(row.split(',')[column] ?? '0'), 0);

    // 108 + 108. The page printed $2.16 above.
    expect(total).toBe(216);
    expect(text).toContain('$2.16');
    // What applying the rate to the month's net would have produced: 4304 × 5% = 215.2
    // → 215 → $2.15. If the file and the screen ever disagree by a cent, this is the
    // line that says which one moved.
    expect(total).not.toBe(215);
  });
});

describe('/commission — FR-805', () => {
  it('carries no diner phone, email or name onto the screen', async () => {
    const { html, text } = await render({ month: '2026-03' });

    // The diners in these fixtures really do have all three in the database, so the
    // absence below is not the absence of data.
    expect(text).toContain('2 drops');
    for (const secret of [PRIVATE_NAME, PRIVATE_EMAIL, PRIVATE_PHONE_SUFFIX]) {
      expect(html).not.toContain(secret);
    }
    // And the page says what an organiser does not see, because "you see your own
    // totals only" is the part they would otherwise have to guess.
    expect(text).toContain('never who joined, never their phone number');
  });
});

describe('/commission — an organiser with no profile (FR-906)', () => {
  it('prints a sentence they can act on, not an error page', async () => {
    const previous = sessionState.session;
    sessionState.session = {
      userId: profilelessUserId,
      role: 'ORGANISER',
      mustChangePassword: false,
    };

    try {
      const { html, text } = await render({ month: '2026-03' });

      expect(text).toContain('Your account is not finished setting up');
      // It must say whose problem it is: the organiser cannot create their own profile.
      expect(text).toContain('Ask the team to complete it');
      expect(text).toContain('there is nothing you need to do');
      // Not a statement, and not a download: there is no rate to compute with.
      expect(html).not.toContain('<table');
      expect(hrefsOf(html)).not.toContain('/api/organiser/commission?month=2026-03&format=csv');
    } finally {
      sessionState.session = previous;
    }
  });
});

describe('/commission — nothing writes', () => {
  it('renders a month without changing a single row', async () => {
    const before = await writeCounts();
    await render({ month: '2026-03' });
    await render({ month: 'nonsense' });
    const after = await writeCounts();

    expect(after).toEqual(before);
  });
});

/** Global counts, which is safe here: the suite runs one file at a time. */
async function writeCounts(): Promise<Record<string, number>> {
  const [orders, drops, participants, shareLinks, auditLogs] = await Promise.all([
    prisma.order.count(),
    prisma.drop.count(),
    prisma.dropParticipant.count(),
    prisma.shareLink.count(),
    prisma.auditLog.count(),
  ]);
  return { orders, drops, participants, shareLinks, auditLogs };
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
