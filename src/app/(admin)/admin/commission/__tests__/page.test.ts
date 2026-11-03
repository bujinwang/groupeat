import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/admin/commission` rendered — gap 12(g), against real Postgres.
 *
 * ## What this screen is, and why it needed rendering rather than more query tests
 *
 * The route and the roll-up already have 26 tests. None of them sees the page, and the
 * page is where the operator decides the numbers are right before paying from the file
 * it exports. Three things on it exist only as JSX, and each has a plausible wrong
 * version that passes type checking:
 *
 *   1. **The live-not-frozen paragraph.** Same decision as the organiser page, higher
 *      stakes: the operator is about to move money from this list. If a refund lands
 *      between the download and the transfer, the file they hold is stale.
 *   2. **`no activity` and a dash rather than `$0.00`.** The page's own argument is that
 *      `$0.00` reads as "computed, and it is zero" while an organiser with no lines has
 *      nothing attributed at all — the difference between "nothing to pay" and
 *      "attribution may be broken".
 *   3. **`2 to pay, 39 with nothing this month`.** Counts derived on the page from the
 *      roster, and the sentence beside them explains why a name could be missing.
 *
 * ## The roster is global, so the assertions are written against its own arithmetic
 *
 * `adminCommissionRollupFor` lists **every** organiser profile in the database, because
 * that is what the operator needs: a roster of 5–15 people, and a question of "did I miss
 * anyone". A test file cannot make the database contain only its own fixtures, so:
 *
 *   - counts and totals are compared against the rendered table's own row count, not
 *     against this file's three fixtures;
 *   - the equivalent `$0.00` is asserted **absent**, which is the claim that survives any
 *     roster size and is exactly the one the page's comment defends;
 *   - the equivalence test compares two pages rendered against the same database, so the
 *     noise cancels.
 *
 * The month is **2026-07**, used by nothing else in the suite, so every non-zero figure
 * on the page belongs to this file.
 *
 * ## What is mocked
 *
 * `server-only` and `@/lib/auth/session`, for the two reasons every test in this repo
 * states: the first throws outside a React Server Component graph, the second reads a
 * cookie jar that does not exist here. `@/lib/auth/authorize` is **real**, so the JSON and
 * CSV assertions go through the genuine `requireAdmin` gate — a MERCHANT session reaching
 * this endpoint is refused by the shipped code, not by a stand-in.
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
const { ADMIN_COMMISSION_CSV_COLUMNS } = await import('@/lib/organisers/commission');

const PREFIX = `acp${Date.now().toString(36).slice(-5)}`;
const fx = settlementFixtures(PREFIX);

const HOUR = 60 * 60 * 1000;
/**
 * 625 cents, chosen so that **two arithmetic implementations print different totals**.
 *
 * At 5%, a 1250-cent line earns exactly 62.5 cents, which rounds to 63. Two such lines
 * sum to 126; applying the rate once to the 2500-cent month gives exactly 125. The page
 * must print 126, because the file it exports must add up to what a human sums by hand.
 *
 * This is the fixture lesson from the `/commission` slice, unlearned once and taught
 * again here: with round prices the two implementations agree and every "the admin figure
 * is the organiser's figure" assertion becomes a coincidence. Probe M below is the proof
 * that it now discriminates.
 */
const DEAL_PRICE = 625;
const MONTH = '2026-07';

let merchantId = '';
let itemId = '';
let adminUserId = '';
let merchantUserId = '';

/** The two organisers with activity. The third, `idle`, needs only to exist. */
let adaProfileId = '';
let boProfileId = '';
const organiserUserIds: string[] = [];
const organiserProfileIds: string[] = [];
const customerIds: string[] = [];

let customerSeq = 0;

async function newOrganiser(tag: string, commissionPct: number): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}@example.test`,
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

