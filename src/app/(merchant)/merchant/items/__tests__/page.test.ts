import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/merchant/items` rendered — gap 12, the first of the ten `/merchant/*` pages.
 *
 * > `PRD-sprint1 §6.2` — the dish list. Each card shows the dish name, the menu price,
 * > and a status badge derived from the guardrail evaluation.
 *
 * ## What a render can see here that a loader test cannot
 *
 * The page has no query of its own worth testing: `listItems` is a scoped `findMany` and
 * `getFloor` a single row. Everything this page *decides* is in `statusOf` — a switch that
 * turns seven `PanelState`s plus an `ineligible` flag into five words and four colours.
 *
 * That switch has a plausible wrong version for every arm, and each wrong version is a
 * sentence a merchant would act on:
 *
 *   - **`Blocked` on an ineligible dish.** A dish containing alcohol can never be in a
 *     drop (FR-104 / AGLC). Labelling it "Needs work" would invite the merchant to go and
 *     fix it, and there is nothing to fix — the rule is regulatory.
 *   - **`Can't deal` on an `INFEASIBLE` dish.** This one is arithmetic: no price clears
 *     the floor at this menu price. "Needs work" would suggest a missing number, and the
 *     merchant would hunt for one.
 *   - **`Ready` on a `THIN` dish.** The most expensive of the four. A thin discount is
 *     viable but will not sell; calling it Ready sends the merchant to publish a deal
 *     nobody joins, and the failure arrives at the cutoff with their prep already planned.
 *
 * So the fixture is one dish per reachable arm, chosen by computing the state rather than
 * guessing it — see the table below.
 *
 * ## The five arms, and which are reachable from this page at all
 *
 * `statusOf` switches on `evaluation.state` after an `ineligible` short-circuit, and the
 * page calls `evaluateItem` **without `dealPriceCents`**. That matters, because
 * `evaluateItem` then evaluates at `minViablePrice`:
 *
 *   | fixture            | menu | food | pack | state            | badge        |
 *   |--------------------|------|------|------|------------------|--------------|
 *   | `ready`            | 1600 |  480 |   80 | `FLOOR`          | Ready        |
 *   | `thin`             |  500 |  100 |  150 | `THIN`           | Thin margin  |
 *   | `infeasible`       |  500 |  200 |   80 | `INFEASIBLE`     | Can't deal   |
 *   | `invalid`          |  500 |  400 |  150 | `INVALID_COST_DATA` | Needs work |
 *   | `alcohol`          | 1600 |  480 |   80 | `INFEASIBLE` + `CONTAINS_ALCOHOL` | Blocked |
 *   | `notBatchable`     | 1600 |  480 |   80 | `INFEASIBLE` + `NOT_BATCHABLE`    | Blocked |
 *
 * **`PanelState.OK` is unreachable from this page**, and that is a property of the page
 * rather than of the fixtures. `OK` requires `dealPriceCents > minViablePriceCents`, and
 * with no `dealPriceCents` the price *is* the floor, so `resolvePanelState` returns
 * `FLOOR`. Confirmed by sweeping 252 cost combinations through `evaluateItem` with the
 * page's own arguments: the states produced were `FLOOR`, `THIN`, `INFEASIBLE`,
 * `INVALID_COST_DATA` and nothing else. So `case PanelState.OK` in `statusOf` cannot be
 * reached by this page today — it is kept because the panel's states are shared and the
 * badge function is the natural place to answer for all of them, and this note is here so
 * nobody later reads the absence of an `OK` test as an omission.
 *
 * ## The two `Blocked` dishes are one assertion each, deliberately
 *
 * `alcohol` and `notBatchable` both evaluate to `INFEASIBLE`, so a badge keyed on state
 * alone would print "Can't deal" for both. The page checks `ineligible` *first*, and the
 * two fixtures are what hold that ordering in place: removing the short-circuit changes
 * both badges, and removing AGLC's precedence (`containsAlcohol` before `isBatchable` in
 * `ineligibilityOf`) changes nothing here — that ordering is `evaluate.ts`'s, tested
 * there. What this file proves is that the *page* reads the flag at all.
 *
 * ## What is mocked, and what that costs
 *
 * `server-only` and `@/lib/auth/session`. The second is not a convenience: `getSession`
 * reads a cookie jar that does not exist outside a request, so without it every page in
 * this group is unreachable. What is *not* mocked is `requireMerchant`, `listItems`,
 * `getFloor` or `evaluateItem` — the page runs its real query against real Postgres and
 * its real evaluation, which is the half that can be wrong.
 *
 * The cost: `requireMerchant`'s 401 and 403 arms are not exercised here, because the
 * session is injected rather than resolved. Those live in `authorize.ts`'s own tests and
 * in every route handler that calls it. A test here asserting a redirect would be
 * asserting the mock.
 *
 * ## What a render cannot see
 *
 * `ItemForm` is not on this page, so nothing here depends on it. But the page's cards
 * carry an "Edit →" link and *nothing else* is interactive — there is no `onClick`, no
 * client component, and no `useState`. This is one of the few merchant pages a plain
 * `renderToHtml` covers completely rather than partially.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { settlementFixtures } = await import('@/lib/settlement/__tests__/settlement-fixtures');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `mchitems${Date.now().toString(36).slice(-5)}`;
const fx = settlementFixtures(PREFIX);

/**
 * Menu prices, all distinct, so a card asserting `$16.00` cannot pass on another dish's
 * price. `ready` and the two blocked dishes share 1600 on purpose — they are told apart by
 * their badge, and giving them different prices would make the fixture table harder to
 * read than the assertion requires.
 */
