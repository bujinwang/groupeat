import 'dotenv/config';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDraft, markPublished } from '@/lib/db/drops';
import { createItem } from '@/lib/db/items';
import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, buildGuardrailSnapshot, formatCents } from '@/lib/guardrail';
import { renderToHtml } from '@/lib/testing/render';

/**
 * `src/app/d/[publicCode]/opengraph-image.tsx` — FR-308, the P0 launch blocker.
 *
 * > `FR-308 | Share preview card | 1200×630, dish + price + pickup | P0`
 *
 * ## Why this file, when every page and route has a suite
 *
 * A V8 coverage run over the whole suite found exactly **eight source files with
 * zero executed statements**. Four are type-only, barrels or a keyless real port;
 * this is the largest of the four that are real runtime code. It is also the one
 * the PRD calls the launch blocker, and its own docblock says why: *"A broken link
 * preview kills distribution."* There is no feed and no discovery — a drop spreads
 * because somebody pastes a URL into a group chat, and this image is the only thing
 * the other forty people see before deciding to tap.
 *
 * It had never rendered once. A card that printed the wrong price, the wrong
 * pickup hour, or omitted "nobody is charged" would have shipped to WhatsApp and
 * WeChat with the entire 2339-test suite green, because no test imported the
 * module. This is the same shape as the count route's payload: a **client** (the
 * social crawler) reads these strings literally, and nothing on the server can
 * see a field that is missing.
 *
 * ## What is replaced, and what is real
 *
 * `next/og`'s `ImageResponse` is replaced by a capturing stub — it needs WASM and
 * a real image encoder, neither of which is the subject. Everything else is
 * production code against real rows: `getPublicDrop`'s scoped query, the frozen
 * `guardrailSnapshot` reader, `formatCents`, and `Intl.DateTimeFormat`. The
 * assertions read the React element tree the stub receives, which is exactly the
 * input the real `ImageResponse` would rasterise.
 *
 * ## The two claims a value comparison cannot make
 *
 *   1. **The "was" price is frozen, not current.** The fixture's snapshot says
 *      `$20.00` while the dish's `menuPriceCents` today is `$16.00`. The card must
 *      print the snapshot. A future refactor that reached for the menu item would
 *      advertise a price the merchant never agreed to.
 *   2. **The pickup hour is the merchant's zone, not the host's.** The host is
 *      `America/Edmonton` (UTC−6 year-round since 2026-11-01); the fixture is
 *      `America/Toronto` (UTC−5 in November), so a label formatted in the host
 *      zone is exactly one hour out. Asserted against `Intl` recomputation AND a
 *      literal, so a shared-function import cannot satisfy the test alone.
 */

/** Every `new ImageResponse(element, options)` the module makes. */
const captured = vi.hoisted(
  () => [] as { element: unknown; options: unknown }[],
);

vi.mock('next/og', () => ({
  ImageResponse: class ImageResponse {
    constructor(element: unknown, options: unknown) {
      captured.push({ element, options });
    }
  },
}));

const og = await import('../opengraph-image');

const PREFIX = `ogimg-${Date.now().toString(36).slice(-6)}`;
const HOUR = 60 * 60 * 1000;

const merchantIds: string[] = [];
const userIds: string[] = [];

let itemId = '';
/** A published, public drop in Toronto; merchant name differs from the dish. */
let liveCode = '';
/** A published drop whose merchant is named after its own dish. */
let sameNameCode = '';
/** A DRAFT — invisible to `getPublicDrop`, like a code that was never issued. */
let draftCode = '';

const FROZEN_MENU_PRICE_CENTS = 2000;
const CURRENT_MENU_PRICE_CENTS = 1600;
const DEAL_PRICE_CENTS = 1310;
const MIN_QTY = 8;
/** Fixed instant: 23:00Z → 6:00 PM in Toronto (UTC−5), 5:00 PM in Edmonton. */
const WINDOW_START = new Date('2026-11-10T23:00:00Z');

function timing() {
  return {
    cutoffAt: new Date(Date.now() + 24 * HOUR),
    windowStart: WINDOW_START,
    windowEnd: new Date(WINDOW_START.getTime() + 2 * HOUR),
  };
}

function context(code: string): { params: Promise<{ publicCode: string }> } {
  return { params: Promise.resolve({ publicCode: code }) };
}

/** Calls the endpoint and returns the ONE element tree it handed to `ImageResponse`. */
async function renderCard(code: string): Promise<{ element: unknown; options: unknown }> {
  captured.length = 0;
  await og.default(context(code));
  expect(captured).toHaveLength(1);
  const first = captured[0];
  if (!first) {
    throw new Error('ImageResponse was never constructed');
  }
  return first;
}

/** Flattens a React element tree to the strings a crawler would rasterise. */
function textsOf(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textsOf);
  if (typeof node === 'object' && 'props' in node) {
    const element = node as { props?: { children?: unknown } };
    return textsOf(element.props?.children);
  }
  return [];
}