/**
 * One captured drop for one organiser, optionally with a partial refund.
 *
 * Phones are random rather than sequential: `Customer.phone` is unique and this suite
 * runs against a shared database, so a number left behind by an earlier run must not
 * collide with this one.
 */
async function capturedDrop(args: {
  organiserProfileId: string;
  qty: number;
  capturedAt: string;
  refundedCents?: number;
}): Promise<void> {
  const refundedCents = args.refundedCents ?? 0;
  const subtotalCents = args.qty * DEAL_PRICE;

  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    maxQty: 200,
    status: 'CAPTURED',
    cutoffAt: new Date(Date.now() - 2 * HOUR),
    windowStart: new Date('2026-07-05T19:00:00Z'),
    windowEnd: new Date('2026-07-05T21:00:00Z'),
  });

  const link = await prisma.shareLink.create({
    data: {
      token: randomBytes(16).toString('base64url'),
      dropId,
      merchantId,
      organiserId: args.organiserProfileId,
    },
    select: { id: true },
  });

  customerSeq += 1;
  const customer = await prisma.customer.create({
    data: { phone: `+1780${randomBytes(5).toString('hex')}${customerSeq}` },
    select: { id: true },
  });
  customerIds.push(customer.id);

  const participant = await prisma.dropParticipant.create({
    data: {
      dropId,
      customerId: customer.id,
      qty: args.qty,
      shareLinkId: link.id,
      amountCents: subtotalCents,
      platformFeeCents: 0,
      authStatus: 'AUTHORIZED',
      chargeStatus: refundedCents > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED',
    },
    select: { id: true },
  });

  await prisma.order.create({
    data: {
      dropId,
      participantId: participant.id,
      qty: args.qty,
      unitPriceCents: DEAL_PRICE,
      subtotalCents,
      platformFeeCents: 0,
      refundedCents,
      createdAt: new Date(args.capturedAt),
    },
  });
}

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

  // A MERCHANT account, only so the 403 test has a real session to be refused with.
  const merchantUser = await prisma.user.create({
    data: {
      email: `${PREFIX}-merchant@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  merchantUserId = merchantUser.id;

  adaProfileId = await newOrganiser('ada', 5);
  boProfileId = await newOrganiser('bo', 7.5);
  // No drops behind this one, and no variable holding its id: `newOrganiser` already
  // pushes it into `organiserProfileIds` for cleanup, and nothing here needs to name it.
  await newOrganiser('idle', 5);

  // Ada: two drops that each net 1250 cents. One is 2 units untouched; the other is 3
  // units with one unit refunded. Each earns 62.5 → 63, so her month is 126 — and the
  // rate applied to the month's 2500 net is 125. The difference between those two
  // numbers is what makes every assertion below load-bearing.
  await capturedDrop({ organiserProfileId: adaProfileId, qty: 2, capturedAt: '2026-07-10T18:00:00Z' });
  await capturedDrop({
    organiserProfileId: adaProfileId,
    qty: 3,
    capturedAt: '2026-07-12T18:00:00Z',
    refundedCents: 625,
  });
  // Bo: one drop, 2 units at 7.5% → 93.75 → 94. Also not a round cent, and the
  // single-line control: his figures must agree under either implementation.
  await capturedDrop({ organiserProfileId: boProfileId, qty: 2, capturedAt: '2026-07-11T18:00:00Z' });

  // The month is deliberately the one the page defaults to, so the "current month"
  // assertions and the figure assertions are about the same render.
  expect(currentCommissionMonthKey()).not.toBe(MONTH);

  sessionState.session = { userId: adminUserId, role: 'ADMIN', mustChangePassword: false };
});

afterAll(async () => {
  await prisma.shareLink
    .deleteMany({ where: { organiserId: { in: organiserProfileIds } } })
    .catch(() => undefined);
  await prisma.user
    .deleteMany({ where: { id: { in: [...organiserUserIds, adminUserId, merchantUserId] } } })
    .catch(() => undefined);
  await fx.cleanup();
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => undefined);
});

async function render(params: { month?: string | string[] }): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(admin)/admin/commission/page');
  const html = await renderToHtml(await page.default({ searchParams: Promise.resolve(params) }));
  return { html, text: textOf(html) };
}

/** Rows in the rendered table body, i.e. the roster this render actually listed. */
function rowCount(html: string): number {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
  return [...body.matchAll(/<tr\b/g)].length;
}

/** Non-overlapping occurrences of `needle`. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('/admin/commission — the roster', () => {
  it('lists every organiser, with this file’s three in it', async () => {
    const { html, text } = await render({ month: MONTH });

    // The two who earned, by name, and the one who did not — a zero-activity organiser
    // disappearing is the failure the page's own copy is written against.
    expect(text).toContain(`${PREFIX} ada`);
    expect(text).toContain(`${PREFIX} bo`);
    expect(text).toContain(`${PREFIX} idle`);
    expect(text).toContain(`${PREFIX}-ada@example.test`);

    // Every profile in the database is listed, which is the page's stated contract.
    expect(rowCount(html)).toBe(await prisma.organiserProfile.count());

    // And the idle organiser's name is on a row of its own, not merely somewhere in the
    // document — this is the difference between being listed and being mentioned.
    expect(cellsOf(html, `${PREFIX} idle`)[2]).toBe('no activity');
  });

  it('says no activity and shows a dash, never $0.00, for an organiser with none', async () => {
    const { text } = await render({ month: MONTH });

    expect(text).toContain('no activity');
    // The claim under test. `$0.00` in a money column reads as "computed, and it is
    // zero"; an organiser with no lines has nothing attributed, and the difference is
    // "nothing to pay" versus "attribution may be broken". This file's idle organiser
    // and every leftover profile in the database are all in the `no activity` case, so
    // this assertion is exactly the page's own reasoning.
    expect(text).not.toContain('$0.00');
    // And the dash is what stands in its place.
    expect(text).toContain('—');
  });

  it('counts who is owed and says why a missing name would matter', async () => {
    const { text } = await render({ month: MONTH });

    // This file puts exactly two organisers in the paid bucket for July. Any leftover
    // profile with July activity would break this — which is why the month is unique.
    expect(text).toContain('2 to pay,');
    // The sentence that makes an absent name a question rather than an absence.
    expect(text).toContain('every organiser on the roster is listed');
    expect(text).toContain('a missing name means a missing profile rather than a quiet month');
  });
});

describe('/admin/commission — the figures', () => {
  it('puts each organiser’s name on the same row as their rate, drops and money', async () => {
    const { html } = await render({ month: MONTH });

    // Cell-level, because a table of names and figures that are one row out of step is
    // readable, plausible, and pays the wrong person. `toContain` against the document
    // cannot see that, and neither can `toContain` against the row: `5.00%` is rendered
    // as `5.00<!-- -->%` and would fail here for a reason that has nothing to do with
    // the page.
    //
    // Ada: two drops, each netting 1250 cents — 2 units untouched, then 3 units with one
    // refunded. 2500 kept in total, and 63 + 63 = 126 commission, because each line is
    // rounded on its own. The rate applied to her 2500-cent month would print 125, so
    // the `$1.26` below is a discriminating figure and not a coincidence.
    expect(cellsOf(html, `${PREFIX} ada`)).toEqual([
      `${PREFIX} ada ${PREFIX}-ada@example.test`,
      '5.00%',
      '2',
      '$25.00',
      '$1.26',
    ]);

    // Bo: one drop, 1250 net, no refund, at 7.5% → 93.75 → 94. The single-line control.
    expect(cellsOf(html, `${PREFIX} bo`)).toEqual([
      `${PREFIX} bo ${PREFIX}-bo@example.test`,
      '7.50%',
      '1',
      '$12.50',
      '$0.94',
    ]);

    // The idle organiser: `no activity` and two dashes, and no currency at all.
    expect(cellsOf(html, `${PREFIX} idle`)).toEqual([
      `${PREFIX} idle ${PREFIX}-idle@example.test`,
      '5.00%',
      'no activity',
      '—',
      '—',
    ]);

    // The named figure this file exists to distinguish. A roll-up that applied Ada's 5%
    // to her month instead of summing her two rounded lines would print `$1.25` here and
    // `$1.25` on her own page: the two screens would agree with each other and be wrong
    // together, and every "admin equals organiser" assertion would still pass. Asserted
    // against Ada's own cell rather than the document, because the roster is global.
    expect(cellsOf(html, `${PREFIX} ada`)[4]).not.toBe('$1.25');
  });

  it('prints a grand total that is the sum of the roster, including this file’s part', async () => {
    const { html, text } = await render({ month: MONTH });

    // The page's headline and its footer must be the same number, read out of the render
    // rather than recomputed here: it is the number the operator sees.
    const headline = /\$([\d,]+\.\d{2})<\/p>\s*<p class="text-\[10px\] text-ink-soft">total to transfer/.exec(
      html,
    );
    expect(headline).not.toBeNull();
    const footer = /<tfoot>([\s\S]*?)<\/tfoot>/.exec(html)?.[1] ?? '';
    const footerCells = [...footer.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
      textOf(cell[1] ?? ''),
    );

    // `Total` has `colSpan={2}` (Organiser + Rate), so the footer has four cells, not
    // five: [Total, Drops, Kept, To transfer].
    expect(footerCells).toHaveLength(4);
    expect(footerCells[0]).toContain('Total');

    // The headline figure appears exactly twice in the render — the header and the
    // footer — and nowhere else. This is the counting lesson from gap 12(f) applied
    // before it could bite: `toContain` would pass on either occurrence alone, so a
    // header that printed one number while the footer printed another would go unseen
    // for the price of a single loose assertion.
    expect(countOf(text, `$${headline?.[1]}`)).toBe(2);

    // The last cell is the To transfer column, and it is the headline figure.
    expect(footerCells[3]).toBe(`$${headline?.[1]}`);
    // Its Drops column is the sum of every row's line count — the roster's, not this
    // file's 3. Two of Ada's drops plus one of Bo's is all July has.
    expect(footerCells[1]).toBe('3');
    expect(footerCells[2]).toBe('$37.50');

    // This file contributes exactly 220 — 126 + 94 — and nothing else in the database
    // has July activity, so the total is exactly that and not merely at least it. Note
    // that 220 is *not* 5% of anything: it is the sum of three rounded lines, which is
    // what the exported file must add up to when a human sums its column.
    expect(`$${headline?.[1]}`).toBe('$2.20');
    expect(text).toContain('total to transfer');
  });

  it('states the rate beside each figure, and 7.5% is not shown as 7% or 8%', async () => {
    const { html } = await render({ month: MONTH });

    // `commissionPctLabel` is the only place a basis-point count becomes a label. A
    // `Math.round(bp / 100)` version would print 8% for Bo, and the operator would
    // transfer the wrong amount while the total stayed right.
    const boCells = cellsOf(html, `${PREFIX} bo`);
    expect(boCells[1]).toBe('7.50%');
    expect(boCells[1]).not.toBe('8.00%');
    expect(boCells[1]).not.toBe('7.00%');
  });
});

describe('/admin/commission — the live-not-frozen paragraph', () => {
  it('says the figures are live, above the table, and names the consequence', async () => {
    const { html, text } = await render({ month: MONTH });

    expect(text).toContain(
      'These figures are live, current as of this page load — not a frozen invoice.',
    );
    // The consequence, addressed to the person about to send money.
    expect(text).toContain('A refund landing after you pay restates the month');
    expect(text).toContain(
      'The CSV you download at the moment you send the money is the record of what was transferred',
    );
    // And the instruction that follows from it, which is the whole point of the copy.
    expect(text).toContain('re-download it if you are paying even a day later');

    const sentenceAt = html.indexOf('current as of this page load');
    const tableAt = html.indexOf('<table');
    expect(sentenceAt).toBeGreaterThan(-1);
    expect(tableAt).toBeGreaterThan(-1);
    expect(sentenceAt).toBeLessThan(tableAt);
  });

  it('states that one computation feeds both views, so they cannot disagree', async () => {
    const { text } = await render({ month: MONTH });
    // This is the claim gap 17's design rests on — the admin figure is the organiser's
    // `commissionStatementFor` total, not a second implementation. The page says it; the
    // equivalence test below proves it.
    expect(text).toContain('one computation, two views, so they cannot disagree');
    expect(text).toContain('Nothing is paid automatically');
  });
});

describe('/admin/commission — the month selector', () => {
  /** `2026-11` → `2026-12`, and `2026-12` → `2027-01`. */
  function monthAfter(key: string): string {
    const [year, month] = key.split('-').map(Number) as [number, number];
    return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}`;
  }

  it('offers the previous month, and the current one as a chip', async () => {
    const current = currentCommissionMonthKey();
    const { html } = await render({ month: MONTH });
    const hrefs = hrefsOf(html);

    expect(hrefs).toContain('/admin/commission?month=2026-06');
    expect(hrefs).toContain(`/admin/commission?month=${current}`);
  });

  it('offers a next month for a month in the past', async () => {
    // July is behind the fixtures' clock, so stepping forward is meaningful.
    const { html } = await render({ month: MONTH });
    expect(hrefsOf(html)).toContain('/admin/commission?month=2026-08');
  });

  it('offers no next month when the month being viewed is the current one', async () => {
    // **This is the assertion the guard exists for, and the first version of this file
    // missed it.** The previous test renders July, which is in the past, so a next link
    // legitimately appears whether or not the guard is present — probed by replacing
    // `monthKey < currentMonth ? shiftMonthKey(...) : null` with an unconditional
    // `shiftMonthKey(...)` and watching all 18 tests pass. Only a render of the *current*
    // month distinguishes the two.
    const current = currentCommissionMonthKey();
    const { html } = await render({ month: current });

    expect(hrefsOf(html)).toContain(`/admin/commission?month=${current}`);
    // A future month is always empty, and a roster with every figure at zero reads as a
    // missing roster rather than an unstarted month.
    expect(hrefsOf(html)).not.toContain(`/admin/commission?month=${monthAfter(current)}`);
  });

  it('offers no next month when no month is named at all', async () => {
    // The default path — no `?month=` — resolves to the current month, so it must inherit
    // the same refusal. A guard written only on the explicit-parameter path would let
    // this one through.
    const current = currentCommissionMonthKey();
    const { html } = await render({});

    expect(hrefsOf(html)).not.toContain(`/admin/commission?month=${monthAfter(current)}`);
  });
});