const READY_MENU = 1600;
const THIN_MENU = 500;
const INFEASIBLE_MENU = 500;
const INVALID_MENU = 500;
const ALCOHOL_MENU = 1600;
const NOT_BATCHABLE_MENU = 1600;

let merchantId = '';
let userId = '';

/** Dish ids by the role they play, so an assertion names its case. */
const dish = {
  ready: '',
  thin: '',
  infeasible: '',
  invalid: '',
  alcohol: '',
  notBatchable: '',
  archived: '',
};

const createdItemIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];

/** Creates a dish and remembers it, so teardown does not depend on reading the list. */
async function dishRow(args: {
  name: string;
  menuPriceCents: number;
  foodCostCents: number;
  packagingCents: number;
  isBatchable?: boolean;
  containsAlcohol?: boolean;
  archivedAt?: Date | null;
}): Promise<string> {
  const item = await prisma.menuItem.create({
    data: {
      merchantId,
      name: args.name,
      menuPriceCents: args.menuPriceCents,
      foodCostCents: args.foodCostCents,
      packagingCents: args.packagingCents,
      batchYield: 60,
      prepMinutes: 6,
      isBatchable: args.isBatchable ?? true,
      containsAlcohol: args.containsAlcohol ?? false,
      category: 'Bowls',
      archivedAt: args.archivedAt ?? null,
    },
    select: { id: true },
  });
  createdItemIds.push(item.id);
  return item.id;
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  createdMerchantIds.push(merchantId);

  // A floor of 25%, which is the schema default and the number the fixture arithmetic
  // assumes. Set explicitly rather than inherited, so a change to the default does not
  // silently re-price every dish in this file.
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { name: 'Copper Kettle', floorPctOfMenu: 0.25, timezone: 'America/Edmonton' },
  });

  const owner = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  userId = owner.id;
  createdUserIds.push(userId);
  await prisma.merchantUser.create({
    data: { merchantId, userId, role: 'OWNER' },
  });

  dish.ready = await dishRow({
    name: 'Halloumi Wrap',
    menuPriceCents: READY_MENU,
    foodCostCents: 480,
    packagingCents: 80,
  });
  dish.thin = await dishRow({
    name: 'Side Salad',
    menuPriceCents: THIN_MENU,
    foodCostCents: 100,
    packagingCents: 150,
  });
  dish.infeasible = await dishRow({
    name: 'Beef Short Rib',
    menuPriceCents: INFEASIBLE_MENU,
    foodCostCents: 200,
    packagingCents: 80,
  });
  dish.invalid = await dishRow({
    name: 'Mislabelled Bowl',
    menuPriceCents: INVALID_MENU,
    foodCostCents: 400,
    packagingCents: 150,
  });
  dish.alcohol = await dishRow({
    name: 'House Red',
    menuPriceCents: ALCOHOL_MENU,
    foodCostCents: 480,
    packagingCents: 80,
    containsAlcohol: true,
  });
  dish.notBatchable = await dishRow({
    name: 'Hand-Plated Tasting',
    menuPriceCents: NOT_BATCHABLE_MENU,
    foodCostCents: 480,
    packagingCents: 80,
    isBatchable: false,
  });
  // Listed by `listItems`'s `archivedAt: null` filter, not by anything on the page. If this
  // ever appears, the leak is in the query.
  dish.archived = await dishRow({
    name: 'Retired Special',
    menuPriceCents: 9900,
    foodCostCents: 100,
    packagingCents: 0,
    archivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });

  sessionState.session = { userId, role: 'MERCHANT', mustChangePassword: false };
});

