import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { hrefsOf, renderWithRouter, textOf } from '@/lib/testing/render';

/**
 * `/admin/drops` rendered — gap 12(a), against real Postgres.
 *
 * ## Why this page, and why it needed a harness change rather than a test
 *
 * `/admin/drops` is FR-901, and it is the screen the whole admin half of M7 was built
 * for: until it existed, force-fail and partial refund were reachable only by composing
 * an HTTP request. Four things on it exist only as JSX or only as a branch:
 *
 *   1. **The chip bar.** Each chip is a real URL with a count beside it, and the count
 *      comes from a *separate unfiltered read*. A chip that counted its own filtered rows
 *      would read `All 3` next to `FAILED 3` — plausible and useless. Nothing but a
 *      render can tell those two implementations apart, and the difference is invisible
 *      from the query tests that already existed.
 *   2. **An unparseable `?status=`.** It must show *everything* plus a sentence naming
 *      what was ignored, because a filter that silently matches nothing cannot be told
 *      from a filter that found nothing.
 *   3. **The money column, which says three different facts.** Captured → the amount at
 *      risk; partly refunded → the remainder *and* the refund named separately; nothing
 *      captured → a dash. Collapsing these into one number makes the page lie in one of
 *      three ways.
 *   4. **Whether `ForceFailControl` is offered**, per row, from the same constant the
 *      service refuses by. A control on a `LOCKED` drop teaches the operator that the
 *      button is broken; a missing control on `FAILED` hides the one case it is for.
 *
 * ## The harness had to grow first, and the growth is recorded where it lives
 *
 * `ForceFailControl` calls `useRouter()`, and `next/navigation` throws an invariant when
 * no app-router context is mounted. Probed first: calling this page under the existing
 * `renderToHtml` fails **inside the control, before a byte is written**, so the page was
 * unrenderable rather than merely untested. `renderWithRouter` in
 * `src/lib/testing/render.ts` supplies the real context. Everything below renders through
 * it, including the plain-data assertions, so there is one code path and not two.
 *
 * ## The list is global and capped at 100, so the assertions are roster-independent
 *
 * `listAdminDrops` lists **every** drop in the database, ordered `status asc, cutoffAt
 * desc`, with `take: 100`. A test file cannot make the database contain only its own
 * fixtures. So:
 *
 *   - **counts are derived from a fresh `groupBy`** taken in the test, not hardcoded,
 *     and compared against what the chips printed. That is the chip bug under test:
 *     a filtered count and an unfiltered count differ by construction whenever the
 *     filter matches fewer drops than exist;
 *   - **the filtered row count is compared against the filtered `prisma.drop.count()`**;
 *   - **the "at risk" total is compared against the sum of the rendered rows**, because
 *     under a filter it is a subset — asserting a hardcoded global total would be a
 *     test that breaks when any other file leaves a drop behind.
 *
 * ## The month is irrelevant here; the statuses are not
 *
 * One drop per status, so every chip has a non-zero count and no status is
 * indistinguishable from an absent one. `CRITICAL_DROP` is `CAPTURED` with a real order
 * that was **partly refunded**, which is the only fixture that can tell `subtotal −
 * refunded` from `subtotal`.
 *
 * ## What is mocked
 *
 * `server-only` and `@/lib/auth/session`, for the reasons every test in this repo states.
 * `@/lib/auth/authorize` is **real** where it is exercised, so the refusals come from
 * shipped code.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { settlementFixtures, ALL_DROP_STATUSES } = await import(
  '@/lib/settlement/__tests__/settlement-fixtures'
);
const { ADMIN_DROP_STATUSES } = await import('@/lib/db/admin-drops');
const { FORCE_FAILABLE } = await import('@/lib/admin/force-fail');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `adr${Date.now().toString(36).slice(-5)}`;
const fx = settlementFixtures(PREFIX);

/**
 * Deal price **625**, so `subtotal − refunded` and `subtotal` disagree by a number that
 * is not a round dollar: 2 plates is 1250, and a 250-cent refund leaves 1000. A 100-cent
 * price would make the two implementations differ by a number that also appears in the
 * price column, which is this suite's recurring way of accidentally proving nothing.
 */
