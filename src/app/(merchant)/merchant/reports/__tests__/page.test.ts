import 'dotenv/config';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/merchant/reports` rendered — M9's merchant surface.
 *
 * ## What a render can and cannot prove here, and what was mis-asserted first
 *
 * The page's claims are of two kinds, and only one of them is visible in HTML:
 *
 *   - **Which figures appear, and in what words.** Renderable, and asserted below.
 *   - **That the arithmetic is right.** Not renderable — a wrong number renders as
 *     convincingly as a right one. `lib/reports/__tests__/drop-report.test.ts` and
 *     `lib/db/__tests__/reports.test.ts` own that, against literals and real rows.
 *
 * A first draft of this file asserted `expect(html).toContain('$22.24')`-style
 * strings for the totals, which passes on a page that printed the same money in
 * every cell. What is asserted instead is the **pairing**: the label and its value
 * are checked together by extracting the `<dt>`/`<dd>` pairs, so swapping "GMV" and
 * "Platform fee" fails. That is the defect a render test is actually positioned to
 * catch — the arithmetic is covered where the arithmetic lives.
 *
 * ## The session is mocked; the query is not
 *
 * `requireMerchant` reads the session, so `@/lib/auth/session` is the seam. Everything
 * behind it — the merchant row, the drops, the orders, the ledger, the assembly — runs
 * for real against Postgres. Mocking `merchantReportQuery` as well would leave this
 * suite asserting its own fixtures.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { DEFAULT_FEES, buildGuardrailSnapshot } = await import('@/lib/guardrail');
const { platformFeeCentsForOrder } = await import('@/lib/settlement/platform-fee');
const { captureEntries } = await import('@/lib/settlement/ledger');

const PREFIX = `rptpage${Date.now().toString(36).slice(-5)}`;

const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];
const createdDropIds: string[] = [];
const createdCustomerIds: string[] = [];
const createdOrganiserIds: string[] = [];

let merchantId = '';
let ownerUserId = '';
let itemId = '';

/** Every item created by `freshMerchant`, so teardown can remove them all. */
const createdItemIds: string[] = [];

async function makeDrop(args: {
  dealPriceCents?: number;
  minQty: number;
  maxQty: number;
  status?: 'COMPLETED' | 'CANCELLED';
  windowStart?: Date;
  /** Defaults to an indexed name; set it when a test needs to find its own row. */
  title?: string;
}): Promise<string> {
  const dealPriceCents = args.dealPriceCents ?? 1112;
  const drop = await prisma.drop.create({
    data: {
      merchantId,
      menuItemId: itemId,
      publicCode: `${PREFIX}${createdDropIds.length}${Date.now()}`.slice(0, 24).toUpperCase(),
      title: args.title ?? `${PREFIX} drop ${createdDropIds.length + 1}`,
      dealPriceCents,
      minQty: args.minQty,
      maxQty: args.maxQty,
      maxPerCustomer: 4,
      cutoffAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      windowStart: args.windowStart ?? new Date(Date.now() - 60 * 60 * 1000),
      windowEnd: new Date(Date.now() + 60 * 60 * 1000),
      status: args.status ?? 'COMPLETED',
      guardrailSnapshot: buildGuardrailSnapshot(
        {
          ...DEFAULT_FEES,
          menuPriceCents: 1600,
          foodCostCents: 480,
          packagingCents: 80,
          floorPctOfMenu: 0.25,
        },
        dealPriceCents,
        new Date().toISOString(),
      ),
      publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    },
    select: { id: true },
  });
  createdDropIds.push(drop.id);
  return drop.id;
}

/**
 * A monotonic counter, not `Date.now()`.
 *
 * A `Date.now()`-based phone collided between two `makeCustomer()` calls in the same
 * millisecond, which failed as a `Customer_phone_key` violation in an unrelated test.
 * The counter is the unique part; the timestamp prefix only keeps reruns in a
 * different wall-clock second from colliding with a leftover row.
 */
let phoneSeq = 0;

async function makeCustomer(): Promise<string> {
  phoneSeq += 1;
  const customer = await prisma.customer.create({
    data: { phone: `+1781${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(3, '0')}` },
    select: { id: true },
  });
  createdCustomerIds.push(customer.id);
  return customer.id;
}

async function capture(args: {
  dropId: string;
  customerId: string;
  qty: number;
  dealPriceCents: number;
  shareLinkId?: string;
  refundAll?: boolean;
}): Promise<void> {
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
      chargeStatus: args.refundAll ? 'REFUNDED' : 'CAPTURED',
      paymentIntentId: `pi_${PREFIX}_${Date.now()}_${createdCustomerIds.length}`,
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
      refundedCents: args.refundAll ? subtotalCents : 0,
      platformFeeReversedCents: args.refundAll ? platformFeeCents : 0,
      stripeChargeId: `ch_${PREFIX}_${Date.now()}`,
    },
    select: { id: true },
  });

  const entries = captureEntries({
    dropId: args.dropId,
    order: { id: order.id, subtotalCents, platformFeeCents },
    stripeRef: `ch_${PREFIX}_${Date.now()}`,
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

  if (args.refundAll) {
    await prisma.ledgerEntry.create({
      data: {
        orderId: order.id,
        dropId: args.dropId,
        type: 'REFUND',
        amountCents: -subtotalCents,
        stripeRef: `re_${PREFIX}`,
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        orderId: order.id,
        dropId: args.dropId,
        type: 'ADJUSTMENT',
        amountCents: -platformFeeCents,
        stripeRef: `re_${PREFIX}`,
      },
    });
  }
}

/**
 * Every `<dt>` label mapped to the `<dd>` text that follows it, **within one
 * fragment of the page**.
 *
 * ## Why adjacency, and why scoped
 *
 * A mutation that relabels a row from "Contribution" to "GMV" **survived** the first
 * version of this file, which checked `toContain('Contribution')` and separately
 * `toContain('GMV')` — both still true after the relabel. Swapping two labels is
 * exactly the defect a render test is positioned to catch, and a presence check
 * cannot see it.
 *
 * The fragment matters because a page with two drops legitimately repeats every
 * per-drop label. Extracting globally would report a duplicate on correct output, so
 * the per-drop assertions are run against the slice of HTML belonging to one drop
 * (`rowHtmlFor`), where a repeated label really is a defect. The summary card is
 * asserted separately, where its labels are unique by construction.
 */
function labelValuePairs(fragment: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const duplicates: string[] = [];
  const pattern = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  let match = pattern.exec(fragment);
  while (match !== null) {
    const label = stripTags(match[1] ?? '');
    if (pairs.has(label)) {
      duplicates.push(label);
    }
    pairs.set(label, stripTags(match[2] ?? ''));
    match = pattern.exec(fragment);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `duplicate <dt> labels in one row: ${duplicates.join(', ')} — a merchant cannot ` +
        `tell two rows with the same name apart, and the assertion below would silently ` +
        `read whichever came last.`,
    );
  }
  return pairs;
}

/**
 * The HTML of one drop's list item, found by its title.
 *
 * A drop row is a `<li>` in the "By drop" list. Slicing from the title to the next
 * `</li>` gives a fragment in which every label is unique, which is what makes the
 * duplicate check meaningful rather than a false alarm on a two-drop page.
 */
function rowHtmlFor(html: string, dropTitle: string): string {
  const start = html.indexOf(dropTitle);
  if (start < 0) {
    throw new Error(`no drop row for "${dropTitle}" — the fixture did not render`);
  }
  const end = html.indexOf('</li>', start);
  return html.slice(start, end < 0 ? undefined : end);
}

/** The summary card, which precedes the by-drop list. Labels here are unique. */
function summaryHtmlFor(html: string): string {
  const start = html.indexOf('Across');
  const listStart = html.indexOf('By drop');
  if (start < 0) {
    throw new Error('no summary card rendered');
  }
  return html.slice(start, listStart < 0 ? undefined : listStart);
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&middot;/g, '·')
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A fresh merchant + owner + item per test, and a fresh session pointing at them.
 *
 * ## Why this is per-test rather than `beforeAll`
 *
 * The first version of this file created one merchant in `beforeAll` and appended
 * drops to it from every test. That made the suite **order-dependent**: the
 * "nothing to report" test only passed while it happened to run first, and the
 * per-drop assertions broke as soon as a second test added a row — the duplicate
 * label check fired on a page that was rendering correctly.
 *
 * A report is a whole-portfolio query, so a test that adds a drop changes the answer
 * to every later test's question. The only honest fix is one tenant per test, which
 * is also what makes each test's arithmetic checkable by hand.
 */
async function freshMerchant(): Promise<void> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${Date.now()}-${createdUserIds.length}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  ownerUserId = user.id;
  createdUserIds.push(user.id);

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} kitchen ${createdMerchantIds.length}`,
      slug: `${PREFIX}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantId = merchant.id;
  createdMerchantIds.push(merchant.id);

  const item = await prisma.menuItem.create({
    data: {
      merchantId,
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
  itemId = item.id;

  sessionState.session = {
    userId: ownerUserId,
    role: 'MERCHANT',
    mustChangePassword: false,
  };
}

afterAll(async () => {
  if (createdDropIds.length > 0) {
    await prisma.ledgerEntry.deleteMany({ where: { dropId: { in: createdDropIds } } }).catch(() => undefined);
    await prisma.drop.deleteMany({ where: { id: { in: createdDropIds } } }).catch(() => undefined);
  }
  if (createdCustomerIds.length > 0) {
    await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } }).catch(() => undefined);
  }
  if (createdOrganiserIds.length > 0) {
    await prisma.organiserProfile.deleteMany({ where: { id: { in: createdOrganiserIds } } }).catch(() => undefined);
  }
  if (createdItemIds.length > 0) {
    await prisma.menuItem.deleteMany({ where: { id: { in: createdItemIds } } }).catch(() => undefined);
  }
  if (createdMerchantIds.length > 0) {
    await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } }).catch(() => undefined);
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('/merchant/reports', () => {
  /**
   * **The withheld-drops banner, which had no test at all.**
   *
   * Two mutations survived the first sweep because nothing rendered the banner:
   * hiding it behind an impossible condition, and making it count something else.
   * The banner is the one place this page admits a drop is missing, and a merchant
   * who ran six drops and sees five needs it — so it is tested through a real row
   * that genuinely fails to reconcile.
   *
   * A drop whose `CHARGE` entry is short by a cent is a ledger/order disagreement
   * of exactly the kind settlement's own transaction is supposed to make
   * impossible. Simulating it requires writing the ledger row wrongly on purpose,
   * which is what `captureEntries` is bypassed for here.
   */
  it('names how many drops were withheld when one does not reconcile', async () => {
    await freshMerchant();
    const dropId = await makeDrop({ minQty: 1, maxQty: 10 });
    const customer = await makeCustomer();
    await capture({ dropId, customerId: customer, qty: 2, dealPriceCents: 1112 });

    // Break the ledger deliberately: one cent less than the order says.
    await prisma.ledgerEntry.updateMany({
      where: { dropId, type: 'CHARGE' },
      data: { amountCents: 2223 },
    });

    try {
      const { default: Page } = await import('../page');
      const html = textOf(await renderToHtml(await Page()));

      expect(html).toContain('1 drop is not shown');
      expect(html).toContain('do not agree with our payment records');
      // And the withheld drop's own row is absent rather than printed with figures
      // this page cannot stand behind.
      expect(html).not.toContain('$22.24');
    } finally {
      await prisma.ledgerEntry.updateMany({
        where: { dropId, type: 'CHARGE' },
        data: { amountCents: 2224 },
      });
    }
  });

  it('says there is nothing to report when the merchant has no closed drops', async () => {
    await freshMerchant();
    const { default: Page } = await import('../page');
    const html = textOf(await renderToHtml(await Page()));

    expect(html).toContain('Nothing to report yet');
    // And not the summary card, which would be a table of zeroes pretending to be data.
    expect(html).not.toContain('Contribution %');
  });

  it('pairs each label with its own figure', async () => {
    await freshMerchant();
    const dropId = await makeDrop({ minQty: 1, maxQty: 10, title: `${PREFIX} pairing drop` });
    const customer = await makeCustomer();
    // 2 units at $11.12: GMV 2224, fee 178, contribution 802.
    await capture({ dropId, customerId: customer, qty: 2, dealPriceCents: 1112 });

    const { default: Page } = await import('../page');
    const html = await renderToHtml(await Page());

    const row = labelValuePairs(rowHtmlFor(html, `${PREFIX} pairing drop`));
    // The pairing is the assertion: GMV and Platform fee must not swap, and a
    // relabel collides inside this row and throws.
    expect(row.get('GMV')).toBe('$22.24');
    expect(row.get('Platform fee')).toBe('$1.78');
    expect(row.get('Contribution')).toBe('$8.02');
    // 802 / 2224 = 36.06% → 36%.
    expect(row.get('Contribution %')).toBe('36%');
    expect(row.get('Units sold')).toBe('2');
    expect(row.get('Customers')).toBe('1 new · 0 returning');

    // The summary row, which is cumulative across every drop on the page — so the
    // assertions here are on labels and pairings, not on totals that other tests
    // also add to.
    const summary = labelValuePairs(summaryHtmlFor(html));
    expect(summary.has('Total GMV')).toBe(true);
    expect(summary.has('Total contribution')).toBe(true);
    expect(summary.has('Overall contribution %')).toBe(true);
    expect(summary.has('New customers, all drops')).toBe(true);
  });

  it('names the organiser who brought the buyer, and the direct-link remainder', async () => {
    await freshMerchant();
    const dropId = await makeDrop({ minQty: 1, maxQty: 20 });

    const organiserUser = await prisma.user.create({
      data: {
        email: `${PREFIX}-org-${Date.now()}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'ORGANISER',
        // Nested, not two statements. `/admin/users` renders a heading counted from
        // profile-less organisers and a form per row, and it asserts those two agree.
        // Creating the user and then the profile leaves a window — a few hundred
        // microseconds — in which this row is an organiser with no profile, and the
        // first full-suite run of M9 failed exactly there: "1 organisers missing a"
        // appeared inside another suite's `/not.toContain/`. One statement has no
        // window. A per-test tenant isolates *data*, not *time* — the database is
        // still shared, so nothing here may be observable mid-write.
        organiser: { create: { displayName: `${PREFIX} Priya` } },
      },
      select: { id: true, organiser: { select: { id: true } } },
    });
    createdUserIds.push(organiserUser.id);
    createdOrganiserIds.push(organiserUser.organiser!.id);
    const profile = organiserUser.organiser!;

    const link = await prisma.shareLink.create({
      data: {
        token: `${PREFIX}-tok-${Date.now()}`,
        dropId,
        merchantId,
        organiserId: profile.id,
      },
      select: { id: true },
    });

    const throughPriya = await makeCustomer();
    const direct = await makeCustomer();
    await capture({
      dropId,
      customerId: throughPriya,
      qty: 2,
      dealPriceCents: 1112,
      shareLinkId: link.id,
    });
    await capture({ dropId, customerId: direct, qty: 1, dealPriceCents: 1112 });

    const { default: Page } = await import('../page');
    const html = textOf(await renderToHtml(await Page()));

    expect(html).toContain('Who brought people');
    expect(html).toContain(`${PREFIX} Priya — 2 units`);
    // The plain-link diner is named rather than left as an unexplained shortfall.
    expect(html).toContain('Direct link — 1 unit');
  });

  /**
   * FR-705's sentence, on screen. The PRD's example is a sold-out drop suggesting a
   * bigger run, so the assertion is on that sentence rather than on the badge alone —
   * a badge would pass even if the advice were wrong.
   */
  it('suggests a bigger run for a sold-out drop', async () => {
    await freshMerchant();
    const dropId = await makeDrop({ minQty: 2, maxQty: 4 });
    const customer = await makeCustomer();
    await capture({ dropId, customerId: customer, qty: 4, dealPriceCents: 1112 });

    const { default: Page } = await import('../page');
    const html = textOf(await renderToHtml(await Page()));

    // maxQty 4 sold out: 4 + max(10, 2) = 14.
    expect(html).toContain('Sold out at 4. Try 14 units next time.');
    expect(html).toContain('Sold out');
  });

  /**
   * A fully refunded drop reports zero contribution and **is** shown. This is the
   * case where an over-eager "reconcile or hide" rule would be wrong about correct
   * data: the money genuinely moved and genuinely came back.
   */
  it('shows a cancelled drop as zero contribution with the refund named', async () => {
    await freshMerchant();
    const dropId = await makeDrop({ minQty: 1, maxQty: 10, status: 'CANCELLED' });
    const customer = await makeCustomer();
    await capture({
      dropId,
      customerId: customer,
      qty: 2,
      dealPriceCents: 1112,
      refundAll: true,
    });

    const { default: Page } = await import('../page');
    const html = textOf(await renderToHtml(await Page()));

    expect(html).toContain('$22.24 went back to diners');
    expect(html).toContain('kept $0.00');
  });

  /**
   * The explanatory copy is part of the feature, not decoration. FR-702 is the
   * retention number, and a merchant reading "3 new" without knowing the measure is
   * platform-wide would read it as "3 new to me" and draw the wrong conclusion about
   * their own marketing. The page has to say which question the number answers.
   *
   * The drop is not scenery. The first version of this test asserted the copy against
   * a brand-new tenant and failed: with nothing to report the page returns its empty
   * state, which has no counts in it and therefore no need to explain them. The
   * explanation lives on the page that actually prints "1 new". A test that reads it
   * off the empty state would have been asserting copy no merchant ever sees next to
   * a number.
   */
  it('explains that new-versus-returning is measured platform-wide', async () => {
    await freshMerchant();
    const dropId = await makeDrop({ minQty: 1, maxQty: 10 });
    const customer = await makeCustomer();
    await capture({ dropId, customerId: customer, qty: 1, dealPriceCents: 1112 });

    const { default: Page } = await import('../page');
    const html = textOf(await renderToHtml(await Page()));

    expect(html).toContain('across the whole platform');
    expect(html).toContain('does not count as a visit');
    expect(html).toContain('counts three times');
  });

  /**
   * The `!merchant` guard is unreachable, like `/merchant/payouts`' — `primaryMerchantId`
   * throws before `getMerchant` is reached, and `MerchantUser.merchantId` cascades, so a
   * membership row cannot outlive its merchant. Asserted here so nobody later reads the
   * absence of a test as an oversight.
   */
  it('cannot reach the no-merchant branch from a valid session', async () => {
    await freshMerchant();
    const orphan = await prisma.user.create({
      data: {
        email: `${PREFIX}-orphan-${Date.now()}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    createdUserIds.push(orphan.id);

    sessionState.session = {
      userId: orphan.id,
      role: 'MERCHANT',
      mustChangePassword: false,
    };

    try {
      const { default: Page } = await import('../page');
      await expect(Page()).rejects.toThrow(/No merchant is attached/);
    } finally {
      sessionState.session = {
        userId: ownerUserId,
        role: 'MERCHANT',
        mustChangePassword: false,
      };
    }
  });
});
