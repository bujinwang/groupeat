import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/admin/merchants/:id` rendered — gap 12, US-A1/US-A2 and FR-904's entry point.
 *
 * The admin page is the merchant page's mirror image on two counts, and both are rules
 * rather than layout:
 *
 *   1. **The floor IS editable here.** The merchant's own settings page states the number
 *      and offers nothing; this one offers the only control in the product that can move it.
 *      PRD-sprint1 Q-4's reasoning is that a merchant lowering their own floor to "make the
 *      deal work" defeats the guardrail — the admin is the party who is allowed to.
 *   2. **The dish panel here is a read-only evaluation, and it prints differently.** Each
 *      row prints *either* the lowest viable price or the copy's headline, chosen by
 *      `lowest === null`. That is one ternary covering two very different sentences, and
 *      getting it backwards would put a price on a dish that can never be in a deal.
 *
 * ## What is asserted per dish row, and why the branch matters
 *
 * `const lowest = evaluation.view?.minViablePriceCents ?? null;` then
 * `lowest === null ? copy.headline : 'Lowest deal price $X'`. `view` is null for every
 * ineligible dish and non-null for every priceable one, so:
 *
 *   - an **ineligible** dish prints the reason ("contains alcohol" / "not batchable") and
 *     **no figure at all**, because there is no batch to price;
 *   - a **priceable** dish prints `Lowest deal price $X`, and the copy's headline is absent.
 *
 * Both directions are asserted on the same row, because "prints the right headline" is
 * satisfied by a page that prints the headline *and* a bogus price underneath it.
 *
 * ## Impersonation starts from this page, and the owner filter is a real branch
 *
 * `ImpersonateControl` receives **every** member and filters to `role === 'OWNER'` itself.
 * If the merchant has no owner it renders a sentence explaining why rather than a control
 * that would fail on submit. Two fixtures hold that: one merchant with an owner and staff,
 * one with only a manager. The manager's email must not appear in the owner `<select>` —
 * that is what makes the filter load-bearing rather than decorative.
 *
 * ## The database is shared, so nothing asserts a global total
 *
 * `Dishes (N)` is scoped to this file's own merchant, which is safe because the merchant is
 * freshly created. Nothing here asserts an `AiDraft` or user count in the abstract.
 *
 * ## What is mocked
 *
 * `server-only` and nothing else. The page reads no session — the `(admin)` layout has
 * already established the caller is an ADMIN — so the page function is callable directly.
 * `FloorEditor` uses `useActionState`, which renders as a `<form action={…}>` under a plain
 * render; `ImpersonateControl` uses `useState` only, and neither calls `useRouter`, so
 * `renderToHtml` suffices.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

// The page itself does not read a session, but `actions.ts` (imported by `FloorEditor`) does
// at module scope via `@/lib/auth/session`. Mocking it keeps that import inert.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => null,
}));

const { prisma } = await import('@/lib/db/prisma');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `admch${Date.now().toString(36).slice(-5)}`;

const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];
const createdItemIds: string[] = [];
const createdDraftIds: string[] = [];

/** 25% floor, one dish of each kind, one owner and one manager, two AI runs. */
const ids = {
  full: '',
  /** No dishes, no drafts, one owner. */
  empty: '',
  /** A manager and nothing else — the "no owner account" branch. */
  ownerless: '',
  /** Two dishes, so the plural branch of `Dishes (N)` is provable against an empty one. */
  singular: '',
  /** Not ACTIVE, so the badge's `tone === 'ok' ? … : 'neutral'` false arm renders. */
  suspended: '',
  /**
   * One dish at $24.00, so `highestMenuPriceCents` returns something that is **not** 1600.
   *
   * `ids.full` cannot test the highest-price lookup: every one of its dishes is $16.00, and
   * $16.00 is the fallback constant the page uses when a merchant has no dishes at all. So
   * `highest ?? 1600` and a hardcoded `1600` print the same sentence on that fixture, and a
   * broken lookup would look correct. Found by checking what the assertion *could* fail on
   * rather than by watching it pass.
   */
  pricier: '',
};

async function makeMerchant(args: {
  suffix: string;
  name: string;
  floorPct: string;
  status?: string;
  pickupAddress?: string | null;
  pickupInstructions?: string | null;
}): Promise<string> {
  const merchant = await prisma.merchant.create({
    data: {
      name: args.name,
      slug: `${PREFIX}-${args.suffix}`,
      status: (args.status ?? 'ACTIVE') as never,
      floorPctOfMenu: args.floorPct,
      pickupAddress: args.pickupAddress ?? null,
      pickupInstructions: args.pickupInstructions ?? null,
    },
    select: { id: true },
  });
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

async function addMember(
  merchantId: string,
  emailSuffix: string,
  role: 'OWNER' | 'MANAGER' | 'STAFF',
  name: string | null = null,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${emailSuffix}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      name,
      mustChangePassword: false,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  await prisma.merchantUser.create({ data: { merchantId, userId: user.id, role } });
  return user.id;
}

async function makeDish(args: {
  merchantId: string;
  name: string;
  menuPriceCents: number;
  foodCostCents: number;
  packagingCents: number;
  isBatchable?: boolean;
  containsAlcohol?: boolean;
}): Promise<string> {
  const item = await prisma.menuItem.create({
    data: {
      merchantId: args.merchantId,
      name: args.name,
      menuPriceCents: args.menuPriceCents,
      foodCostCents: args.foodCostCents,
      packagingCents: args.packagingCents,
      batchYield: 30,
      prepMinutes: 6,
      category: 'Bowls',
      isBatchable: args.isBatchable ?? true,
      containsAlcohol: args.containsAlcohol ?? false,
    },
    select: { id: true },
  });
  createdItemIds.push(item.id);
  return item.id;
}

async function makeDraft(merchantId: string, index: number): Promise<void> {
  const draft = await prisma.aiDraft.create({
    data: {
      merchantId,
      merchantName: 'Fixture Merchant',
      surface: 'merchant_builder',
      promptVersion: 'v1',
      inputJson: {},
      outputJson: {},
      guardrailPassed: true,
    },
    select: { id: true },
  });
  createdDraftIds.push(draft.id);
  expect(index).toBeGreaterThan(0);
}

/**
 * Vector A's dish: menu 1600, food 480, packaging 80, 25% floor → `$11.12` lowest viable.
 *
 * The same numbers as `items/__tests__/page.test.ts` uses, deliberately: the admin page and
 * the merchant page evaluate through the same `evaluateItem`, and a divergence between the
 * two figures would be a defect this suite could not see if it invented its own arithmetic.
 */
// The keys have to be `makeDish`'s argument names, not shorthand for them: this object is
// spread into `makeDish({ …, ...A })`, so a key called `menu` lands in `args` as `menu` and
// `args.menuPriceCents` stays `undefined`. Prisma's error for that names the field, not the
// spread — `Argument \`menuPriceCents\` is missing` — which reads like a missing line in the
// `data` block and is not one.
const A = { menuPriceCents: 1600, foodCostCents: 480, packagingCents: 80 };
const A_MENU = A.menuPriceCents;
const A_MIN_VIABLE = 1112;

