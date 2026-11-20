import 'dotenv/config';

import type { Metadata } from 'next';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderWithRouter, textOf } from '@/lib/testing/render';

/**
 * `/d/:publicCode` rendered — the deal page, FR-301…FR-308.
 *
 * ## This is the only page a diner is ever promised
 *
 * No feed, no discovery, no account: the page is reached by a pasted URL in a group chat, and
 * it has one job after the tap. So the assertions here are about what a stranger with no
 * session and no JavaScript reads, and the two claims worth stating before the tests:
 *
 *   1. **The "was" price is the frozen one.** It is a price representation under the
 *      Competition Act (PRD-v1 §15.2) and has to be the price true when the offer was struck —
 *      not what the merchant typed into the dish this morning. `getPublicDrop` reads it from
 *      `guardrailSnapshot`; this suite renders a dish whose *current* price has been changed
 *      after publication, so a page that read the dish would print the wrong number.
 *   2. **The join gate and the button cannot disagree.** `resolveJoinGate` is unit-tested;
 *      what is not, until here, is that the page renders the *right one of its two blocked
 *      sentences* — "cannot take card payments" versus "not taking joins yet" — because they
 *      describe different facts and the second is a lie about the first.
 *
 * ## Why `renderWithRouter` and not `renderToHtml`
 *
 * `CountPoller` is a client component that calls `useRouter()`, and `next/navigation` throws
 * *"expected app router to be mounted"* when the context is absent. This page therefore
 * cannot be rendered by the plain entry point — same blocking case as `/admin/drops`. The
 * poller renders its **initial** snapshot, which is the server's, so the headline, the
 * progress bar's `aria-valuenow` and the scarcity line are all the server's numbers.
 *
 * `generateMetadata` is called separately and asserted on its return value: it is an exported
 * function whose whole output is the link preview, which is the entire funnel (FR-308).
 *
 * ## What nothing here can reach
 *
 * `CountPoller`'s 15-second poll, its phase-change `router.refresh()`, and the join button's
 * navigation are all browser behaviour. `record()` writes a funnel event to a sink; the page
 * calls it, and this suite asserts the page renders, not that the sink was written — that is
 * `funnel.test.ts` and `events.test.ts`. `JOIN_FLOW_PROVEN_LIVE` is a module constant set to
 * `false`, so the *offered* join button (`joinGate.offerJoin === true`) is unreachable in this
 * build for a reason no fixture can change; the two blocked shapes are what the page can show,
 * and both are asserted.
 */

vi.mock('server-only', () => ({}));

const sessionState = vi.hoisted(() => ({
  session: null as { userId: string; role: string; mustChangePassword: boolean } | null,
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => sessionState.session,
}));

const recordedEvents = vi.hoisted(() => [] as { event: string; payload: unknown }[]);

vi.mock('@/lib/analytics/record-funnel', () => ({
  record: (event: { event: string; payload: unknown } | null) => {
    if (event) recordedEvents.push(event);
  },
}));

// The page reads `headers()` for two things: the funnel event's `isHumanView` gate and the
// share-link click gate. A per-test holder keeps both controllable without re-mocking.
//
// `countShareLinkClick` is deliberately **not** mocked: it writes a column this suite reads
// back, so the click assertions measure the real write path rather than a stub's call log.
const requestHeaders = vi.hoisted(() => ({ headers: new Map<string, string>() }));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => requestHeaders.headers.get(name) ?? null,
  }),
}));

const { prisma } = await import('@/lib/db/prisma');
const { createItem } = await import('@/lib/db/items');
const { DEFAULT_FEES, buildGuardrailSnapshot, formatCents } = await import('@/lib/guardrail');
const { ensureShareLink } = await import('@/lib/db/share-links');
const { SHARE_TOKEN_PARAM } = await import('@/lib/organisers/share-link');

const PREFIX = `dealpage${Date.now().toString(36).slice(-5)}`;
const HOUR = 60 * 60 * 1000;

/**
 * A monotonic counter behind the diner phone numbers, because a random draw collided.
 *
 * `phone` is `@unique` on `Customer`, and this helper used
 * `Math.floor(Math.random() * 9000 + 1000)` — a space of 9000 values. Two draws per
 * `makeDrop` (a 'Diner' and a 'Paid Diner'), roughly ten makes per run, so about twenty
 * draws from 9000: the birthday probability of at least one collision is ~2%. It failed one
 * full run of 153 files with `Unique constraint failed on the fields: (phone)`, in a file
 * whose own tests all passed when it was run alone — eight isolated runs in a row were
 * green.
 *
 * A counter has no collision probability at all, which is the point. This is the same
 * defect as the `paymentIntentId` flake in the M9 reports suite, and the same fix: **a
 * random value is not a sequence**, and the id must be unique rather than unlikely to
 * repeat. `Date.now()` is not an option here either — it is not a counter, as that flake
 * also proved.
 */
let dinerSeq = 0;

function nextDinerPhone(): string {
  dinerSeq += 1;
  return `+1403555${String(dinerSeq).padStart(4, '0')}`;
}

const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];
const createdDropIds: string[] = [];
const createdCustomerIds: string[] = [];
const createdShareLinkIds: string[] = [];

/** Menu $16.00, deal $13.10, 25% floor — vector A's numbers, as elsewhere. */
const MENU = 1600;
const DEAL = 1310;

