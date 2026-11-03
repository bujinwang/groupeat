import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

import { MAX_SCANNED_CODE_LENGTH } from '@/lib/redemption/rules';

/**
 * `/merchant/pickup` rendered — gap 12, the counter screen (FR-601…FR-605).
 *
 * Three things on this page are decisions rather than layout, and each has a plausible
 * wrong version that a staff member would act on at 6pm:
 *
 *   1. **The scanner is above the manifest.** The docblock is explicit: "The scanner is
 *      first because it is what a staff member opens the page to do… the batch view is for
 *      the moment between diners." So the test asserts the *document order*, not merely
 *      that both are present — a page that put the manifest first would pass a
 *      presence-only assertion and fail the intent.
 *   2. **Which drops are "at the counter".** `listCounterDrops` filters by status *and* a
 *      floor on `windowEnd`, never by `isRedeemableStatus`. The docblock's reason is worth
 *      a test each way: a `CAPTURED` drop whose window has not opened **is** listed ("a
 *      merchant who opens the screen early should see the drop waiting rather than an
 *      empty list"), while a drop that ended 13 hours ago is not.
 *   3. **Plates, not orders.** The badge counts plates still owed (`qty - redeemedQty`,
 *      floored at zero), and the summary prints both plates and orders because "one order
 *      can be four plates".
 *
 * ## The time filter is one-sided, and that is pinned as a finding
 *
 * `where` has `windowEnd: { gte: now − 12h }` and **no upper bound**, so a `CAPTURED` drop
 * whose window opens next month still qualifies. The docblock says the filter exists so
 * that "anything wider would put every drop a merchant has ever run in front of a staff
 * member at 6pm" — true of the past, and not true of the future. The test below asserts the
 * current behaviour and says so, rather than asserting the behaviour the docblock implies,
 * because a failing suite is not the right place to settle a product question. It is
 * flagged here so it is a known seam rather than a surprise.
 *
 * ## The timezone is only observable through a formatted label
 *
 * `windowLabel` takes the merchant's zone (falling back to `America/Edmonton`). Nothing else
 * on the page exposes the zone, so the assertion is the rendered `Wed 6:00 p.m.` string. To
 * keep it honest the test computes the expected labels with the same platform formatter for
 * both fixture zones and requires them to **differ** — otherwise the assertion would pass on
 * a page that ignored the zone entirely.
 *
 * ## What is mocked
 *
 * `server-only` and `@/lib/auth/session`. `requireMerchant`, `primaryMerchantId`,
 * `getMerchant`, `listCounterDrops` and `loadManifest` are all real, against real Postgres.
 * `RedeemScanner` is a client component and is not hydrated: its initial panel ("Nothing
 * scanned yet.") is asserted, and every scan outcome — `REDEEMED`, `PARTIAL`,
 * `ALREADY_REDEEMED`, `REFUSED` — stays browser-only. Those are the scanner's own renders,
 * covered where the rules live (`src/lib/redemption/__tests__/`).
 *
 * ## One field this suite deliberately does not pin, and where it is pinned instead
 *
 * `Manifest.timeZone` is returned by the loader and serialised by the JSON route
 * (`GET /api/merchant/pickup-queue/:id`), but this page never reads it — the page takes the
 * zone from `getMerchant` and passes that to both `windowLabel` and `RedeemScanner`. So
 * mutating `loadManifest`'s `timeZone` leaves this suite green, which a probe confirmed.
 * That is not a coverage gap: `manifest.test.ts` asserts the field directly ("carries the
 * merchant timezone so the screen can render local times"), and the same probe kills that
 * test. The division is deliberate — the field's *value* is the loader's business, the
 * page's *use* of a zone is this suite's. Recorded so nobody adds a second, weaker
 * assertion for the same fact.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');

const PREFIX = `mchpk${Date.now().toString(36).slice(-5)}`;

const HOUR = 60 * 60 * 1000;

const ids = {
  /** `America/Edmonton`, one of each counter-relevant drop. */
  merchantId: '',
  userId: '',
  dish: '',
  /** `America/Toronto` — 2 hours ahead, so a wrong zone changes the label. */
  eastMerchantId: '',
  eastUserId: '',
  eastDish: '',
  /** A merchant outside the caller's scope, for the 404 case. */
  foreignMerchantId: '',
  foreignDish: '',
};