const DEAL_PRICE = 625;
const CRITICAL_REFUND = 250;

/**
 * Every status except `DRAFT`, which this file leaves absent on purpose so the
 * empty-filter branch is reachable. Module scope because `beforeAll` seeds from it and
 * two describes assert against it.
 */
const SEEDED_STATUSES = ALL_DROP_STATUSES.filter((status) => status !== 'DRAFT');

let merchantId = '';
let itemId = '';
let adminUserId = '';

/** Status → the drop id this file created in that status. */
const dropByStatus = new Map<string, string>();
let criticalDropId = '';

// No participant or customer id bookkeeping: `fx.cleanup()` deletes the drops this file
// created, and participants and orders cascade from them. Tracking them by hand was three
// declarations that nothing read.

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

  // One drop per status **except DRAFT**, which is left absent so the empty-filter
  // branch is reachable. `PUBLISHED` and `LOCKED` are force-failable in one case and not
  // the other, which is the pair the per-row decision turns on; `FAILED` and `COMPLETED`
  // are force-failable even though they sound terminal.
  for (const [index, status] of SEEDED_STATUSES.entries()) {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 4,
      maxQty: 40,
      status,
      // Distinct, descending cutoffs so `cutoffAt desc` has something to order within a
      // status group, and so the label of a specific drop is predictable.
      cutoffAt: new Date(Date.UTC(2026, 6, 10 + index, 23, 0, 0)),
      windowStart: new Date(Date.UTC(2026, 6, 11 + index, 0, 0, 0)),
      windowEnd: new Date(Date.UTC(2026, 6, 11 + index, 2, 0, 0)),
    });
    dropByStatus.set(status, dropId);
  }

  // The one drop that carries money, so the money column has something to say.
  // 2 plates at 625 = 1250 captured, 250 refunded → **1000 still out there**.
  //
  // This is the fixture that discriminates: `subtotal − refunded` prints $10.00 and the
  // `subtotal`-only implementation prints $12.50. Both are plausible on a screen, and
  // only one of them is the amount a force-fail would return.
  criticalDropId = dropByStatus.get('CAPTURED') ?? '';
  const criticalParticipantId = await fx.participant({
    dropId: criticalDropId,
    qty: 2,
    chargeStatus: 'CAPTURED',
  });
  const participant = await prisma.dropParticipant.findUniqueOrThrow({
    where: { id: criticalParticipantId },
    select: { id: true, amountCents: true },
  });

  await prisma.order.create({
    data: {
      dropId: criticalDropId,
      participantId: participant.id,
      qty: 2,
      unitPriceCents: DEAL_PRICE,
      subtotalCents: participant.amountCents,
      platformFeeCents: 0,
      refundedCents: CRITICAL_REFUND,
    },
  });

  sessionState.session = { userId: adminUserId, role: 'ADMIN', mustChangePassword: false };
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.user.deleteMany({ where: { id: adminUserId } }).catch(() => undefined);
});

async function render(params: { status?: string }): Promise<{
  html: string;
  text: string;
  refreshes: number;
}> {
  const page = await import('@/app/(admin)/admin/drops/page');
  const { html, router } = await renderWithRouter(
    await page.default({ searchParams: Promise.resolve(params) }),
  );
  return { html, text: textOf(html), refreshes: router.refreshes };
}

/** Counts straight from the database, which is what the chips are supposed to show. */
async function dbCounts(): Promise<Record<string, number>> {
  const grouped = await prisma.drop.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const status of ADMIN_DROP_STATUSES) {
    counts[status] = 0;
  }
  for (const group of grouped) {
    counts[group.status] = group._count._all;
  }
  return counts;
}

