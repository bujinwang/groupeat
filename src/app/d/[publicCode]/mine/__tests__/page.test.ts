import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/d/:publicCode/mine?t=…` rendered — the diner's own order page (M4 slice 2c).
 *
 * ## The token in the URL is not the redemption code
 *
 * The code is a bearer credential that buys food. A URL containing it would put it in an SMS
 * archive, a browser history, and — because every drop is shared into group chats — potentially
 * a link-preview fetcher's logs. `lib/participant/access.ts` derives a separate key for a
 * **read-only** token, and this page is the only consumer. A leaked link shows a name, a
 * quantity and four digits; it does not feed anyone.
 *
 * That is a claim about what the page must **not** render, and it has two halves worth
 * asserting separately: the token in the URL is a different string from the code (so a page
 * printing the token would already be visible as wrong), and the code only appears when
 * `resolveOrderView` says handing over food is still legitimate.
 *
 * ## Three phases, and the money is the discriminator
 *
 * `resolveOrderView` keys `CHARGED` off `chargeStatus === 'CAPTURED'` rather than off the drop
 * status, because a drop can be `CAPTURED` while one diner's card declined — and that diner
 * must not be told they have food coming. The fixtures below therefore include exactly that
 * case: a captured drop where *this* participant is not captured. It is the one combination a
 * status-only implementation gets wrong, and no single-drop fixture can express it.
 *
 * ## What this suite can and cannot reach
 *
 * Every phase, every sentence, the code block, the pickup block and the invalid-link copy are
 * server-rendered and asserted here. Nothing on this page is a client component, so there is no
 * interaction to miss. What *is* unreachable is the deliberate omission the module docblock
 * makes: the page never renders the phone number, only its last four digits, and that is
 * asserted rather than assumed.
 *
 * ## Two probes that survive, and why each one is fine
 *
 * A probe sweep of 28 mutations left four survivors on the first run and two on the last. Both
 * remaining ones are **equivalent mutants** — the mutation changes the source without changing
 * any behaviour this page can exhibit — and they are recorded here so a later reader does not
 * re-litigate them:
 *
 *   - *Gating the code block on `true` instead of `view.code`.* `view.code` is non-null only in
 *     the `CHARGED` arm, which is the only arm that renders the block, and the block is inside
 *     `{view.code ? … : null}`. Every non-charged fixture renders no block either way. The
 *     defence is one layer down: probe W (dropping `collectable` from the resolver's gate) and
 *     probe V (dropping `outstandingQty`) both kill, and those are the layers that decide
 *     whether a code is *legitimate*. The page's copy of the guard is belt-and-braces on a
 *     value its parent already computed.
 *   - *Replacing `loadOrderPage(publicCode, token ?? '', …)`'s caller-side guard.* A missing
 *     token and an empty one both reach `verifyParticipantAccess('')`, which splits to one part
 *     and returns `null`, so the refusal is identical. The guard's real job is to keep a bare
 *     URL out of the invalid-token log, and that is asserted directly in "logs a token that
 *     failed and stays silent when there was no token at all".
 *
 * Three earlier survivors were genuine gaps and are fixed, each with the test that closes it:
 * the `plate`/`plates` ternary (no fixture had a quantity of one, so nothing read the header's
 * quantity line), the pickup-window timezone (the label prints twice — see `pickupSection`),
 * and the token signature (every forged token in the first draft was malformed in three ways
 * at once, so skipping verification changed nothing).
 */

vi.mock('server-only', () => ({}));

/**
 * The logger, spied rather than silenced.
 *
 * `logInvalidToken` writes nothing to the DOM, so the page's "did a bogus token show up here"
 * signal is invisible to every render-based assertion — probe M swapped the condition that
 * decides *when* it fires and no test noticed. Mocking it is what makes the signal observable;
 * the module under test is unchanged.
 */
vi.mock('@/lib/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The access token is an HMAC over `JWT_SECRET`, so the suite has to agree with the app about
// the key before it can mint one. Set before the modules below are imported.
process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const { prisma } = await import('@/lib/db/prisma');
const { createItem } = await import('@/lib/db/items');
const { DEFAULT_FEES, buildGuardrailSnapshot, formatCents } = await import('@/lib/guardrail');
const { signParticipantAccess } = await import('@/lib/participant/access');
const { logger } = await import('@/lib/logging/logger');

const PREFIX = `mine${Date.now().toString(36).slice(-5)}`;
const HOUR = 60 * 60 * 1000;

const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];
const createdDropIds: string[] = [];
const createdCustomerIds: string[] = [];

const MENU = 1600;
const DEAL = 1310;
const MERCHANT_TZ = 'America/Toronto';

/**
 * The diner's phone, so the last-four digression is provable rather than assumed.
 *
 * `Customer.phone` is `@unique`, so every fixture needs its own row — and the first version of
 * this file used one constant, which made the *second* call to `makeParticipant` throw
 * `Unique constraint failed on the fields: (phone)` inside `beforeAll`, before a single test
 * ran. The fix cannot be a random number, because two assertions in this suite quote the
 * digits: the page must print `0199` and must not print anything longer. So the **last four
 * are fixed** and the prefix varies — one counter per fixture and the clock's last three
 * digits per run, which keeps two concurrent or interrupted runs off each other's rows while
 * every stored number still ends `0199`.
 */
const RUN = String(Date.now()).slice(-3);
let phoneCounter = 0;

function nextPhone(): string {
  // 1 + RUN(3) + counter(3) + 0199 = the eleven digits E.164 expects, with the tail the
  // assertions below are written against.
  return `+1${RUN}${String(500 + phoneCounter++).slice(-3)}0199`;
}

/** What each fixture actually stored, so the no-leak assertion quotes the real number. */
const phones: Record<string, string> = {};

const ids = {
  merchant: '',
  item: '',
  /** Captured, pickup window open, nothing collected yet. The code is legitimate here. */
  charged: '',
  /**
   * Captured by the cutoff job, but the pickup window has not opened — `CAPTURED` is not in
   * `REDEEMABLE_STATUSES`, so the scanner would refuse a code today. The row has one; the page
   * must not print it.
   */
  capturedBeforePickup: '',
  /** Captured, one of three plates already collected. */
  partlyCollected: '',
  /** Captured and fully collected — a code would be a credential for nothing. */
  fullyCollected: '',
  /** Captured, but the pickup window has closed. */
  chargedPickupEnded: '',
  /** The drop is captured; *this* diner's card declined. The status-only bug. */
  declinedOnCapturedDrop: '',
  /** Still waiting for the threshold: a hold at most. */
  waiting: '',
  /** The same waiting phase with a one-person threshold, so the singular has a false arm. */
  soloThreshold: '',
  /** One plate, so the header's `plate`/`plates` ternary has an observable false arm. */
  singlePlate: '',
  /** The drop failed: nobody was charged. */
  notCharged: '',
  /**
   * This diner was captured and then refunded while the drop itself is healthy. The refunded
   * arm of `resolveOrderView` is only reachable when the *drop* status does not decide it.
   */
  refundedOnLiveDrop: '',
};

const tokens: Record<string, string> = {};

async function makeDrop(args: {
  title: string;
  minQty: number;
  maxQty: number;
  status: string;
  cutoffOffsetHours?: number;
  windowOffsetHours?: number;
}): Promise<string> {
  const now = Date.now();
  const cutoffOffset = args.cutoffOffsetHours ?? -2;
  const windowOffset = args.windowOffsetHours ?? -1;

  const snapshot = buildGuardrailSnapshot(
    {
      ...DEFAULT_FEES,
      menuPriceCents: MENU,
      foodCostCents: 480,
      packagingCents: 80,
      floorPctOfMenu: 0.25,
    },
    DEAL,
    new Date(now).toISOString(),
  );

  const drop = await prisma.drop.create({
    data: {
      merchantId: ids.merchant,
      menuItemId: ids.item,
      publicCode: `${PREFIX}${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
      title: args.title,
      dealPriceCents: DEAL,
      minQty: args.minQty,
      maxQty: args.maxQty,
      maxPerCustomer: 4,
      status: args.status as never,
      publishedAt: new Date(now - 48 * HOUR),
      guardrailSnapshot: snapshot,
      cutoffAt: new Date(now + cutoffOffset * HOUR),
      windowStart: new Date(now + windowOffset * HOUR),
      windowEnd: new Date(now + (windowOffset + 2) * HOUR),
    },
    select: { id: true, publicCode: true },
  });
  createdDropIds.push(drop.id);
  return drop.publicCode;
}