describe('/admin/commission — the download and the JSON', () => {
  it('links the CSV to the month being viewed', async () => {
    const { html, text } = await render({ month: MONTH });

    expect(hrefsOf(html)).toContain('/api/admin/commission?month=2026-07&format=csv');
    expect(hrefsOf(html)).toContain('/api/admin/commission?month=2026-07');
    expect(text).toContain('Download 2026-07 for all organisers as CSV');
    expect(text).toContain('View as JSON');
  });

  it('produces a file whose rows sum to its own TOTAL row', async () => {
    const route = await import('@/app/api/admin/commission/route');
    const response = await route.GET(
      new NextRequest('http://localhost/api/admin/commission?month=2026-07&format=csv'),
    );

    expect(response.status).toBe(200);
    const csv = await response.text();
    const rows = csv.trim().split('\n');
    const header = (rows[0] ?? '').split(',');
    expect(header).toEqual([...ADMIN_COMMISSION_CSV_COLUMNS]);

    const commissionAt = header.indexOf('commission_cents');
    const bodyRows = rows.slice(1, -1);
    const totalRow = rows[rows.length - 1] ?? '';

    // The label is how a human finds the figure in a spreadsheet.
    expect(totalRow.startsWith('TOTAL,')).toBe(true);

    const summed = bodyRows.reduce(
      (sum, row) => sum + Number(row.split(',')[commissionAt] ?? '0'),
      0,
    );
    const printed = Number(totalRow.split(',')[commissionAt] ?? '0');

    // The property the file exists for: a human summing the column gets the TOTAL.
    expect(summed).toBe(printed);
    // And this file's contribution is really in there, so the equality is not 0 = 0.
    // 126 (Ada) + 94 (Bo) is the whole of July's activity in this database — and 126 is
    // the sum of two rounded 62.5s, so a TOTAL row that recomputed a rate over the
    // month's net would print 125 and disagree with its own body rows.
    expect(printed).toBe(220);
    // No per-organiser subtotal rows, or the column would double-count.
    expect(bodyRows.filter((row) => /^TOTAL,/.test(row))).toHaveLength(0);
  });

  it('refuses a malformed month on the CSV path with a 400', async () => {
    const route = await import('@/app/api/admin/commission/route');
    const response = await route.GET(
      new NextRequest('http://localhost/api/admin/commission?month=nonsense&format=csv'),
    );

    // A file named with one month whose figures are another's corrupts the only
    // artefact that records a payment. The page falls back; the file refuses.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Nothing was downloaded');
  });

  it('refuses a merchant session with a 403 rather than the roster', async () => {
    const previous = sessionState.session;
    sessionState.session = {
      userId: merchantUserId,
      role: 'MERCHANT',
      mustChangePassword: false,
    };

    try {
      const route = await import('@/app/api/admin/commission/route');
      const response = await route.GET(
        new NextRequest('http://localhost/api/admin/commission?month=2026-07&format=csv'),
      );

      expect(response.status).toBe(403);
      // Not a roster in the body: an organiser must not learn what the others earned.
      expect(await response.text()).not.toContain(`${PREFIX} ada`);
    } finally {
      sessionState.session = previous;
    }
  });
});