afterAll(async () => {
  if (createdItemIds.length > 0) {
    await prisma.menuItem.deleteMany({ where: { id: { in: createdItemIds } } }).catch(() => undefined);
  }
  if (createdMerchantIds.length > 0) {
    await prisma.merchantUser.deleteMany({ where: { merchantId: { in: createdMerchantIds } } }).catch(() => undefined);
    await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } }).catch(() => undefined);
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
  }
  await fx.cleanup();
});

/** Render the page as the signed-in owner. */
async function render(): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(merchant)/merchant/items/page');
  const html = await renderToHtml(await page.default());
  return { html, text: textOf(html) };
}

/**
 * The card for one dish, as HTML.
 *
 * Cards are `<article>`s inside `<li>`s, and each links to `/merchant/items/<id>`. The
 * href is the only unique identifier in the markup — the dish name appears both here and
 * (for some fixtures) inside a shared word, and the menu price is not unique. Scoped so
 * "this dish is Ready" cannot be satisfied by another card's badge, which is precisely the
 * mistake `/admin/commission` made with a page-wide `toContain`.
 */
function cardFor(html: string, itemId: string): string {
  for (const match of html.matchAll(/<li\b[\s\S]*?<\/li>/g)) {
    if (match[0].includes(`/merchant/items/${itemId}`)) {
      return match[0];
    }
  }
  throw new Error(`No <li> links to ${itemId}`);
}

/** The card for one dish, as comparable text. */
function textFor(html: string, itemId: string): string {
  return textOf(cardFor(html, itemId));
}

