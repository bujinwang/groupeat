import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/merchant/drops` rendered — gap 12, the third `/merchant/*` page.
 *
 * The list itself decides almost nothing: it reads `Drop.status`, looks the dish name up from
 * the items it already loaded, and prints both. Unlike the dish list there is no guardrail
 * state to compute — a published drop's money is in its frozen snapshot and a draft's is
 * provisional, so the page deliberately does not evaluate anything.
 *
 * What it *does* decide, and what this suite is about, is the shape of the page a merchant
 * sees depending on whether they can start a drop at all:
 *
 *   - With a batchable dish: a `New drop` button and, when there are no drops, an explanation
 *     of what a drop is.
 *   - Without one: `Add a dish first`, and an empty state that names the reason.
 *
 * That branch is the whole point of the page's `hasBatchableDish` computation, and getting it
 * backwards is not a crash — it is a button that leads to a screen saying "no dish can be a
 * drop yet".
 *
 * ## The status table is asserted exhaustively, from a fixture that renders one of each
 *
 * `STATUS_COPY` maps eight `DropStatus` values to five tones and eight labels. A missing entry
 * falls through to `{ label: drop.status, tone: 'neutral' }`, so a new status does not crash —
 * it prints the raw enum, `PICKUP_OPEN`, on a merchant's screen. The all-statuses fixture makes
 * that visible; eight separate pages would not have.
 *
 * ## What is mocked
 *
 * `server-only` and `@/lib/auth/session`. Everything else is real — `requireMerchant`,
 * `listDrops`, `listItems`, `Badge`, `Card`, `buttonClass`. Nothing on this page is a client
 * component, so a plain `renderToHtml` covers it fully rather than partially.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `mchdrops${Date.now().toString(36).slice(-5)}`;

const ids = {
  merchantId: '',
  bareMerchantId: '',
  userId: '',
  bareUserId: '',
  dish: '',
  /** One drop per `DROP_COPY` entry, all on the main merchant. */
  byStatus: {} as Record<string, string>,
  /** Always `DRAFT`, built first, so it is the last in a `createdAt desc` ordering. */
  oldest: '',
  /** Always `DRAFT`, built last, so it is first in a `createdAt desc` ordering. */
  newest: '',
};

const createdDropIds: string[] = [];
const createdItemIds: string[] = [];

const DAY = 24 * 60 * 60 * 1000;