describe('/admin/commission — an unreadable ?month=', () => {
  it('names the month it could not read instead of silently showing another', async () => {
    const current = currentCommissionMonthKey();
    const { text } = await render({ month: 'nonsense' });

    expect(text).toContain(
      `That month was not a month we can read (nonsense), so this is ${current}.`,
    );
  });

  it('treats a repeated ?month= as unreadable, not as absent', async () => {
    const current = currentCommissionMonthKey();
    const { text } = await render({ month: ['2026-07', '2026-08'] });

    // Absent means "the current month", which is the right answer to a question nobody
    // asked. An array must not be normalised into it, or the operator gets a roster with
    // no note attached.
    expect(text).toContain(
      `That month was not a month we can read (2026-07,2026-08), so this is ${current}.`,
    );
    expect(text).not.toContain('2026-07 · owed to organisers');
  });
});

describe('/admin/commission — the equivalence gap 17 claims', () => {
  it('shows each organiser the same figure their own commission page shows', async () => {
    // The admin figure is documented as *being* the organiser's `commissionStatementFor`
    // total rather than a second implementation. The route test asserts the JSON agrees;
    // this asserts the two rendered pages agree, which is what an operator comparing a
    // phone call against a screen would actually be doing.
    const admin = await render({ month: MONTH });
    const previous = sessionState.session;

    try {
      const organiserPages: Array<{ name: string; html: string }> = [];
      // Destructured from a paired literal rather than indexed out of `organiserUserIds`,
      // because a bare index is `string | undefined` under `noUncheckedIndexedAccess` and
      // the pair keeps the name and the id from drifting apart.
      const pairs: ReadonlyArray<readonly [string | undefined, string]> = [
        [organiserUserIds[0], 'ada'],
        [organiserUserIds[1], 'bo'],
      ];

      for (const [userId, name] of pairs) {
        if (!userId) {
          throw new Error(`No organiser user id was recorded for ${name}`);
        }
        sessionState.session = { userId, role: 'ORGANISER', mustChangePassword: false };
        const page = await import('@/app/(organiser)/commission/page');
        const html = await renderToHtml(
          await page.default({ searchParams: Promise.resolve({ month: MONTH }) }),
        );
        organiserPages.push({ name, html });
      }

      // Ada nets 25.00 and is owed 1.26; Bo nets 12.50 and is owed 0.94. Different
      // numbers on purpose — if both were 0.94 a copy-paste between rows would pass.
      //
      // Ada's 1.26 is also the discriminating figure: a roll-up that re-applied the rate
      // to her month instead of summing her lines would show 1.25 here *and* 1.25 on her
      // own page, so the two screens would agree with each other and be wrong together.
      // That is why this test compares each page against a constant rather than against
      // the other page's output.
      const expected = [
        { name: 'ada', net: '$25.00', commission: '$1.26' },
        { name: 'bo', net: '$12.50', commission: '$0.94' },
      ];

      for (const [index, page] of organiserPages.entries()) {
        const want = expected[index];
        expect(want).toBeDefined();
        if (!want) {
          continue;
        }

        // The organiser's own screen: headline commission, and the footer's Kept column.
        expect(textOf(page.html)).toContain(want.commission);
        expect(textOf(page.html)).toContain(want.net);
        // One row per drop for Ada, so her own `Kept` column splits 12.50 / 12.50 and
        // her `Commission` column 0.63 / 0.63 — two halves that only reach her 1.26
        // figure because each was rounded first.
        expect(cellsOf(admin.html, `${PREFIX} ${want.name}`)[3]).toBe(want.net);
        expect(cellsOf(admin.html, `${PREFIX} ${want.name}`)[4]).toBe(want.commission);
      }

      // And Bo's 7.5% survives to both screens, so the rate is not being flattened to a
      // default anywhere in the middle. Read through `textOf`, because the raw HTML says
      // `7.50<!-- -->%` and a string assertion would fail for a reason that is not the
      // page's.
      const boPage = organiserPages[1];
      expect(boPage).toBeDefined();
      expect(textOf(boPage?.html ?? '')).toContain('7.50% of what your link sold');
      expect(cellsOf(admin.html, `${PREFIX} bo`)[1]).toBe('7.50%');
    } finally {
      sessionState.session = previous;
    }
  });
});

describe('/admin/commission — nothing writes', () => {
  it('renders a month without changing a single row', async () => {
    const before = await writeCounts();
    await render({ month: MONTH });
    await render({ month: 'nonsense' });
    const after = await writeCounts();

    expect(after).toEqual(before);
  });
});

/**
 * The text of each cell in the `<tr>` whose content includes `needle`.
 *
 * Cell-scoped assertions are the whole reason this helper exists. A table that puts the
 * right names and the right figures in the wrong order renders perfectly and pays the
 * wrong person, and a `toContain` against the whole document cannot see it. Asserting
 * against the row's raw HTML is better but still fails on `5.00<!-- -->%`, because React
 * separates the interpolated value from the literal `%` with a comment — so each cell is
 * read through `textOf` and compared as text.
 */
function cellsOf(html: string, needle: string): string[] {
  for (const match of html.matchAll(/<tr\b[\s\S]*?<\/tr>/g)) {
    if (!match[0].includes(needle)) {
      continue;
    }
    return [...match[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
      textOf(cell[1] ?? ''),
    );
  }
  throw new Error(`No <tr> contains ${needle}`);
}

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
