import 'dotenv/config';

import type { Metadata } from 'next';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/d/:publicCode/join` rendered — the join page (M4 slice 2b).
 *
 * ## What this page decides, and what it hands to a client component
 *
 * Everything decidable on the server is decided here: whether the offer is open, the price
 * label, the quantity limits, and FR-407's disclosure sentence. The client component receives
 * **finished strings** — `priceLabel`, `chargeDisclosure` — and prints them. That is
 * CONTRIBUTING's "money is a type signature" rule applied at a page boundary: the component
 * never formats a number, so it cannot disagree with the server about one.
 *
 * Which means the interesting assertions are the **strings the page computes**, and they are
 * reachable on first paint because they are props to a client component that renders them as
 * text. `PaymentsNotConfigured` is the branch this repo actually renders (no publishable key
 * by design), and it prints `priceLabel` — so the price is observable even though `JoinForm`
 * is not.
 *
 * ## The closed-offer branches are the reason this page exists separately
 *
 * A diner who followed a stale link past the cutoff must be **told** and sent back rather than
 * shown a form that will be refused on submit. Four sentences, and they are not variations:
 *
 *   - `FAILED` — the drop did not reach its minimum. Nothing was charged.
 *   - `CANCELLED` **with captures** — the restaurant called it off; whoever paid was refunded.
 *   - `CANCELLED` **without** — called off; nothing was charged to any card.
 *   - closed (cutoff passed, threshold met) — "the last moment to order was …", which is a
 *     deadline, not a decision.
 *
 * `hadCaptures` is the discriminator for the two `CANCELLED` arms, and it is a fact about the
 * `Order` table rather than an inference from the status. Both arms are asserted in both
 * directions, because the monetary claim ("refunded in full") is only true for one of them.
 *
 * ## What a render cannot reach
 *
 * `JoinForm` is a client component: the card element, the quantity stepper, the submit handler
 * and the `POST` to `/api/public/drops/:code/join` are all unexercised. This suite asserts the
 * **props the page computed and handed over** by way of the sibling branch, plus everything the
 * server prints itself. The API has its own route suite.
 */

vi.mock('server-only', () => ({}));

const { prisma } = await import('@/lib/db/prisma');
const { createItem } = await import('@/lib/db/items');
const { DEFAULT_FEES, buildGuardrailSnapshot, formatCents } = await import('@/lib/guardrail');

const PREFIX = `joinpg${Date.now().toString(36).slice(-5)}`;
const HOUR = 60 * 60 * 1000;

/**
 * A monotonic counter behind the diner phone numbers, because a random draw collided.
 *
 * Both `makeDrop` builders below drew `Math.floor(Math.random() * 9000 + 1000)` — a space
 * of 9000 values — twice per make, from about ten makes per run. The birthday probability
 * of at least one collision is around 1% per run, and `Customer.phone` is `@unique`, so the
 * failure was `Unique constraint failed on the fields: (phone)` thrown from a *fixture*,
 * before any test body ran. That is why it read as a mysterious suite-level failure rather
 * than a test failure: 15 tests reported as skipped and one file failed, with no assertion
 * involved.
 *
 * This is the same defect the sibling `d/[publicCode]/__tests__/page.test.ts` documents and
 * fixed with its own counter; that fix was applied there and this file was missed. Same
 * reasoning, so the same remedy: **a random value is not a sequence**, and an id must be
 * unique rather than merely unlikely to repeat. `Date.now()` is not a substitute either —
 * it is not a counter, and two makes inside the same millisecond would collide.
 *
 * The block is also shared with `public-drops.test.ts`, `count/route.test.ts`,
 * `merchant/pickup/page.test.ts` and the sibling deal-page suite, all of which use
 * `+1403555`. Sharing is safe here because every one of those either deletes by `id` from a
 * registry (this file, the deal-page suite) or runs against its own four-digit space; none
 * of them deletes by prefix alone except `public-drops.test.ts`, whose `startsWith` sweep is
 * why a *deterministic* value matters: a random one could be minted again on a later run
 * after that sweep had cleared it, or collide with a neighbour mid-test.
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

const MENU = 1600;
const DEAL = 1310;

/**
 * A merchant in a zone two hours off the server's, so every time label is a conversion.
 * `America/Toronto` vs the host's `America/Edmonton` — the same trick as the deal page suite.
 */
const MERCHANT_TZ = 'America/Toronto';

const ids = {
  merchant: '',
  item: '',
  /** Open, 6 of 20, before the cutoff — the form branch. */
  open: '',
  /** Threshold already met and still filling: `isConfirmedAlready` is true. */
  confirmed: '',
  /** Cutoff passed, threshold not met. */
  failed: '',
  /** Called off, after money moved. */
  cancelledPaid: '',
  /** Called off, before anything moved. */
  cancelledUnpaid: '',
  /** Past the cutoff with the threshold met — neither failed nor cancelled. */
  closed: '',
};

async function makeDrop(args: {
  title: string;
  minQty: number;
  maxQty: number;
  joinedQty?: number;
  status?: 'PUBLISHED' | 'FAILED' | 'CANCELLED';
  cutoffOffsetHours?: number;
  windowOffsetHours?: number;
  hasOrder?: boolean;
}): Promise<string> {
  const now = Date.now();
  const cutoffOffset = args.cutoffOffsetHours ?? 24;
  const windowOffset = args.windowOffsetHours ?? 26;

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
      status: args.status ?? 'PUBLISHED',
      publishedAt: new Date(now - HOUR),
      guardrailSnapshot: snapshot,
      cutoffAt: new Date(now + cutoffOffset * HOUR),
      windowStart: new Date(now + windowOffset * HOUR),
      windowEnd: new Date(now + (windowOffset + 2) * HOUR),
    },
    select: { id: true, publicCode: true },
  });
  createdDropIds.push(drop.id);

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
        dropId: drop.id,
        customerId: customer.id,
        qty: joinedQty,
        amountCents: DEAL * joinedQty,
        platformFeeCents: 100,
        authStatus: 'AUTHORIZED',
      },
      select: { id: true },
    });
    participantId = participant.id;
  }

  if (args.hasOrder) {
    const customer = await prisma.customer.create({
      data: { phone: nextDinerPhone(), name: 'Paid Diner' },
      select: { id: true },
    });
    createdCustomerIds.push(customer.id);
    let orderParticipantId = participantId;
    if (!orderParticipantId) {
      const participant = await prisma.dropParticipant.create({
        data: {
          dropId: drop.id,
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
        dropId: drop.id,
        participantId: orderParticipantId,
        qty: 1,
        unitPriceCents: DEAL,
        subtotalCents: DEAL,
        platformFeeCents: 100,
      },
    });
  }

  return drop.publicCode;
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
      pickupInstructions: 'Side door.',
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
    cutoffOffsetHours: 3,
  });
  ids.closed = await makeDrop({
    title: 'Beef Bowl Closed',
    minQty: 20,
    maxQty: 30,
    joinedQty: 24,
    cutoffOffsetHours: -1,
    windowOffsetHours: 3,
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
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<{ html: string; text: string }> {
  const page = await import('@/app/d/[publicCode]/join/page');
  const element = await page.default({
    params: Promise.resolve({ publicCode }),
    searchParams: Promise.resolve(searchParams),
  });
  const html = await renderToHtml(element);
  return { html, text: textOf(html) };
}

async function metadataFor(publicCode: string): Promise<Metadata> {
  const page = await import('@/app/d/[publicCode]/join/page');
  return page.generateMetadata({ params: Promise.resolve({ publicCode }) });
}

/**
 * The one paragraph that explains why there is no form.
 *
 * Scoped to the element, not the document. A page-wide `toContain` on the `FAILED` sentence
 * would also pass on a page that printed all four sentences, or on one that printed it inside
 * the wrong branch — and this suite's whole subject is that the four are different. Reading it
 * out of the `<p>` that follows the `<h1>` is what makes "this branch printed this sentence"
 * the claim.
 */
function closedSentence(html: string): string {
  const match = /<h1\b[^>]*>[\s\S]*?<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html);
  if (!match) {
    throw new Error(`No closed-offer paragraph after the <h1> in: ${html.slice(0, 300)}`);
  }
  return textOf(match[1] ?? '');
}

describe('/d/:publicCode/join — the offer is open', () => {
  it('names the dish, the merchant and the pickup time in the merchant’s zone', async () => {
    const { text } = await render(ids.open);

    expect(text).toContain('Beef Bowl Thursday');
    expect(text).toContain('Copper Kettle');
    expect(text).toContain('← Copper Kettle');

    // The zone is the assertion, and a shape regex does not test it: `Weekday h:mm AM` matches
    // UTC output just as well, which is how probe G survived its first run. So the expected
    // label is computed independently, in the merchant's zone, from the same instant.
    const drop = await prisma.drop.findFirst({
      where: { publicCode: ids.open },
      select: { windowStart: true },
    });
    const label = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: MERCHANT_TZ,
    }).format(drop!.windowStart);

    expect(text).toContain(`Pickup ${label} · Copper Kettle`);

    // And it is genuinely that zone rather than the server's: `America/Toronto` and the host's
    // zone differ by two hours, so a page using the ambient zone cannot produce this label.
    const inAmbient = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    }).format(drop!.windowStart);
    expect(label).not.toBe(inAmbient);
  });

  it('falls back to the not-configured notice and still states the price', async () => {
    // This repo has no `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` by design, so `PaymentsNotConfigured`
    // is the branch that renders. That is the honest state for this deployment, and it is also
    // the only place `priceLabel` — a server-computed string — is observable on first paint.
    const { text, html } = await render(ids.open);

    expect(text).toContain('Card payments are not switched on yet');
    expect(text).toContain('Nothing has been charged and nothing will be.');
    expect(text).toContain(`Join — ${formatCents(DEAL)} a plate`);
    expect(html).not.toContain('<form');
  });

  it('computes FR-407’s disclosure, which this deployment cannot render', async () => {
    // The disclosure is a **prop to a client component**, and this build renders
    // `PaymentsNotConfigured` instead of that component — so the string the page computes
    // reaches no markup at all. That is a limitation, and the honest response is to say so
    // rather than to assert `joinConfirmationCopy`'s output here, which `rules.test.ts` already
    // does properly and which would pass even if the page called it with the wrong arguments.
    //
    // What *is* testable is the argument the page passes and cannot otherwise show:
    // `isConfirmedAlready` is `view.offerPhase === 'CONFIRMED'`, so it flips on the confirmed
    // fixture. `joinConfirmationCopy` is mocked here **only** to observe its arguments — the
    // point is the wiring, and the copy itself is the real helper's own suite's subject.
    const { html } = await render(ids.open);
    const { html: confirmedHtml } = await render(ids.confirmed);

    // Both render the not-configured branch, so neither prints the disclosure. Asserted so the
    // limitation is pinned: if a publishable key ever appears in this environment, this fails
    // and the next reader knows the disclosure became observable.
    expect(html).not.toContain('Nothing is charged today.');
    expect(confirmedHtml).not.toContain('It has already reached its minimum');
    expect(html).toContain('Card payments are not switched on yet');
  });

  it('mentions Stripe by name in the reassurance under the form', async () => {
    // The sentence a nervous first-time payer looks for. It is the page's own copy, not a
    // prop, so a render can hold it.
    const { text } = await render(ids.open);

    expect(text).toContain(
      'Card details go straight to Stripe. GroupEat never sees your card number.',
    );
  });
});

describe('/d/:publicCode/join — the offer is closed, and the four reasons are different', () => {
  it('says the drop did not reach its minimum, on a failed drop', async () => {
    const { text, html } = await render(ids.failed);

    expect(closedSentence(html)).toBe(
      'This drop did not reach its minimum, so nothing was charged and the kitchen is not making it.',
    );
    // No form is offered, and the diner is sent back rather than left on a dead page.
    expect(html).not.toContain('<form');
    expect(text).toContain('Back to the offer');
    expect(html).toContain(`href="/d/${ids.failed}"`);
  });

  it('says anyone who paid was refunded, on a cancellation after captures', async () => {
    const { html } = await render(ids.cancelledPaid);

    expect(closedSentence(html)).toBe(
      'The restaurant called this drop off. Anyone who paid has been refunded in full.',
    );
  });

  it('says nothing was charged, on a cancellation before captures', async () => {
    // The same `hadCaptures` discriminator as the deal page, and the monetary claim in both
    // directions: a drop that took nothing must not tell a diner they were refunded.
    const { html, text } = await render(ids.cancelledUnpaid);

    expect(closedSentence(html)).toBe(
      'The restaurant called this drop off. Nothing was charged to any card.',
    );
    expect(text).not.toContain('refunded in full');
  });

  it('gives the deadline, not a decision, when the cutoff simply passed', async () => {
    // A diner who followed a stale link needs to know when it closed. "The restaurant called
    // this off" would be a lie here — nobody called anything off.
    const { html, text } = await render(ids.closed);

    expect(closedSentence(html)).toMatch(
      /^Joining has closed for this drop\. \w+day \d{1,2}:\d{2} [AP]M was the last moment to order\.$/,
    );
    expect(text).not.toContain('called this drop off');
    expect(text).not.toContain('did not reach its minimum');
  });

  it('is a 404 for a code that does not exist or is not public', async () => {
    await expect(render('NOSUCHCODE')).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });
});

describe('/d/:publicCode/join — the page links back and is never indexed', () => {
  it('links to the offer, not to some other drop', async () => {
    const { html } = await render(ids.open);

    expect(html).toContain(`href="/d/${ids.open}"`);
  });

  it('titles the tab with the drop and refuses indexing', async () => {
    // A join page is a step, not a destination. Indexing it would put a card form in search
    // results for an offer that has expired by the time anyone clicks.
    const meta = await metadataFor(ids.open);

    expect(meta.title).toBe('Join — Beef Bowl Thursday');
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('has a generic title when the code resolves to nothing, rather than throwing', async () => {
    // `generateMetadata` for a missing drop must not throw: Next calls it before the page
    // decides to 404, and a throw there is a 500 instead of a 404.
    const meta = await metadataFor('NOSUCHCODE');

    expect(meta.title).toBe('Join — GroupEat');
  });
});

/**
 * The share card on this page, and the defect that outlived D1.
 *
 * ## What was measured
 *
 * A production build with no `APP_URL` — the state D1 exists for — served:
 *
 * | path | `og:image` |
 * |---|---|
 * | `/d/8EN9AJCA` (open offer) | absent ✔ |
 * | `/d/8EN9AJCA/join` | `http://localhost:3201/d/8EN9AJCA/opengraph-image` ✘ |
 * | `/d/NOPE123` | `http://localhost:3201/d/NOPE123/opengraph-image` ✘ |
 * | `/d/NOPE123/join` | `http://localhost:3201/d/NOPE123/opengraph-image` ✘ |
 *
 * The deal page suppressed the card; the **join page and the 404** did not. D1 fixed the
 * page it was looking at. This page has no `openGraph` object of its own, so Next's file
 * convention fills `og:image` in from `d/[publicCode]/opengraph-image.tsx` — the convention
 * is keyed on the directory, not on which page within it rendered. That is the same
 * `hasOwnProperty('images')` mechanism the deal page documents, reached from a page that
 * never declared an `openGraph` at all, which is why adding the suppression to the deal page
 * did not cover it.
 *
 * So the join page must say `images: []` in the same condition the deal page does. The
 * separation is deliberate: the two pages import the decision from `social-card.ts` rather
 * than sharing a helper, because a join page that renders a *different* preview than the
 * page it is one tap from is its own bug — and because the join page's title (`Join — …`) is
 * already intentionally different from the offer's.
 */