/**
 * The frozen price is $16.00 and the dish is later edited to $22.00, so "was $16.00" and
 * "was $22.00" cannot both be right. Only the snapshot is the published truth.
 */
const MENU_AFTER_EDIT = 2200;

const ids = {
  merchant: '',
  item: '',
  /** Open, 6 of 20 in — not yet confirmed, joinable in principle. */
  open: '',
  /** 22 of 20 in and still open: ADR-003, a confirmed drop keeps filling. */
  confirmed: '',
  /** Threshold not met, cutoff passed → `FAILED`, nobody charged. */
  failed: '',
  /** Called off after orders were captured → the refunded sentence. */
  cancelledPaid: '',
  /** Called off before anything was charged → the released-hold sentence. */
  cancelledUnpaid: '',
  /** Everything claimed, still before the cutoff → `SOLD_OUT`. */
  soldOut: '',
  /** Cutoff passed with the threshold met but not yet settled → `settling`. */
  settling: '',
  /** A `DRAFT` — invisible to the public read path. */
  draft: '',
  /**
   * Deal price equal to the menu price, so `discountPct === 0` and the badge's `> 0` guard
   * has a false arm. Without it, mutating `> 0` to `>= 0` renders "0% off $16.00" and every
   * test stays green — found by probe N surviving.
   */
  noDiscount: '',
};

/** The organiser's token for `ids.open`, created in `beforeAll`. */
let shareToken = '';

/** The owner account for `ids.merchant`, used by FR-206's preview tests. */
let ownerUserId = '';