function textOf(element: unknown): string {
  /**
   * `join('')`, not `join(' ')`: adjacent JSX text nodes concatenate in a DOM
   * `textContent` with no separator. `Pickup {pickup}` is two nodes, and joining
   * them with a space produced "Pickup  Tuesday 6:00 PM" — a false failure that
   * would have sent a reader hunting for a bug in `Intl` instead of in the
   * helper. The flex layout separates the spans visually, not in the text.
   */
  return textsOf(element).join('');
}

/** All `style` objects in the tree, for the layout/typography assertions. */
function stylesOf(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) stylesOf(child, out);
    return out;
  }
  if ('props' in node) {
    const element = node as {
      props?: { style?: Record<string, unknown>; children?: unknown };
    };
    if (element.props?.style) out.push(element.props.style);
    stylesOf(element.props?.children, out);
  }
  return out;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  userIds.push(owner.id);

  const merchant = await prisma.merchant.create({
    data: {
      name: 'North Bowl Kitchen',
      slug: `${PREFIX}-slug`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      timezone: 'America/Toronto',
      pickupAddress: '2915 10 Ave NE, Calgary',
      pickupInstructions: 'Side door.',
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantIds.push(merchant.id);

  const item = await createItem([merchant.id], {
    name: 'Beef Bowl',
    description: null,
    menuPriceCents: CURRENT_MENU_PRICE_CENTS,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });
  itemId = item.id;

  // The snapshot is the price AS IT WAS WHEN PUBLISHED — deliberately different
  // from the dish's current $16.00, so a card that read the live menu item would
  // be caught. `frozenMenuPrice` in public-drops.ts reads `input.menuPriceCents`.
  const snapshot = buildGuardrailSnapshot(
    {
      ...DEFAULT_FEES,
      menuPriceCents: FROZEN_MENU_PRICE_CENTS,
      foodCostCents: 480,
      packagingCents: 80,
      floorPctOfMenu: 0.25,
    },
    DEAL_PRICE_CENTS,
    new Date().toISOString(),
  );

  const base = {
    menuItemId: itemId,
    description: null,
    heroImageUrl: null,
    dealPriceCents: DEAL_PRICE_CENTS,
    minQty: MIN_QTY,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  };

  const live = await createDraft([merchant.id], { ...base, title: `${PREFIX} lunch` });
  liveCode = live.publicCode;
  await markPublished({ id: live.id, publishedAt: new Date(), guardrailSnapshot: snapshot });

  const draft = await createDraft([merchant.id], { ...base, title: `${PREFIX} draft` });
  draftCode = draft.publicCode;

  // A second merchant named after its own dish, to reach the `showMerchant` arm
  // that suppresses the duplicate name.
  const selfNamed = await prisma.merchant.create({
    data: {
      name: 'Beef Bowl',
      slug: `${PREFIX}-self-slug`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      timezone: 'America/Toronto',
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantIds.push(selfNamed.id);
  const selfItem = await createItem([selfNamed.id], {
    name: 'beef bowl',
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });
  const sameNamed = await createDraft([selfNamed.id], {
    ...base,
    menuItemId: selfItem.id,
    title: `${PREFIX} self-named`,
  });
  sameNameCode = sameNamed.publicCode;
  await markPublished({ id: sameNamed.id, publishedAt: new Date(), guardrailSnapshot: snapshot });
});

beforeEach(() => {
  captured.length = 0;
});

afterAll(async () => {
  if (merchantIds.length > 0) {
    await prisma.order
      .deleteMany({ where: { drop: { merchantId: { in: merchantIds } } } })
      .catch(() => undefined);
    await prisma.drop
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
    await prisma.menuItem
      .deleteMany({ where: { merchantId: { in: merchantIds } } })
      .catch(() => undefined);
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('FR-308 · the card contract', () => {
  it('is a 1200×630 PNG with an alt text, and passes the size to ImageResponse', async () => {
    expect(og.size).toEqual({ width: 1200, height: 630 });
    expect(og.contentType).toBe('image/png');
    expect(og.alt).toBe('A GroupEat batch order');

    const card = await renderCard(liveCode);
    expect(card.options).toEqual({ width: 1200, height: 630 });
  });

  it('carries exactly the three facts that make the tap decision', async () => {
    const card = await renderCard(liveCode);
    const text = textOf(card.element);

    // What: the dish and the merchant.
    expect(text).toContain('Beef Bowl');
    expect(text).toContain('North Bowl Kitchen');
    expect(text).toContain('GroupEat');
    // How much: the deal and the "was" price.
    expect(text).toContain(formatCents(DEAL_PRICE_CENTS));
    expect(text).toContain(formatCents(FROZEN_MENU_PRICE_CENTS));
    expect(text).toContain('a plate, was');
    // When, and the P0 money sentence FR-306 requires to be explicit.
    expect(text).toContain('Pickup');
    expect(text).toContain(`${MIN_QTY} orders or nobody is charged`);
  });

  it('prints the FROZEN menu price, not the dish price today', async () => {
    /**
     * The fixture's snapshot says $20.00; `MenuItem.menuPriceCents` is $16.00.
     * `getPublicDrop` resolves the frozen value from the snapshot. A card that
     * reached for the live item would print $16.00 and advertise a discount the
     * merchant never agreed to — the docblock's stated reason for using the same
     * query the page uses.
     */
    const text = textOf((await renderCard(liveCode)).element);
    expect(text).toContain(formatCents(FROZEN_MENU_PRICE_CENTS));
    expect(text).not.toContain(formatCents(CURRENT_MENU_PRICE_CENTS));
    // Also against a literal: a shared-function import alone would satisfy the
    // first assertion even if `formatCents` itself changed.
    expect(text).toContain('$20.00');
    expect(text).toContain('$13.10');
  });

  it('renders the price at 132px so it is legible in a phone thumbnail', async () => {
    // FR-308's "at a size legible on a phone thumbnail" is a layout decision,
    // not a string. Asserted here so shrinking the headline to body text fails.
    const styles = stylesOf((await renderCard(liveCode)).element);
    expect(styles.some((style) => style.fontSize === 132)).toBe(true);
    expect(styles.some((style) => style.background === '#0f7b4f')).toBe(true);
  });

  it('formats pickup in the merchant zone, not the host zone', async () => {
    /**
     * Host is America/Edmonton (UTC−6 since Alberta's permanent DST on
     * 2026-11-01); the merchant is America/Toronto (UTC−5 in November).
     * 23:00Z is 6:00 PM in the merchant's zone and 5:00 PM in the host's, so a
     * card that dropped `timeZone` prints a pickup hour that is an hour early —
     * on the one artefact a diner uses to decide whether they can make it.
     */
    const text = textOf((await renderCard(liveCode)).element);

    const recomputed = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Toronto',
    }).format(WINDOW_START);

    expect(text).toContain(`Pickup ${recomputed}`);
    expect(text).toContain('6:00 PM');
    expect(text).not.toContain('5:00 PM');
  });

  it('does not print the merchant name when it is the dish name', async () => {
    const normal = textOf((await renderCard(liveCode)).element);
    expect(normal).toContain('North Bowl Kitchen');

    // Case- and whitespace-insensitive: `showMerchant` trims and lowercases both.
    const selfNamed = textOf((await renderCard(sameNameCode)).element);
    expect(selfNamed).not.toContain('Beef Bowl Kitchen');
    const merchantLabel = textsOf((await renderCard(sameNameCode)).element).filter((t) =>
      t.trim().toLowerCase().includes('beef bowl'),
    );
    // The dish headline still appears once; the merchant label is empty.
    expect(merchantLabel).toHaveLength(1);
  });

  it('leaks no participant, phone, address or organiser information', async () => {
    /**
     * A public, enumerable endpoint whose output is cached by chat apps. The
     * fixture's merchant has a pickup address and instructions, and the public
     * drop row carries them; the card must not. Asserted on the full rendered
     * HTML, not a spot-check of strings.
     */
    const html = await renderToHtml((await renderCard(liveCode)).element as never);
    expect(html).not.toContain('2915 10 Ave');
    expect(html).not.toContain('Side door');
    expect(html).not.toContain('+1403');
    expect(html).not.toContain('@example');
    expect(html).not.toContain('participant');
  });
});

describe('FR-308 · a missing drop is a 200 card that reveals nothing', () => {
  it('answers a card for a code that was never issued', async () => {
    const card = await renderCard(`${PREFIX}-no-such-code`);
    expect(textOf(card.element)).toContain('This drop is not available');
    expect(card.options).toEqual({ width: 1200, height: 630 });
  });

  it('answers the SAME card for a DRAFT, so a 200 cannot enumerate codes', async () => {
    /**
     * The docblock's claim, and the reason it does not 404: a failed image fetch
     * is cached by WhatsApp and renders as a bare URL, which for a drop that did
     * not run is the worst outcome. The two cards must be byte-identical HTML, or
     * the response shape would distinguish "unpublished" from "never existed".
     */
    const unknown = await renderCard(`${PREFIX}-no-such-code`);
    const unknownHtml = await renderToHtml(unknown.element as never);
    const draft = await renderCard(draftCode);
    const draftHtml = await renderToHtml(draft.element as never);

    expect(draftHtml).toBe(unknownHtml);
    expect(draft.options).toEqual(unknown.options);
  });

  it('does not print a price, a date or a dish name on the unavailable card', async () => {
    const text = textOf((await renderCard(draftCode)).element);
    expect(text).toBe('This drop is not available');
  });
});