/** One participant on a drop, with a real signed read-only token. */
async function makeParticipant(args: {
  dropCode: string;
  customerSuffix: string;
  qty: number;
  redeemedQty?: number;
  authStatus?: 'AUTHORIZED' | 'VOIDED' | 'EXPIRED' | 'PENDING' | 'FAILED';
  /**
   * The schema's `ChargeStatus`, quoted rather than guessed. The first version of this file
   * typed it as `'NOT_ATTEMPTED' | 'AUTHORIZED' | …` — the vocabulary of a processor, not of
   * this database — and Prisma refused the `AUTHORIZED` fixture with `Invalid value for
   * argument chargeStatus. Expected ChargeStatus`. Held-but-not-charged is `NONE` here, which
   * is also the column default: `resolveOrderView` treats anything that is neither `CAPTURED`
   * nor one of the refund/failure values as `WAITING`, so `NONE` is exactly a live hold.
   */
  chargeStatus: 'NONE' | 'CAPTURED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED';
  redemptionCode: string | null;
}): Promise<string> {
  const drop = await prisma.drop.findFirst({
    where: { publicCode: args.dropCode },
    select: { id: true },
  });

  const phone = nextPhone();
  phones[args.customerSuffix] = phone;

  const customer = await prisma.customer.create({
    data: { phone, name: 'Diner' },
    select: { id: true },
  });
  createdCustomerIds.push(customer.id);

  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: drop!.id,
      customerId: customer.id,
      qty: args.qty,
      redeemedQty: args.redeemedQty ?? 0,
      amountCents: DEAL * args.qty,
      platformFeeCents: 100,
      authStatus: args.authStatus ?? 'AUTHORIZED',
      chargeStatus: args.chargeStatus,
      redemptionCode: args.redemptionCode,
    },
    select: { id: true },
  });

  // `customerSuffix` is not an assertion — it keys `phones` above, so the no-leak test can
  // quote the exact string this fixture stored instead of a constant that might drift.
  return signParticipantAccess({
    participantId: participant.id,
    dropId: drop!.id,
  });
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

  const merchant = await prisma.merchant.create({
    data: {
      name: 'Copper Kettle',
      slug: PREFIX,
      status: 'ACTIVE',
      floorPctOfMenu: '0.25',
      timezone: MERCHANT_TZ,
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

  // The code is legitimate here: `PICKUP_OPEN` is in `REDEEMABLE_STATUSES` and the window is
  // open. **The first draft of this fixture was `CAPTURED`**, and the page correctly printed
  // no code — `COLLECTABLE_DROP_STATUSES` is the scanner's `['PICKUP_OPEN', 'COMPLETED']`,
  // because capture runs at the cutoff, which can be the day before the kitchen cooks. A code
  // shown then is a code the counter would refuse, which is the one thing this page must not
  // do. `capturedBeforePickup` below keeps that case.
  ids.charged = await makeDrop({
    title: 'Beef Bowl Thursday',
    minQty: 20,
    maxQty: 30,
    status: 'PICKUP_OPEN',
  });
  tokens.charged = await makeParticipant({
    dropCode: ids.charged,
    customerSuffix: 'charged',
    qty: 2,
    chargeStatus: 'CAPTURED',
    redemptionCode: 'RBQ7-K2M4',
  });

  ids.capturedBeforePickup = await makeDrop({
    title: 'Beef Bowl Not Yet Ready',
    minQty: 20,
    maxQty: 30,
    status: 'CAPTURED',
    windowOffsetHours: 20,
  });
  tokens.capturedBeforePickup = await makeParticipant({
    dropCode: ids.capturedBeforePickup,
    customerSuffix: 'beforePickup',
    qty: 1,
    chargeStatus: 'CAPTURED',
    redemptionCode: 'EARLY-9K3',
  });

  ids.partlyCollected = await makeDrop({
    title: 'Beef Bowl Partly Collected',
    minQty: 20,
    maxQty: 30,
    status: 'PICKUP_OPEN',
  });
  tokens.partlyCollected = await makeParticipant({
    dropCode: ids.partlyCollected,
    customerSuffix: 'partly',
    qty: 3,
    redeemedQty: 1,
    chargeStatus: 'CAPTURED',
    redemptionCode: 'PLT3-XY88',
  });

  ids.fullyCollected = await makeDrop({
    title: 'Beef Bowl Fully Collected',
    minQty: 20,
    maxQty: 30,
    status: 'PICKUP_OPEN',
  });
  tokens.fullyCollected = await makeParticipant({
    dropCode: ids.fullyCollected,
    customerSuffix: 'fully',
    qty: 2,
    redeemedQty: 2,
    chargeStatus: 'CAPTURED',
    redemptionCode: 'ALL9-ZZ11',
  });

  ids.chargedPickupEnded = await makeDrop({
    title: 'Beef Bowl Pickup Over',
    minQty: 20,
    maxQty: 30,
    status: 'COMPLETED',
    windowOffsetHours: -5,
  });
  tokens.chargedPickupEnded = await makeParticipant({
    dropCode: ids.chargedPickupEnded,
    customerSuffix: 'ended',
    qty: 1,
    chargeStatus: 'CAPTURED',
    redemptionCode: 'END5-QQ77',
  });

  // The combination a status-only implementation gets wrong: the drop is `CAPTURED`, so a
  // page keying off `drop.status` tells this diner they have food coming. Their card declined.
  ids.declinedOnCapturedDrop = await makeDrop({
    title: 'Beef Bowl Declined Card',
    minQty: 20,
    maxQty: 30,
    status: 'CAPTURED',
  });
  tokens.declined = await makeParticipant({
    dropCode: ids.declinedOnCapturedDrop,
    customerSuffix: 'declined',
    qty: 1,
    chargeStatus: 'FAILED',
    redemptionCode: null,
  });

  ids.waiting = await makeDrop({
    title: 'Beef Bowl Still Filling',
    minQty: 20,
    maxQty: 30,
    status: 'PUBLISHED',
    cutoffOffsetHours: 5,
    windowOffsetHours: 8,
  });
  tokens.waiting = await makeParticipant({
    dropCode: ids.waiting,
    customerSuffix: 'waiting',
    qty: 1,
    chargeStatus: 'NONE',
    redemptionCode: null,
  });

  // `minQty: 1` is a real configuration — one family-sized order fills the drop — and it is
  // the only way to observe the `person`/`people` ternary's false arm.
  ids.soloThreshold = await makeDrop({
    title: 'Beef Bowl One Order',
    minQty: 1,
    maxQty: 30,
    status: 'PUBLISHED',
    cutoffOffsetHours: 5,
    windowOffsetHours: 8,
  });
  tokens.soloThreshold = await makeParticipant({
    dropCode: ids.soloThreshold,
    customerSuffix: 'solo',
    qty: 1,
    chargeStatus: 'NONE',
    redemptionCode: null,
  });

  ids.notCharged = await makeDrop({
    title: 'Beef Bowl That Did Not Run',
    minQty: 20,
    maxQty: 30,
    status: 'FAILED',
    windowOffsetHours: -3,
  });
  tokens.notCharged = await makeParticipant({
    dropCode: ids.notCharged,
    customerSuffix: 'failed',
    qty: 2,
    chargeStatus: 'REFUNDED',
    redemptionCode: 'GONE-0000',
  });

  ids.refundedOnLiveDrop = await makeDrop({
    title: 'Beef Bowl Called Off After Capture',
    minQty: 20,
    maxQty: 30,
    status: 'PICKUP_OPEN',
  });
  tokens.refundedOnLiveDrop = await makeParticipant({
    dropCode: ids.refundedOnLiveDrop,
    customerSuffix: 'refundedLive',
    qty: 2,
    chargeStatus: 'REFUNDED',
    redemptionCode: 'BACK-4R4R',
  });

  ids.singlePlate = await makeDrop({
    title: 'Beef Bowl For One',
    minQty: 20,
    maxQty: 30,
    status: 'PICKUP_OPEN',
  });
  tokens.singlePlate = await makeParticipant({
    dropCode: ids.singlePlate,
    customerSuffix: 'single',
    qty: 1,
    chargeStatus: 'CAPTURED',
    redemptionCode: 'ONE1-AAAA',
  });
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { dropId: { in: createdDropIds } } });
  await prisma.dropParticipant.deleteMany({ where: { dropId: { in: createdDropIds } } });
  await prisma.drop.deleteMany({ where: { id: { in: createdDropIds } } });
  await prisma.menuItem.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchantUser.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
});