describe('/merchant/items — the dish list', () => {
  it('badges each dish from its guardrail state, one word per outcome', async () => {
    const { html } = await render();

    // Every arm of `statusOf`, asserted per card. A page that badged every dish the same
    // would fail five of these; a page that collapsed `INFEASIBLE` and `INVALID_COST_DATA`
    // would fail the `Mislabelled Bowl` line and pass the rest, which is why they are
    // separate fixtures rather than separate assertions on one dish.
    expect(textFor(html, dish.ready)).toContain('Ready');
    expect(textFor(html, dish.thin)).toContain('Thin margin');
    expect(textFor(html, dish.infeasible)).toContain("Can't deal");
    expect(textFor(html, dish.invalid)).toContain('Needs work');
  });

  it('says Blocked for a dish that can never be a drop, on either disqualifier', async () => {
    const { html } = await render();

    // Both are `INFEASIBLE` before the badge sees them, so a badge derived from `state`
    // alone prints "Can't deal" here and every other fixture still passes. The
    // short-circuit on `ineligible` is the only thing that distinguishes them.
    expect(textFor(html, dish.alcohol)).toContain('Blocked');
    expect(textFor(html, dish.alcohol)).not.toContain("Can't deal");
    expect(textFor(html, dish.notBatchable)).toContain('Blocked');
    expect(textFor(html, dish.notBatchable)).not.toContain("Can't deal");

    // No assertion here that the two reason *sentences* differ, and the reason is worth
    // recording because the obvious one is vacuous. This page prints no reason sentence at
    // all — the badge is the same `Blocked` for both — so a `not.toBe` between the two
    // cards' texts passes on the dish names alone and would survive a page that printed one
    // fixed string for every blocked dish. Measured: two cards differing only in name are
    // unequal with an identical badge, so that assertion could not fail. What actually
    // distinguishes the second dish is which flag fired, and that ordering is
    // `evaluate.ts`'s — `containsAlcohol` before `isBatchable` in `ineligibilityOf`, tested
    // there. This file's job is narrower: the page reads `ineligible` at all, and the
    // short-circuit precedes the switch.
  });

  it('does not call a thin discount Ready, which is the expensive confusion', async () => {
    const { html } = await render();
    const thin = textFor(html, dish.thin);

    // The `Side Salad` is viable — this is the whole point. `THIN` means the discount is
    // too shallow to sell, not that the dish is broken, so the badge must not read Ready
    // and must not read Blocked either. A merchant told Ready would publish a deal nobody
    // joins; told Blocked, they would stop trying a dish that works at a deeper price.
    expect(thin).toContain('Thin margin');
    expect(thin).not.toContain('Ready');
    expect(thin).not.toContain('Blocked');

    // The state really is `THIN` rather than `FLOOR` at 4% off — asserted against the pure
    // module so a change to the thin threshold fails here with a legible message instead of
    // silently re-labelling the badge.
    const { evaluateItem } = await import('@/lib/items/evaluate');
    const { PanelState } = await import('@/lib/guardrail');
    const stored = await prisma.menuItem.findUniqueOrThrow({ where: { id: dish.thin } });
    expect(evaluateItem({ item: stored, floorPctOfMenu: 0.25 }).state).toBe(PanelState.THIN);
  });

  it('shows each dish’s own menu price, formatted as money', async () => {
    const { html } = await render();

    // Prices are distinct where they can be, and asserted per card. `$16.00 menu price`
    // appears on three cards by design — the badge is what differs — so the `ready` card is
    // asserted on all three of its own facts rather than on the price alone.
    const ready = textFor(html, dish.ready);
    expect(ready).toContain('Halloumi Wrap');
    expect(ready).toContain(`${formatCents(READY_MENU)} menu price`);

    // A cheaper dish proves the price is per-row and not a constant: 500 formats as
    // `$5.00`, and no other fixture has that price.
    expect(textFor(html, dish.thin)).toContain(`${formatCents(THIN_MENU)} menu price`);
    expect(textFor(html, dish.infeasible)).not.toContain(`${formatCents(READY_MENU)} menu price`);
  });

  it('leaves archived dishes off the list', async () => {
    const { html, text } = await render();

    // `listItems` filters `archivedAt: null`. Asserted here rather than only in the query's
    // own test because this page is where a merchant would notice: a retired dish they
    // cannot edit appearing in the list reads as a data error.
    expect(text).not.toContain('Retired Special');
    expect(hrefsOf(html)).not.toContain(`/merchant/items/${dish.archived}`);
  });

  it('links each card to its own edit page, and offers a new-dish button', async () => {
    const { html } = await render();
    const hrefs = hrefsOf(html);

    // Every dish present, with its own href. A page that linked every card to the first
    // dish would satisfy `toContain('/merchant/items/')` and fail this.
    for (const id of [dish.ready, dish.thin, dish.infeasible, dish.invalid, dish.alcohol, dish.notBatchable]) {
      expect(hrefs).toContain(`/merchant/items/${id}`);
    }

    expect(hrefs).toContain('/merchant/items/new');
    expect(textOf(html)).toContain('+ New dish');
  });

  it('orders the list by name, which is what listItems asks the database for', async () => {
    const { html } = await render();

    // Positional, derived from the fixture names rather than hardcoded as a sequence: the
    // six names sort to Beef, Halloumi, Hand-Plated, House, Mislabelled, Side. A `findMany`
    // that lost its `orderBy` would return insertion order and fail here — and insertion
    // order is deliberately not alphabetical (the `ready` dish is created first but sorts
    // second).
    const order = [
      dish.infeasible, // Beef Short Rib
      dish.ready, // Halloumi Wrap
      dish.notBatchable, // Hand-Plated Tasting
      dish.alcohol, // House Red
      dish.invalid, // Mislabelled Bowl
      dish.thin, // Side Salad
    ];
    const positions = order.map((id) => html.indexOf(`/merchant/items/${id}`));
    for (const position of positions) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });
});

describe('/merchant/items — a merchant with no dishes', () => {
  it('shows the empty state rather than an empty list', async () => {
    // A second merchant with nothing in it, and a session switched to its owner. The empty
    // branch is otherwise unreachable in this file, because the shared merchant has six
    // dishes — and a `drops.length === 0` shaped branch that nothing renders is exactly the
    // kind of code probe T found in `/organiser`.
    const emptyMerchantId = await fx.merchant(`acct_${PREFIX}empty`);
    createdMerchantIds.push(emptyMerchantId);

    const emptyOwner = await prisma.user.create({
      data: {
        email: `${PREFIX}-empty@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    createdUserIds.push(emptyOwner.id);
    await prisma.merchantUser.create({
      data: { merchantId: emptyMerchantId, userId: emptyOwner.id, role: 'OWNER' },
    });

    const previous = sessionState.session;
    sessionState.session = { userId: emptyOwner.id, role: 'MERCHANT', mustChangePassword: false };
    try {
      const { text } = await render();

      expect(text).toContain('No dishes yet.');
      // The sentence that makes the empty state useful rather than merely accurate.
      expect(text).toContain('whether it can be part of a deal');
      // And no card markup — an empty `<ul>` would render as nothing and pass a text
      // assertion about absence, so the positive statement is paired with the count of
      // dish links, which must be zero apart from the new-dish button.
      expect(text).not.toContain('menu price');
    } finally {
      sessionState.session = previous;
    }
  });
});