/** A dish, then a drop on it, in whatever state the caller wants after publication. */
async function makeDrop(args: {
  title: string;
  minQty: number;
  maxQty: number;
  joinedQty?: number;
  status?: 'PUBLISHED' | 'FAILED' | 'CANCELLED';
  cutoffOffsetHours?: number;
  windowOffsetHours?: number;
  hasOrder?: boolean;
  /** Defaults to the shared `DEAL`; overridden only by the no-discount fixture. */
  dealPriceCents?: number;
  description?: string | null;
  heroImageUrl?: string | null;
}): Promise<string> {
  const now = Date.now();
  const cutoffOffset = args.cutoffOffsetHours ?? 24;
  const windowOffset = args.windowOffsetHours ?? 26;

  // `Drop.guardrailSnapshot` is a non-nullable `Json`, so it is written in the same insert
  // as everything else rather than patched in afterwards. That is also honest about the
  // schema: a drop without a frozen snapshot cannot exist, which is what makes the "was
  // $X.XX" price a fact rather than a hope.
  const guardrailInput = {
    ...DEFAULT_FEES,
    menuPriceCents: MENU,
    foodCostCents: 480,
    packagingCents: 80,
    floorPctOfMenu: 0.25,
  };
  const snapshot = buildGuardrailSnapshot(guardrailInput, DEAL, new Date(now).toISOString());

  const draft = await prisma.drop.create({
    data: {
      merchantId: ids.merchant,
      menuItemId: ids.item,
      // `publicCode` is `@unique` and generated by `generatePublicCode()` in production; a
      // random suffix here keeps parallel runs from colliding without importing the
      // generator, whose own suite covers its shape.
      publicCode: `${PREFIX}${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
      title: args.title,
      description: args.description ?? null,
      heroImageUrl: args.heroImageUrl ?? null,
      dealPriceCents: args.dealPriceCents ?? DEAL,
      minQty: args.minQty,
      maxQty: args.maxQty,
      maxPerCustomer: 4,
      status: args.status ?? 'PUBLISHED',
      publishedAt: new Date(now - HOUR),
      guardrailSnapshot: snapshot,
      cutoffAt: new Date(now + cutoffOffset * HOUR),
      windowStart: new Date(now + windowOffset * HOUR),
      windowEnd: new Date(now + (windowOffset + 2) * HOUR),
    },
    select: { id: true, publicCode: true },
  });
  createdDropIds.push(draft.id);

  // Participants: only live authorisations count, which is asserted by
  // `public-drops.test.ts`; here they exist to move `joinedQty`.
  const joinedQty = args.joinedQty ?? 0;
  let participantId: string | null = null;
  if (joinedQty > 0) {
    const customer = await prisma.customer.create({
      data: { phone: nextDinerPhone(), name: 'Diner' },
      select: { id: true },
    });
    createdCustomerIds.push(customer.id);
    const participant = await prisma.dropParticipant.create({
      data: {
        dropId: draft.id,
        customerId: customer.id,
        qty: joinedQty,
        amountCents: (args.dealPriceCents ?? DEAL) * joinedQty,
        platformFeeCents: 100,
        authStatus: 'AUTHORIZED',
      },
      select: { id: true },
    });
    participantId = participant.id;
  }

  // `hadCaptures` is `orders.length > 0` — a row, not an amount, so one is enough.
  //
  // `Order` requires a `participantId` (D-5 made it a real relation, so an order cannot
  // point at a participant that does not exist) plus `unitPriceCents` and `subtotalCents`.
  // The participant above is reused when there is one; otherwise the caller gets a minimal
  // captured participant, because a drop with an order and no participant is a state the
  // schema forbids — a useful thing to find out from Prisma rather than from a fixture that
  // quietly invented it.
  if (args.hasOrder) {
    let orderParticipantId = participantId;
    if (!orderParticipantId) {
      const customer = await prisma.customer.create({
        data: { phone: nextDinerPhone(), name: 'Paid Diner' },
        select: { id: true },
      });
      createdCustomerIds.push(customer.id);
      const participant = await prisma.dropParticipant.create({
        data: {
          dropId: draft.id,
          customerId: customer.id,
          qty: 1,
          amountCents: DEAL,
          platformFeeCents: 100,
          authStatus: 'AUTHORIZED',
        },
        select: { id: true },
      });
      orderParticipantId = participant.id;
    }

    await prisma.order.create({
      data: {
        dropId: draft.id,
        participantId: orderParticipantId,
        qty: 1,
        unitPriceCents: DEAL,
        subtotalCents: DEAL,
        platformFeeCents: 100,
      },
    });
  }

  return draft.publicCode;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  ownerUserId = user.id;

  const merchant = await prisma.merchant.create({
    data: {
      name: 'Copper Kettle',
      slug: PREFIX,
      status: 'ACTIVE',
      floorPctOfMenu: '0.25',
      // Deliberately not the browser's zone, so every time label in the page is a
      // conversion and a page that formatted in the server's zone would print a
      // different hour. `America/Toronto` is two hours ahead of Calgary.
      timezone: 'America/Toronto',
      pickupAddress: '123 10 Ave NE, Calgary',
      pickupInstructions: 'Side door, ring the bell.',
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  ids.merchant = merchant.id;
  createdMerchantIds.push(merchant.id);

  const item = await createItem([merchant.id], {
    name: 'Beef Bowl',
    description: null,
    menuPriceCents: MENU,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });
  ids.item = item.id;

  ids.open = await makeDrop({ title: 'Beef Bowl Thursday', minQty: 20, maxQty: 30, joinedQty: 6 });
  ids.confirmed = await makeDrop({
    title: 'Beef Bowl Confirmed',
    minQty: 20,
    maxQty: 30,
    joinedQty: 22,
    description: 'One batch, cooked to order.',
  });
  ids.failed = await makeDrop({
    title: 'Beef Bowl That Did Not Run',
    minQty: 20,
    maxQty: 30,
    joinedQty: 4,
    status: 'FAILED',
    cutoffOffsetHours: -2,
    windowOffsetHours: -1,
  });
  ids.cancelledPaid = await makeDrop({
    title: 'Beef Bowl Called Off After Orders',
    minQty: 20,
    maxQty: 30,
    joinedQty: 22,
    status: 'CANCELLED',
    cutoffOffsetHours: -2,
    windowOffsetHours: -1,
    hasOrder: true,
  });
  ids.cancelledUnpaid = await makeDrop({
    title: 'Beef Bowl Called Off Before Orders',
    minQty: 20,
    maxQty: 30,
    joinedQty: 3,
    status: 'CANCELLED',
    cutoffOffsetHours: 2,
  });
  ids.soldOut = await makeDrop({
    title: 'Beef Bowl Sold Out',
    minQty: 20,
    maxQty: 30,
    joinedQty: 30,
  });
  ids.settling = await makeDrop({
    title: 'Beef Bowl Settling',
    minQty: 20,
    maxQty: 30,
    joinedQty: 24,
    cutoffOffsetHours: -1,
    windowOffsetHours: 3,
  });
  // Same price as the menu, so the badge's `discountPct > 0` guard is false. The page must
  // then print no badge at all rather than "0% off $16.00".
  ids.noDiscount = await makeDrop({
    title: 'Beef Bowl At Menu Price',
    minQty: 20,
    maxQty: 30,
    joinedQty: 2,
    dealPriceCents: MENU,
  });

  // A draft, created but never published: the public read path must not see it. It still
  // needs a `guardrailSnapshot` because the column is non-nullable — a draft that can never
  // be read publicly still carries the frozen price it would have had.
  const draft = await prisma.drop.create({
    data: {
      merchantId: merchant.id,
      menuItemId: item.id,
      publicCode: `${PREFIX}DRAFT`.toUpperCase(),
      title: 'Not published yet',
      dealPriceCents: DEAL,
      minQty: 20,
      maxQty: 30,
      maxPerCustomer: 4,
      status: 'DRAFT',
      guardrailSnapshot: buildGuardrailSnapshot(
        { ...DEFAULT_FEES, menuPriceCents: MENU, foodCostCents: 480, packagingCents: 80, floorPctOfMenu: 0.25 },
        DEAL,
        new Date().toISOString(),
      ),
      cutoffAt: new Date(Date.now() + 24 * HOUR),
      windowStart: new Date(Date.now() + 26 * HOUR),
      windowEnd: new Date(Date.now() + 28 * HOUR),
    },
    select: { id: true, publicCode: true },
  });
  createdDropIds.push(draft.id);
  ids.draft = draft.publicCode;

  // The dish is edited *after* publication. If the page read the dish instead of the
  // snapshot, every "was $16.00" below would print $22.00 instead.
  await prisma.menuItem.update({
    where: { id: item.id },
    data: { menuPriceCents: MENU_AFTER_EDIT },
  });

  // An organiser with a real link on the open drop, so the join-href assertions and the
  // click counter have something real to read. `ensureShareLink` refuses a drop that is not
  // `PUBLISHED` and before its cutoff, which `ids.open` satisfies by construction.
  const organiserUser = await prisma.user.create({
    data: {
      email: `${PREFIX}-organiser@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  createdUserIds.push(organiserUser.id);
  const profile = await prisma.organiserProfile.create({
    data: { userId: organiserUser.id, displayName: 'Robin Castellanos' },
    select: { id: true },
  });
  const link = await ensureShareLink({
    organiserProfileId: profile.id,
    dropId: (await prisma.drop.findFirst({
      where: { publicCode: ids.open },
      select: { id: true },
    }))!.id,
  });
  shareToken = link!.token;
  const stored = await prisma.shareLink.findUnique({
    where: { token: shareToken },
    select: { id: true },
  });
  createdShareLinkIds.push(stored!.id);
});

afterAll(async () => {
  await prisma.shareLink.deleteMany({ where: { id: { in: createdShareLinkIds } } });
  await prisma.order.deleteMany({ where: { dropId: { in: createdDropIds } } });
  await prisma.dropParticipant.deleteMany({ where: { dropId: { in: createdDropIds } } });
  await prisma.drop.deleteMany({ where: { id: { in: createdDropIds } } });
  await prisma.menuItem.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchantUser.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
});

type RenderArgs = {
  searchParams?: Record<string, string | string[] | undefined>;
  /** Defaults to a navigation request with an ordinary browser UA — a human. */
  headers?: Record<string, string>;
  /** FR-206. The draft preview needs a merchant session; every other test is signed out. */
  preview?: boolean;
  session?: { userId: string; role: string; mustChangePassword: boolean } | null;
};

async function render(
  publicCode: string,
  args: RenderArgs = {},
): Promise<{ html: string; text: string }> {
  requestHeaders.headers = new Map(
    Object.entries(
      args.headers ?? {
        'sec-fetch-mode': 'navigate',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      },
    ),
  );

  sessionState.session = args.session ?? null;
  recordedEvents.length = 0;
  const page = await import('@/app/d/[publicCode]/page');
  const element = await page.default({
    params: Promise.resolve({ publicCode }),
    searchParams: Promise.resolve({
      ...(args.searchParams ?? {}),
      ...(args.preview ? { preview: '1' } : {}),
    }),
  });
  const { html } = await renderWithRouter(element);
  return { html, text: textOf(html) };
}

/**
 * `generateMetadata`'s return value, which is the link preview and nothing else.
 *
 * Typed as the full `Metadata` rather than the three fields the earlier tests read:
 * `openGraph` and `twitter` are now part of the claim (the card-suppression branch),
 * and a narrowed return type here silently turned those assertions into type errors
 * instead of testing anything.
 */
async function metadataFor(publicCode: string, preview = false): Promise<Metadata> {
  const page = await import('@/app/d/[publicCode]/page');
  return page.generateMetadata({
    params: Promise.resolve({ publicCode }),
    ...(preview ? { searchParams: Promise.resolve({ preview: '1' }) } : {}),
  });
}

/** The `href` of the one Join control, which is either an `<a>` or a disabled `<button>`. */
function joinHref(html: string): string | null {
  return /href="(\/d\/[^"]*\/join[^"]*)"/.exec(html)?.[1] ?? null;
}

/** The sentence under the disabled Join button, which is the only paragraph in that block. */
function blockedJoinSentence(html: string): string {
  const block = /<div>\s*<button\b[\s\S]*?<\/button>\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html);
  if (!block) {
    throw new Error('No blocked-join block');
  }
  return textOf(block[1] ?? '');
}

describe('/d/:publicCode — the offer, as a stranger reads it', () => {
  it('prints the merchant, the title and the deal price', async () => {
    const { text } = await render(ids.open);

    expect(text).toContain('Copper Kettle');
    expect(text).toContain('Beef Bowl Thursday');
    expect(text).toContain(formatCents(DEAL));
    expect(text).toContain('a plate');
  });

  it('reads the "was" price from the frozen snapshot, not from the dish', async () => {
    // The dish now costs $22.00. The offer was struck at $16.00, and §15.2 requires the
    // representation to be the price that was true then. A page reading `item.menuPriceCents`
    // prints $22.00 and is a misleading price claim — which is exactly the failure
    // `frozenMenuPrice` exists to prevent, and this is the only place that would show it.
    const { text } = await render(ids.open);

    expect(text).toContain(`off ${formatCents(MENU)}`);
    expect(text).not.toContain(formatCents(MENU_AFTER_EDIT));
    // 18% off: (1600 - 1310) / 1600. Asserted as a number so a page that printed the right
    // prices inside a wrong percentage would still fail.
    expect(text).toContain('18% off');
  });

  it('states the pickup window in the merchant’s zone, not the server’s', async () => {
    const { text, html } = await render(ids.open);

    // The merchant is in Toronto, the server in Calgary. A Thursday 2pm Toronto pickup is
    // noon in Calgary, so a page formatting with the ambient zone prints the wrong hour —
    // and a diner reads the wrong time. The 24-hour default would also print "14:00" against
    // the "2:00 PM" an en-US formatter produces.
    //
    // What is *not* asserted is a fixed hour: the fixture's window is "now + 26h", so the
    // weekday depends on when the suite runs. Pinning a literal would make this test fail at
    // midnight and pass all day, which is worse than not testing it. The assertion that does
    // discriminate the zone is the two-hour gap between the same instant read in Toronto and
    // in the server's zone — compared against an independently computed label below.
    const pickup = /Pickup<\/h2>\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html);
    expect(pickup, 'the Pickup section heading and its first paragraph').not.toBeNull();
    const label = textOf(pickup?.[1] ?? '');

    expect(label).toMatch(/^\w+day, \d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M$/);
    expect(text).toContain('123 10 Ave NE, Calgary');
    expect(text).toContain('Side door, ring the bell.');

    // And it is genuinely the merchant's zone: the same instant rendered in UTC differs from
    // what the page printed, so a page using the server's ambient zone (which is not UTC
    // here) or a hardcoded one cannot produce this label by accident.
    const drop = await prisma.drop.findFirst({
      where: { publicCode: ids.open },
      select: { windowStart: true },
    });
    const inToronto = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Toronto',
    }).format(drop!.windowStart);
    expect(label).toContain(inToronto);
  });

  it('omits the description and address it does not have, and composes a hero', async () => {
    // The other direction: an absent optional must not print `null` or an empty element.
    // FR-205 adds one exception: no photo does not mean no image — the server composes
    // a branded card from the offer.
    const { html, text } = await render(ids.soldOut);

    expect(html).toContain('<img');
    expect(html).toContain('data:image/svg+xml');
    expect(html).toContain('alt="Beef Bowl"');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('prefers a merchant-supplied hero over the generated card', async () => {
    const code = await makeDrop({
      title: 'Custom Hero',
      minQty: 2,
      maxQty: 5,
      heroImageUrl: 'https://images.example/hero.jpg',
    });

    const { html } = await render(code);
    expect(html).toContain('src="https://images.example/hero.jpg"');
    expect(html).not.toContain('data:image/svg+xml');
  });

  it('prints no discount badge when the deal price is the menu price', async () => {
    // `discountPct > 0` — a drop at the menu price saves nothing, and "0% off $16.00" is a
    // badge that says nothing at the loudest spot on the page. Found by probe N: mutating
    // `> 0` to `>= 0` kept every test green because no fixture had a zero discount, so the
    // guard had no false arm to observe.
    const { text } = await render(ids.noDiscount);

    expect(text).not.toContain('0% off');
    expect(text).not.toContain('% off');
    // The price itself is still stated, twice: the deal price and the footer's promise.
    expect(text).toContain(`${formatCents(MENU)} a plate`);
  });

  it('is a 404 for a code that does not exist, with no hint that a draft exists', async () => {
    // Drafts, deleted drops and mistyped codes all produce the same answer, so a guessed
    // code cannot reveal that an unpublished price exists.
    await expect(render(ids.draft)).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
    await expect(render('NOSUCHCODE')).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });
});