async function render(
  publicCode: string,
  searchParams: { t?: string | string[] } = {},
): Promise<{ html: string; text: string }> {
  const page = await import('@/app/d/[publicCode]/mine/page');
  const element = await page.default({
    params: Promise.resolve({ publicCode }),
    searchParams: Promise.resolve(searchParams),
  });
  const html = await renderToHtml(element);
  return { html, text: textOf(html) };
}

/** The emerald block that says the food is theirs, or null. */
function chargedSection(html: string): string | null {
  const match = /<section\b[^>]*class="[^"]*emerald[^"]*"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  return match ? textOf(match[1] ?? '') : null;
}

/** The redemption-code block, or null. */
function codeBlock(html: string): string | null {
  const match = /Redemption code<\/p>\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html);
  return match ? textOf(match[1] ?? '') : null;
}

/**
 * The standalone "Pickup" section's text, or null.
 *
 * Scoped because `windowLabel` is printed **twice** on a charged order — once inside the
 * emerald block and once in this section — so a document-wide `toContain(label)` is satisfied
 * by either. Probe G formatted only this second call site in UTC and survived, which is the
 * fourth time in this repo that a page-wide assertion has measured a different element than
 * the one under test.
 */
function pickupSection(html: string): string | null {
  const match = /<section\b[^>]*>(?:(?!<\/section>)[\s\S])*?<h2\b[^>]*>Pickup<\/h2>([\s\S]*?)<\/section>/.exec(
    html,
  );
  return match ? textOf(match[1] ?? '') : null;
}