/** Non-overlapping occurrences of `needle`. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Rendered drop cards. `Card as="li"` is the only `<li>` this page emits. */
function rowCount(html: string): number {
  return countOf(html, '<li class="rounded-xl');
}

/**
 * The "N shown · $X at risk" line in the header.
 *
 * Read as one string rather than as two independent `toContain`s: the pair is a single
 * claim, and a page whose count said 3 while its total covered 1 would pass two separate
 * assertions about the presence of a number and a sentence.
 */
function atRiskLine(html: string): { shown: number; cents: number } {
  const text = textOf(html);
  const match = /(\d+) shown · \$([\d,]+\.\d{2}) at risk/.exec(text);
  if (!match) {
    throw new Error('No "N shown · $X at risk" line rendered');
  }
  return { shown: Number(match[1]), cents: Math.round(Number((match[2] ?? '0').replace(/,/g, '')) * 100) };
}

/**
 * The chip whose label is `status` (or `All`), as `{ label, count, href }`.
 *
 * Chips are `<a>` elements whose text is the label followed by the count, so the two are
 * read out of one element rather than found anywhere in the document — a count that
 * appeared under a *different* chip would pass a document-wide `toContain`, and putting
 * the right numbers against the wrong statuses is exactly the chip bug this file exists
 * to catch.
 */