describe('/d/:publicCode — the five offer phases', () => {
  it('counts progress while the offer is open', async () => {
    const { text } = await render(ids.open);

    expect(text).toContain('6 of 20 orders in');
  });

  it('says "so far" on a confirmed drop that is still filling', async () => {
    // ADR-003: a confirmed drop keeps taking joins to `maxQty`, so "22 orders" would be a
    // claim about a number still moving — and a merchant reading it would take it as the
    // number to cook. Two words, and they are the whole reason the branch exists.
    const { text } = await render(ids.confirmed);

    expect(text).toContain('Confirmed — 22 orders so far.');
    expect(text).not.toContain('Confirmed — 22 orders.');
    expect(text).toContain('The kitchen is on.');
  });

  it('says nobody was charged on a failed drop, and names the threshold', async () => {
    // FR-306 in its own words. A diner who joined and taps the same link must not read a
    // 404 or a soft sentence.
    const { text } = await render(ids.failed);

    expect(text).toContain("This drop didn't reach 20 — nobody was charged.");
    expect(text).toContain('Nothing was taken from any card. The kitchen is not making this batch.');
  });

  it('distinguishes a cancellation after payment from one before it', async () => {
    // `hadCaptures` is a fact about the `Order` table, not an inference from the status.
    //
    // **This test found a real bug.** `PUBLIC_VISIBLE_STATUSES` did not contain `CANCELLED`,
    // so `getPublicDrop` returned `null` and this page answered 404 to a diner whose order had
    // already been captured and refunded. The page's cancellation copy — `headlineFor`'s
    // branch, the `hadCaptures` paragraph, and two arms of the blocked-join wording — was
    // written and tested at the `resolveDropView` level, and reachable through nothing.
    // Adding `CANCELLED` to the list is the fix; these assertions are what would have caught
    // it, and this comment is here so the connection is not lost if the list is edited again.
    const paid = await render(ids.cancelledPaid);
    const unpaid = await render(ids.cancelledUnpaid);

    expect(paid.text).toContain(
      'This drop was cancelled by the restaurant. Everyone who paid has been refunded in full.',
    );
    expect(paid.text).toContain(
      'The restaurant called this drop off. Your card has been refunded — it usually lands within five business days.',
    );

    expect(unpaid.text).toContain(
      'This drop was cancelled by the restaurant. Nobody was charged, and any hold on your card is released.',
    );
    expect(unpaid.text).toContain(
      'The restaurant called this drop off. Nothing was taken from any card.',
    );
    // The monetary claim, in both directions: a drop that took nothing must not tell a diner
    // they were refunded, and a drop that took money must not say nobody was charged.
    expect(unpaid.text).not.toContain('refunded in full');
    expect(paid.text).not.toContain('Nobody was charged');
  });

  it('says the cards are being charged on a settled-but-unsettled drop', async () => {
    const { text } = await render(ids.settling);

    expect(text).toContain("Confirmed — 24 orders. We're charging cards now.");
    expect(text).toContain('You will get a message as soon as the cards are charged.');
  });
});

