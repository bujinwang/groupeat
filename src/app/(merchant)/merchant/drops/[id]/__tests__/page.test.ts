import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

import { renderWithRouter, textOf } from '@/lib/testing/render';

/**
 * `/merchant/drops/:id` rendered — gap 12, the second `/merchant/*` page and the one with
 * the most expensive property in the group.
 *
 * Two modes on one route, chosen by `drop.status`:
 *
 *   - **`DRAFT`** — the editable form, the blocking problems, and the publish button.
 *   - **everything else** — read-only, with the money read from the **frozen snapshot**.
 *
 * ## The claim worth rendering: FR-207
 *
 * The page's own docblock states the rule and the reason it is easy to get wrong:
 *
 * > Not from `buildDealView` against the current dish. That was my first draft and it was
 * > wrong in the most expensive possible way: the dish may have been edited since publish,
 * > and a view rebuilt now would silently report a different contribution than the one this
 * > drop actually earned. The snapshot is the record.
 *
 * `publish.test.ts` already proves the *row* survives a dish edit. It cannot prove what the
 * page **prints**, because a page is free to ignore the row it loaded — and the wrong
 * version of this page is not a crash, it is a plausible number. So the test here publishes,
 * renders, edits the dish, renders again, and asserts the figure did not move *and* is not
 * the figure a recomputation would produce. That second half is what makes the assertion
 * falsifiable: `$4.01` from the snapshot against `-$7.39` from the edited dish.
 *
 * ## What the draft branch can assert that nothing else can
 *
 * The page lists its refusals by calling `reviewForPublish` — the same function `publishDrop`
 * runs. That is a claim about *this page* (that it does not reimplement the checks), and it
 * is why the refusals here are asserted as full sentences: a page that hardcoded a friendlier
 * message would still be wrong, because the preview would then disagree with the server the
 * moment a rule changed.
 *
 * ## What is mocked, and what that costs
 *
 * `server-only` and `@/lib/auth/session` — the second because a session cookie cannot be
 * minted by a render. Everything below is real: `requireMerchant`, `findDrop`, `listItems`,
 * `primaryMerchantFloor`, `countJoinedQty`, `reviewForPublish`, `readGuardrailSnapshot`,
 * `snapshotBreakdown`, and all three client components (`DropForm`, `PublishButton`,
 * `CancelDropButton`).
 *
 * ## What a render still cannot see, precisely
 *
 * All three components are unhydrated, so their `useState` shows its initial value:
 *
 *   - `CancelDropButton` renders its **closed** state. Note what that hides: the component
 *     computes `participants` into a sentence — *"3 people are holding plates"* — and that
 *     sentence is inside the `if (!open)` early return's *other* branch, so **no fixture can
 *     make this render print it.** The prop is passed and asserted-invisible; the counting
 *     itself is `countJoinedQty`'s, tested there. Do not add an assertion on that sentence
 *     expecting it to fail — it cannot pass.
 *   - `PublishButton`'s `payoutsReady` branch **is** reachable and is asserted below in its
 *     `false` form, because `readOnboarding` with no `stripeAccountId` returns
 *     `NOT_STARTED`. The `true` form needs a Stripe account and is not rendered here.
 *   - `DropForm`'s fields are inputs, so their *values* are in the HTML and their editing is
 *     not. The floor helper text is derived state and is asserted, because it is the number
 *     a merchant prices against.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { publishDrop } = await import('@/lib/drops/publish');
const { DEFAULT_FEES, formatCents, buildGuardrailSnapshot } = await import('@/lib/guardrail');

const PREFIX = `mchdrop${Date.now().toString(36).slice(-5)}`;

/**
 * Vector A, the guardrail snapshot in `docs/`, so the numbers are the ones the rest of the
 * suite uses: menu 1600, food 480, packaging 80, floor 25% → `minViablePrice` 1112, and at
 * that price the breakdown is $5.60 ingredients, $0.62 card, $0.89 platform, **$4.01 kept**.
 *
 * Those four figures are hardcoded below on purpose. Deriving them in the test from
 * `snapshotBreakdown` would assert the page against the function the page calls, which passes
 * even if both are wrong; the numbers are checkable arithmetic and belong in the file.
 */
const MENU = 1600;
const FOOD = 480;
const PACKAGING = 80;
const DEAL_PRICE = 1112;
const KEPT_CENTS = 401;
const INGREDIENTS_CENTS = 560;
const CARD_FEE_CENTS = 62;
const PLATFORM_FEE_CENTS = 89;

