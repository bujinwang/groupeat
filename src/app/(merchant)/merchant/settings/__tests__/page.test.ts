import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/merchant/settings` rendered — gap 12, the floor and the pickup details.
 *
 * The page's docblock makes two product rules and states them as things this screen **does
 * not do**, which is the hardest kind of claim to hold in place: a rule enforced by absence
 * has no line to point at, and the regression that breaks it is an *added* field rather
 * than a changed one. So both are asserted as absences, deliberately and by name.
 *
 *   1. **The floor is not editable here.** Q-4: a merchant who lowers their floor "to make
 *      the deal work" has defeated the guardrail. The page states the number and offers no
 *      control for it.
 *   2. **The thin-margin warning appears here and nowhere else, and only under 15%.**
 *
 * ## The first rule is asserted as a set of field names, not as a missing string
 *
 * "No floor input" is unassertable directly — there is no element to look for. Asserting
 * `not.toContain('floorPctOfMenu')` would pass on a page that added a control named
 * something else, which is exactly how an editable floor would arrive. So the test collects
 * **every `name=` in the markup** and requires the set to be exactly the pickup fields
 * plus FR-704's digest consent checkbox. A new editable control of any kind on this page
 * fails it, whatever it is called — and the digest box is named explicitly so that adding
 * it did not silently widen the rule.
 *
 * ## The second rule is two-sided, and the boundary is the schema's
 *
 * `isThin` is `floorPctOfMenu < FLOOR_WARN_THRESHOLD` (0.15), so `0.15` itself must not warn
 * and `0.14` must. Both are asserted, because a warning test alone passes on a page that
 * warns unconditionally — and an unconditional warning is precisely the failure the docblock
 * is about ("a warning shown before the merchant has a reason to care teaches them to
 * dismiss warnings").
 *
 * `floorPctOfMenu` is `Decimal(5,2)`, so `0.14` is the tightest value below the threshold
 * that the column can hold: `0.1499` rounds to `0.15` on write. The boundary test therefore
 * pins `0.14 → warns` / `0.15 → silent`, which is the whole reachable range around it.
 *
 * ## The example price is the merchant's own highest dish, and that is three rules
 *
 * `highestMenuPriceCents(merchantIds)` is an `orderBy menuPriceCents desc` over the caller's
 * scope, filtered to `archivedAt: null`, with a `?? 1600` fallback on the page. So:
 *
 *   - the number is the merchant's **highest** dish, not a constant (a fixture at `$24.00`
 *     proves the page is not printing `$16.00`);
 *   - **archived** dishes are excluded, because they cannot be sold and so cannot set the
 *     example;
 *   - a merchant with **no** dishes falls back to `$16.00` (PRD-sprint1 §5.1).
 *
 * All three are separate tests below, and each one is chosen so that a wrong implementation
 * prints a different dollar figure — not merely a different code path.
 *
 * ## The cross-merchant case, which is pinned because it is surprising
 *
 * The floor comes from `merchantIds[0]` while the example price spans **all** of them. For a
 * user attached to two merchants, the page can therefore print merchant A's margin against
 * merchant B's priciest dish. That is asserted rather than left to chance, so that changing
 * it is a deliberate act — see the comment on that test, which also records why the ordering
 * has to be forced with explicit ids to make the fixture deterministic at all.
 *
 * ## What is mocked
 *
 * `server-only` and `@/lib/auth/session`. `requireMerchant`, `getMerchant`,
 * `highestMenuPriceCents`, `floorWarningCopy` and `PickupForm` are all real. The form is a
 * client component and is not hydrated, so its `useState` shows the seeded values and its
 * save is inert — asserted below for what a render can see, and nothing more.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `mchset${Date.now().toString(36).slice(-5)}`;

const ids = {
  /** Floor 25%, one dish at $16.00. The control case. */
  plain: '',
  /** Floor 25%, highest dish $24.00 — proves the example is not the $16.00 constant. */
  pricey: '',
  /** Floor 50%, no dishes — the `$16.00` fallback, distinguishable only at a different pct. */
  bare: '',
  /** Floor 25%, one live dish at $8.00 and an archived one at $50.00. */
  archived: '',
  /** Floor 14% — one point under the threshold. */
  thin: '',
  /** Floor 15% — exactly the threshold, which must be silent. */
  boundary: '',
};

const users: Record<keyof typeof ids, string> = {
  plain: '',
  pricey: '',
  bare: '',
  archived: '',
  thin: '',
  boundary: '',
};

/** A user with a MERCHANT session and no merchant attached at all. */
let orphanUserId = '';

/** Explicit ids, so `merchantIds[0]` is deterministic — see the cross-merchant test. */
const DUAL_LOW_ID = `${PREFIX}0000-0000-0000-0000000000a1`;
const DUAL_HIGH_ID = `${PREFIX}0000-0000-0000-0000000000b2`;
let dualUserId = '';

const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];
const createdItemIds: string[] = [];

async function makeMerchant(args: {
  suffix: string;
  name: string;
  floorPct: string;
  id?: string;
  pickupAddress?: string | null;
  pickupInstructions?: string | null;
}): Promise<string> {
  const merchant = await prisma.merchant.create({
    data: {
      ...(args.id ? { id: args.id } : {}),
      name: args.name,
      slug: `${PREFIX}-${args.suffix}`,
      status: 'ACTIVE',
      // The column is `Decimal(5,2)`; passing the string keeps the test's intent visible
      // rather than letting a float round-trip decide the value.
      floorPctOfMenu: args.floorPct,
      pickupAddress: args.pickupAddress ?? null,
      pickupInstructions: args.pickupInstructions ?? null,
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

async function makeDish(args: {
  merchantId: string;
  name: string;
  menuPriceCents: number;
  archived?: boolean;
}): Promise<string> {
  const item = await prisma.menuItem.create({
    data: {
      merchantId: args.merchantId,
      name: args.name,
      menuPriceCents: args.menuPriceCents,
      foodCostCents: 480,
      packagingCents: 80,
      batchYield: 30,
      prepMinutes: 6,
      category: 'Bowls',
      archivedAt: args.archived ? new Date() : null,
    },
    select: { id: true },
  });
  createdItemIds.push(item.id);
  return item.id;
}

beforeAll(async () => {
  ids.plain = await makeMerchant({ suffix: 'plain', name: 'Plain Kettle', floorPct: '0.25' });
  ids.pricey = await makeMerchant({ suffix: 'pricey', name: 'Pricey Grill', floorPct: '0.25' });
  ids.bare = await makeMerchant({ suffix: 'bare', name: 'Bare Pantry', floorPct: '0.50' });
  ids.archived = await makeMerchant({ suffix: 'arch', name: 'Archived Deli', floorPct: '0.25' });
  ids.thin = await makeMerchant({ suffix: 'thin', name: 'Thin Margin Co', floorPct: '0.14' });
  ids.boundary = await makeMerchant({ suffix: 'edge', name: 'Edge Case Cafe', floorPct: '0.15' });

  users.plain = await makeOwner('plain', ids.plain);
  users.pricey = await makeOwner('pricey', ids.pricey);
  users.bare = await makeOwner('bare', ids.bare);
  users.archived = await makeOwner('arch', ids.archived);
  users.thin = await makeOwner('thin', ids.thin);
  users.boundary = await makeOwner('edge', ids.boundary);

  await makeDish({ merchantId: ids.plain, name: 'Beef Bowl', menuPriceCents: 1600 });
  await makeDish({ merchantId: ids.pricey, name: 'Tomahawk', menuPriceCents: 2400 });
  // `bare` deliberately gets no dish at all.

  await makeDish({ merchantId: ids.archived, name: 'Live Dish', menuPriceCents: 800 });
  await makeDish({
    merchantId: ids.archived,
    name: 'Retired Platter',
    menuPriceCents: 5000,
    archived: true,
  });

  await makeDish({ merchantId: ids.thin, name: 'Thin Bowl', menuPriceCents: 1600 });
  await makeDish({ merchantId: ids.boundary, name: 'Edge Bowl', menuPriceCents: 1600 });

  // A MERCHANT user with no `MerchantUser` row — the "no merchant attached" branch.
  const orphan = await prisma.user.create({
    data: {
      email: `${PREFIX}-orphan@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  createdUserIds.push(orphan.id);
  orphanUserId = orphan.id;
});

