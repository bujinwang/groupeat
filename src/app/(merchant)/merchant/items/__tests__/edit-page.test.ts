import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderWithRouter, textOf } from '@/lib/testing/render';

/**
 * `/merchant/items/new` and `/merchant/items/:id` rendered — gap 12, the dish form in both
 * modes.
 *
 * One suite because they are the same component with and without a dish: `/new` renders
 * `<ItemForm />` with no props and says so ("save the dish once and we'll tell you the lowest
 * price that still works"), and `/:id` renders it with `initialValues`, a server-computed
 * `initialEvaluation` and the dish's `ineligibilityOf` result.
 *
 * ## The claim only the edit page can make
 *
 * The panel's first number is computed **on the server** and passed in, so the first paint
 * already shows `$11.12` rather than a spinner or an empty box. That is the page's stated
 * design ("the evaluation is computed on the server and passed in, so the first paint already
 * shows a number"). A component that waited for its own `useEffect` would look identical once
 * hydrated and show nothing here — so the assertion is that the number is in the *server*
 * output.
 *
 * ## The ineligibility branch is per-dish, and outranks the price panel
 *
 * `ineligibilityOf` returns `CONTAINS_ALCOHOL` or `NOT_BATCHABLE`, and `GuardrailPanel`
 * short-circuits on it **before** any evaluation: no price is produced at all, because there
 * is no batch to price. Three fixtures therefore, one per branch, each asserting the copy that
 * belongs to it — plus the assertion that the priced panel did *not* render, which is what
 * makes the short-circuit load-bearing rather than cosmetic.
 *
 * ## What is mocked, and what a render cannot see
 *
 * `server-only` and `@/lib/auth/session`; `requireMerchant`, `findItem`, `getFloor`,
 * `evaluateItem` and the whole form are real. The form is unhydrated, so its `useState` shows
 * the initial values the server passed and nothing more: no `onChange`, no debounced
 * re-evaluation, no save. Those are the interactions gap 12 keeps on its browser list.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `mchitem${Date.now().toString(36).slice(-5)}`;

/** Vector A: menu 1600, food 480, packaging 80, floor 25% → min viable $11.12. */
const MENU = 1600;
const FOOD = 480;
const PACKAGING = 80;
const MIN_VIABLE = 1112;

/**
 * The first number in `formatCents(MIN_VIABLE)` is not asserted as free text: `$11.12` also
 * appears as the deal price on some panels, so every price assertion below names the sentence
 * it lives in.
 */

const ids = {
  merchantId: '',
  otherMerchantId: '',
  userId: '',
  priced: '',
  alcohol: '',
  nonBatchable: '',
  foreign: '',
};

const createdItemIds: string[] = [];