const ids = {
  merchantId: '',
  otherMerchantId: '',
  userId: '',
  dish: '',
  alcoholDish: '',
  nonBatchableDish: '',
  draftBlocked: '',
  draftReady: '',
  draftClean: '',
  published: '',
  cancelled: '',
  locked: '',
  pickupOpen: '',
  foreign: '',
};

const createdDropIds: string[] = [];

const DAY = 24 * 60 * 60 * 1000;

/**
 * A snapshot built by the real constructor, for the fixtures that skip `publishDrop`.
 *
 * `LOCKED` and `CANCELLED` cannot be reached by publishing — `cancel.ts`'s CAS requires
 * `PUBLISHED`, and settlement moves a drop to `LOCKED` after capture — so those rows are
 * written directly. They still need a **readable** snapshot, because every non-`DRAFT`
 * status renders through `readGuardrailSnapshot`, which throws on `{}`. Using the real
 * builder rather than a literal keeps these fixtures honest: the same version, the same
 * input shape, the same arithmetic as a published drop.
 */
function readableSnapshot(): Prisma.InputJsonObject {
  return buildGuardrailSnapshot(
    {
      ...DEFAULT_FEES,
      menuPriceCents: MENU,
      foodCostCents: FOOD,
      packagingCents: PACKAGING,
      floorPctOfMenu: 0.25,
    },
    DEAL_PRICE,
    new Date().toISOString(),
  ) as unknown as Prisma.InputJsonObject;
}

/**
 * A drop body whose timings always satisfy §8.3, because they are relative to now.
 *
 * Typed as Prisma's own create input rather than `Record<string, unknown>`: the loose type
 * compiled nothing, so a fixture missing a required column failed at runtime instead of at
 * `tsc` — and `status` had to be widened to the enum by hand rather than falling back to the
 * string literal type Prisma wants.
 */
function dropBody(
  overrides: Partial<Prisma.DropUncheckedCreateInput> = {},
): Prisma.DropUncheckedCreateInput {
  const now = Date.now();
  return {
    merchantId: ids.merchantId,
    menuItemId: ids.dish,
    title: 'Beef Bowl Thursday',
    dealPriceCents: DEAL_PRICE,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    publicCode: `${PREFIX}${Math.random().toString(36).slice(2, 8)}`,
    cutoffAt: new Date(now + 3 * DAY),
    windowStart: new Date(now + 4 * DAY),
    windowEnd: new Date(now + 4 * DAY + 2 * 60 * 60 * 1000),
    status: 'DRAFT',
    guardrailSnapshot: {},
    ...overrides,
  };
}

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

  const [dish, alcoholDish, nonBatchableDish] = await Promise.all([
    prisma.menuItem.create({
      data: {
        merchantId: ids.merchantId,
        name: 'Beef Bowl',
        menuPriceCents: MENU,
        foodCostCents: FOOD,
        packagingCents: PACKAGING,
        batchYield: 30,
        prepMinutes: 6,
        category: 'Bowls',
      },
      select: { id: true },
    }),
    // Both disqualifiers, so the form's `filter` has something to remove for each reason
    // rather than one reason twice.
    prisma.menuItem.create({
      data: {
        merchantId: ids.merchantId,
        name: 'House Red',
        menuPriceCents: MENU,
        foodCostCents: FOOD,
        packagingCents: PACKAGING,
        batchYield: 30,
        prepMinutes: 6,
        category: 'Drinks',
        containsAlcohol: true,
      },
      select: { id: true },
    }),
    prisma.menuItem.create({
      data: {
        merchantId: ids.merchantId,
        name: 'Hand-Plated Tasting',
        menuPriceCents: MENU,
        foodCostCents: FOOD,
        packagingCents: PACKAGING,
        batchYield: 30,
        prepMinutes: 6,
        category: 'Bowls',
        isBatchable: false,
      },
      select: { id: true },
    }),
  ]);
  ids.dish = dish.id;
  ids.alcoholDish = alcoholDish.id;
  ids.nonBatchableDish = nonBatchableDish.id;

  // A draft whose price is below the floor: `reviewForPublish` refuses, so the page has a
  // refusal list to render. 500 is comfortably below 1112 rather than one cent below it,
  // because the assertion names the $11.12 minimum and a boundary case would make the
  // fixture's intent harder to read than it needs to be.
  const draftBlocked = await prisma.drop.create({
    data: dropBody({ title: 'Too Cheap', dealPriceCents: 500 }),
    select: { id: true },
  });
  ids.draftBlocked = draftBlocked.id;

  // A draft pointing at a dish that cannot be a drop at all. Separate from the price
  // refusal because the two come from different branches of `reviewForPublish` and produce
  // different sentences.
  const draftReady = await prisma.drop.create({
    data: dropBody({ title: 'House Rules', menuItemId: ids.alcoholDish }),
    select: { id: true },
  });
  ids.draftReady = draftReady.id;

  // A draft that passes review — the state a merchant actually wants, and the one that had
  // no fixture until a probe survived. Deal price at the floor, quantities inside the batch
  // yield, timings relative to now: `reviewForPublish` returns an empty refusal list, so the
  // page's "Before this can go live" card must not render at all.
  const draftClean = await prisma.drop.create({
    data: dropBody({ title: 'Ready To Go' }),
    select: { id: true },
  });
  ids.draftClean = draftClean.id;

  const published = await prisma.drop.create({
    data: dropBody({ title: 'Sold Out Soon' }),
    select: { id: true },
  });
  ids.published = published.id;

  const cancelled = await prisma.drop.create({
    data: dropBody({ title: 'Called Off', status: 'CANCELLED', guardrailSnapshot: readableSnapshot() }),
    select: { id: true },
  });
  ids.cancelled = cancelled.id;

  // `LOCKED` is the state the page comments about: money is moving, so there must be no
  // cancel card. It is the only status the comment names as a *reason* for the guard.
  const locked = await prisma.drop.create({
    data: dropBody({ title: 'Mid Settlement', status: 'LOCKED', guardrailSnapshot: readableSnapshot() }),
    select: { id: true },
  });
  ids.locked = locked.id;

  // The pickup window, which the page's cancel guard also excludes. It exists here so the
  // test asserts the requirement rather than restating the comment — a `PICKUP_OPEN` drop
  // that offered "call it off" would be worse than a `LOCKED` one: diners are queueing.
  const pickupOpen = await prisma.drop.create({
    data: dropBody({
      title: 'Collect Now',
      status: 'PICKUP_OPEN',
      guardrailSnapshot: readableSnapshot(),
    }),
    select: { id: true },
  });
  ids.pickupOpen = pickupOpen.id;

  const foreign = await prisma.drop.create({
    data: dropBody({ merchantId: ids.otherMerchantId, title: 'Not Yours' }),
    select: { id: true },
  });
  ids.foreign = foreign.id;

  createdDropIds.push(
    ids.draftBlocked,
    ids.draftReady,
    ids.draftClean,
    ids.published,
    ids.cancelled,
    ids.locked,
    ids.pickupOpen,
    ids.foreign,
  );

  sessionState.session = { userId: ids.userId, role: 'MERCHANT', mustChangePassword: false };
});