describe('/d/:publicCode — the join button, and the two reasons it can be off', () => {
  it('disables the button with the payments reason when no key is configured', async () => {
    // This repo has no `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` by design, so `blockedBy` is
    // `PAYMENTS` — the capability reason, which is the one a diner can verify.
    const { html, text } = await render(ids.open);

    expect(joinHref(html)).toBeNull();
    expect(blockedJoinSentence(html)).toBe(
      'This drop cannot take card payments yet. Nothing has been charged and nothing will be.',
    );
    // The button is still labelled with the price, so the diner knows what they would pay.
    expect(text).toContain(`Join — ${formatCents(DEAL)} a plate`);
  });

  it('names each blocked reason separately, because they are different facts', async () => {
    // `blockedBy` has three values and this build can only reach two of them at this call
    // site: `UNPROVEN` needs a publishable key, and `offerJoin` needs `provenLive`. Asserting
    // that the *other* sentence is absent is what makes the first test load-bearing — a page
    // printing both would pass a `toContain` on either.
    const { html } = await render(ids.open);

    expect(blockedJoinSentence(html)).not.toContain('not taking joins yet');
  });

  it('explains a sold-out drop with the number of plates, not the deadline', async () => {
    const { html, text } = await render(ids.soldOut);

    expect(joinHref(html)).toBeNull();
    expect(text).toContain('All plates claimed');
    expect(blockedJoinSentence(html)).toBe(
      'All 30 plates are claimed. The kitchen is cooking for them.',
    );
  });

  it('tells a diner on a failed drop that nobody was charged, twice over', async () => {
    const { text } = await render(ids.failed);

    expect(text).toContain('This drop did not run');
    expect(blockedJoinSentence((await render(ids.failed)).html)).toBe('Nobody was charged.');
  });

  it('never renders a join href in this build, because the flow is unproven', async () => {
    // This is a *limitation*, asserted so nobody later reads the absence of a token
    // assertion as an oversight.
    //
    // The join `<a>` renders only when `joinGate.offerJoin` is true, which needs both a
    // publishable key and `JOIN_FLOW_PROVEN_LIVE === true`. The constant is a deliberate
    // `false` in this repo — the end-to-end in-app join flow has not been proven (a
    // test-mode card was held at the port level on 2026-11-07, but that script writes
    // no app DB row and renders no confirmation) — so **in every fixture the page
    // renders a disabled button instead of a link**, and the token-bearing
    // href the component computes cannot appear. Probed: forcing `offerJoin` true turns this
    // test red, which is the whole value it has.
    const { html } = await render(ids.open, {
      searchParams: { [SHARE_TOKEN_PARAM]: shareToken },
    });

    expect(joinHref(html)).toBeNull();
    expect(html).not.toContain(`/join?${SHARE_TOKEN_PARAM}=`);
  });

  it('counts a click for a human, and not for an unfurler building the link card', async () => {
    // Every share is fetched by WhatsApp's and WeChat's unfurler to build the card, so an
    // ungated counter measures sharing *effort* rather than reach. The gate is
    // `isHumanView`, and this page is the only caller of `countShareLinkClick` — so this is
    // the only place the gate is observable at all.
    const before = await prisma.shareLink.findUnique({
      where: { token: shareToken },
      select: { clicks: true },
    });

    await render(ids.open, {
      searchParams: { [SHARE_TOKEN_PARAM]: shareToken },
      headers: { 'sec-fetch-mode': 'navigate', 'user-agent': 'WhatsApp/2.23.1' },
    });
    const unfurled = await prisma.shareLink.findUnique({
      where: { token: shareToken },
      select: { clicks: true },
    });
    expect(unfurled?.clicks).toBe(before?.clicks);

    await render(ids.open, {
      searchParams: { [SHARE_TOKEN_PARAM]: shareToken },
      headers: {
        'sec-fetch-mode': 'navigate',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      },
    });
    const clicked = await prisma.shareLink.findUnique({
      where: { token: shareToken },
      select: { clicks: true },
    });
    expect(clicked?.clicks).toBe((before?.clicks ?? 0) + 1);
  });

  it('names the organiser when the visit came from their link (FR-302)', async () => {
    const shared = await render(ids.open, {
      searchParams: { [SHARE_TOKEN_PARAM]: shareToken },
    });
    expect(shared.text).toContain('Shared by Robin Castellanos');

    // A direct visitor was brought by nobody. Inventing a name would be a person the
    // diner cannot ask a question.
    const direct = await render(ids.open);
    expect(direct.text).not.toContain('Shared by');
  });

  it('ignores a malformed token instead of failing the diner’s page load', async () => {
    // Attribution must never be able to break a page. A token that is not a token is the
    // server's to reject, and the page behaves as if it were absent.
    const { text } = await render(ids.open, {
      searchParams: { [SHARE_TOKEN_PARAM]: 'not-a-token' },
    });

    expect(text).toContain('6 of 20 orders in');

    // The same for a token that is well-formed but belongs to a different drop: it resolves
    // to `null` and the page renders normally, with no click counted for this drop.
    const before = await prisma.shareLink.findUnique({
      where: { token: shareToken },
      select: { clicks: true },
    });
    const other = await render(ids.confirmed, {
      searchParams: { [SHARE_TOKEN_PARAM]: shareToken },
    });
    expect(other.text).toContain('Confirmed — 22 orders so far.');

    const after = await prisma.shareLink.findUnique({
      where: { token: shareToken },
      select: { clicks: true },
    });
    // `resolveShareToken` refuses a link that names another drop, so no click is counted —
    // which is the page-level half of "a token that works anywhere is a token that can be
    // farmed". The loader's own suite holds the other half.
    expect(after?.clicks).toBe(before?.clicks);
  });
});