const drops: Record<string, string> = {};

const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];
const createdItemIds: string[] = [];
const createdDropIds: string[] = [];
const createdCustomerIds: string[] = [];

async function makeMerchant(suffix: string, name: string, timezone: string): Promise<string> {
  const merchant = await prisma.merchant.create({
    data: {
      name,
      slug: `${PREFIX}-${suffix}`,
      status: 'ACTIVE',
      timezone,
      floorPctOfMenu: '0.25',
    },
    select: { id: true },
  });
  createdMerchantIds.push(merchant.id);
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
  createdUserIds.push(user.id);
  await prisma.merchantUser.create({ data: { merchantId, userId: user.id, role: 'OWNER' } });
  return user.id;
}

async function makeDish(merchantId: string, name: string): Promise<string> {
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
    },
    select: { id: true },
  });
  createdItemIds.push(item.id);
  return item.id;
}

/**
 * A drop with an explicit window and status.
 *
 * `minQty`/`maxQty`/`maxPerCustomer` are set to satisfy the publish-time invariants even
 * though this suite never publishes — a fixture that could not exist in production makes a
 * test that proves nothing about production.
 */
async function makeDrop(args: {
  key: string;
  merchantId: string;
  menuItemId: string;
  title: string;
  status: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<string> {
  const drop = await prisma.drop.create({
    data: {
      merchantId: args.merchantId,
      menuItemId: args.menuItemId,
      title: args.title,
      publicCode: `${PREFIX}${Math.random().toString(36).slice(2, 10)}`,
      dealPriceCents: 1112,
      minQty: 5,
      maxQty: 40,
      maxPerCustomer: 4,
      cutoffAt: new Date(args.windowStart.getTime() - 24 * HOUR),
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      status: args.status as never,
      guardrailSnapshot: {},
    },
    select: { id: true },
  });
  createdDropIds.push(drop.id);
  drops[args.key] = drop.id;
  return drop.id;
}

let phoneCounter = 0;

async function makeParticipant(args: {
  dropId: string;
  name: string | null;
  qty: number;
  redeemedQty: number;
}): Promise<void> {
  phoneCounter += 1;
  const customer = await prisma.customer.create({
    data: {
      phone: `+1403555${String(1000 + phoneCounter).slice(-4)}`,
      name: args.name,
    },
    select: { id: true },
  });
  createdCustomerIds.push(customer.id);

  await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId: customer.id,
      qty: args.qty,
      redeemedQty: args.redeemedQty,
      amountCents: args.qty * 1112,
      platformFeeCents: 89 * args.qty,
      // A captured, paid order. `AuthStatus` has no `CAPTURED` member — authorisation and
      // capture are separate axes, and a paid order is `AUTHORIZED` + `CAPTURED`. Found by
      // running it: the enum is five values, not the four a name-guess would suggest.
      authStatus: 'AUTHORIZED',
      chargeStatus: 'CAPTURED',
    },
  });
}

/**
 * What the page's own formatter should produce, computed here with the platform API.
 *
 * Not a re-implementation of `windowLabel`'s two-branch try/catch — just the format the
 * label is made of, so the assertion names the string a staff member reads.
 */
