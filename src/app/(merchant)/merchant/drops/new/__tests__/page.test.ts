import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderWithRouter, textOf } from '@/lib/testing/render';

/**
 * `/merchant/drops/new` and `/merchant/drops/new/ai` rendered — gap 12, the two ways a
 * merchant starts a drop.
 *
 * They are one suite because they answer the same question from two directions, and the
 * claim worth testing is the one they share: **a dish the publish path would refuse never
 * reaches the picker.** Both pages build their dish list with
 * `.filter((item) => item.isBatchable && !item.containsAlcohol)`, and both pass a server
 * computed `minViablePriceCents` down. If either filter drifts, the merchant is offered an
 * option that `publishDrop` will reject at the last step — after they have planned a batch.
 *
 * ## Why the floor is asserted through the rendered helper text
 *
 * Both pages compute `minViablePrice` server-side and hand it to a client component. The
 * component then prints it. A page that let the form compute its own floor from the menu
 * price would look identical until the fee constants or the merchant's floor changed — which
 * is exactly the class of drift the server-side computation exists to prevent. So the
 * assertion is on the rendered sentence: `$11.12`, vector A's floor.
 *
 * ## What a render can and cannot see here
 *
 * `DropForm` and `DealBuilder` are client components and are not hydrated, so:
 *
 *   - `DropForm` renders its **initial** field values. Those are derived from the props the
 *     page passed, so `$11.12` in the helper text is a real server value.
 *   - `DealBuilder` renders **question 1 of 5**. The three proposals, the price cards and the
 *     pasted group-chat message are behind `phase === 'results'`, which needs clicks. That is
 *     the interview's real content and it stays browser-only — recorded, not skipped quietly.
 *
 * Both need `renderWithRouter`: each mounts a component calling `useRouter()`.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `mchnew${Date.now().toString(36).slice(-5)}`;

/** Vector A: menu 1600, food 480, packaging 80, floor 25% → min viable $11.12. */
const MENU = 1600;
const MIN_VIABLE = 1112;

const ids = {
  /** Has one batchable dish and one of each ineligible kind. */
  stockedMerchantId: '',
  stockedUserId: '',
  /** Has a dish, but not one that can be in a drop. */
  ineligibleOnlyMerchantId: '',
  ineligibleOnlyUserId: '',
  /** Has no dishes at all. */
  bareMerchantId: '',
  bareUserId: '',
  batchableDish: '',
};

const createdItemIds: string[] = [];