afterAll(async () => {
  await prisma.merchantUser.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.menuItem.deleteMany({ where: { id: { in: createdItemIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

async function render(userId: string): Promise<{ html: string; text: string }> {
  const previous = sessionState.session;
  sessionState.session = { userId, role: 'MERCHANT', mustChangePassword: false };
  try {
    const page = await import('@/app/(merchant)/merchant/settings/page');
    const html = await renderToHtml(await page.default());
    return { html, text: textOf(html) };
  } finally {
    sessionState.session = previous;
  }
}

/**
 * Every `name=` in the markup, sorted.
 *
 * The claim "the floor is not editable here" has no element to assert the absence of, so it
 * is asserted as an exhaustive set instead: a control added under any name shows up here.
 */
function fieldNames(html: string): string[] {
  return [...html.matchAll(/\bname="([^"]*)"/g)].map((match) => match[1] ?? '').sort();
}

/** The rendered `value=` of an `<input id="…">`, or `null` when the id is absent. */
function inputValue(html: string, id: string): string | null {
  const tag = new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`).exec(html);
  if (!tag) {
    return null;
  }
  const value = /value="([^"]*)"/.exec(tag[0]);
  return value?.[1] ?? null;
}

/** The rendered text of a `<textarea id="…">` — React SSR writes a controlled value as children. */
function textareaValue(html: string, id: string): string | null {
  const match = new RegExp(`<textarea\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)</textarea>`).exec(html);
  return match ? textOf(match[1] ?? '') : null;
}

describe('/merchant/settings — the minimum margin, stated not offered', () => {
  it('states the floor as a percentage and the money that means at the highest dish', async () => {
    const { text } = await render(users.plain);

    expect(text).toContain('Your minimum margin');
    expect(text).toContain('25%');
    // 25% of the $16.00 dish. Written as `formatCents` of the arithmetic rather than as a
    // literal, so the assertion survives a change to the currency formatter.
    expect(text).toContain(
      `At 25%, a ${formatCents(1600)} dish must leave you at least ${formatCents(400)} per plate.`,
    );
  });

  it('uses the highest-priced dish, not the $16.00 example from the PRD', async () => {
    // This merchant's only dish is $24.00. A page printing the fallback constant would say
    // $16.00 and $6.00; the assertion is on the figure it must *not* print as much as the
    // one it must.
    const { text } = await render(users.pricey);

    expect(text).toContain(
      `At 25%, a ${formatCents(2400)} dish must leave you at least ${formatCents(600)} per plate.`,
    );
    expect(text).not.toContain('a $16.00 dish must leave you at least');
  });

  it('falls back to $16.00 for a merchant with no dishes', async () => {
    // A 50% floor, so the fallback price is visible in both the percentage and the money:
    // 50% of $16.00 is $8.00, which no other fixture prints.
    const { text } = await render(users.bare);

    expect(text).toContain('50%');
    expect(text).toContain(
      `At 50%, a ${formatCents(1600)} dish must leave you at least ${formatCents(800)} per plate.`,
    );
  });

  it('ignores an archived dish when choosing the highest price', async () => {
    // This merchant's priciest row is *archived* at $50.00. `highestMenuPriceCents` filters
    // `archivedAt: null`, because a retired dish cannot be sold and so cannot set the
    // example. Dropping that filter would print $12.50 instead of $2.00.
    const { text } = await render(users.archived);

    expect(text).toContain(
      `At 25%, a ${formatCents(800)} dish must leave you at least ${formatCents(200)} per plate.`,
    );
    expect(text).not.toContain(formatCents(1250));
  });

  it('offers no control for the floor — the only writable fields are the pickup ones', async () => {
    const { html, text } = await render(users.plain);

    // The exhaustive half. `PickupForm` contributes the two pickup fields and FR-704's
    // consent form contributes exactly one checkbox; anything else appearing here is a new
    // editable value on a page that exists to stop the floor from drifting.
    expect(fieldNames(html)).toEqual(['digestOptIn', 'pickupAddress', 'pickupInstructions']);
    // No `<select>` anywhere, so no dropdown of percentages either.
    expect(html).not.toContain('<select');

    // The stated half, so the rule is explained rather than merely enforced.
    expect(text).toContain('This is not editable here.');
    expect(text).toContain('Moving it either way goes through your GroupEat contact');
  });

  it('tells a user with no merchant attached rather than rendering an empty card', async () => {
    const { text } = await render(orphanUserId);

    expect(text).toContain('No merchant is attached to this account.');
    // Not a half-rendered page: no heading, no zeroed percentage.
    expect(text).not.toContain('Your minimum margin');
    expect(text).not.toContain('0%');
  });
});

describe('/merchant/settings — the thin-margin warning, and its boundary', () => {
  it('warns at 14%, naming the percentage and what it leaves on a plate', async () => {
    const { text } = await render(users.thin);

    expect(text).toContain('A 14% minimum is very thin.');
    // 14% of $16.00 = $2.24, through `floorWarningCopy` rather than recomputed here.
    expect(text).toContain(`you'd keep ${formatCents(224)} on a ${formatCents(1600)} dish`);
    // The floor is still stated in the card above it — the warning is additive.
    expect(text).toContain('At 14%, a $16.00 dish must leave you at least $2.24 per plate.');
  });

  it('says nothing at 15%, which is the threshold and not under it', async () => {
    // `isThin` is `floorPctOfMenu < FLOOR_WARN_THRESHOLD`. A page using `<=` — the natural
    // off-by-one — would warn here, and the docblock's failure mode ("teaches them to
    // dismiss warnings") starts at exactly this merchant.
    const { text } = await render(users.boundary);

    expect(text).toContain('15%');
    expect(text).not.toContain('minimum is very thin');
    expect(text).not.toContain('very thin');
  });

  it('says nothing on a healthy floor either, so the warning is not always-on', async () => {
    const { text } = await render(users.plain);

    expect(text).not.toContain('very thin');
    // The other half of the same claim: the warning's body sentence has no home here.
    expect(text).not.toContain("That still has to cover labour and rent");
  });
});

describe('/merchant/settings — pickup details', () => {
  it('seeds the form with what is stored, and says there is nothing to save yet', async () => {
    const merchantId = await makeMerchant({
      suffix: 'pickup',
      name: 'Seed Corner',
      floorPct: '0.25',
      pickupAddress: '123 10 Ave NE, Calgary',
      pickupInstructions: null,
    });
    const userId = await makeOwner('pickup', merchantId);

    const { html, text } = await render(userId);

    expect(inputValue(html, 'pickupAddress')).toBe('123 10 Ave NE, Calgary');
    // `null` instructions render as an empty textarea rather than the word "null".
    expect(textareaValue(html, 'pickupInstructions')).toBe('');
    expect(text).not.toContain('null');

    // `dirty` is false on first paint, so the button is disabled and the page says why.
    expect(text).toContain('No changes yet.');
    expect(/<button\b[^>]*\bdisabled\b/.test(html)).toBe(true);
    expect(text).toContain('Save pickup details');
  });

  it('explains that pickup appears on every deal page', async () => {
    // The reason the field exists, and the only place the merchant is told the consequence
    // of getting it wrong.
    const { text } = await render(users.plain);

    expect(text).toContain('Pickup');
    expect(text).toContain('Shown on every deal page, so a diner can find you without asking.');
    // Lowercase `which`: the sentence begins "The thing diners always get wrong:" and the
    // field list continues it. Asserting the capitalised form is a test of my reading.
    expect(text).toContain('which door, which counter, who to ask for.');
  });
});

describe('/merchant/settings — a user attached to two merchants', () => {
  it('reads the floor from one merchant and the example price across both, and that is pinned', async () => {
    // Two merchants with **explicit ids**, because the page takes `merchantIds[0]` and
    // `requireMerchantScope` orders by `merchantId asc`. With generated uuids the fixture
    // would decide at random which merchant's floor it was asserting.
    const low = await makeMerchant({
      id: DUAL_LOW_ID,
      suffix: 'dual-low',
      name: 'Dual Low',
      floorPct: '0.25',
    });
    await makeDish({ merchantId: low, name: 'Dual Cheap Dish', menuPriceCents: 1000 });

    const high = await makeMerchant({
      id: DUAL_HIGH_ID,
      suffix: 'dual-high',
      name: 'Dual High',
      floorPct: '0.40',
    });
    await makeDish({ merchantId: high, name: 'Dual Pricey Dish', menuPriceCents: 3000 });

    dualUserId = await makeOwner('dual', low);
    await prisma.merchantUser.create({ data: { merchantId: high, userId: dualUserId, role: 'OWNER' } });

    const { text } = await render(dualUserId);

    // `DUAL_LOW_ID` sorts first, so the page states 25% — that merchant's floor.
    expect(text).toContain('At 25%, a');
    expect(text).not.toContain('At 40%');
    // But `highestMenuPriceCents(merchantIds)` spans both, so the example dish is the *other*
    // merchant's $30.00, and 25% of it is $7.50.
    //
    // This is pinned rather than celebrated: the page shows one merchant's margin against
    // another's dish. It is the current behaviour of two separate correct-looking calls, and
    // a reader who changes either one should have to change this test on purpose. Whether
    // multi-merchant accounts should see a combined example is a product question, not a
    // defect this suite can settle.
    expect(text).toContain(`a ${formatCents(3000)} dish must leave you at least ${formatCents(750)}`);
    expect(text).not.toContain(formatCents(1000));
  });
});

describe('/merchant/settings — the weekly digest consent (FR-704)', () => {
  it('offers an owner the box, unchecked by default', async () => {
    // The default is `false` on the membership, so a merchant created before this
    // feature is not silently subscribed. This fixture is that merchant.
    const { html, text } = await render(users.plain);

    expect(text).toContain('Weekly email');
    expect(text).toContain('Every Monday morning');

    const checkbox = /<input\b[^>]*id="digestOptIn"[^>]*>/.exec(html);
    expect(checkbox).not.toBeNull();
    expect(checkbox?.[0]).not.toContain('checked');
  });

  it('renders the box checked once the owner has consented', async () => {
    await prisma.merchantUser.update({
      where: { merchantId_userId: { merchantId: ids.plain, userId: users.plain } },
      data: { digestOptIn: true, digestOptInAt: new Date() },
    });

    const { html } = await render(users.plain);

    const checkbox = /<input\b[^>]*id="digestOptIn"[^>]*>/.exec(html);
    expect(checkbox?.[0]).toContain('checked');
  });

  it('tells a manager the setting is the owner’s, and renders no checkbox', async () => {
    const manager = await prisma.user.create({
      data: {
        email: `${PREFIX}-manager@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    createdUserIds.push(manager.id);
    await prisma.merchantUser.create({
      data: { merchantId: ids.plain, userId: manager.id, role: 'MANAGER' },
    });

    const { html, text } = await render(manager.id);

    expect(text).toContain('Only an owner can change this setting.');
    expect(html).not.toContain('id="digestOptIn"');
  });
});