/**
 * The header's `<qty> plate(s) · <amount>` line.
 *
 * Scoped for the fourth time in this repo: `1 of 1 still to collect.` and `at least 1 person`
 * both contain a bare `1`, so a document-wide match on the quantity is not a claim about the
 * header. Probe J collapsed the `plate`/`plates` ternary and survived because nothing was
 * reading this line at all.
 */
function quantityLabel(html: string): string {
  const match = /(\d+) (plate|plates) · (?:CA\$|\$)[\d.,]+/.exec(textOf(html));
  if (!match) throw new Error(`No quantity line in: ${textOf(html).slice(0, 200)}`);
  return match[0];
}

describe('/d/:publicCode/mine — a charged order', () => {
  it('names the order, the quantity and the amount', async () => {
    const { html, text } = await render(ids.charged, { t: tokens.charged });

    expect(text).toContain('Copper Kettle');
    expect(text).toContain('Beef Bowl Thursday');
    expect(quantityLabel(html)).toBe(`2 plates · ${formatCents(DEAL * 2)}`);
    expect(text).toContain('You are in — show this at the counter');
  });

  it('uses the singular for a one-plate order', async () => {
    // The other half of the `plate`/`plates` ternary, and the reason probe J survived: every
    // fixture with a drawn header had `qty: 2` or more, so mutating the ternary to the plural
    // unconditionally changed no rendered string. `partlyCollected` is 3; this fixture is 1.
    const { html } = await render(ids.singlePlate, { t: tokens.singlePlate });

    expect(quantityLabel(html)).toBe(`1 plate · ${formatCents(DEAL)}`);
  });

  it('shows the redemption code, and says how many plates are still owed', async () => {
    const { html, text } = await render(ids.charged, { t: tokens.charged });

    expect(codeBlock(html)).toBe('RBQ7-K2M4');
    expect(text).toContain(`You were charged ${formatCents(DEAL * 2)}.`);
    expect(text).toContain('2 of 2 still to collect.');
  });

  it('counts down the plates as they are collected', async () => {
    // 3 ordered, 1 collected → the page says **2 of 3 still to collect**, and the first draft
    // of this assertion said "1 of 3" because the fixture's `redeemedQty` was 1. The page is
    // right and the test was wrong: `outstandingQty` is `qty − redeemedQty`, so the number in
    // the sentence counts plates *owed*, not plates gone. Asserting the collected figure would
    // have passed on an off-by-one in either direction, so both halves are pinned here.
    const { html, text } = await render(ids.partlyCollected, { t: tokens.partlyCollected });

    expect(text).toContain('2 of 3 still to collect.');
    expect(text).not.toContain('1 of 3 still to collect.');
    expect(text).not.toContain('Everything has been collected.');
    // The code is still legitimate — there is food left to hand over.
    expect(codeBlock(html)).toBe('PLT3-XY88');
  });

  it('withholds the code once everything has been collected', async () => {
    // `code` is null when `outstandingQty === 0`, because a code with nothing behind it is a
    // credential for nothing. The diner still sees the order and the amount.
    const { html, text } = await render(ids.fullyCollected, { t: tokens.fullyCollected });

    expect(text).toContain('Everything has been collected.');
    expect(codeBlock(html)).toBeNull();
    expect(html).not.toContain('ALL9-ZZ11');
    // But the section itself is still there — the order did not disappear.
    expect(chargedSection(html)).toContain('You are in');
  });

  it('says the window closed, and withholds the code for the same reason', async () => {
    const { html, text } = await render(ids.chargedPickupEnded, { t: tokens.chargedPickupEnded });

    expect(text).toContain('Pickup has ended');
    expect(text).toContain('The pickup window closed');
    expect(text).toContain('The restaurant may still be able to help — call them.');
    expect(codeBlock(html)).toBeNull();
    expect(html).not.toContain('END5-QQ77');
  });

  it('withholds the code when the money moved but the counter would still refuse it', async () => {
    // The case this suite originally could not see, because its `charged` fixture was itself
    // `CAPTURED` and the code was therefore *correctly* absent — a fixture that made the page
    // look wrong when it was right.
    //
    // Capture runs at the cutoff. For a drop whose pickup is the next day, `CAPTURED` is the
    // honest status and `PICKUP_OPEN` is still hours away. `REDEEMABLE_STATUSES` is
    // `['PICKUP_OPEN', 'COMPLETED']` — deliberately, because the scanner must not hand over
    // food the kitchen has not cooked — so a code printed here is a code the counter refuses.
    // The diner is charged, is told so, and is told where to go; they are not handed a
    // credential that expires before it works.
    const { html, text } = await render(ids.capturedBeforePickup, {
      t: tokens.capturedBeforePickup,
    });

    expect(text).toContain('You are in — show this at the counter');
    expect(text).toContain(`You were charged ${formatCents(DEAL)}.`);
    expect(text).toContain('1 of 1 still to collect.');
    expect(codeBlock(html)).toBeNull();
    expect(html).not.toContain('EARLY-9K3');
    // Not the same answer as an ended window: the window is in the future, so the diner is
    // told when to come rather than to phone the restaurant.
    expect(text).not.toContain('Pickup has ended');
  });
});