/** The page's own table, restated here so a change to it fails this suite. */
const EXPECTED_COPY: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PUBLISHED: { label: 'Live', tone: 'ok' },
  LOCKED: { label: 'Locked in', tone: 'ok' },
  CAPTURED: { label: 'Charged', tone: 'ok' },
  PICKUP_OPEN: { label: 'Pickup open', tone: 'ok' },
  COMPLETED: { label: 'Done', tone: 'neutral' },
  FAILED: { label: 'Did not fill', tone: 'blocked' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

async function makeMerchant(slugSuffix: string, name: string): Promise<string> {
  const merchant = await prisma.merchant.create({
    data: {
      name,
      slug: `${PREFIX}${slugSuffix}`,
      status: 'PENDING',
      floorPctOfMenu: 0.25,
      timezone: 'America/Edmonton',
    },
    select: { id: true },
  });
  return merchant.id;
}

async function makeOwner(emailSuffix: string, merchantId: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${emailSuffix}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  await prisma.merchantUser.create({ data: { merchantId, userId: user.id, role: 'OWNER' } });
  return user.id;
}

async function makeDish(merchantId: string, name: string, overrides: Record<string, unknown> = {}) {
  const item = await prisma.menuItem.create({
    data: {
      merchantId,
      name,
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      batchYield: 30,
      prepMinutes: 6,
      category: 'Bowls',
      ...overrides,
    },
    select: { id: true },
  });
  createdItemIds.push(item.id);
  return item.id;
}

/**
 * A drop at one status.
 *
 * `createdAt` is set explicitly rather than left to `@default(now())`, because the page orders
 * by `createdAt desc` and rows written in the same millisecond would make the ordering
 * assertion a coin toss.
 *
 * The first row written gets the **oldest** timestamp and each later one is newer, so
 * insertion order and `createdAt` order agree and the list is predictable: `writtenLast` must
 * appear first. `orderBy` is still the thing under test — dropping it yields `createdAt` order
 * from Postgres's own default, which is not insertion order — but a fixture where the two
 * disagree would make the assertion a test of my arithmetic rather than of the query.
 */
let minuteOffset = 0;
async function makeDrop(args: {
  merchantId: string;
  menuItemId: string;
  title: string;
  status?: string;
  minQty?: number;
  dealPriceCents?: number;
}): Promise<string> {
  minuteOffset += 1;
  const drop = await prisma.drop.create({
    data: {
      merchantId: args.merchantId,
      menuItemId: args.menuItemId,
      title: args.title,
      dealPriceCents: args.dealPriceCents ?? 1112,
      minQty: args.minQty ?? 20,
      maxQty: 30,
      maxPerCustomer: 4,
      publicCode: `${PREFIX}${Math.random().toString(36).slice(2, 10)}`,
      cutoffAt: new Date(Date.now() + 3 * DAY),
      windowStart: new Date(Date.now() + 4 * DAY),
      windowEnd: new Date(Date.now() + 4 * DAY + 2 * 60 * 60 * 1000),
      status: (args.status ?? 'DRAFT') as never,
      guardrailSnapshot: {},
      // Older as the loop advances, so the *last* row created is the newest.
      createdAt: new Date(Date.now() - (1000 - minuteOffset) * 60 * 1000),
    },
    select: { id: true },
  });
  createdDropIds.push(drop.id);
  return drop.id;
}

beforeAll(async () => {
  ids.merchantId = await makeMerchant('', 'Copper Kettle');
  ids.bareMerchantId = await makeMerchant('-bare', 'Empty Pantry');
  ids.userId = await makeOwner('owner', ids.merchantId);
  ids.bareUserId = await makeOwner('bare', ids.bareMerchantId);

  ids.dish = await makeDish(ids.merchantId, 'Beef Bowl');

  // Order matters: `oldest` is written first so it ends up last in the list, which is what
  // makes the ordering assertion meaningful rather than a restatement of insertion order.
  ids.oldest = await makeDrop({
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Written First',
  });

  for (const [status, copy] of Object.entries(EXPECTED_COPY)) {
    ids.byStatus[status] = await makeDrop({
      merchantId: ids.merchantId,
      menuItemId: ids.dish,
      title: `Status ${status}`,
    });
    // Set the status in a second statement so the enum cast is in one place.
    await prisma.drop.update({
      where: { id: ids.byStatus[status]! },
      data: { status: status as never },
    });
    expect(copy.label.length).toBeGreaterThan(0);
  }

  ids.newest = await makeDrop({
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Written Last',
    minQty: 12,
    dealPriceCents: 1499,
  });

  sessionState.session = { userId: ids.userId, role: 'MERCHANT', mustChangePassword: false };
});

afterAll(async () => {
  if (createdDropIds.length > 0) {
    await prisma.dropParticipant.deleteMany({ where: { dropId: { in: createdDropIds } } });
    await prisma.drop.deleteMany({ where: { id: { in: createdDropIds } } });
  }
  if (createdItemIds.length > 0) {
    await prisma.menuItem.deleteMany({ where: { id: { in: createdItemIds } } });
  }
  await prisma.merchantUser.deleteMany({
    where: { merchantId: { in: [ids.merchantId, ids.bareMerchantId].filter(Boolean) } },
  });
  await prisma.merchant.deleteMany({
    where: { id: { in: [ids.merchantId, ids.bareMerchantId].filter(Boolean) } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [ids.userId, ids.bareUserId].filter(Boolean) } },
  });
});

/** Render the page as whoever `userId` names. */
async function render(userId: string): Promise<{ html: string; text: string }> {
  const previous = sessionState.session;
  sessionState.session = { userId, role: 'MERCHANT', mustChangePassword: false };
  try {
    const page = await import('@/app/(merchant)/merchant/drops/page');
    const html = await renderToHtml(await page.default());
    return { html, text: textOf(html) };
  } finally {
    sessionState.session = previous;
  }
}

/**
 * The `<li>` for one drop, as HTML.
 *
 * Scoped by the href, the only unique thing in the markup: every card also carries a status
 * badge, and several carry `Draft`. A page-wide `toContain('Locked in')` would pass on a page
 * that badge every row the same way.
 */
function cardFor(html: string, dropId: string): string {
  for (const match of html.matchAll(/<li\b[\s\S]*?<\/li>/g)) {
    if (match[0].includes(`/merchant/drops/${dropId}`)) {
      return match[0];
    }
  }
  throw new Error(`No <li> links to ${dropId}`);
}

function textFor(html: string, dropId: string): string {
  return textOf(cardFor(html, dropId));
}

/**
 * The badge's own text, for one card.
 *
 * Needed because a card's text also contains the drop's title, and a fixture titled
 * "Status DRAFT" would satisfy — or defeat — an assertion about the badge. Every assertion
 * that is *about the badge* uses this; every other one uses `textFor`.
 */