afterAll(async () => {
  if (createdDropIds.length > 0) {
    await prisma.dropParticipant.deleteMany({ where: { dropId: { in: createdDropIds } } });
    await prisma.drop.deleteMany({ where: { id: { in: createdDropIds } } });
  }
  for (const merchantId of [ids.merchantId, ids.otherMerchantId]) {
    if (merchantId === '') {
      continue;
    }
    await prisma.menuItem.deleteMany({ where: { merchantId } });
    await prisma.merchantUser.deleteMany({ where: { merchantId } });
  }
  await prisma.merchant.deleteMany({
    where: { id: { in: [ids.merchantId, ids.otherMerchantId].filter((id) => id !== '') } },
  });
  if (ids.userId !== '') {
    await prisma.user.deleteMany({ where: { id: ids.userId } });
  }
});

/** Render the page for one drop, as the signed-in owner. */
async function render(dropId: string): Promise<string> {
  const page = await import('@/app/(merchant)/merchant/drops/[id]/page');
  const { html } = await renderWithRouter(
    await page.default({ params: Promise.resolve({ id: dropId }) }),
  );
  return html;
}

describe('/merchant/drops/:id — a draft', () => {
  it('renders the editable form with the draft badge and the save button', async () => {
    const text = textOf(await render(ids.draftBlocked));

    expect(text).toContain('Too Cheap');
    // The mode indicator, not the status enum: a merchant should not read `DRAFT`.
    expect(text).toContain('Draft');
    // The dish name is resolved from the item id, so this also proves the page joined the
    // drop to its dish rather than printing a uuid.
    expect(text).toContain('Beef Bowl');
    expect(text).toContain(`${formatCents(500)} per plate`);

    expect(text).toContain('Details');
    expect(text).toContain('Save changes');
    expect(text).toContain('Publish');
  });

  it('lists the publish refusals in the sentences publish itself would return', async () => {
    const text = textOf(await render(ids.draftBlocked));

    // Both halves matter and they come from different places in the refusal object: the
    // `message` is the card-level sentence, and the field error is the specific number.
    // A page that showed only the message would leave the merchant without the price to fix.
    expect(text).toContain('Before this can go live');
    expect(text).toContain('That price loses you money.');
    expect(text).toContain(`The lowest price that still works is ${formatCents(DEAL_PRICE)}.`);
  });

  it('names the dish as the reason when the dish cannot be a drop at all', async () => {
    const text = textOf(await render(ids.draftReady));

    // A different branch of `reviewForPublish` from the price refusal above, with a
    // different sentence — and the sentence names alcohol, which is the regulatory reason
    // rather than an arithmetic one. Worth its own fixture: the two refusals are the two
    // things a draft can fail for that the merchant can act on.
    expect(text).toContain('This dish cannot be a drop.');
    expect(text).toContain('This dish contains alcohol, which cannot be sold as a drop in Alberta.');
    expect(text).not.toContain('That price loses you money.');
  });

  it('offers only dishes that can actually be in a drop', async () => {
    // The page filters `isBatchable && !containsAlcohol` before handing the list to the form,
    // because the form's select is the merchant's only way to change the dish. Offering an
    // alcohol dish there would let them pick something publish is guaranteed to refuse.
    const html = await render(ids.draftBlocked);
    const options = [...html.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)].map((match) =>
      textOf(match[1] ?? ''),
    );

    expect(options).toContain('Beef Bowl');
    expect(options).not.toContain('House Red');
    expect(options).not.toContain('Hand-Plated Tasting');
  });

  it('shows the minimum price for the selected dish, which is what the merchant prices against', async () => {
    const text = textOf(await render(ids.draftBlocked));

    // `minViablePrice` computed for this dish at this floor, not the drop's deal price and
    // not the menu price. 1112 is vector A's floor, so a page that printed the deal price
    // (500) or the menu price (1600) fails here.
    expect(text).toContain(`Your minimum for this dish is ${formatCents(DEAL_PRICE)}.`);
  });

  it('does not show the frozen-money card on a draft, because nothing is frozen yet', async () => {
    const text = textOf(await render(ids.draftBlocked));

    expect(text).not.toContain('What you keep');
    expect(text).not.toContain('These are the figures frozen when you published.');
    // And no share link: a draft has no public page to share.
    expect(text).not.toContain(`/d/${ids.draftBlocked}`);
  });

  it('shows no "before this can go live" card on a draft that passes review', async () => {
    const text = textOf(await render(ids.draftClean));

    // The state every merchant is aiming for, and the one that had no fixture at first —
    // which is exactly how probe E survived. `reviewForPublish` returns an empty refusal
    // list here, so a page that rendered the card unconditionally showed an empty heading
    // above nothing, and every assertion passed because every other draft fixture refuses
    // something. This test is the reason that mutation is now visible.
    expect(text).not.toContain('Before this can go live');
    // And the card that must still be there — a clean draft is still publishable, so it is
    // not simply a blank page.
    expect(text).toContain('Save changes');
    expect(text).toContain('Ready To Go');
  });

  it('says payouts are not ready instead of offering a publish that would be refused', async () => {
    const text = textOf(await render(ids.draftBlocked));

    // No `stripeAccountId` on this merchant, so `readOnboarding` returns `NOT_STARTED` and
    // the button is replaced by the reason plus a link. This is the reachable half of
    // `PublishButton`'s `payoutsReady` branch — the `true` half needs a Stripe account.
    expect(text).toContain('Set up payouts first.');
    expect(text).toContain('Go to payouts');
    expect(text).not.toContain('Publish this drop');
  });
});