function chipFor(
  html: string,
  status: string | null,
): { label: string; count: number; href: string; active: boolean } {
  const label = status ?? 'All';
  const pattern = new RegExp(
    `<a class="([^"]*)" href="([^"]*)">${label}<span class="[^"]*">(\\d+)</span></a>`,
  );
  const match = pattern.exec(html);
  if (!match) {
    throw new Error(`No chip rendered for ${label}`);
  }
  return {
    label,
    count: Number(match[3]),
    href: (match[2] ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'"),
    active: (match[1] ?? '').includes('border-brand'),
  };
}

/**
 * The text of each drop's own `<li>`, keyed by the drop's public code.
 *
 * Card-level rather than document-level for the reason the commission suite documents:
 * a list that puts the right titles above the wrong statuses renders perfectly and sends
 * the operator to the wrong drop.
 */
function cardFor(html: string, publicCode: string): string {
  for (const match of html.matchAll(/<li\b[\s\S]*?<\/li>/g)) {
    if (match[0].includes(`>${publicCode}<`)) {
      return textOf(match[0]);
    }
  }
  throw new Error(`No <li> contains the code ${publicCode}`);
}

describe('/admin/drops — the chip bar', () => {
  it('prints each chip’s count from every drop, not from the filtered list', async () => {
    const counts = await dbCounts();
    const { html } = await render({ status: 'FAILED' });

    // The bug this catches, stated as a number: under `?status=FAILED` the page lists one
    // drop. A chip bar derived from `rows` would print `All 1`; the real one prints the
    // table's total. Both look plausible beside `FAILED 1`, which is why review missed it.
    expect(chipFor(html, null).count).toBe(await prisma.drop.count());
    expect(chipFor(html, 'FAILED').count).toBe(counts.FAILED);

    // The two counts differ, so the assertion above is not comparing 1 to 1.
    expect(chipFor(html, null).count).not.toBe(chipFor(html, 'FAILED').count);

    // And every status is present with its own count — a status missing from the bar is
    // indistinguishable from a status with no drops.
    for (const status of ADMIN_DROP_STATUSES) {
      expect(chipFor(html, status).count).toBe(counts[status]);
    }
  });

  it('marks only the chip being viewed, and All only when nothing is filtered', async () => {
    const filtered = await render({ status: 'CAPTURED' });

    expect(chipFor(filtered.html, 'CAPTURED').active).toBe(true);
    expect(chipFor(filtered.html, null).active).toBe(false);
    expect(chipFor(filtered.html, 'FAILED').active).toBe(false);

    const unfiltered = await render({});
    expect(chipFor(unfiltered.html, null).active).toBe(true);
    expect(chipFor(unfiltered.html, 'CAPTURED').active).toBe(false);
  });

  it('links every chip to its own status, and All to the bare list', async () => {
    const { html } = await render({ status: 'FAILED' });
    const hrefs = hrefsOf(html);

    expect(hrefs).toContain('/admin/drops');
    for (const status of ADMIN_DROP_STATUSES) {
      expect(hrefs).toContain(`/admin/drops?status=${status}`);
      expect(chipFor(html, status).href).toBe(`/admin/drops?status=${status}`);
    }
    expect(chipFor(html, null).href).toBe('/admin/drops');
  });
});

describe('/admin/drops — the list', () => {
  it('shows every drop when nothing is filtered, and only the named status when it is', async () => {
    const all = await render({});
    const total = await prisma.drop.count();

    // `listAdminDrops` caps at 100 rows, so "shows every drop" is only assertable below
    // the cap. Saying so explicitly means a shared database that one day holds more than
    // 100 drops fails here with a sentence about the cap, rather than an off-by-N that
    // reads like a rendering bug.
    expect(total).toBeLessThan(100);
    expect(rowCount(all.html)).toBe(total);

    const failed = await render({ status: 'FAILED' });
    expect(rowCount(failed.html)).toBe(
      await prisma.drop.count({ where: { status: 'FAILED' } }),
    );
    // The filtered view is a strict subset here, so "shows only FAILED" is a real
    // narrowing and not an artefact of the fixture having one drop of each status.
    expect(rowCount(failed.html)).toBeLessThan(rowCount(all.html));
  });

  it('totals the money still out there across the rows it is showing', async () => {
    // Under a filter the total is a **subset**, so asserting the global figure would be a
    // test that breaks whenever another file leaves a drop behind. The property that
    // survives any roster is that the header agrees with the rows beneath it.
    const captured = await render({ status: 'CAPTURED' });
    const line = atRiskLine(captured.html);

    expect(line.shown).toBe(rowCount(captured.html));
    // This file's part is exact: 1250 captured − 250 refunded = 1000, and it is the only
    // `CAPTURED` drop in the database. The `subtotal`-only implementation would print
    // 1250 here, which is the same mistake the card test catches, one level up.
    expect(line.cents).toBe(1000);

    // And a status with no money at all totals zero rather than inheriting another's.
    const published = await render({ status: 'PUBLISHED' });
    expect(atRiskLine(published.html).cents).toBe(0);
  });

  it('names each drop’s merchant, code, price and plate count on its own card', async () => {
    const { html } = await render({ status: 'CAPTURED' });

    const drop = await prisma.drop.findUniqueOrThrow({
      where: { id: criticalDropId },
      select: {
        publicCode: true,
        title: true,
        minQty: true,
        participants: { select: { qty: true } },
      },
    });

    const joinedQty = drop.participants.reduce((sum, p) => sum + p.qty, 0);
    const card = cardFor(html, drop.publicCode);

    expect(card).toContain(drop.title);
    expect(card).toContain(`${PREFIX} merchant`);
    expect(card).toContain(`${formatCents(DEAL_PRICE)}/plate`);
    // Plates, not joins: 2 plates in one join must not read as "1/4 plates".
    expect(card).toContain(`${joinedQty}/${drop.minQty} plates`);
  });

  it('says a drop with no captures has no money, without printing $0.00', async () => {
    const { html } = await render({ status: 'PUBLISHED' });
    const drop = await prisma.drop.findFirstOrThrow({
      where: { status: 'PUBLISHED', merchantId },
      select: { publicCode: true },
    });

    // `$0.00` in a money column reads as "computed, and it is zero" — the same argument
    // the commission page makes — and on this page it would read as "$0.00 at risk",
    // which is the normal state of a published drop and not a problem to investigate.
    expect(cardFor(html, drop.publicCode)).not.toContain('$0.00');
    expect(cardFor(html, drop.publicCode)).toContain('—');
  });

  it('shows what is still out there for a partly refunded drop, and names the refund', async () => {
    const { html } = await render({ status: 'CAPTURED' });
    const drop = await prisma.drop.findUniqueOrThrow({
      where: { id: criticalDropId },
      select: { publicCode: true },
    });

    const card = cardFor(html, drop.publicCode);

    // 1250 captured, 250 refunded → 1000 still out there. The `subtotal`-only
    // implementation prints $12.50 here, so these two assertions are what make the
    // money column load-bearing rather than decorative.
    expect(card).toContain('$10.00');
    expect(card).not.toContain('$12.50');
    // And the refund is named rather than absorbed: the operator has to be able to say
    // "you already got $2.50 back" without opening the drop.
    expect(card).toContain('$2.50 already back');
  });
});

describe('/admin/drops — the filter that cannot be parsed', () => {
  it('lists everything and names what it ignored', async () => {
    const { html, text } = await render({ status: 'WHATEVER' });

    expect(text).toContain('“WHATEVER” is not a drop status, so every drop is listed.');
    // The valid set, so the operator can fix the URL without guessing. Every status, not
    // a hand-written subset, which is why it is built from the constant.
    expect(text).toContain(`Valid: ${ADMIN_DROP_STATUSES.join(', ')}.`);

    // "Everything", not "nothing": the row count is the whole table, which is the claim
    // the sentence makes. A filter that silently matched nothing would read identically
    // to a filter that found nothing.
    expect(countOf(html, 'plates')).toBe(await prisma.drop.count());
  });

  it('does not mark any chip active when the filter was ignored', async () => {
    const { html } = await render({ status: 'WHATEVER' });

    // Neither `All` nor a status chip: the view is not the result of a filter, and
    // highlighting one would assert a selection the page did not honour.
    expect(chipFor(html, null).active).toBe(false);
    for (const status of ADMIN_DROP_STATUSES) {
      expect(chipFor(html, status).active).toBe(false);
    }
  });

  it('says so in a sentence when a valid filter matches nothing', async () => {
    // `DRAFT` is the one status this file deliberately does **not** create, so the empty
    // branch is reachable without touching anybody else's rows. The first version of this
    // test created a drop in every status and then looked for one with none — found
    // nothing, took its own early-return branch, and asserted that a variable was
    // defined. It passed while testing nothing at all.
    const counts = await dbCounts();
    // Checked, not assumed. This is a **global** count because the page queries the whole
    // table, so the premise is genuinely about the whole database: a single DRAFT drop
    // anywhere makes the empty branch unreachable and the test would pass by rendering
    // something else. It has already fired once, on a DRAFT left behind by an aborted run
    // of another suite — which is the diagnostic this message is for, because the failure
    // otherwise looks like a page defect.
    expect(
      counts.DRAFT,
      'A DRAFT drop exists in the dev database, so the empty-filter branch is unreachable. '
        + 'This is leaked data from another suite (or an aborted run), not a page bug: '
        + 'delete the stray DRAFT drop and re-run.',
    ).toBe(0);

    const { html, text } = await render({ status: 'DRAFT' });

    expect(text).toContain('No drops are DRAFT right now.');
    // A sentence, not an empty list standing beside chips that look broken.
    expect(rowCount(html)).toBe(0);
    // And the chips still carry the real table counts, so "no drops are DRAFT" does not
    // read as "there are no drops".
    expect(chipFor(html, null).count).toBe(await prisma.drop.count());
    expect(chipFor(html, 'DRAFT').count).toBe(0);
  });
});

describe('/admin/drops — the force-fail control, per row', () => {
  it('offers the control on exactly the statuses the service accepts', async () => {
    const { html } = await render({});

    for (const status of SEEDED_STATUSES) {
      const drop = await prisma.drop.findFirstOrThrow({
        where: { status, merchantId },
        select: { publicCode: true },
      });
      const card = cardFor(html, drop.publicCode);
      const offered = card.includes('Force-fail');

      // The one definition, imported by both the page and the service. A UI with its own
      // list agrees today and stops agreeing the first time `FORCE_FAILABLE` changes —
      // and then either offers a button that 409s or hides the one case it is for.
      const expected = (FORCE_FAILABLE as readonly string[]).includes(status);
      expect({ status, offered }).toEqual({ status, offered: expected });
    }

    // The `false` side of that comparison must actually occur, or the loop is asserting
    // that a control renders on everything. `LOCKED` and `DRAFT` are the two statuses
    // outside `FORCE_FAILABLE`, and `LOCKED` is seeded.
    expect((FORCE_FAILABLE as readonly string[]).includes('LOCKED')).toBe(false);
  });

  it('offers nothing at all on the mid-capture drop, which is the case that reads wrong', async () => {
    const locked = await prisma.drop.findFirstOrThrow({
      where: { status: 'LOCKED', merchantId },
      select: { publicCode: true },
    });

    // Asserted twice on purpose: once through the loop above, once named. `LOCKED` is
    // mid-settlement, and a force-fail there races the capture job and writes the ledger
    // twice — the refusal with the longest explanation in `force-fail.ts`. A control
    // offered here is the most damaging version of this bug.
    const { html } = await render({ status: 'LOCKED' });
    expect(cardFor(html, locked.publicCode)).not.toContain('Force-fail');
  });

  it('renders the closed state of the control, and never the dialog', async () => {
    const { html } = await render({ status: 'FAILED' });

    // The control is a client component whose `useState` starts closed, and nothing is
    // hydrated here — so the *only* honest claim is about the initial state. Two presses
    // are the requirement; a render can confirm the first press is what the operator has
    // to make deliberately, and cannot confirm the second.
    expect(html).toContain('Force-fail…');
    expect(html).not.toContain('type to confirm');
    expect(html).not.toContain('This cannot be undone');
  });
});

describe('/admin/drops — nothing writes', () => {
  it('cannot be rendered without a router context, which is why renderWithRouter exists', async () => {
    // A test that a *test helper* is necessary, and it earns its place: the obvious
    // "simplification" of this file is to call `renderToHtml` everywhere, and without
    // this assertion the only thing that would notice is a red suite with a confusing
    // invariant. The failure is inside `ForceFailControl`, before a byte is written —
    // so the page would be unrenderable rather than merely untested.
    const { renderToHtml } = await import('@/lib/testing/render');
    const page = await import('@/app/(admin)/admin/drops/page');

    await expect(
      renderToHtml(await page.default({ searchParams: Promise.resolve({}) })),
    ).rejects.toThrow(/expected app router to be mounted/);
  });

  it('renders several views without changing a row or refreshing the router', async () => {
    const before = await writeCounts();

    const views = [await render({}), await render({ status: 'FAILED' }), await render({ status: 'WHATEVER' })];
    for (const view of views) {
      // `router.refresh()` is the control's move after a *successful* force-fail. A page
      // that called it during render would navigate on every load, which is the kind of
      // bug that looks like a flicker and is a re-render loop.
      expect(view.refreshes).toBe(0);
    }

    expect(await writeCounts()).toEqual(before);
  });
});

/**
 * Global counts, safe *within one process* only: `fileParallelism: false` serialises test
 * files, so nothing else in this run writes between the two calls. Nothing here scopes the
 * counts, so a *second* process is not covered — another `npm run verify` (refused by the
 * residue lock), `prisma studio`, a scratch script, the dev server — and its rows arrive as
 * this file's drift. See the Teardown section of `AGENTS.md`.
 */
async function writeCounts(): Promise<Record<string, number>> {
  const [orders, drops, participants, audits] = await Promise.all([
    prisma.order.count(),
    prisma.drop.count(),
    prisma.dropParticipant.count(),
    prisma.auditLog.count(),
  ]);
  return { orders, drops, participants, audits };
}