describe('/d/:publicCode — the link preview, which is the whole funnel', () => {
  it('titles the card with the offer and the price, not the restaurant', async () => {
    const meta = await metadataFor(ids.open);

    expect(meta.title).toBe(`Beef Bowl Thursday — ${formatCents(DEAL)}`);
    expect(meta.description).toContain('Beef Bowl from Copper Kettle.');
    // The saving is computed, so a wrong menu price would show up here too.
    expect(meta.description).toContain(
      `${formatCents(DEAL)} a plate, was ${formatCents(MENU)} (save ${formatCents(MENU - DEAL)}).`,
    );
    expect(meta.description).toContain('Nobody is charged unless 20 orders come in.');
  });

  it('drops "from <merchant>" when the restaurant is named after the dish', async () => {
    // "Beef Bowl from Beef Bowl" is what a restaurant named after its own dish produces, and
    // a preview that reads like a failed template costs a tap.
    await prisma.merchant.update({
      where: { id: ids.merchant },
      data: { name: 'Beef Bowl' },
    });
    try {
      const meta = await metadataFor(ids.open);
      expect(meta.description).not.toContain('from Beef Bowl.');
      expect(meta.description).toContain('Beef Bowl. ');
    } finally {
      await prisma.merchant.update({
        where: { id: ids.merchant },
        data: { name: 'Copper Kettle' },
      });
    }
  });

  it('is never indexed, because the URL is a bearer token in a group chat', async () => {
    const meta = await metadataFor(ids.open);

    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('has a not-found title for a code that resolves to nothing', async () => {
    const meta = await metadataFor('NOSUCHCODE');

    expect(meta.title).toBe('Drop not found — GroupEat');
    expect(meta.description).toBeUndefined();
  });
});

/**
 * The suppression branch: a production deployment with no usable `APP_URL` must emit
 * **no card**, not a card pointing at a laptop.
 *
 * ## Why this is a behavioural test and not a flag check
 *
 * `social-card.test.ts` proves `socialCardOrigin()` returns `unavailable`. It cannot
 * see whether this page *does* anything with that — and a probe that replaced the
 * conditional with `{}` left the entire suite green, because every fixture runs
 * under `NODE_ENV=test`, where the answer is `local` and the branch is not taken.
 * That is the shape of defect this repo keeps finding: a correct decision nobody
 * wired.
 *
 * ## Why `images: []` specifically
 *
 * Next auto-fills the file-convention image unless the metadata object sets an
 * `images` key itself (`hasOwnProperty('images')` in `resolve-metadata.js`). An
 * empty array is therefore the only value that suppresses the card without also
 * breaking the healthy case — and this is the pair of tests that pins both
 * directions, because deleting the suppression and *always* suppressing are two
 * different regressions.
 */
describe('/d/:publicCode — a production deployment with no origin emits no card', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('sets images: [] on both openGraph and twitter when there is no usable origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', '');
    vi.resetModules();

    const page = await import('@/app/d/[publicCode]/page');
    const meta = await page.generateMetadata({ params: Promise.resolve({ publicCode: ids.open }) });

    // `[]` and not `undefined`: both suppress in Next, but `undefined` is what an
    // omitted key looks like, so a future refactor that drops the key entirely would
    // pass an `undefined` assertion and silently restore the localhost card.
    expect(meta.openGraph?.images).toEqual([]);
    expect(meta.twitter?.images).toEqual([]);
    // The rest of the preview survives: the title and description still describe the
    // offer. A degraded card is the point; an empty one is a different bug.
    expect(meta.title).toBe(`Beef Bowl Thursday — ${formatCents(DEAL)}`);
  });

  it('sets no images key at all when APP_URL is usable, so the card still renders', async () => {
    // FR-308 itself. If the two arms were inverted, the launch blocker would be
    // suppressed on the deployments that can actually show it.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://groupeat.ca');
    vi.resetModules();

    const page = await import('@/app/d/[publicCode]/page');
    const meta = await page.generateMetadata({ params: Promise.resolve({ publicCode: ids.open }) });

    expect(meta.openGraph).not.toHaveProperty('images');
    expect(meta.twitter).not.toHaveProperty('images');
  });

  it('sets no images key at all in the suite, where the origin is merely absent', async () => {
    // The third state. `local` is not a misconfiguration — it is a fresh checkout —
    // and suppressing the card there would make every other test in this file
    // measure a page that renders a different preview than production does.
    const meta = await metadataFor(ids.open);

    expect(meta.openGraph).not.toHaveProperty('images');
    expect(meta.twitter).not.toHaveProperty('images');
  });

  it('suppresses the card on a missing code, where the early return used to skip it', async () => {
    // ## The defect this pins
    //
    // `cardSuppression` was computed correctly, then the `!drop` early return threw it
    // away and returned a bare `{ title }`. Because this page has no `openGraph` of its
    // own in that branch, Next's file convention filled `og:image` in from
    // `d/[publicCode]/opengraph-image.tsx` — measured on a production build with no
    // `APP_URL`:
    //
    //   /d/NOPE123   og:image → http://localhost:3201/d/NOPE123/opengraph-image
    //
    // So the one page in the funnel that a *mistyped* code lands on was the one page
    // still shipping a laptop URL as its preview, which is the exact failure D1 was
    // written to end. The three tests above all passed while this was true, because
    // every one of them uses a **valid** code — the early return is precisely the path
    // they never take.
    //
    // A 404 loses nothing by having no card: there is no offer to preview, and
    // `opengraph-image.tsx` already renders "This drop is not available" for the same
    // input, so suppressing the reference costs no information.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', '');
    vi.resetModules();

    const page = await import('@/app/d/[publicCode]/page');
    const meta = await page.generateMetadata({ params: Promise.resolve({ publicCode: 'NOSUCHCODE' }) });

    expect(meta.openGraph?.images).toEqual([]);
    expect(meta.twitter?.images).toEqual([]);
    // The title still says what happened. Suppressing the image is not suppressing the
    // preview — an unfurl with a title and no picture is degraded, not broken.
    expect(meta.title).toBe('Drop not found — GroupEat');
  });

  it('keeps a missing code card-free while leaving the healthy card suppressed for its own reason', async () => {
    // The pair, in one place, because `images: []` on the early return is only correct if
    // the healthy branch is untouched. Reading both from the same stubbed environment is
    // what makes "the fix did not leak into the happy path" a measurement rather than a
    // second test that could drift.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', '');
    vi.resetModules();

    const page = await import('@/app/d/[publicCode]/page');
    const missing = await page.generateMetadata({ params: Promise.resolve({ publicCode: 'NOSUCHCODE' }) });
    const present = await page.generateMetadata({ params: Promise.resolve({ publicCode: ids.open }) });

    expect(missing.openGraph?.images).toEqual([]);
    // The healthy page suppresses too — but for its own reason (`unavailable` origin), and
    // the point of asserting it here is that the early-return fix did not change it.
    expect(present.openGraph?.images).toEqual([]);
    expect(present.title).toBe(`Beef Bowl Thursday — ${formatCents(DEAL)}`);
  });
});