describe('/d/:publicCode/mine — the `chargeStatus` is the authority, not the drop status', () => {
  it('says nothing was charged to a declined diner on a captured drop', async () => {
    // The one combination a status-only implementation gets wrong. The drop is `CAPTURED`, so
    // a page keyed off `drop.status` renders "You are in — show this at the counter" to
    // somebody whose card was declined. `resolveOrderView` keys off `chargeStatus` for exactly
    // this reason, and no single-drop fixture can express it.
    const { html, text } = await render(ids.declinedOnCapturedDrop, { t: tokens.declined });

    expect(text).toContain('Nothing was charged');
    expect(text).toContain(
      'This drop did not go ahead, so your card was not charged and any hold has been released. You owe nothing.',
    );
    expect(text).not.toContain('show this at the counter');
    expect(codeBlock(html)).toBeNull();
  });

  it('describes a waiting order as a hold, and says the code has not been sent', async () => {
    // FR-404's sentence — the state the whole product is built around, and the most important
    // one on the page.
    const { html, text } = await render(ids.waiting, { t: tokens.waiting });

    expect(text).toContain('Your card is held, not charged');
    expect(text).toContain(
      'This offer needs at least 20 people to go ahead. If it does not fill, the hold is released and you owe nothing.',
    );
    expect(text).toContain('We will send your code as soon as the drop is confirmed.');
    expect(codeBlock(html)).toBeNull();
  });

  it('uses the singular for a one-person threshold', async () => {
    // The first version of this test rendered the 20-person `waiting` fixture and asserted
    // `at least 20 people` plus `not 'at least 20 person'`. Both halves are true of a page
    // whose branch is `people` unconditionally, so it proved nothing — a false arm nobody
    // could observe. `minQty: 1` is a real drop configuration (one family-sized order), so
    // the fixture is the fix.
    const [{ text: many }, { text: one }] = await Promise.all([
      render(ids.waiting, { t: tokens.waiting }),
      render(ids.soloThreshold, { t: tokens.soloThreshold }),
    ]);

    expect(many).toContain('at least 20 people');
    expect(one).toContain('at least 1 person');
    // Not just "the plural is absent" — that would pass on a page that printed neither.
    expect(one).not.toContain('at least 1 people');
  });

  it('says nothing was charged on a failed drop, and keeps the code off the page', async () => {
    const { html, text } = await render(ids.notCharged, { t: tokens.notCharged });

    expect(text).toContain('Nothing was charged');
    expect(text).toContain('You owe nothing.');
    // The fixture's participant still carries a `redemptionCode` row. The page must not print
    // it: `resolveOrderView` returns `code: null` for `NOT_CHARGED`, and the assertion is on
    // the document rather than the block so a second render path cannot leak it.
    expect(html).not.toContain('GONE-0000');
    expect(codeBlock(html)).toBeNull();
  });

  it('treats a refunded charge as nothing charged, even while the drop says captured', async () => {
    // Probe X deleted `REFUNDED` from the resolver's not-charged arm and survived: `notCharged`
    // is `FAILED` at the *drop* level, so the `input.dropStatus === 'FAILED'` clause decided it
    // and the `chargeStatus` clause was never load-bearing. This fixture is a refunded
    // participant on a healthy `PICKUP_OPEN` drop — a drop the restaurant called off after
    // capture, refunded per FR-505 — which leaves `chargeStatus` as the only thing that can
    // classify it.
    const { html, text } = await render(ids.refundedOnLiveDrop, { t: tokens.refundedOnLiveDrop });

    expect(text).toContain('Nothing was charged');
    expect(text).not.toContain('You are in — show this at the counter');
    expect(text).not.toContain('You were charged');
    // A code on this row is a code for food that was paid for and given back.
    expect(html).not.toContain('BACK-4R4R');
    expect(codeBlock(html)).toBeNull();
  });
});