async function makeMerchant(slugSuffix: string, name: string, timezone?: string): Promise<string> {
  const merchant = await prisma.merchant.create({
    data: {
      name,
      slug: `${PREFIX}${slugSuffix}`,
      status: 'PENDING',
      // Vector A's floor, set explicitly: the fixture arithmetic below depends on it, and a
      // change to the schema default must not silently re-price every assertion here.
      floorPctOfMenu: 0.25,
      timezone: timezone ?? 'America/Edmonton',
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

beforeAll(async () => {
  ids.stockedMerchantId = await makeMerchant('', 'Copper Kettle');
  ids.stockedUserId = await makeOwner('stocked', ids.stockedMerchantId);

  ids.batchableDish = await makeDish(ids.stockedMerchantId, 'Beef Bowl');
  await makeDish(ids.stockedMerchantId, 'House Red', { containsAlcohol: true, category: 'Drinks' });
  await makeDish(ids.stockedMerchantId, 'Hand-Plated Tasting', { isBatchable: false });
  await makeDish(ids.stockedMerchantId, 'Retired Special', { archivedAt: new Date() });

  // A merchant whose only dishes are ineligible — the state that must produce the same
  // "no dish can be a drop" card as a merchant with none at all.
  ids.ineligibleOnlyMerchantId = await makeMerchant('-inelig', 'Beer Only');
  ids.ineligibleOnlyUserId = await makeOwner('inelig', ids.ineligibleOnlyMerchantId);
  await makeDish(ids.ineligibleOnlyMerchantId, 'House White', { containsAlcohol: true });
  await makeDish(ids.ineligibleOnlyMerchantId, 'Fried To Order', { isBatchable: false });

  ids.bareMerchantId = await makeMerchant('-bare', 'Empty Pantry');
  ids.bareUserId = await makeOwner('bare', ids.bareMerchantId);

  sessionState.session = { userId: ids.stockedUserId, role: 'MERCHANT', mustChangePassword: false };
});

afterAll(async () => {
  if (createdItemIds.length > 0) {
    await prisma.menuItem.deleteMany({ where: { id: { in: createdItemIds } } });
  }
  const merchantIds = [ids.stockedMerchantId, ids.ineligibleOnlyMerchantId, ids.bareMerchantId].filter(
    (id) => id !== '',
  );
  await prisma.merchantUser.deleteMany({ where: { merchantId: { in: merchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } });
  await prisma.user.deleteMany({
    where: { email: { startsWith: PREFIX } },
  });
});

async function renderAs(userId: string, path: 'new' | 'new/ai'): Promise<{ html: string; text: string }> {
  const previous = sessionState.session;
  sessionState.session = { userId, role: 'MERCHANT', mustChangePassword: false };
  try {
    const page =
      path === 'new'
        ? await import('@/app/(merchant)/merchant/drops/new/page')
        : await import('@/app/(merchant)/merchant/drops/new/ai/page');
    const { html } = await renderWithRouter(await page.default());
    return { html, text: textOf(html) };
  } finally {
    sessionState.session = previous;
  }
}

/**
 * The `<option>` labels in a rendered `<select>`, decoded.
 *
 * Only `DropForm` gets a dish list in its first paint, and it prints the name alone. The
 * interview's dish `<select>` is on step 2, so on `/merchant/drops/new/ai` this helper returns
 * the twelve hour options instead — which is what makes it useful for pinning where the
 * interview starts.
 */
function optionLabels(html: string): string[] {
  return [...html.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)].map((match) =>
    textOf(match[1] ?? ''),
  );
}

describe('/merchant/drops/new', () => {
  it('offers only dishes that can actually be in a drop', async () => {
    const { html } = await renderAs(ids.stockedUserId, 'new');
    const options = optionLabels(html);

    // The batchable, non-alcoholic, unarchived dish is the only one of four. Each exclusion is
    // a different rule: AGLC, the batch requirement, and the archived filter.
    expect(options).toContain('Beef Bowl');
    expect(options).not.toContain('House Red');
    expect(options).not.toContain('Hand-Plated Tasting');
    expect(options).not.toContain('Retired Special');
  });

  it('shows the server-computed floor for the selected dish', async () => {
    const { text } = await renderAs(ids.stockedUserId, 'new');

    // `minViablePrice` at 25% with vector A's costs. A form left to compute this itself from
    // the menu price would print a different number the moment the fee constants moved.
    expect(text).toContain(`Your minimum for this dish is ${formatCents(MIN_VIABLE)}.`);
    expect(text).toContain('You cannot publish below it.');
  });

  it('says a draft can be saved at any price, and that publish is the hard stop', async () => {
    const { text } = await renderAs(ids.stockedUserId, 'new');

    // The form's `belowFloor` warning is behind a price the merchant types, so it cannot
    // render here. What can be asserted is the promise the page makes about the two
    // boundaries — saving is free, publishing is not — because a merchant who believes a
    // draft is price-checked will plan a batch that never publishes.
    expect(text).toContain('Save it as a draft first.');
    expect(text).toContain('Nothing is shown to anyone until you publish.');
    expect(text).toContain('Save draft');
  });

  it('offers the interview as an alternative, without forcing it', async () => {
    const { html, text } = await renderAs(ids.stockedUserId, 'new');

    expect(text).toContain('Plan it with me');
    expect(html).toContain('href="/merchant/drops/new/ai"');
    // And the manual form is still there — the interview is an option, not a gate.
    expect(text).toContain('Beef Bowl');
  });

  it('offers no drop at all to a merchant with no eligible dish, and says why', async () => {
    const bare = await renderAs(ids.bareUserId, 'new');
    const ineligible = await renderAs(ids.ineligibleOnlyUserId, 'new');

    // Both merchants reach the same card, which is the point: "you have no dishes" and "you
    // have no *eligible* dishes" are the same sentence to a merchant who wants to run a drop,
    // and neither should see an empty select box.
    for (const { html, text } of [bare, ineligible]) {
      expect(text).toContain('No dish can be a drop yet.');
      expect(text).toContain('A drop starts with a dish you can make in batches');
      expect(text).not.toContain('Save draft');
      expect(optionLabels(html)).toHaveLength(0);
      // And no interview link: it would land on the same wall.
      expect(text).not.toContain('Plan it with me');
    }
  });
});

describe('/merchant/drops/new/ai', () => {
  it('does not reach the dish picker on first paint, so the filter is unassertable here', async () => {
    // This test replaces one that asserted the interview's dish filter, which cannot be done:
    // the dish `<select>` is on **step 2**, and `phase` starts at `{ kind: 'interview', step: 1 }`
    // — which renders only the day and hour pickers. The only `<option>`s in the first paint
    // are the twelve hours.
    //
    // The filter itself is real and load-bearing (it is the same predicate the manual form
    // uses), and it is asserted on `/merchant/drops/new`, where the `<select>` *is* the first
    // paint. What this test does is pin the boundary: if the interview ever renders its dish
    // picker earlier, this fails and the filter needs asserting here too. A silently omitted
    // test would leave that change unnoticed.
    const { html, text } = await renderAs(ids.stockedUserId, 'new/ai');

    expect(text).toContain('Question 1 of 5');
    expect(html).not.toContain('Beef Bowl');
    expect(optionLabels(html)).toEqual([
      '10am', '11am', '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm',
    ]);
  });

  it('opens the interview at question one and states the promise up front', async () => {
    const { text } = await renderAs(ids.stockedUserId, 'new/ai');

    // The promise the interview makes about its own output, in full. Found by a probe rather
    // than by reading: mutating "three ways" to "one way" left every test green, because the
    // suite asserted only the first half of the sentence. It is the specific claim a merchant
    // is relying on when they start clicking, so it is asserted whole.
    expect(text).toContain(
      'Five questions. You will get three ways to run it, each with a price that still clears your minimum margin.',
    );
    expect(text).toContain('Plan a drop');
    expect(text).toContain('Question 1 of 5');
    expect(text).toContain('Which day are you quietest?');
  });

  it('labels the pickup hour choices, which is what the merchant actually reads', async () => {
    const { text } = await renderAs(ids.stockedUserId, 'new/ai');

    // The hour picker's labels are generated in the merchant's timezone. `Pickup starts` and
    // the hour list are the only timezone-visible thing a first render can show; the card
    // labels on the proposals are behind `phase === 'results'`.
    expect(text).toContain('Pickup starts');
    expect(text).toContain('10am');
    expect(text).toContain('9pm');
    expect(text).toContain('We suggest a two-hour window.');
  });

  it('says no dish can be a drop rather than starting an interview it cannot finish', async () => {
    const ineligible = await renderAs(ids.ineligibleOnlyUserId, 'new/ai');

    // The same wall as the manual form, with this page's own wording — the two pages write
    // their own sentence, so asserting one does not cover the other.
    expect(ineligible.text).toContain('No dish can be a drop yet.');
    expect(ineligible.text).toContain('Add one on the Dishes screen and come back.');
    expect(ineligible.text).not.toContain('Question 1 of 5');
  });

  it('renders no proposal, price card or message on first paint, which is the browser-only half', async () => {
    const { text } = await renderAs(ids.stockedUserId, 'new/ai');

    // Stated as an assertion so the boundary is recorded rather than assumed. The three
    // priced proposals, the copy button and the "use this one" action all need
    // `phase === 'results'`, reached by five clicks this harness cannot make. A suite that
    // silently omitted them would read as full coverage of the interview.
    expect(text).not.toContain('Use this one');
    expect(text).not.toContain('Copy message');

    // `timeZone` is in the same position, and a probe found it: replacing the merchant's zone
    // with `'UTC'` left every test green. The prop is threaded to `DealBuilder` and used only
    // to label the proposal cards, which are behind the results phase — so **no fixture can
    // observe it**. What *is* observable is that the page passes something rather than
    // crashing without it, which the render above already proves.
    //
    // This matters beyond the suite: `timeZone` has no test anywhere in the repo, so the two
    // claims its docblock makes — that the card labels and the generated group-chat message
    // cannot disagree about pickup time — rest on review alone. Recorded here so the next
    // reader does not read "the AI page is covered" as covering that.
  });
});