beforeAll(async () => {
  ids.full = await makeMerchant({
    suffix: 'full',
    name: 'Copper Kettle',
    floorPct: '0.25',
    pickupAddress: '123 10 Ave NE, Calgary',
    pickupInstructions: 'Side door.',
  });
  await addMember(ids.full, 'full-owner', 'OWNER', 'Dana Whitfield');
  await addMember(ids.full, 'full-staff', 'STAFF', 'Sam Okafor');

  await makeDish({ merchantId: ids.full, name: 'Beef Bowl', ...A });
  await makeDish({
    merchantId: ids.full,
    name: 'House Red',
    ...A,
    containsAlcohol: true,
  });
  await makeDish({
    merchantId: ids.full,
    name: 'Hand-Plated Tasting',
    ...A,
    isBatchable: false,
  });
  // 500 menu, 200 food, 80 packaging at a 25% floor: no price clears it.
  await makeDish({
    merchantId: ids.full,
    name: 'Impossible Plate',
    menuPriceCents: 500,
    foodCostCents: 200,
    packagingCents: 80,
  });

  await makeDraft(ids.full, 1);
  await makeDraft(ids.full, 2);

  ids.empty = await makeMerchant({ suffix: 'empty', name: 'Empty Pantry', floorPct: '0.40' });
  await addMember(ids.empty, 'empty-owner', 'OWNER', 'Rae Lindqvist');

  ids.ownerless = await makeMerchant({ suffix: 'ownerless', name: 'Managed Only', floorPct: '0.25' });
  await addMember(ids.ownerless, 'ownerless-manager', 'MANAGER', 'Morgan Vale');

  ids.singular = await makeMerchant({ suffix: 'single', name: 'Single Run Co', floorPct: '0.25' });
  await addMember(ids.singular, 'single-owner', 'OWNER');
  await makeDish({ merchantId: ids.singular, name: 'Only Dish', ...A });
  await makeDraft(ids.singular, 1);

  ids.suspended = await makeMerchant({
    suffix: 'suspended',
    name: 'Shuttered Kitchen',
    floorPct: '0.25',
    status: 'SUSPENDED',
  });
  await addMember(ids.suspended, 'suspended-owner', 'OWNER', 'Kit Alvarez');

  ids.pricier = await makeMerchant({ suffix: 'pricier', name: 'Long Table', floorPct: '0.25' });
  await addMember(ids.pricier, 'pricier-owner', 'OWNER', 'Nour Haddad');
  // One $24.00 dish and one $9.00 dish: the pair makes the lookup directional. A page that
  // took the *lowest* dish, or the first row, would print 9.00 — and 25% of $9.00 is $2.25,
  // which appears nowhere else in this file.
  //
  // The cheap dish's name sorts **first** on purpose. `listItems` orders by `name asc`, so
  // `items[0]` is this row; with the expensive one alphabetically first, `items[0]` and
  // `highestMenuPriceCents` return the same dish and a probe swapping one for the other
  // survives. Found exactly that way — probe B survived until the names were swapped.
  await makeDish({
    merchantId: ids.pricier,
    name: 'Family Platter',
    menuPriceCents: 2400,
    foodCostCents: 700,
    packagingCents: 100,
  });
  await makeDish({
    merchantId: ids.pricier,
    name: 'Antipasto Plate',
    menuPriceCents: 900,
    foodCostCents: 250,
    packagingCents: 50,
  });
});