function badgeTextFor(html: string, dropId: string): string {
  const card = cardFor(html, dropId);
  const badge = /<span\b[^>]*class="[^"]*rounded-full[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(card);
  if (!badge) {
    throw new Error(`No badge in the card for ${dropId}`);
  }
  return textOf(badge[1] ?? '');
}

describe('/merchant/drops — the list', () => {
  it('badges every status with its own label, none of them the raw enum', async () => {
    const { html } = await render(ids.userId);

    for (const [status, copy] of Object.entries(EXPECTED_COPY)) {
      const text = textFor(html, ids.byStatus[status]!);
      expect(text).toContain(copy.label);
      // The fallback arm prints the enum. Asserting the absence per card is what makes a
      // new status with no `STATUS_COPY` entry fail here rather than ship as `PICKUP_OPEN`.
      //
      // Scoped to the badge **element**, not the card's text. The first version compared the
      // whole card against the bare status string and failed on `DRAFT` — because the fixture
      // is titled "Status DRAFT", and `DRAFT` is literally inside the title it was asserting
      // against. That is a test measuring its own fixture. The badge is a single element, so
      // matching it directly is both narrower and possible.
      if (copy.label !== status) {
        expect(badgeTextFor(html, ids.byStatus[status]!)).not.toContain(status);
      }
    }
  });

  it('marks the unhappy status as the only blocked one', async () => {
    const { html } = await render(ids.userId);

    // `FAILED` is the single blocked tone in the table, and it is the row a merchant most
    // needs to recognise at a glance — a drop that did not fill. `text-blocked` is the class
    // the badge emits for that tone, so this asserts the tone and not just the word.
    expect(cardFor(html, ids.byStatus.FAILED!)).toContain('Did not fill');
    expect(cardFor(html, ids.byStatus.FAILED!)).toContain('text-blocked');

    for (const status of ['DRAFT', 'PUBLISHED', 'CAPTURED', 'COMPLETED', 'CANCELLED'] as const) {
      expect(cardFor(html, ids.byStatus[status]!)).not.toContain('text-blocked');
    }
  });

  it('shows each drop’s own dish, price and minimum quantity', async () => {
    const { html } = await render(ids.userId);

    // The deal price, not the menu price: this list is about drops, and $14.99 is only on
    // this one row.
    const newest = textFor(html, ids.newest);
    expect(newest).toContain('Written Last');
    expect(newest).toContain(formatCents(1499));
    expect(newest).toContain('need 12');
    expect(newest).toContain('Beef Bowl');

    // And a different row has different values, so nothing above is a constant.
    const oldest = textFor(html, ids.oldest);
    expect(oldest).toContain(formatCents(1112));
    expect(oldest).toContain('need 20');
    expect(oldest).not.toContain(formatCents(1499));
  });

  it('orders newest first, from createdAt rather than insertion order', async () => {
    const { html } = await render(ids.userId);

    // `listDrops` asks for `createdAt: 'desc'`. The two plain drafts were written first and
    // last in setup, so a `findMany` that lost its `orderBy` returns them in insert order and
    // fails here. Everything else in the list is between them.
    expect(html.indexOf(`/merchant/drops/${ids.newest}`)).toBeLessThan(
      html.indexOf(`/merchant/drops/${ids.oldest}`),
    );
  });

  it('links every card to its own drop page, and offers a new drop', async () => {
    const { html, text } = await render(ids.userId);

    for (const dropId of createdDropIds) {
      expect(html).toContain(`/merchant/drops/${dropId}`);
    }
    expect(html).toContain('/merchant/drops/new');
    expect(text).toContain('New drop');
    // Not the "add a dish" path: this merchant has a batchable dish.
    expect(text).not.toContain('Add a dish first');
  });

  it('names an archived dish, which is the only way a drop can outlive its dish', async () => {
    // The first version of this test deleted the dish and expected `'Dish removed'` to appear.
    // It could not: `Drop.menuItem` has no `onDelete` clause, so Postgres refuses the delete
    // outright — `Drop_menuItemId_fkey` — and a dish with any drop is undeletable by
    // construction. The fixture was modelling an impossible state.
    //
    // What *is* reachable is archiving. `listItems` filters `archivedAt: null`, so an archived
    // dish vanishes from the map the page builds, and the `?? 'Dish removed'` fallback is what
    // a merchant sees on a drop whose dish they retired. That is the real path, and this test
    // now models it.
    // Names chosen so neither is a substring of the other, nor of the fallback copy. The
    // first attempt used dish `Retired Dish` under title `Its Dish Is Retired`, and the card
    // reads "... Is Retired" + "Dish removed" — which contains "Retired Dish" across the
    // boundary and made `not.toContain` fail on a page that was behaving correctly.
    const doomedDish = await makeDish(ids.merchantId, 'Aubergine Parm');
    const orphaned = await makeDrop({
      merchantId: ids.merchantId,
      menuItemId: doomedDish,
      title: 'A Drop Whose Dish Went Away',
    });

    try {
      await prisma.menuItem.update({
        where: { id: doomedDish },
        data: { archivedAt: new Date() },
      });

      const { html } = await render(ids.userId);
      expect(textFor(html, orphaned)).toContain('Dish removed');
      // And not the dish's name, which is the positive half: the page is reading the filtered
      // list rather than the row's own join.
      expect(textFor(html, orphaned)).not.toContain('Aubergine Parm');
    } finally {
      await prisma.drop.deleteMany({ where: { id: orphaned } });
      await prisma.menuItem.deleteMany({ where: { id: doomedDish } });
      const index = createdItemIds.indexOf(doomedDish);
      if (index >= 0) {
        createdItemIds.splice(index, 1);
      }
      const dropIndex = createdDropIds.indexOf(orphaned);
      if (dropIndex >= 0) {
        createdDropIds.splice(dropIndex, 1);
      }
    }
  });
});