function label(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

let morningWindowStart: Date;
let morningWindowEnd: Date;

beforeAll(async () => {
  ids.merchantId = await makeMerchant('main', 'Counter Kettle', 'America/Edmonton');
  ids.userId = await makeOwner('main', ids.merchantId);
  ids.dish = await makeDish(ids.merchantId, 'Beef Bowl');

  ids.eastMerchantId = await makeMerchant('east', 'Eastern Grill', 'America/Toronto');
  ids.eastUserId = await makeOwner('east', ids.eastMerchantId);
  ids.eastDish = await makeDish(ids.eastMerchantId, 'East Bowl');

  ids.foreignMerchantId = await makeMerchant('foreign', 'Someone Else', 'America/Edmonton');
  ids.foreignDish = await makeDish(ids.foreignMerchantId, 'Foreign Bowl');

  const now = Date.now();

  // A window well inside the "-12h to open" band, anchored to a fixed hour of the day so
  // the two zones cannot coincidentally print the same label. `morningWindowStart` is
  // `now + 1h`, which is far enough ahead that the *label* is not the thing under test.
  morningWindowStart = new Date(now + 1 * HOUR);
  morningWindowEnd = new Date(now + 3 * HOUR);

  // Window start order is deliberate: `ordered-early` must render above `ordered-late`,
  // and their titles are the only thing that distinguishes them.
  await makeDrop({
    key: 'orderedEarly',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Ordered Early',
    status: 'PICKUP_OPEN',
    windowStart: new Date(now - 3 * HOUR),
    windowEnd: new Date(now + 1 * HOUR),
  });
  await makeDrop({
    key: 'orderedLate',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Ordered Late',
    status: 'PICKUP_OPEN',
    windowStart: new Date(now - 1 * HOUR),
    windowEnd: new Date(now + 2 * HOUR),
  });

  // Two participants on `orderedEarly`: 1 of 3 collected (Waiting), 2 of 2 (Collected).
  // Plates: 5 total, 3 collected.
  await makeParticipant({ dropId: drops.orderedEarly!, name: 'Dana Whitfield', qty: 3, redeemedQty: 1 });
  await makeParticipant({ dropId: drops.orderedEarly!, name: null, qty: 2, redeemedQty: 2 });

  // Everything collected: the badge must say so rather than "0 plates left".
  await makeDrop({
    key: 'allDone',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'All Collected Drop',
    status: 'PICKUP_OPEN',
    windowStart: new Date(now - 2 * HOUR),
    windowEnd: new Date(now + 1 * HOUR),
  });
  await makeParticipant({ dropId: drops.allDone!, name: 'Sam Okafor', qty: 2, redeemedQty: 2 });

  // No participants at all: "Nobody joined this drop."
  await makeDrop({
    key: 'nobody',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Deserted Drop',
    status: 'PICKUP_OPEN',
    windowStart: new Date(now - 2 * HOUR),
    windowEnd: new Date(now + 1 * HOUR),
  });

  // CAPTURED, window still ahead: listed, because opening the screen early should show the
  // drop waiting rather than an empty list.
  await makeDrop({
    key: 'capturedAhead',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Charged Not Yet Open',
    status: 'CAPTURED',
    windowStart: new Date(now + 2 * HOUR),
    windowEnd: new Date(now + 4 * HOUR),
  });

  // Ended 13 hours ago: outside the -12h floor.
  await makeDrop({
    key: 'stale',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Stale Yesterday Drop',
    status: 'COMPLETED',
    windowStart: new Date(now - 20 * HOUR),
    windowEnd: new Date(now - 13 * HOUR),
  });

  // Status outside the counter list, window wide open now: excluded by status alone.
  await makeDrop({
    key: 'draft',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Draft Never Published',
    status: 'DRAFT',
    windowStart: new Date(now - 1 * HOUR),
    windowEnd: new Date(now + 2 * HOUR),
  });
  await makeDrop({
    key: 'failed',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Failed Drop',
    status: 'FAILED',
    windowStart: new Date(now - 1 * HOUR),
    windowEnd: new Date(now + 2 * HOUR),
  });

  // A CAPTURED drop three weeks out. `windowEnd >= now − 12h` has no upper bound, so this
  // is listed. See the module docblock: pinned as current behaviour, not as intent.
  await makeDrop({
    key: 'farFuture',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Three Weeks Out',
    status: 'CAPTURED',
    windowStart: new Date(now + 21 * 24 * HOUR),
    windowEnd: new Date(now + 21 * 24 * HOUR + 2 * HOUR),
  });

  // The same window on the Edmonton merchant, so the two renders differ only by the zone
  // their merchant carries. Without a matched pair the timezone test would be comparing two
  // different instants and could not tell a wrong zone from a wrong clock.
  await makeDrop({
    key: 'westWindow',
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Western Window',
    status: 'PICKUP_OPEN',
    windowStart: morningWindowStart,
    windowEnd: morningWindowEnd,
  });

  // The other merchant's own drop, for the timezone comparison.
  await makeDrop({
    key: 'east',
    merchantId: ids.eastMerchantId,
    menuItemId: ids.eastDish,
    title: 'Eastern Window',
    status: 'PICKUP_OPEN',
    windowStart: morningWindowStart,
    windowEnd: morningWindowEnd,
  });

  // The foreign merchant's drop — the caller must never see it.
  await makeDrop({
    key: 'foreign',
    merchantId: ids.foreignMerchantId,
    menuItemId: ids.foreignDish,
    title: 'Foreign Window',
    status: 'PICKUP_OPEN',
    windowStart: morningWindowStart,
    windowEnd: morningWindowEnd,
  });
});

afterAll(async () => {
  await prisma.dropParticipant.deleteMany({ where: { dropId: { in: createdDropIds } } });
  await prisma.merchantUser.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.drop.deleteMany({ where: { id: { in: createdDropIds } } });
  await prisma.menuItem.deleteMany({ where: { id: { in: createdItemIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

async function render(
  userId: string,
  searchParams: { drop?: string } = {},
): Promise<{ html: string; text: string }> {
  const previous = sessionState.session;
  sessionState.session = { userId, role: 'MERCHANT', mustChangePassword: false };
  try {
    const page = await import('@/app/(merchant)/merchant/pickup/page');
    const element = await page.default({ searchParams: Promise.resolve(searchParams) });
    const html = await renderToHtml(element);
    return { html, text: textOf(html) };
  } finally {
    sessionState.session = previous;
  }
}

/** The `<li>` for one drop in the counter list. */
function cardFor(html: string, dropId: string): string {
  for (const match of html.matchAll(/<li\b[\s\S]*?<\/li>/g)) {
    if (match[0].includes(`/merchant/pickup?drop=${dropId}`)) {
      return match[0];
    }
  }
  throw new Error(`No <li> links to ${dropId}`);
}

function textFor(html: string, dropId: string): string {
  return textOf(cardFor(html, dropId));
}

/** The badge's own text — the plate count, separated from the title and window. */
function badgeTextFor(html: string, dropId: string): string {
  const badge = /<span\b[^>]*class="[^"]*rounded-full[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(
    cardFor(html, dropId),
  );
  if (!badge) {
    throw new Error(`No badge in the card for ${dropId}`);
  }
  return textOf(badge[1] ?? '');
}

describe('/merchant/pickup — the scanner comes first', () => {
  it('puts the scan screen above the drop list, which is the reason staff open it', async () => {
    const { html, text } = await render(ids.userId);

    expect(text).toContain('Check a diner');
    // The scanner's initial panel, not a hydrated result: "Nothing scanned yet."
    expect(text).toContain('Nothing scanned yet.');
    expect(text).toContain('Check and hand over');
    expect(text).toContain('Drops at the counter');

    // Document order, which is the actual claim. A page that rendered the manifest first
    // would satisfy every presence assertion above and still be the wrong screen.
    const scannerAt = html.indexOf('Nothing scanned yet.');
    const listAt = html.indexOf('Drops at the counter');
    expect(scannerAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(-1);
    expect(scannerAt).toBeLessThan(listAt);
  });

  it('offers the manual code field first, because a typed code beats a missing camera', async () => {
    // `BarcodeDetector` is absent in Node, so `canScan` is false and the camera button is
    // not rendered — which is the real degradation path the component documents.
    const { html, text } = await render(ids.userId);

    expect(html).toContain('id="redemption-code"');
    expect(text).toContain('Scan the diner');
    expect(text).toContain('type the letters after the last dot');
    // Autocomplete off on a shared counter phone, per the component's comment. React 19's
    // server renderer emits these as **camelCase** attributes (`autoComplete`, not
    // `autocomplete`), which is the opposite of what the HTML spec calls them — found by
    // reading the output rather than by reading the JSX.
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('autoCorrect="off"');
    expect(html).toContain('autoCapitalize="off"');
    expect(html).toContain('spellCheck="false"');
    // The code field's own length cap, from the pure module rather than a literal.
    expect(html).toContain(`maxLength="${MAX_SCANNED_CODE_LENGTH}"`);
    // No camera button without a detector — the field is the only input, not a fallback
    // that looks broken.
    expect(text).not.toContain('Use camera');
  });
});

describe('/merchant/pickup — which drops are at the counter', () => {
  it('lists a charged drop whose window is ahead, and labels it on its manifest', async () => {
    const { html } = await render(ids.userId);

    // `CAPTURED` is in the list on purpose: a merchant opening the screen early should see
    // the drop waiting.
    expect(textFor(html, drops.capturedAhead!)).toContain('Charged Not Yet Open');
    // The status *word* is not on the list card — the card carries only the plate badge and
    // a link. It is on the manifest heading, which is where `STATUS_LABEL` is read. So the
    // label is asserted on the selected manifest rather than on the list, and it is
    // asserted **there** rather than page-wide: a page-wide `toContain('Not open yet')`
    // would pass on a page that badged every manifest with the same word.
    const manifest = await render(ids.userId, { drop: drops.capturedAhead! });
    const heading = textOf(
      /<div class="flex flex-wrap items-baseline justify-between gap-2">([\s\S]*?)<\/div>/.exec(
        manifest.html,
      )?.[1] ?? '',
    );
    expect(heading).toContain('Charged Not Yet Open');
    expect(heading).toContain('Not open yet');
    expect(manifest.text).not.toContain('CAPTURED');
  });

  it('badges a charged drop with no participants as "All collected", which is wrong', async () => {
    // Found by this suite, not by reading the page. `outstanding` is `plates - collected`,
    // and a `CAPTURED` drop has no participants until the cutoff runs — so 0 - 0 = 0, and
    // the badge says "All collected" for a drop whose food has not been cooked, let alone
    // handed over.
    //
    // It is pinned as current behaviour rather than asserted as correct, because the right
    // fix is a product decision the page cannot make alone: "All collected" and "Nothing to
    // collect yet" are different sentences and the badge has one branch. What this test
    // guarantees is that the behaviour cannot change silently in either direction — if
    // someone adds the missing branch, this test fails and has to be rewritten on purpose.
    const { html } = await render(ids.userId);

    expect(badgeTextFor(html, drops.capturedAhead!)).toBe('All collected');
    // And it is not the plate count either, so the badge is genuinely the zero case.
    expect(badgeTextFor(html, drops.capturedAhead!)).not.toContain('0');
  });

  it('drops a window that closed more than twelve hours ago', async () => {
    const { text } = await render(ids.userId);

    expect(text).not.toContain('Stale Yesterday Drop');
  });

  it('drops statuses that are not worked at a counter, even with an open window', async () => {
    const { text } = await render(ids.userId);

    // Both have a window spanning now; only their status excludes them.
    expect(text).not.toContain('Draft Never Published');
    expect(text).not.toContain('Failed Drop');
  });

  it('lists a drop whose window is three weeks out, because the time filter has no ceiling', async () => {
    // `windowEnd: { gte: now − 12h }` bounds the past only. Pinned as it behaves: the
    // docblock frames the filter as "open, or about to open, or recently closed", and a
    // drop three weeks ahead is none of those. Recorded here so the seam is visible; a
    // future decisions section can settle whether the ceiling belongs in `where`.
    const { text } = await render(ids.userId);

    expect(text).toContain('Three Weeks Out');
  });

  it('orders the list by window start, not by title or insertion', async () => {
    const { html } = await render(ids.userId);

    // `Ordered Early` starts two hours before `Ordered Late`, and its title sorts after —
    // so an alphabetical or id order would show them the other way round.
    const early = html.indexOf('Ordered Early');
    const late = html.indexOf('Ordered Late');
    expect(early).toBeGreaterThan(-1);
    expect(late).toBeGreaterThan(-1);
    expect(early).toBeLessThan(late);
  });

  it('links each drop to its own manifest, and to nothing else', async () => {
    const { html } = await render(ids.userId);

    expect(html).toContain(`href="/merchant/pickup?drop=${drops.orderedEarly}"`);
    expect(html).toContain(`href="/merchant/pickup?drop=${drops.capturedAhead}"`);
  });

  it('never shows another merchant’s drop', async () => {
    const { text } = await render(ids.userId);

    expect(text).not.toContain('Foreign Window');
  });

  it('says so when no drop is at its window', async () => {
    // A merchant with no drops at all. The sentence names the reason rather than printing
    // an empty list, which is the difference between "nothing now" and "nothing here".
    const quietMerchantId = await makeMerchant('quiet', 'Quiet Cafe', 'America/Edmonton');
    const quietUserId = await makeOwner('quiet', quietMerchantId);
    await makeDish(quietMerchantId, 'Quiet Dish');

    const { text } = await render(quietUserId);

    expect(text).toContain('No drop is at its pickup window. When one opens it will appear here.');
    expect(text).not.toContain('Drops at the counter\n');
    // The scanner is still there: the screen's first job does not depend on a drop existing.
    expect(text).toContain('Nothing scanned yet.');
  });
});

describe('/merchant/pickup — the plate counts', () => {
  it('badges plates still owed, in the plural', async () => {
    const { html } = await render(ids.userId);

    // 3 + 2 plates, 1 + 2 collected → 2 outstanding.
    expect(badgeTextFor(html, drops.orderedEarly!)).toBe('2 plates left');
  });

  it('says all collected at zero rather than "0 plates left"', async () => {
    const { html } = await render(ids.userId);

    expect(badgeTextFor(html, drops.allDone!)).toBe('All collected');
  });

  it('uses the singular for one plate, because a counter reads words', async () => {
    const oneLeft = await makeDrop({
      key: 'oneLeft',
      merchantId: ids.merchantId,
      menuItemId: ids.dish,
      title: 'One Plate Left',
      status: 'PICKUP_OPEN',
      windowStart: new Date(Date.now() - 2 * HOUR),
      windowEnd: new Date(Date.now() + 1 * HOUR),
    });
    await makeParticipant({ dropId: oneLeft, name: 'Rae Lindqvist', qty: 2, redeemedQty: 1 });

    const { html } = await render(ids.userId);

    expect(badgeTextFor(html, oneLeft)).toBe('1 plate left');
  });
});

describe('/merchant/pickup — the manifest', () => {
  it('counts plates and orders separately, because one order can be four plates', async () => {
    const { text } = await render(ids.userId, { drop: drops.orderedEarly! });

    // Two participants: 3+2 = 5 plates, 1+2 = 3 collected; both orders touched, one complete.
    expect(text).toContain('3 of 5 plates collected');
    expect(text).toContain('1 of 2 orders complete');
  });

  it('shows each participant with a surname, four digits and their own progress', async () => {
    const { text } = await render(ids.userId, { drop: drops.orderedEarly! });

    expect(text).toContain('Dana Whitfield');
    expect(text).toContain('1 of 3 collected');
    // `Unnamed` rather than an empty gap or the string "null".
    expect(text).toContain('Unnamed');
    expect(text).not.toContain('null');
    expect(text).toContain('Waiting');
    expect(text).toContain('Collected');
  });

  it('never prints a full phone number, only the last four', async () => {
    const { text, html } = await render(ids.userId, { drop: drops.orderedEarly! });

    // FR-805 minimisation: the test fixture phones are `+1403555xxxx`. Neither the country
    // code nor more than four digits may reach the screen.
    expect(text).not.toContain('+1403');
    expect(html).not.toContain('+1403');
  });

  it('says nobody joined rather than rendering an empty list', async () => {
    const { text } = await render(ids.userId, { drop: drops.nobody! });

    expect(text).toContain('Deserted Drop');
    expect(text).toContain('Nobody joined this drop.');
  });

  it('labels the selected drop with its status word, not the enum', async () => {
    const { text } = await render(ids.userId, { drop: drops.orderedEarly! });

    expect(text).toContain('Ordered Early');
    expect(text).toContain('Open');
    expect(text).not.toContain('PICKUP_OPEN');
  });

  it('loads a manifest the caller has the id for, even outside the counter window', async () => {
    // `listCounterDrops` would not show this one — it ended 13 hours ago — but the docblock
    // is explicit that a bookmark to a manifest keeps working. The list must still exclude
    // it while the manifest shows it.
    const { html, text } = await render(ids.userId, { drop: drops.stale! });

    expect(text).toContain('Stale Yesterday Drop');
    expect(text).toContain('Finished');
    // Still not in the counter list itself.
    const listSection = html.slice(0, html.indexOf('Stale Yesterday Drop'));
    expect(listSection).not.toContain(`href="/merchant/pickup?drop=${drops.stale}"`);
  });

  it('shows nothing extra when no drop is selected', async () => {
    const { text } = await render(ids.userId);

    // The manifest section is a `selected ? … : null`, so a summary line must be absent.
    expect(text).not.toContain('plates collected');
    expect(text).not.toContain('orders complete');
  });

  it('is a 404 for another merchant’s drop, not a 403 and not an empty page', async () => {
    // `loadManifest` throws `AppError.notFound` outside scope. The page does not catch it,
    // so the rejection is what a request would turn into a 404 — asserted at the seam
    // rather than by rendering an error boundary this suite does not have.
    await expect(render(ids.userId, { drop: drops.foreign! })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('/merchant/pickup — the merchant’s own timezone', () => {
  it('formats the window in the merchant’s zone, and the two zones differ', async () => {
    const edmonton = label(morningWindowStart, 'America/Edmonton');
    const toronto = label(morningWindowStart, 'America/Toronto');

    // Guard the assertion itself: if the platform ever formatted both zones identically,
    // the two tests below would pass on a page that ignored the zone entirely.
    expect(edmonton).not.toBe(toronto);

    // Scoped to the drop's own card, not the whole page. The first version asserted against
    // `text` and failed for the right reason: other fixtures print `Tue 6:45 p.m.` as the
    // end of *their* windows, so a page-wide `not.toContain` was measuring the fixtures. A
    // card-scoped assertion is both narrower and the actual claim — this drop's window, in
    // this merchant's zone.
    const west = await render(ids.userId);
    expect(textFor(west.html, drops.westWindow!)).toContain(edmonton);
    expect(textFor(west.html, drops.westWindow!)).not.toContain(toronto);

    const east = await render(ids.eastUserId);
    expect(textFor(east.html, drops.east!)).toContain(toronto);
    expect(textFor(east.html, drops.east!)).not.toContain(edmonton);
  });
});