beforeAll(async () => {
  const [merchant, other] = await Promise.all([
    prisma.merchant.create({
      data: {
        name: 'Copper Kettle',
        slug: `${PREFIX}`,
        status: 'PENDING',
        floorPctOfMenu: 0.25,
        timezone: 'America/Edmonton',
      },
      select: { id: true },
    }),
    prisma.merchant.create({
      data: {
        name: 'Someone Else',
        slug: `${PREFIX}-other`,
        status: 'PENDING',
        floorPctOfMenu: 0.25,
        timezone: 'America/Edmonton',
      },
      select: { id: true },
    }),
  ]);
  ids.merchantId = merchant.id;
  ids.otherMerchantId = other.id;

  const owner = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  ids.userId = owner.id;
  await prisma.merchantUser.create({
    data: { merchantId: ids.merchantId, userId: ids.userId, role: 'OWNER' },
  });

  async function makeDish(
    merchantId: string,
    name: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const item = await prisma.menuItem.create({
      data: {
        merchantId,
        name,
        menuPriceCents: MENU,
        foodCostCents: FOOD,
        packagingCents: PACKAGING,
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

  ids.priced = await makeDish(ids.merchantId, 'Beef Bowl');
  ids.alcohol = await makeDish(ids.merchantId, 'House Red', {
    containsAlcohol: true,
    category: 'Drinks',
  });
  ids.nonBatchable = await makeDish(ids.merchantId, 'Hand-Plated Tasting', { isBatchable: false });
  ids.foreign = await makeDish(ids.otherMerchantId, 'Not Yours');

  sessionState.session = { userId: ids.userId, role: 'MERCHANT', mustChangePassword: false };
});

afterAll(async () => {
  if (createdItemIds.length > 0) {
    await prisma.menuItem.deleteMany({ where: { id: { in: createdItemIds } } });
  }
  const merchantIds = [ids.merchantId, ids.otherMerchantId].filter((id) => id !== '');
  await prisma.merchantUser.deleteMany({ where: { merchantId: { in: merchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } });
  if (ids.userId !== '') {
    await prisma.user.deleteMany({ where: { id: ids.userId } });
  }
});

async function renderEdit(itemId: string): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(merchant)/merchant/items/[id]/page');
  const { html } = await renderWithRouter(
    await page.default({ params: Promise.resolve({ id: itemId }) }),
  );
  return { html, text: textOf(html) };
}

async function renderNew(): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(merchant)/merchant/items/new/page');
  // `/new` renders `ItemForm` without an id, and `ItemForm` calls `useRouter()`, so the
  // router context is still required even though no evaluation happens.
  const { html } = await renderWithRouter(await page.default());
  return { html, text: textOf(html) };
}

/** The `value` attributes of the rendered inputs, by id. */
function inputValue(html: string, id: string): string | null {
  const match = new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`).exec(html);
  if (!match) {
    return null;
  }
  const value = /value="([^"]*)"/.exec(match[0]);
  return value?.[1] ?? null;
}

describe('/merchant/items/new', () => {
  it('says the panel appears after the first save, instead of showing an empty price', async () => {
    const { text } = await renderNew();

    // No id means nothing to evaluate. The honest version of that is a sentence, not a
    // `$0.00` or a panel with no numbers in it.
    // `textOf` decodes entities, so the `&apos;` in the source arrives as an apostrophe.
    expect(text).toContain("Save the dish once and we'll tell you the lowest price that still works.");
    expect(text).not.toContain('This is the lowest price that still works.');
  });

  it('asks for every field the guardrail needs, with the cost fields labelled honestly', async () => {
    const { text } = await renderNew();

    // The four numbers the price depends on, plus the two eligibility flags. Missing any one
    // of these makes the panel unanswerable, so their presence is the form's contract with
    // `evaluateItem`.
    expect(text).toContain('Dish name');
    expect(text).toContain('What you normally charge');
    expect(text).toContain('Ingredient cost per plate');
    expect(text).toContain('Container cost per order');
    expect(text).toContain('How many can you make in one batch');
    expect(text).toContain('Can this dish be batched?');
    expect(text).toContain('Does this dish contain alcohol?');

    // The ingredient-cost helper is the one that stops a merchant entering labour or rent.
    expect(text).toContain('Just the food. Not labour, not rent, not the gas bill.');
  });

  it('links back to the dish list', async () => {
    const { html, text } = await renderNew();

    expect(html).toContain('href="/merchant/items"');
    expect(text).toContain('← Dishes');
    expect(text).toContain('New dish');
  });
});

describe('/merchant/items/:id — a dish that can be a deal', () => {
  it('shows the price panel on first paint, computed on the server', async () => {
    const { text } = await renderEdit(ids.priced);

    // The whole point of passing `initialEvaluation`: no spinner, no empty panel. `$11.12` is
    // `minViablePrice` at 25% for vector A's costs, and the sentence around it is the panel's
    // own.
    expect(text).toContain('This is the lowest price that still works.');
    expect(text).toContain(`${formatCents(MIN_VIABLE)} per plate`);
    expect(text).toContain(`${formatCents(MENU)}`);
    // And the contribution, which is the number the merchant actually cares about.
    expect(text).toContain('You keep $4.01 per plate');
  });

  it('fills the form with the dish as saved, rather than an empty form', async () => {
    const { html, text } = await renderEdit(ids.priced);

    // Named per field, so a form that rendered values in the wrong input fails here. The
    // MoneyInput renders a **formatted dollar string** — `$16.00`, not `16.00` — which is the
    // conversion most likely to be wrong, and it is asserted as the merchant sees it.
    expect(inputValue(html, 'name')).toBe('Beef Bowl');
    expect(inputValue(html, 'menuPriceCents')).toBe(formatCents(1600));
    expect(inputValue(html, 'foodCostCents')).toBe(formatCents(480));
    expect(inputValue(html, 'packagingCents')).toBe(formatCents(80));
    expect(inputValue(html, 'batchYield')).toBe('30');
    expect(inputValue(html, 'prepMinutes')).toBe('6');
    expect(text).toContain('Save dish');
  });

  it('names the dish in the heading and links back to the list', async () => {
    const { html, text } = await renderEdit(ids.priced);

    expect(text).toContain('Beef Bowl');
    expect(text).toContain('← Dishes');
    expect(html).toContain('href="/merchant/items"');
  });

  it('leaves the alcohol dialog and the pricing panel both showing their closed state', async () => {
    const { text } = await renderEdit(ids.priced);

    // The `AlcoholFlagDialog` is `open={pendingAlcoholOff}` with `pendingAlcoholOff` starting
    // false, so its warning copy — the sentence a merchant reads before switching alcohol off —
    // is not in this render. Asserted as an absence so the boundary is explicit rather than a
    // silent omission in the "covered" column.
    expect(text).not.toContain('Are you sure');
    expect(text).not.toContain('switch it off');
  });
});

describe('/merchant/items/:id — a dish that can never be in a deal', () => {
  it('says alcohol is the reason, and produces no price at all', async () => {
    const { text } = await renderEdit(ids.alcohol);

    // `ineligibilityOf` runs before any evaluation, so the panel short-circuits. The
    // regulatory sentence is the one a merchant must not be able to mistake for "fix your
    // numbers", which is why it is asserted in full.
    expect(text).toContain("This dish contains alcohol, so it can't be part of a deal.");
    expect(text).toContain("under Alberta's AGLC liquor rules");

    // The load-bearing half: no price, no contribution. A panel that rendered the numbers
    // beside the warning would be telling a merchant there is a price for a dish that can
    // never be sold this way.
    expect(text).not.toContain('This is the lowest price that still works.');
    expect(text).not.toContain('You keep');
  });

  it('says the batch requirement is the reason for a hand-plated dish', async () => {
    const { text } = await renderEdit(ids.nonBatchable);

    // The other branch of `ineligibilityOf`, with different copy — asserted separately because
    // a component that used one sentence for both would still pass a single-reason test.
    expect(text).toContain('This dish is marked as not batchable.');
    expect(text).toContain("You've told us you can't make 20 of these at once");
    expect(text).not.toContain("This dish contains alcohol, so it can't be part of a deal.");
    expect(text).not.toContain('You keep');
  });

  it('still fills the form, because the merchant has to be able to fix the dish', async () => {
    const { html } = await renderEdit(ids.alcohol);

    // The panel refusing to price the dish must not stop the merchant editing it — turning
    // alcohol off is the only repair, and it happens in this form.
    expect(inputValue(html, 'name')).toBe('House Red');
    expect(inputValue(html, 'menuPriceCents')).toBe(formatCents(1600));
  });
});

describe('/merchant/items/:id — a dish that is not this merchant’s', () => {
  it('is a 404 rather than another merchant’s dish', async () => {
    // `findItem` scopes by merchant id, so a real id outside the session's scope must be
    // indistinguishable from a missing one. Both are asserted, so a page that leaked a 500 for
    // the foreign case but a 404 for a missing id fails here.
    const page = await import('@/app/(merchant)/merchant/items/[id]/page');

    await expect(
      page.default({ params: Promise.resolve({ id: ids.foreign }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });

    await expect(
      page.default({ params: Promise.resolve({ id: 'no-such-dish-at-all' }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });
});