afterAll(async () => {
  await prisma.aiDraft.deleteMany({ where: { id: { in: createdDraftIds } } });
  await prisma.merchantUser.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.menuItem.deleteMany({ where: { id: { in: createdItemIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

async function render(merchantId: string): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(admin)/admin/merchants/[id]/page');
  const element = await page.default({ params: Promise.resolve({ id: merchantId }) });
  const html = await renderToHtml(element);
  return { html, text: textOf(html) };
}

/** The `<li>` card for one dish, scoped by its name. */
function dishCard(html: string, dishName: string): string {
  for (const match of html.matchAll(/<li\b[\s\S]*?<\/li>/g)) {
    if (textOf(match[0]).includes(dishName)) {
      return match[0];
    }
  }
  throw new Error(`No <li> mentions ${dishName}`);
}

function dishText(html: string, dishName: string): string {
  return textOf(dishCard(html, dishName));
}

/** The status badge in the page header, as both the word and the tone that colours it. */
function headerBadge(html: string): { text: string; tone: 'ok' | 'neutral' } {
  const badge = /<span\b([^>]*class="[^"]*rounded-full[^"]*"[^>]*)>([\s\S]*?)<\/span>/.exec(html);
  if (!badge) {
    throw new Error('No badge in the header');
  }
  const attributes = badge[1] ?? '';
  // `Badge`'s two tones for this call site, named by the class each one emits. The page
  // passes `ok` for ACTIVE and `neutral` for everything else, so the class is the only
  // place that branch is visible — the word "SUSPENDED" prints the same either way.
  const tone = attributes.includes('bg-ok/10') ? 'ok' : 'neutral';
  return { text: textOf(badge[2] ?? ''), tone };
}

/** An `<input id="…">`'s rendered `value=`. */
function inputValue(html: string, id: string): string | null {
  const tag = new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`).exec(html);
  if (!tag) {
    return null;
  }
  return /value="([^"]*)"/.exec(tag[0])?.[1] ?? null;
}

/** Every `<option>` inside the impersonation owner `<select>`. */
function ownerOptions(html: string): string[] {
  const select = /<select\b[^>]*id="impersonate-target"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  // The control renders closed on first paint, so the select is absent until expanded —
  // callers that need it assert the absent case explicitly instead of getting `[]` here.
  if (!select) {
    return [];
  }
  return [...(select[1] ?? '').matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)].map((match) =>
    textOf(match[1] ?? ''),
  );
}

/**
 * The floor editor's helper sentence, extracted whole.
 *
 * Scoping is the point. `not.toContain('$9.00')` on the page text caught the Side Salad's
 * own price in its dish row within seconds of being written — the assertion was measuring
 * the dish list, not the sentence about the floor. (Third time in this repo; see AGENTS.md.)
 * The sentence is the only element that carries PRD-sprint1 §5.1's claim, so it is the only
 * one worth asserting.
 */
function floorSentence(text: string): string {
  const match = /At \d+%, a \$[\d.,]+ dish must leave the merchant at least \$[\d.,]+ per plate\./.exec(
    text,
  );
  if (!match) {
    throw new Error(`No floor sentence in: ${text.slice(0, 200)}`);
  }
  return match[0];
}

describe('/admin/merchants/:id — the header', () => {
  it('names the merchant, its slug and its status, and links back to users', async () => {
    const { html, text } = await render(ids.full);

    expect(text).toContain('Copper Kettle');
    expect(text).toContain(`/${PREFIX}-full`);
    expect(text).toContain('← Users');
    expect(html).toContain('href="/admin/users"');
    // The badge prints `merchant.status` directly — the raw enum, deliberately. Asserted as
    // it behaves so a future change to a friendly label has to update this line.
    expect(headerBadge(html)).toEqual({ text: 'ACTIVE', tone: 'ok' });
  });

  it('drops the badge to neutral for a merchant that is not active', async () => {
    // `tone={merchant.status === 'ACTIVE' ? 'ok' : 'neutral'}` is a real branch and every
    // other fixture is ACTIVE, so without this the false arm never renders. The word does
    // not discriminate — `SUSPENDED` prints the same in either tone — so the tone is read
    // from the class. A suspended merchant shown in the healthy green is the misread this
    // catches, and it is a one-word change to produce.
    const { html } = await render(ids.suspended);

    expect(headerBadge(html)).toEqual({ text: 'SUSPENDED', tone: 'neutral' });
  });

  it('is a 404 for a merchant id that does not exist', async () => {
    // `rejects.toThrow()` with no argument would also pass on a Prisma error, a `TypeError`
    // or the render itself falling over — a broken page would satisfy it. `notFound()`
    // throws a digest-tagged error and Next turns that into the 404, so the digest is the
    // only assertion that distinguishes "handled as missing" from "crashed".
    await expect(render('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });
});

describe('/admin/merchants/:id — the floor editor, which is the admin’s job', () => {
  it('offers an editable percent seeded from the merchant’s floor', async () => {
    const { html } = await render(ids.full);

    // The one control in the product that can move a merchant's floor. `FloorEditor`
    // converts the stored fraction (0.25) back to the percent a human types (25).
    expect(inputValue(html, 'floorPctOfMenu')).toBe('25');
    expect(html).toContain('name="floorPctOfMenu"');
  });

  it('states the percentage with a dollar figure at the merchant’s highest dish', async () => {
    // PRD-sprint1 §5.1: a percentage alone has no meaning, so it is always shown attached to
    // a real menu price. All four of this merchant's dishes are $16.00, so the highest is
    // $16.00 and 25% of it is $4.00.
    const { text } = await render(ids.full);

    expect(floorSentence(text)).toBe(
      `At 25%, a ${formatCents(1600)} dish must leave the merchant at least ${formatCents(400)} per plate.`,
    );
  });

  it('takes the figure from the highest dish, not the lowest or the first', async () => {
    // The fixture that makes `highestMenuPriceCents` observable: $24.00 and $9.00 on the
    // same merchant. `ids.full` cannot do this — every dish there is $16.00, which is also
    // the no-dishes fallback, so a hardcoded 1600 would print the same sentence. 25% of
    // $24.00 is $6.00; 25% of $9.00 is $2.25 and appears nowhere else in this file.
    const { text } = await render(ids.pricier);
    const sentence = floorSentence(text);

    // The sentence is asserted whole, so a page printing the right figure at the wrong
    // percentage ("At 25%, a $16.00 dish … $9.00") cannot pass by containing one of them.
    expect(sentence).toBe(
      `At 25%, a ${formatCents(2400)} dish must leave the merchant at least ${formatCents(600)} per plate.`,
    );
    // And the low dish does not reach it, which is what makes the lookup directional
    // rather than "any dish will do".
    expect(sentence).not.toContain(formatCents(900));
    expect(sentence).not.toContain(formatCents(225));
  });

  it('falls back to $16.00 for a merchant with no dishes', async () => {
    // The 40% floor makes the fallback price visible in the money as well: 40% of $16.00 is
    // $6.40, which no other fixture prints.
    const { text } = await render(ids.empty);

    expect(floorSentence(text)).toBe(
      `At 40%, a ${formatCents(1600)} dish must leave the merchant at least ${formatCents(640)} per plate.`,
    );
  });

  it('seeds the pickup fields from the merchant, and blanks a null', async () => {
    const filled = await render(ids.full);
    expect(inputValue(filled.html, 'pickupAddress')).toBe('123 10 Ave NE, Calgary');
    expect(inputValue(filled.html, 'pickupInstructions')).toBe('Side door.');

    const blank = await render(ids.empty);
    expect(inputValue(blank.html, 'pickupAddress')).toBe('');
    expect(inputValue(blank.html, 'pickupInstructions')).toBe('');
    expect(blank.text).not.toContain('null');
  });

  it('carries the merchant id in the form, without which the save would target nothing', async () => {
    const { html } = await render(ids.full);

    expect(html).toContain(`name="merchantId" value="${ids.full}"`);
  });
});

describe('/admin/merchants/:id — the dish evaluation is read-only and one ternary wide', () => {
  it('prints the lowest viable price for a priceable dish, and not a headline', async () => {
    const { html } = await render(ids.full);
    const row = dishText(html, 'Beef Bowl');

    expect(row).toContain(formatCents(A_MENU));
    expect(row).toContain(`Lowest deal price ${formatCents(A_MIN_VIABLE)}`);
    // The other arm of the ternary. A page printing both would pass a headline-only check.
    expect(row).not.toContain('This is the lowest price that still works.');
    expect(row).not.toContain("can't be a deal");
  });

  it('prints the alcohol reason instead of a price, because there is no batch to price', async () => {
    const { html } = await render(ids.full);
    const row = dishText(html, 'House Red');

    expect(row).toContain("This dish contains alcohol, so it can't be part of a deal.");
    // No figure anywhere in the row: `view` is null, so `lowest` is null.
    expect(row).not.toContain('Lowest deal price');
  });

  it('prints the batchability reason for a hand-plated dish', async () => {
    const { html } = await render(ids.full);
    const row = dishText(html, 'Hand-Plated Tasting');

    expect(row).toContain('This dish is marked as not batchable.');
    expect(row).not.toContain('Lowest deal price');
    // The two Blocked reasons must not be the same sentence — the admin's next action
    // differs (regulatory block vs a setting they can change).
    expect(row).not.toContain('contains alcohol');
  });

  it('prints the infeasible headline for a dish no price can rescue', async () => {
    const { html } = await render(ids.full);
    const row = dishText(html, 'Impossible Plate');

    // `minViablePrice` returns null, so `view.minViablePriceCents` is null and the ternary
    // takes the headline arm even though `view` is non-null.
    expect(row).toContain("This dish can't be a deal at your minimum margin.");
    expect(row).not.toContain('Lowest deal price');
  });

  it('counts the dishes, and says so when there are none', async () => {
    const withDishes = await render(ids.full);
    expect(withDishes.text).toContain('Dishes (4)');
    expect(withDishes.text).not.toContain('This merchant has no dishes yet.');

    const none = await render(ids.empty);
    expect(none.text).toContain('Dishes (0)');
    expect(none.text).toContain('This merchant has no dishes yet.');
  });
});

describe('/admin/merchants/:id — the AI runs link, in three shapes', () => {
  it('offers to open the runs, plural, when there are several', async () => {
    const { html, text } = await render(ids.full);

    expect(text).toContain('Open 2 runs');
    expect(html).toContain(`href="/admin/ai-drafts?merchantId=${ids.full}"`);
  });

  it('uses the singular for exactly one run', async () => {
    // The plural rule is a real branch (`draftCount === 1 ? 'run' : 'runs'`), and a fixture
    // with two runs cannot prove it — `2 run` and `2 runs` both fail the plural assertion,
    // so a broken singular branch would only ever show up on a merchant with one.
    const { text } = await render(ids.singular);

    expect(text).toContain('Open 1 run');
    expect(text).not.toContain('Open 1 runs');
  });

  it('still links somewhere useful at zero, rather than a dead label', async () => {
    const { html, text } = await render(ids.empty);

    expect(text).toContain('No runs yet — open the list');
    expect(html).toContain(`href="/admin/ai-drafts?merchantId=${ids.empty}"`);
  });

  it('explains why the runs are there, which is the support conversation', async () => {
    const { text } = await render(ids.full);

    expect(text).toContain('AI runs');
    expect(text).toContain('What the deal builder proposed for this merchant, with the guardrail inputs that');
    expect(text).toContain('produced it.');
  });
});

describe('/admin/merchants/:id — impersonation, and the owner filter', () => {
  it('renders the control closed, with no owner list until the admin opens it', async () => {
    const { html, text } = await render(ids.full);

    expect(text).toContain('View as this merchant…');
    // The closed state states the consequences, which is the whole reason it is two steps.
    expect(text).toContain('Opens a read-only session as one of this merchant');
    expect(text).toContain('Every change is refused while it is open');
    expect(text).toContain('recorded in the audit log');

    // Closed means no `useState` branch has run: no select, no reason field, no submit.
    expect(ownerOptions(html)).toEqual([]);
    expect(html).not.toContain('id="impersonate-reason"');
    expect(text).not.toContain('Open read-only session');
  });

  it('says a merchant has no owner rather than offering a control that would fail', async () => {
    // A MANAGER-only merchant. FR-904 covers owners only, and the component filters the
    // candidate list itself — so the page passes the manager through and the filter is what
    // protects the branch. Without this fixture the filter is untested code.
    const { text } = await render(ids.ownerless);

    expect(text).toContain('This merchant has no owner account');
    expect(text).toContain('FR-904 covers merchant owners only.');
    expect(text).not.toContain('View as this merchant…');
  });

  it('renders the impersonation control closed, without candidate emails inside it', async () => {
    // This test used to claim it proved the owner *filter* worked, and it could not: the
    // control renders closed, so no address is in the document whether the filter drops the
    // staff member or not. A test that passes identically with the line under test deleted
    // is not evidence, so the claim is narrowed to what a first paint can show — that a
    // closed control prints no candidate contact details — and the filter is left to the
    // fixture above, where it is load-bearing.
    //
    // The page now has a separate **People** list that intentionally prints every member's
    // email, so the assertion has to be scoped to the control rather than the whole page.
    const { html } = await render(ids.full);
    const from = html.indexOf('View as this merchant');
    const to = html.indexOf('AI runs');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const control = html.slice(from, to);

    expect(control).not.toContain('full-staff@example.test');
    expect(control).not.toContain('full-owner@example.test');
  });
});

describe('/admin/merchants/:id — the reason this page exists', () => {
  it('does not restate Q-4’s rule, because the admin is the exception to it', async () => {
    // The merchant's settings page says "This is not editable here." This page must NOT say
    // that: it is the place where the floor *is* editable, and copying the sentence across
    // would tell the admin to contact themselves.
    const { text } = await render(ids.full);

    expect(text).not.toContain('This is not editable here.');
    expect(text).toContain('Minimum margin (%)');
    expect(text).toContain('Save merchant');
  });
});