describe('/merchant/drops — a merchant who cannot start a drop', () => {
  it('offers to add a dish and explains why, instead of a dead new-drop button', async () => {
    const { html, text } = await render(ids.bareUserId);

    // This merchant has no dishes at all. `hasBatchableDish` is false, so the header action
    // changes and the empty state names the reason. Sending them to `/merchant/drops/new`
    // would land on "No dish can be a drop yet", which is the same information one click
    // later and phrased as a refusal.
    expect(text).toContain('Add a dish first');
    expect(text).not.toContain('New drop');

    // The label is only half of it. A branch that rewords the button but leaves the href on
    // `/merchant/drops/new` reads correctly in `text` and is still the dead end this branch
    // exists to prevent — so the destination is asserted too. `text` cannot see an href, and
    // this is exactly the gap that widened when the destructured `html` went unused.
    expect(html).toContain('href="/merchant/items/new"');
    expect(html).not.toContain('href="/merchant/drops/new"');

    expect(text).toContain('No drops yet.');
    expect(text).toContain('A drop needs a dish you can make in batches.');
    // The *other* empty-state sentence, which only a merchant with a dish should read.
    expect(text).not.toContain('A drop is a batch of one dish, sold in advance to a group');
  });

  it('offers the new-drop button to a merchant with a dish, and explains what a drop is', async () => {
    // The complement, so the two empty states are proved distinct rather than one assertion
    // standing in for both. A third merchant with a dish but no drops.
    const withDishMerchantId = await makeMerchant('-withdish', 'Has A Dish');
    const withDishUserId = await makeOwner('withdish', withDishMerchantId);
    const dish = await makeDish(withDishMerchantId, 'Solo Dish');

    try {
      const { html, text } = await render(withDishUserId);

      expect(text).toContain('New drop');
      expect(text).not.toContain('Add a dish first');
      // The complement of the href assertion above: a merchant who *can* start a drop is sent
      // to the drop form, not back to the dish form. Both tests check both hrefs, so swapping
      // the two destinations fails twice rather than passing on a page that renders one label.
      expect(html).toContain('href="/merchant/drops/new"');
      expect(html).not.toContain('href="/merchant/items/new"');
      expect(text).toContain('No drops yet.');
      expect(text).toContain('A drop is a batch of one dish, sold in advance to a group');
      expect(text).not.toContain('A drop needs a dish you can make in batches.');
      expect(dish).toBeTruthy();
    } finally {
      await prisma.merchantUser.deleteMany({ where: { merchantId: withDishMerchantId } });
      // `Merchant.delete` cascades the dish; do it explicitly so teardown is visible.
      await prisma.menuItem.deleteMany({ where: { merchantId: withDishMerchantId } });
      await prisma.merchant.delete({ where: { id: withDishMerchantId } });
      await prisma.user.deleteMany({ where: { id: withDishUserId } });
    }
  });
});

describe('/merchant/drops — a merchant with drops', () => {
  it('renders no empty-state card at all, in either of its two forms', async () => {
    // The empty state is a `drops.length === 0` branch, and both of its sentences are
    // specific enough to assert the absence of. A page that rendered the card
    // unconditionally — the mutation probe E caught on `/merchant/drops/[id]` — would put
    // "No drops yet." above a list of nine drops.
    const { text } = await render(ids.userId);

    expect(text).not.toContain('No drops yet.');
    expect(text).not.toContain('A drop is a batch of one dish');
    expect(text).not.toContain('A drop needs a dish you can make in batches.');

    // And the list really is there, so this is not passing on a blank page.
    expect(text).toContain('Written Last');
    expect(text).toContain('Written First');
  });
});