describe('/d/:publicCode/mine — the invalid-link answer, which is one answer for all failures', () => {
  it('refuses a missing token with the generic sentence and a way back', async () => {
    const { html, text } = await render(ids.charged);

    expect(text).toContain('This link is not valid');
    expect(text).toContain(
      'It may have been truncated by your messaging app, or it belongs to an order that no longer exists. Open the most recent message we sent you, or ask the restaurant.',
    );
    expect(text).toContain('See this offer');
    expect(html).toContain(`href="/d/${ids.charged}"`);
  });

  it('logs a token that failed and stays silent when there was no token at all', async () => {
    // A wave of invalid tokens is the only signal that a messaging app is truncating links,
    // and it cannot be seen in markup — probe M swapped the guard that decides whether this
    // fires and every render assertion stayed green. Both arms are asserted, because "logs
    // always" is as wrong as "logs never": a diner who opened a bare URL is not an incident.
    vi.mocked(logger.warn).mockClear();

    await render(ids.charged);
    expect(logger.warn).not.toHaveBeenCalled();

    await render(ids.charged, { t: 'p1.eyJhIjoxfQ.notasignature' });
    expect(logger.warn).toHaveBeenCalledWith('participant.order_link_invalid', {
      publicCode: ids.charged,
    });
  });

  it('composes "See this offer" from the canonical code, not the segment it was given', async () => {
    /**
     * The second-URL problem, at the page that renders the link.
     *
     * A diner who opens a lowercased link gets a page that works — the order loads,
     * because the lookup normalises. But if this page echoed the segment it received
     * into its own "See this offer" link, `/d/abc2345` and `/d/ABC2345` would become
     * two distinct strings for one drop: share counts split, and a lowercased code goes
     * into the diner's history. It must compose the stored form instead.
     *
     * The token is deliberately *not* provided, so this exercises the refusal branch —
     * which is where the link is rendered — and keeps the assertion independent of the
     * order view.
     */
    expect(ids.charged.toLowerCase()).not.toBe(ids.charged);

    const { html } = await render(ids.charged.toLowerCase());

    expect(html).toContain('See this offer');
    expect(html).toContain(`href="/d/${ids.charged}"`);
    expect(html).not.toContain(`href="/d/${ids.charged.toLowerCase()}"`);
  });

  it('gives the same answer for a forged signature as for a missing one', async () => {
    // Distinguishing them would tell an attacker which of their guesses was closer, so the
    // suite asserts they are indistinguishable rather than merely both refusals.
    const missing = await render(ids.charged);
    const forged = await render(ids.charged, { t: 'p1.eyJhIjoxfQ.notasignature' });

    expect(forged.text).toBe(missing.text);
  });

  it('refuses a token whose payload names the real participant but whose signature is junk', async () => {
    // **This test exists because a weaker one survived a probe.** The forged token above is
    // malformed in three ways at once — it is not base64 of a real payload, it names no
    // participant, and its signature is nonsense — so a loader that skipped signature
    // verification entirely would still find no row and still render the refusal. Probe P
    // proved it: replacing the page's `token ? … : null` guard left the suite green.
    //
    // This token is wrong in exactly one way. The payload is a genuine signing of a genuine
    // participant on this very drop; only the signature is replaced. If `verifyParticipantAccess`
    // ever stops checking, this renders a page that leaks a diner's order to anyone who can
    // read two ids out of a shared link.
    const genuine = tokens.charged!;
    const [version, body] = genuine.split('.');
    const swapped = `${version}.${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

    const { html, text } = await render(ids.charged, { t: swapped });

    expect(text).toContain('This link is not valid');
    expect(text).not.toContain('Beef Bowl Thursday');
    expect(html).not.toContain('RBQ7-K2M4');
    expect(codeBlock(html)).toBeNull();
  });

  it('gives the same answer for a valid token on the wrong drop', async () => {
    // The token names the participant *and* the drop, and `loadOrderPage` filters on both — so
    // a token from one drop pasted onto another's URL is the same refusal, not a partial view.
    const wrongDrop = await render(ids.partlyCollected, { t: tokens.charged });

    expect(wrongDrop.text).toContain('This link is not valid');
    expect(wrongDrop.text).not.toContain('Beef Bowl Thursday');
  });

  it('takes the first of a repeated ?t= rather than coercing the array', async () => {
    // A repeated parameter arrives as an array. Taking the first is not a security decision —
    // every candidate has to verify anyway — but it keeps the type honest.
    //
    // Probe O (take the last element instead) kills this, because the second candidate is a
    // junk token: with the last one selected the page refuses, so the *answer* is what the
    // ordering decides, not just which token gets tried.
    const { text } = await render(ids.charged, { t: [tokens.charged!, 'p1.zzz.zzz'] });

    expect(text).toContain('Beef Bowl Thursday');
    expect(text).not.toContain('This link is not valid');
  });
});

describe('/d/:publicCode/mine — what the page deliberately does not print', () => {
  it('shows four digits of the phone and never the number', async () => {
    // The minimisation `manifest.ts` applies to the staff screen, applied to the diner's own.
    // A link that leaks in a group chat discloses an order, not a contact.
    //
    // The negative half quotes *this fixture's* stored number rather than the bare last four:
    // `not.toContain('0199')` would pass for the wrong reason the moment any other digit on
    // the page happened to include it, and every fixture here ends `0199` anyway, so the
    // discriminated claim is about the whole string, not the tail.
    const { html, text } = await render(ids.charged, { t: tokens.charged });
    const phone = phones.charged!;

    expect(phone.endsWith('0199')).toBe(true);
    expect(text).toContain('under the number ending 0199');
    expect(html).not.toContain(phone);
    // …and not the digits without the `+`/country code either, which is how a formatter would
    // leak it if one were ever introduced.
    expect(html).not.toContain(phone.replace('+1', ''));
    // And **not** a whole number either. Probe Q appended the length instead of the digits and
    // survived, so `phoneLast4` alone is too narrow a claim: the page must not print a
    // number-shaped run anywhere, including one it computed rather than read.
    expect(text).not.toMatch(/\d{10,}/);
  });

  it('prints the pickup address and instructions, and nothing null', async () => {
    const { text } = await render(ids.charged, { t: tokens.charged });

    expect(text).toContain('123 10 Ave NE, Calgary');
    expect(text).toContain('Side door, ring the bell.');
    expect(text).toContain('Pickup');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('formats the pickup window in the merchant’s zone, not the server’s', async () => {
    // A shape regex does not test a timezone — `Weekday h:mm – h:mm` matches UTC output just
    // as well. The host running this suite is `America/Edmonton`; the fixture merchant is
    // `America/Toronto`, so the two readings differ by two hours and the label has to be
    // computed independently and compared.
    const drop = await prisma.drop.findFirstOrThrow({
      where: { publicCode: ids.charged },
      select: { windowStart: true, windowEnd: true },
    });
    const { text: whole } = await render(ids.charged, { t: tokens.charged! });

    const time = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: MERCHANT_TZ,
    });
    const day = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: MERCHANT_TZ,
    }).format(drop.windowStart);
    const expected = `${day}, ${time.format(drop.windowStart)} – ${time.format(drop.windowEnd)}`;

    // Scoped to the Pickup section, not the document: the same label is printed inside the
    // emerald block, and a page-wide `toContain` would be satisfied by whichever copy was
    // left in the right zone. Probe G survived on exactly that.
    //
    // `toContain` rather than `toBe` because the section also carries the address and the
    // instructions — the claim is about which zone the label was formatted in, not about the
    // section containing nothing else.
    const scoped = pickupSection((await render(ids.charged, { t: tokens.charged! })).html);
    expect(scoped).toContain(expected);
    // The section is the one this test thinks it is. A regex that quietly matched some other
    // `<section>` would make the assertion above measure the wrong element.
    expect(scoped).toContain('123 10 Ave NE, Calgary');
    expect(scoped).not.toContain('Redemption code');
    // The document agrees, but that is the weaker claim and is why the scoped one comes first.
    expect(whole).toContain(expected);

    // Guard on the guard: if the ambient zone ever agreed with the fixture's, this test would
    // pass without testing anything. The host is pinned to `America/Edmonton` and the fixture
    // merchant to `America/Toronto`, so the readings differ by two hours and never coincide —
    // but the assertion is what makes that a fact rather than an assumption about the host.
    const ambient = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(drop.windowStart);
    expect(time.format(drop.windowStart)).not.toBe(ambient);

    // And the whole label differs in the ambient zone, weekday included — not only the clock,
    // which is what a `hour`+`minute`-only comparison would have settled for.
    const ambientLabel = `${new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(
      drop.windowStart,
    )}, ${ambient}`;
    const utcLabel = `${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
      drop.windowStart,
    )}, ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
      drop.windowStart,
    )}`;
    expect(expected).not.toBe(utcLabel);
    expect(expected).not.toBe(ambientLabel);
  });

  it('is never indexed and never cached', async () => {
    // A tokenised URL must not appear in search results, and `nocache` keeps it out of a
    // shared cache that another diner's browser could read.
    const page = await import('@/app/d/[publicCode]/mine/page');

    expect(page.metadata.robots).toEqual({ index: false, follow: false, nocache: true });
    expect(page.metadata.title).toBe('Your order — GroupEat');
  });
});