describe('/merchant/drops/:id — a published drop', () => {
  it('keeps printing the snapshot’s money after the dish is edited', async () => {
    // Published through the real path, so the snapshot is the real one — not a hand-written
    // object that might not resemble what `publishDrop` stores.
    await publishDrop({
      merchantIds: [ids.merchantId],
      dropId: ids.published,
      actorId: 'gap-12-test',
      now: new Date(),
      payoutsReady: true,
    });

    const before = textOf(await render(ids.published));

    // The four snapshot figures, spelled out. `$4.01` is 1112 − 560 − 62 − 89.
    expect(before).toContain('What you keep');
    expect(before).toContain(formatCents(KEPT_CENTS));
    expect(before).toContain(formatCents(INGREDIENTS_CENTS));
    expect(before).toContain(formatCents(CARD_FEE_CENTS));
    expect(before).toContain(formatCents(PLATFORM_FEE_CENTS));
    expect(before).toContain('These are the figures frozen when you published.');

    // The merchant then edits the dish — the cost of the food goes up five-fold and the
    // packaging nearly quadruples. Both are inside the snapshot's `input`.
    await prisma.menuItem.update({
      where: { id: ids.dish },
      data: { foodCostCents: 1400, packagingCents: 300 },
    });

    try {
      const after = textOf(await render(ids.published));

      // The whole page is unchanged, which is the claim: nothing on it is derived from the
      // live dish.
      expect(after).toBe(before);

      // And the stronger half — the number it must NOT print. Recomputed against the edited
      // dish the contribution is 1112 − 1700 − 62 − 89 = −739, i.e. `-$7.39`. A page that
      // rebuilt the view from the current dish instead of the snapshot prints that, and this
      // is the assertion that would catch it. Without this line the test above would pass on
      // a page that printed a constant.
      expect(after).not.toContain(formatCents(-739));
      expect(after).not.toContain(formatCents(-(1400 + 300) + DEAL_PRICE));
    } finally {
      // Restore, so the fixture's dish is vector A for any later assertion.
      await prisma.menuItem.update({
        where: { id: ids.dish },
        data: { foodCostCents: FOOD, packagingCents: PACKAGING },
      });
    }
  });

  it('shows the live badge, the share path, and the quantity it needs', async () => {
    const html = await render(ids.published);
    const text = textOf(html);

    expect(text).toContain('Live');
    expect(text).toContain('Sold Out Soon');
    expect(text).toContain(`need 20`);
    // The path a diner would be given, built from `publicCode` rather than the drop id.
    expect(text).toContain('/d/');
    expect(text).not.toContain(`/d/${ids.published}`);

    // The share code itself, read from the row, so a page printing a stale or invented code
    // fails.
    const drop = await prisma.drop.findUniqueOrThrow({
      where: { id: ids.published },
      select: { publicCode: true },
    });
    expect(text).toContain(`/d/${drop.publicCode}`);
  });

  it('offers cancellation on a published drop, with the typed code as the second press', async () => {
    const text = textOf(await render(ids.published));

    // FR-208. The button is the component's closed state; the typed code and the reason
    // field are inside the opened panel and are therefore invisible to a render. What is
    // asserted is that the affordance exists and what it promises, not that it works.
    expect(text).toContain('Call it off');
    expect(text).toContain('Call off this drop');
    expect(text).toContain('Nothing is charged and nothing is refunded, because nothing was ever taken.');
  });

  it('does not offer cancellation on a locked drop, where the money is already moving', async () => {
    const text = textOf(await render(ids.locked));

    // The page guards on `status === 'PUBLISHED'` exactly, and its comment gives the reason:
    // `LOCKED` is mid-settlement, so the button would offer something the server refuses.
    // A looser guard — `status !== 'DRAFT'`, say — renders the card here and fails this.
    expect(text).not.toContain('Call off this drop');
    expect(text).not.toContain('Call it off');
    // The read-only money view is still there, which is what makes this a *locked* page
    // rather than an error.
    expect(text).toContain('What you keep');
  });

  it('does not offer cancellation during the pickup window either', async () => {
    const text = textOf(await render(ids.pickupOpen));

    // FR-208 says "until the cutoff", and a `PICKUP_OPEN` drop is past it: diners are
    // queueing at the counter. This case is why the guard is an equality on `PUBLISHED`
    // rather than "has been published" — the assertion exists so the requirement is tested
    // rather than restated in a comment.
    expect(text).not.toContain('Call off this drop');
    expect(text).not.toContain('Call it off');
    expect(text).toContain('What you keep');
    // And it is not the cancelled branch: a pickup-window drop is very much alive.
    expect(text).not.toContain('This drop was called off');
  });
});

describe('/merchant/drops/:id — a cancelled drop', () => {
  it('says it was called off, and offers neither publishing nor cancelling again', async () => {
    const text = textOf(await render(ids.cancelled));

    expect(text).toContain('This drop was called off');
    // The sentence that closes the loop for a merchant wondering whether they can retry.
    expect(text).toContain('A cancelled drop cannot be republished');
    expect(text).not.toContain('Call off this drop');
    expect(text).not.toContain('Save changes');
  });
});

describe('/merchant/drops/:id — a drop that is not this merchant’s', () => {
  it('is a 404 rather than another merchant’s drop', async () => {
    // `findDrop` scopes by merchant id, so a valid id outside the session's scope must be
    // indistinguishable from a missing one. The digest is how a `notFound()` surfaces from a
    // render: it throws, and Next turns that into the 404 boundary.
    const page = await import('@/app/(merchant)/merchant/drops/[id]/page');
    await expect(
      page.default({ params: Promise.resolve({ id: ids.foreign }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });
});
