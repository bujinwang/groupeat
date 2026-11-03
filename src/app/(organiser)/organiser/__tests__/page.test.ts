import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/organiser` rendered — gap 12(e), FR-801/802/805.
 *
 * > `FR-801 | Organiser sees available drops from their merchants |` — PRD-v1.md:536
 * > `FR-802 | "Get share link" generates unique token, 2 taps max | Link + copyable
 * > pre-written message` — PRD-v1.md:537
 * > `FR-805 | Organiser cannot see participant phone numbers | P0` — PRD-v1.md:540
 *
 * ## This is Journey B's acceptance test, minus the taps
 *
 * The PRD judges this page by one sentence: *"organiser can go from login to a
 * shareable link in ≤2 taps."* A render cannot count taps — the button press is a server
 * action and the copy is `navigator.clipboard`. What it *can* prove is the thing the tap
 * count depends on: that the link and the pre-written message are on the first screen an
 * organiser sees, with no navigation between them, and that the message says what the page
 * says.
 *
 * So this suite does not repeat the action's behaviour. `getShareLinkAction` is covered by
 * `api/organiser/drops/[id]/share/__tests__/route.test.ts`, which drives it for real and
 * proves it returns the same token as the API route — a comparison no test of the page
 * could make. What is proved *here* is the render: which card offers a button, which shows
 * a message, and whether the words agree.
 *
 * ## The claim only this file can test: the page and the paste cannot disagree
 *
 * The deadline appears twice for one drop — once in the card (`Orders close …`) and once
 * inside the pasted message (`… needed by …`). Both go through `momentLabel` with
 * `merchant.timezone`, and the docblock in `ShareLinkControl` claims that is why composing
 * the message in the browser produces byte-identical text. That claim is only observable
 * when both are on screen at once, which needs the render.
 *
 * The fixtures therefore use **America/Toronto** while this host runs in
 * **America/Edmonton**. Edmonton is UTC−6 year-round since 2026-11-01 and Toronto is
 * UTC−5 in November, so every label differs by exactly one hour from the server's local
 * formatting. A page that formatted in the host zone, or in UTC, prints a visibly different
 * hour — not a subtly different one.
 *
 * ## Prices are chosen so a plausible wrong percentage is visible
 *
 * Drop A: menu 1800, deal 1250 → saving 550. `550/1800` is **31%**; dividing the saving by
 * the *deal* price instead gives 44%. Drop B gives 13% against 14%. Round prices make the
 * two readings agree and the assertion would prove nothing.
 *
 * ## What is mocked
 *
 * `server-only`, and `@/lib/auth/session` — the second because `getSession` reads a cookie
 * jar that does not exist outside a request. Nothing else. `next/cache` is *not* mocked:
 * the page does not call `revalidatePath` (only the action does), and the absence is worth
 * keeping honest rather than papering over.
 *
 * ## What is not proven, named rather than implied
 *
 * Twenty-one probes were run against this suite; eighteen fail a named test, one was a
 * bad probe of my own, and two say something real. The limits:
 *
 *   1. **A tap has never happened.** The button, the pending state ("Getting link…"), the
 *      error sentence after a refusal and the clipboard are all inert in a render. The
 *      action's own tests cover the refusal sentences; the *display* of them is not
 *      proved anywhere.
 *   2. **`state.token ?? existingToken` is unobservable here.** Probe M deleted the
 *      `state.token` half of that precedence and eighteen tests stayed green — because
 *      `useActionState` always returns `INITIAL` in a render, so `state.token` is `null`
 *      in every case this file can produce. The precedence is only exercised by a real
 *      tap: a drop with no token that then gets one. That is the sharpest instance of the
 *      render boundary in this repo, and it is one line of a client component rather than
 *      a page.
 *   3. **The empty-list branch needs a database with no live drop**, and this one is
 *      shared. Probe T replaced `drops.length === 0` with `false` and nothing failed, for
 *      exactly that reason. The branch is read and believed, not asserted.
 *   4. **The `1 open` singular arm is untestable here**, for the same reason: it needs
 *      exactly one shareable drop in the whole database. Only the plural is asserted.
 *   5. **`origin === undefined` is the only origin branch exercised**, because no `APP_URL`
 *      exists in this environment. With an absolute origin the message would carry it and
 *      the "relative link" note would disappear; neither is asserted.
 *   6. **The profile-less account's *layout* is not part of the render.** `layout.tsx`
 *      gates the role and sits inside Next's routing, so it never executes here — the same
 *      boundary every page suite in this repo has.
 *
 * ## The probes that passed, and why that is the interesting part
 *
 * Probes M and T are not weak assertions. They are assertions about code this harness
 * cannot reach: a client component's state after an event, and a branch that requires the
 * shared database to be empty. Recording them as limits rather than deleting the code that
 * they cover is the difference between a suite that is honest about its boundary and one
 * that quietly pretends there isn't one.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { settlementFixtures } = await import('@/lib/settlement/__tests__/settlement-fixtures');
const { momentLabel } = await import('@/lib/time/labels');
const pageModule = await import('../page');

const PREFIX = `org${Date.now().toString(36).slice(-6)}`;
const fx = settlementFixtures(PREFIX);

/**
 * A merchant zone that is not the host's.
 *
 * The host is `America/Edmonton` (UTC−6 all year now); Toronto is UTC−5 in November, so
 * a label formatted in the wrong zone is one hour out and the assertions below can see it.
 */
const TZ = 'America/Toronto';

/**
 * Three cutoffs, one hour apart in Toronto, in ascending order.
 *
 * `momentLabel` prints weekday and clock time, so these land on Tuesday 6:00 PM,
 * Wednesday 11:30 AM and Wednesday 8:15 PM — three different labels from three different
 * days and halves of the day, which is what makes a positional assertion meaningful.
 */
const CUTOFF_A = new Date('2026-11-10T23:00:00Z');
const CUTOFF_B = new Date('2026-11-11T16:30:00Z');
const CUTOFF_C = new Date('2026-11-12T01:15:00Z');

const WINDOW_A_START = new Date('2026-11-11T00:00:00Z');
const WINDOW_A_END = new Date('2026-11-11T02:00:00Z');

/** Menu and deal prices chosen so the discount percentage is not a coincidence. */
const A_MENU = 1800;
const A_DEAL = 1250;
const B_MENU = 2000;
const B_DEAL = 1750;
const C_MENU = 1600;
const C_DEAL = 1200;

let merchantId = '';
let ownProfileId = '';
let organiserUserId = '';
let profilelessUserId = '';

/** The three live drops, by the fixture's own titles. */
let dropA = '';
let dropB = '';
let dropC = '';
let titleA = '';
let titleB = '';
let titleC = '';

/**
 * Tokens this organiser already holds on B and C, so those cards render a message.
 *
 * They must satisfy `isShareToken` — 22 base64url characters — because the page hands them
 * to `shareUrlFor` and a malformed one would produce a URL no public page accepts while
 * still rendering. Written out rather than generated so the expected message is a constant
 * a reader can check by eye.
 */
const TOKEN_B = 'AAAAAAAAAAAAAAAAAAAAAB';
const TOKEN_C = 'CCCCCCCCCCCCCCCCCCCCCC';

const createdProfileIds: string[] = [];
const createdUserIdList: string[] = [];

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  await prisma.merchant.update({
    where: { id: merchantId },
    // The zone under test, and an address so the card's pickup line has real text rather
    // than the fallback — the fallback is asserted separately, by a drop on a second
    // merchant.
    data: { timezone: TZ, pickupAddress: '88 Test Kitchen Lane' },
  });

  organiserUserId = (
    await prisma.user.create({
      data: {
        email: `${PREFIX}-organiser@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'ORGANISER',
      },
      select: { id: true },
    })
  ).id;
  createdUserIdList.push(organiserUserId);

  const profile = await prisma.organiserProfile.create({
    data: {
      userId: organiserUserId,
      displayName: `${PREFIX} Organiser`,
      phone: '+15550000123',
      commissionPct: 7.5,
    },
    select: { id: true },
  });
  ownProfileId = profile.id;
  createdProfileIds.push(profile.id);

  // FR-906's account: signs in fine, has nothing behind it. Exercises the page's only
  // other top-level branch.
  profilelessUserId = (
    await prisma.user.create({
      data: {
        email: `${PREFIX}-noprofile@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'ORGANISER',
      },
      select: { id: true },
    })
  ).id;
  createdUserIdList.push(profilelessUserId);

  // Three items with three different menu prices, created **before** the drops so each
  // drop points at its own price from the start. `fx.item()` hard-codes 1600, so the price
  // is set explicitly afterwards — the fixture's constant would make A and C identical and
  // the "per-drop percentage" assertion below would prove nothing.
  const itemA = await fx.item(merchantId);
  const itemB = await fx.item(merchantId);
  const itemC = await fx.item(merchantId);
  await prisma.menuItem.update({ where: { id: itemA }, data: { menuPriceCents: A_MENU } });
  await prisma.menuItem.update({ where: { id: itemB }, data: { menuPriceCents: B_MENU } });
  await prisma.menuItem.update({ where: { id: itemC }, data: { menuPriceCents: C_MENU } });

  dropA = await fx.drop({
    merchantId,
    menuItemId: itemA,
    dealPriceCents: A_DEAL,
    minQty: 5,
    status: 'PUBLISHED',
    cutoffAt: CUTOFF_A,
    windowStart: WINDOW_A_START,
    windowEnd: WINDOW_A_END,
  });
  dropB = await fx.drop({
    merchantId,
    menuItemId: itemB,
    dealPriceCents: B_DEAL,
    minQty: 5,
    status: 'PUBLISHED',
    cutoffAt: CUTOFF_B,
  });
  dropC = await fx.drop({
    merchantId,
    menuItemId: itemC,
    dealPriceCents: C_DEAL,
    minQty: 5,
    status: 'PUBLISHED',
    cutoffAt: CUTOFF_C,
  });

  // Titles and public codes are distinct per drop and are the only handle the rendered
  // page gives. Read back rather than reconstructed, because the fixture's drop sequence
  // number depends on how many drops it has made.
  const stored = await prisma.drop.findMany({
    where: { id: { in: [dropA, dropB, dropC] } },
    select: { id: true, title: true, publicCode: true },
  });
  const byId = new Map(stored.map((row) => [row.id, row]));
  const titleOf = (id: string): string => {
    const row = byId.get(id);
    if (!row) throw new Error(`drop ${id} did not resolve after creation`);
    codesByTitle.set(row.title, row.publicCode);
    return row.title;
  };
  titleA = titleOf(dropA);
  titleB = titleOf(dropB);
  titleC = titleOf(dropC);

  // A joins to exactly its minimum — the `>=` boundary. A `>` mutation makes this card
  // print `5 of 5` instead of `Threshold met`.
  for (let i = 0; i < 5; i += 1) {
    await fx.participant({ dropId: dropA, qty: 1 });
  }
  // B is short of its minimum, so it prints the count.
  await fx.participant({ dropId: dropB, qty: 2 });
  // C is over it.
  await fx.participant({ dropId: dropC, qty: 6 });

  // Two links already exist — B with one click, C with three. That gives the card three
  // distinct states between them: no token (A), singular opens (B), plural opens (C).
  await prisma.shareLink.create({
    data: { token: TOKEN_B, dropId: dropB, merchantId, organiserId: ownProfileId, clicks: 1 },
  });
  await prisma.shareLink.create({
    data: { token: TOKEN_C, dropId: dropC, merchantId, organiserId: ownProfileId, clicks: 3 },
  });
});

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // Links first. `ShareLink` reaches `OrganiserProfile` by a plain foreign key and only
  // cascades from `Drop`, so deleting the profile while links exist raises
  // `ShareLink_organiserId_fkey` — the mistake this repo has now made three times.
  if (createdProfileIds.length > 0) {
    await step(() =>
      prisma.shareLink.deleteMany({ where: { organiserId: { in: createdProfileIds } } }),
    );
  }
  await step(() => fx.cleanup());
  if (createdProfileIds.length > 0) {
    await step(() =>
      prisma.organiserProfile.deleteMany({ where: { id: { in: createdProfileIds } } }),
    );
  }
  if (createdUserIdList.length > 0) {
    await step(() => prisma.user.deleteMany({ where: { id: { in: createdUserIdList } } }));
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `teardown left the database dirty (${failures.length} step(s) failed)`,
    );
  }
});

type Rendered = { html: string; text: string };

async function renderAs(userId: string): Promise<Rendered> {
  sessionState.session = { userId, role: 'ORGANISER', mustChangePassword: false };
  const html = await renderToHtml(await pageModule.default());
  return { html, text: textOf(html) };
}

/** The page as the organiser who owns a profile sees it. */
function render(): Promise<Rendered> {
  return renderAs(organiserUserId);
}

/**
 * One card, located by the drop's title and scoped to its `<li>`.
 *
 * `toContain` cannot tell you which card it found, and these cards carry near-identical
 * markup — every one has a price, a badge and a deadline line. Row scoping is the only way
 * to assert that *this* drop's price is next to *this* drop's deadline.
 */
function rawCard(html: string, title: string): string {
  const at = html.indexOf(title);
  if (at === -1) {
    throw new Error(`No card in the render contains the title ${title}.`);
  }
  const start = html.lastIndexOf('<li', at);
  const next = html.indexOf('<li', at);
  return html.slice(start === -1 ? at : start, next === -1 ? html.length : next);
}

function card(html: string, title: string): string {
  return textOf(rawCard(html, title));
}

/**
 * Public codes by drop title, captured in `beforeAll`.
 *
 * The card never prints the code — it appears only inside the pasted URL — so scraping it
 * out of the render would assert the page against itself. It is read from the database and
 * asserted against the URL the page built.
 */
const codesByTitle = new Map<string, string>();

function publicCodeOf(title: string): string {
  const code = codesByTitle.get(title);
  if (!code) {
    throw new Error(`no public code recorded for ${title}`);
  }
  return code;
}

describe('/organiser — the list itself', () => {
  it('offers every live drop, soonest cutoff first, and counts only those', async () => {
    // The count assertion is about the whole database, because the query is: every live
    // drop is offered to every organiser (there is no organiser→merchant table to read).
    // So the premise is checked rather than assumed — a leftover POSsTED drop from another
    // suite would make `3 open` wrong for a reason that has nothing to do with this page.
    const live = await prisma.drop.count({
      where: { status: 'PUBLISHED', cutoffAt: { gt: new Date() } },
    });
    expect(
      live,
      'the render asserts a count of 3, so this file needs exactly 3 live drops in the database — another suite has leaked one',
    ).toBe(3);

    const { html, text } = await render();

    expect(text).toContain('Drops you can share');
    expect(text).toContain('3 open');

    // Order is the page's only ranking decision (FR-801's `likelyFill` is not built), so
    // it is asserted positionally: A's cutoff is earliest and A must appear first.
    const atA = text.indexOf(titleA);
    const atB = text.indexOf(titleB);
    const atC = text.indexOf(titleC);
    expect(atA).toBeGreaterThan(-1);
    expect(atB).toBeGreaterThan(atA);
    expect(atC).toBeGreaterThan(atB);

    // The merchant name and address are how an organiser recognises a drop.
    expect(card(html, titleA)).toContain(`${PREFIX} merchant`);
    expect(card(html, titleA)).toContain('88 Test Kitchen Lane');
  });

  it('links to the commission page instead of restating the figure', async () => {
    const { html, text } = await render();

    // The sentence that first tells an organiser their commission is counted, and the
    // link to read it, belong on this screen — not only in the nav.
    expect(text).toContain('your commission is counted');
    expect(hrefsOf(html)).toContain('/commission');
    expect(text).toContain('See what you have earned');
  });

  it('renders every deadline in the merchant’s zone, not the server’s', async () => {
    const { html } = await render();
    const scope = card(html, titleA);

    const expected = `Orders close ${momentLabel(CUTOFF_A, TZ)}`;
    expect(scope).toContain(expected);

    // The host is America/Edmonton, one hour behind Toronto in November. A page
    // formatting with the host zone, or with UTC, prints a different hour — and this
    // assertion is what makes that difference fail rather than look plausible.
    const hostish = momentLabel(CUTOFF_A, 'America/Edmonton');
    expect(hostish).not.toBe(momentLabel(CUTOFF_A, TZ));
    expect(scope).not.toContain(`Orders close ${hostish}`);
    expect(scope).not.toContain(`Orders close ${momentLabel(CUTOFF_A, 'UTC')}`);
  });

  it('states the pickup window as a range in the same zone', async () => {
    const { html } = await render();
    const scope = card(html, titleA);

    // Both ends, in the merchant's zone, joined by an en dash. A page that printed only
    // the start would still pass a `toContain` on the start, so the end is asserted too.
    expect(scope).toContain(
      `pick up ${momentLabel(WINDOW_A_START, TZ)}–${momentLabel(WINDOW_A_END, TZ)}`,
    );
  });
});

describe('/organiser — money, which must be this drop’s', () => {
  it('prints the deal price with the menu price it beats, and the discount between them', async () => {
    const { html } = await render();
    const scope = card(html, titleA);

    expect(scope).toContain('$12.50');
    expect(scope).toContain('was $18.00');
    // 550 / 1800 = 30.6% → 31. Dividing the saving by the deal price gives 44%, which is
    // the plausible wrong implementation, and the fixture makes the two disagree.
    expect(scope).toContain('31% off');
    expect(scope).not.toContain('44% off');
  });

  it('computes the percentage per drop, so two cards cannot share one figure', async () => {
    const { html } = await render();

    // 250 / 2000 = 12.5% → 13 (round half up). The reversed reading is 14%.
    expect(card(html, titleB)).toContain('13% off');
    expect(card(html, titleB)).not.toContain('31% off');
    expect(card(html, titleC)).toContain('25% off');
    expect(card(html, titleC)).not.toContain('13% off');
  });
});

describe('/organiser — the threshold, which is the whole pitch', () => {
  it('shows the count against the minimum while the drop still needs plates', async () => {
    const { html } = await render();
    const scope = card(html, titleB);

    expect(scope).toContain('2 of 5');
    expect(scope).not.toContain('Threshold met');
  });

  it('says the threshold is met once the count reaches the minimum, not after it', async () => {
    const { html } = await render();

    // A is exactly at its minimum. `>=` prints `Threshold met`; `>` would print `5 of 5`,
    // and that is the boundary this fixture exists to test.
    expect(card(html, titleA)).toContain('Threshold met');
    expect(card(html, titleA)).not.toContain('5 of 5');

    expect(card(html, titleC)).toContain('Threshold met');
    expect(card(html, titleC)).not.toContain('6 of 5');
  });
});

describe('/organiser — the two taps', () => {
  it('offers the link button, and nothing to copy, for a drop with no token', async () => {
    const { html, text } = await render();
    const raw = rawCard(html, titleA);
    const scope = textOf(raw);

    expect(scope).toContain('Get share link');
    expect(raw).toContain(`value="${dropA}"`);
    expect(scope).not.toContain('Copy message');
    expect(scope).not.toContain('Copy link only');
    expect(raw).not.toContain('<pre');

    // Exactly one card offers the button. A page that rendered both states on every card
    // — the failure mode of dropping the `token === null` early return — would show it on
    // all three, and a bare `toContain` on one card could not see that.
    expect([...text.matchAll(/Get share link/g)]).toHaveLength(1);
  });

  it('renders the pre-written message, the two copy controls, and the link inside it', async () => {
    const { html } = await render();
    const raw = rawCard(html, titleC);
    const scope = textOf(raw);

    expect(raw).toContain('<pre');
    expect(scope).toContain('Copy message');
    expect(scope).toContain('Copy link only');
    expect(scope).not.toContain('Get share link');

    // The message is four lines: title — merchant, price, demand, url.
    const url = `/d/${encodeURIComponent(publicCodeOf(titleC))}?src=organiser_link&o=${encodeURIComponent(TOKEN_C)}`;
    for (const line of [
      `${titleC} — ${PREFIX} merchant`,
      '$12.00 instead of $16.00 (25% off)',
      'It’s on — 6 plates so far.',
      url,
    ]) {
      expect(scope, `the pasted message is missing the line ${line}`).toContain(line);
    }
  });

  it('says the link is relative when the deployment has no public address', async () => {
    const { html } = await render();

    // No `APP_URL` here, so `publicOrigin()` is `undefined` and the link is relative. An
    // organiser pasting that into a group chat has pasted a dead link, and the page has to
    // say so rather than let them find out from the group.
    expect(textOf(rawCard(html, titleC))).toContain(
      'This link is relative because the app’s public address is not configured',
    );
  });

  it('counts the opens on a link that already has them, singular and plural', async () => {
    const { html } = await render();

    expect(card(html, titleB)).toContain('1 open so far');
    expect(card(html, titleB)).not.toContain('1 opens so far');
    expect(card(html, titleC)).toContain('3 opens so far');

    // A card with no link cannot claim opens at all — `existingClicks` is 0 there and the
    // sentence is conditional on it.
    expect(card(html, titleA)).not.toContain('so far');
  });
});

describe('/organiser — the page is the same words as the paste', () => {
  it('uses one label for the deadline in the card and in the message', async () => {
    const { html } = await render();

    // B is below its minimum, so `shareMessageFor` takes the arm that names the deadline.
    // The claim in `ShareLinkControl`'s docblock is that composing the message in the
    // browser produces the same text the server would, because both go through
    // `momentLabel` with the merchant's zone — and that is only observable with the card
    // and the message on screen together, which is why this is asserted here and nowhere
    // else.
    const scope = card(html, titleB);
    const label = momentLabel(CUTOFF_B, TZ);
    expect(scope).toContain(`Orders close ${label}`);
    expect(scope).toContain(`needed by ${label}`);

    // And not the host's rendering of the same instant.
    const hostish = momentLabel(CUTOFF_B, 'America/Edmonton');
    expect(hostish).not.toBe(label);
    expect(scope).not.toContain(hostish);
  });

  it('swaps the deadline sentence for the total once the threshold is met', async () => {
    const { html } = await render();
    const scope = card(html, titleC);

    // The other arm of the same ternary. A message that kept saying "5 needed by
    // Wednesday" after the drop was already on would read as a bug to everyone who tapped
    // it, so the sentence is replaced rather than left stale — and the deadline must not
    // survive in it.
    expect(scope).toContain('It’s on — 6 plates so far.');
    expect(scope).not.toContain('needed by');
    expect(scope).not.toContain('of 5 needed');

    // The card still states the deadline — it is the organiser's urgency argument. Only
    // the *message* drops it.
    expect(scope).toContain(`Orders close ${momentLabel(CUTOFF_C, TZ)}`);
  });
});

describe('/organiser — the account with nothing behind it', () => {
  it('says the account is unfinished rather than rendering an empty list', async () => {
    const { text } = await renderAs(profilelessUserId);

    // FR-906's account. It signs in — `role` is what the layout gate reads — and arrives
    // with no profile, so there is no name to attribute a link to.
    expect(text).toContain('Your account is not finished setting up');
    expect(text).toContain('there is nothing you need to do');

    // Not the empty-list sentence. "Nothing open right now" would be a lie: three drops
    // are open, they just are not this account's to share.
    expect(text).not.toContain('Nothing open right now');
    expect(text).not.toContain('Drops you can share');
  });

  it('does not offer a single drop to an account that cannot attribute them', async () => {
    const { html, text } = await renderAs(profilelessUserId);

    for (const title of [titleA, titleB, titleC]) {
      expect(text, `a profile-less account was offered ${title}`).not.toContain(title);
    }
    expect(text).not.toContain('Get share link');
    expect(html).not.toContain('<pre');
  });
});

describe('/organiser — FR-805, on the screen rather than in the query', () => {
  it('never names a participant, while their details really are in the database', async () => {
    const { html, text } = await render();

    // The premise, checked rather than assumed: a real person's phone number is one join
    // away from every row this page renders.
    const participant = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: dropA },
      select: { customer: { select: { phone: true, name: true } } },
    });
    expect(participant.customer.phone).toBeTruthy();

    expect(html).not.toContain(participant.customer.phone);
    // Not even the last four, which the admin screens do show.
    expect(html).not.toContain(participant.customer.phone.slice(-4));
    if (participant.customer.name) {
      expect(text).not.toContain(participant.customer.name);
    }

    // Counts, which is what an organiser gets instead.
    expect(text).toContain('You see counts only');
    expect(text).toContain('never who joined');
  });
});

describe('/organiser — it reads, it does not write', () => {
  it('mints no link just because a page rendered', async () => {
    // The action's docblock: "Rows that exist only because a page rendered are not
    // attribution." A page that pre-computed a token for every listed drop would make
    // "how many drops did Sam share?" unanswerable, and the row count is the only place
    // that is visible.
    const before = await prisma.shareLink.count({ where: { organiserId: ownProfileId } });
    expect(before).toBe(2); // B and C only — A has never been tapped.

    await render();
    await render();

    expect(await prisma.shareLink.count({ where: { organiserId: ownProfileId } })).toBe(before);

    // And the state is genuinely unchanged per row, not just in total.
    const stored = await prisma.shareLink.findMany({
      where: { organiserId: ownProfileId },
      select: { dropId: true, clicks: true, token: true },
      orderBy: { dropId: 'asc' },
    });
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dropId: dropB, clicks: 1, token: TOKEN_B }),
        expect.objectContaining({ dropId: dropC, clicks: 3, token: TOKEN_C }),
      ]),
    );
    expect(stored).toHaveLength(2);
  });
});