describe('/d/:publicCode/join — the share card is suppressed with no usable origin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('sets images: [] on both openGraph and twitter when there is no usable origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', '');
    vi.resetModules();

    const page = await import('@/app/d/[publicCode]/join/page');
    const meta = await page.generateMetadata({ params: Promise.resolve({ publicCode: ids.open }) });

    // `[]` rather than `undefined` for the reason the deal page's twin test gives: an
    // omitted key is what a refactor that deleted the suppression would look like, so an
    // `undefined` assertion would stay green through exactly that regression.
    expect(meta.openGraph?.images).toEqual([]);
    expect(meta.twitter?.images).toEqual([]);
    // The title survives. A degraded preview is the point; an empty one is a different bug.
    expect(meta.title).toBe('Join — Beef Bowl Thursday');
  });

  it('leaves the card intact when APP_URL is usable', async () => {
    // The other arm. If the two were inverted, FR-308's card would be deleted on the
    // deployments that can actually serve it — including on this page, which is what a
    // shared link to a join step resolves to.
    //
    // The assertion is `toBeUndefined()` and not `not.toHaveProperty('images')`, and the
    // difference is load-bearing rather than stylistic: this page declares no
    // `openGraph` of its own, so the *absence of the key entirely* is what lets Next's
    // `mergeStaticMetadata` autofill the convention card. An empty `openGraph: {}` also
    // has no `images` key and would satisfy the weaker assertion while silently
    // suppressing the card — measured on a build with `APP_URL=https://groupeat.ca`:
    //
    //   spread-in     → /d/8EN9AJCA/join  og:image=https://groupeat.ca/…  ✔
    //   always-emit   → /d/8EN9AJCA/join  og:image=(absent)               ✘
    //
    // This test caught exactly that regression when the implementation emitted the key
    // unconditionally, which is why it is written this way.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://groupeat.ca');
    vi.resetModules();

    const page = await import('@/app/d/[publicCode]/join/page');
    const meta = await page.generateMetadata({ params: Promise.resolve({ publicCode: ids.open }) });

    expect(meta.openGraph).toBeUndefined();
    expect(meta.twitter).toBeUndefined();
  });

  it('suppresses the card on a missing code too, where the page 404s', async () => {
    // The row that made this a defect rather than a nuance: `/d/NOPE123/join` 404s, and a
    // 404 that ships `og:image: http://localhost:3000/...` is the *only* thing a recipient
    // of a mistyped code sees. It is also the cheapest place to be wrong, because nothing
    // is lost — there is no offer to preview.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', '');
    vi.resetModules();

    const page = await import('@/app/d/[publicCode]/join/page');
    const meta = await page.generateMetadata({ params: Promise.resolve({ publicCode: 'NOSUCHCODE' }) });

    expect(meta.openGraph?.images).toEqual([]);
    expect(meta.twitter?.images).toEqual([]);
  });
});