describe('/d/:code?preview=1 — FR-206', () => {
  const owner = (): { userId: string; role: string; mustChangePassword: boolean } => ({
    userId: ownerUserId,
    role: 'MERCHANT',
    mustChangePassword: false,
  });

  it('renders the draft to its owning merchant, with joins disabled', async () => {
    const { html, text } = await render(ids.draft, {
      preview: true,
      session: owner(),
    });

    expect(text).toContain('Preview.');
    expect(text).toContain('This is the real deal page');
    expect(text).toContain('Not published yet');
    expect(text).toContain('0 of 20 orders in');
    expect(text).toContain('Preview only. Publish this drop to open joins.');
    // The ordinary closed-drop sentence would be a lie: the drop is not closed, it
    // has not opened. The preview branch must come before every other CTA arm.
    expect(text).not.toContain('Joining has closed');
    expect(joinHref(html)).toBeNull();
    // A merchant checking their own copy is not a prospective diner. Counting it
    // would put the merchant in the denominator of their own conversion rate.
    expect(recordedEvents).toHaveLength(0);
  });

  it('404s for a signed-out visitor, exactly like the plain draft URL', async () => {
    await expect(render(ids.draft, { preview: true })).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });

  it('404s for a merchant who does not own the draft', async () => {
    await expect(
      render(ids.draft, {
        preview: true,
        session: {
          userId: '00000000-0000-0000-0000-000000000000',
          role: 'MERCHANT',
          mustChangePassword: false,
        },
      }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });

  it('a public view still records deal_page_viewed, so the guard is not a blanket disable', async () => {
    await render(ids.open);

    expect(recordedEvents.map((event) => event.event)).toContain('deal_page_viewed');
  });

  it('carries no OG card and is not indexable', async () => {
    // A preview is not a share. The metadata returns before the drop is loaded, so
    // there is no card to point at the deployment and no draft price to leak.
    const meta = await metadataFor(ids.draft, true);

    expect(meta.title).toBe('Preview — GroupEat');
    expect(meta.robots).toEqual({ index: false, follow: false });
    // Not `undefined`: the directory-level `opengraph-image.tsx` autofills the card
    // when the page returns no image key at all. `images: []` is the suppression.
    expect(meta.openGraph?.images).toEqual([]);
    expect(meta.twitter?.images).toEqual([]);
  });
});
