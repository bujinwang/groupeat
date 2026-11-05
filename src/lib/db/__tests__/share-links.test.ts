import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { shareableDropJson } from '@/lib/organisers/share-offer';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

import {
  countShareLinkClick,
  ensureShareLink,
  listShareableDrops,
  organiserProfileForUser,
  resolveShareToken,
} from '../share-links';

/**
 * FR-801/802/805 against real Postgres.
 *
 * ## What these tests protect
 *
 *   1. **One link per organiser per drop, by constraint.** The double-tap is the second
 *      tap of the "2 taps max" flow. A read-then-write would have a window exactly as
 *      wide as that tap; the unique index has none. The test fires both writes and then
 *      counts rows.
 *   2. **A token is scoped to its drop.** Attribution feeds commission (FR-804), so a
 *      token that works on any drop is a token that can be farmed: share once, then
 *      point the URL at every other drop in the corridor.
 *   3. **Only live drops are offered.** A locked or past-cutoff drop cannot take a join,
 *      so a link to one burns the organiser's group attention to deliver a "no".
 *   4. **FR-805 has no field to leak.** The row type carries counts only; the test
 *      asserts the phone number that exists in the database does not appear anywhere in
 *      the serialised rows.
 */

const PREFIX = `sl${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const HOUR = 60 * 60 * 1000;
const DEAL_PRICE = 1200;

let userSeq = 0;

/**
 * Every account this file creates, so teardown can delete it.
 *
 * This array is the fix for a leak, and the leak is worth describing because it was
 * invisible from inside this file. It was created and never tracked: `beforeAll` made
 * `organiserUserId`, the one test made `bare`, and teardown deleted neither. The
 * `organiser-1` row was supposed to go with its profile by cascade — which works only
 * when the profile exists, and in the case that matters it did not.
 *
 * What made it visible: `/admin/users` renders every `role: 'ORGANISER'` account with
 * no profile as a broken account needing repair. Running this suite left real rows in
 * the dev database that the admin screen then reported as faults, so the screen
 * accumulated ninety-three phantom repairs in one day. A test that pollutes the data a
 * screen reads is not just untidy — it makes the screen lie to whoever is reading it.
 */
const createdUserIds: string[] = [];

/**
 * An account, tracked for teardown.
 *
 * `settlementFixtures` creates a `User` only as a side effect of `merchant()`, and
 * these tests need bare organisers — including one deliberately without a profile.
 */
async function makeUser(tag: string, role: 'ORGANISER' | 'MERCHANT' = 'ORGANISER'): Promise<string> {
  userSeq += 1;
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}-${userSeq}@example.test`,
      passwordHash: 'not-a-real-hash',
      role,
      mustChangePassword: true,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

let merchantId = '';
let itemId = '';
let organiserProfileId = '';
let organiserUserId = '';
let liveDropId = '';
let livePublicCode = '';

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);

  organiserUserId = await makeUser('organiser');
  const profile = await prisma.organiserProfile.create({
    data: { userId: organiserUserId, displayName: 'Sam Organiser', commissionPct: 5 },
    select: { id: true },
  });
  organiserProfileId = profile.id;

  liveDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 5,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 6 * HOUR),
  });
  const drop = await prisma.drop.findUniqueOrThrow({
    where: { id: liveDropId },
    select: { publicCode: true },
  });
  livePublicCode = drop.publicCode;
});

afterAll(async () => {
  // The order here is the fix, and getting it wrong is instructive enough to write
  // down. `ShareLink` cascades from `Drop` — not from `OrganiserProfile`, which it
  // references with a plain foreign key. So the drop has to go **first**, taking the
  // links with it; deleting the profile while links still point at it raises
  // `ShareLink_organiserId_fkey`.
  //
  // What made this a leak rather than a red test: each delete had
  // `.catch(() => undefined)` on it, so the violation was swallowed and teardown
  // reported success. Three accounts survived every run that way, and the only reason
  // anyone noticed is that `/admin/users` lists every profile-less organiser as a
  // broken account needing repair — so this suite was quietly filling the admin screen
  // with phantom faults. A teardown must fail loudly; it is the one place where a
  // swallowed error has no other symptom.
  //
  // Loud is not the same as fragile, though: a throw in step one must not skip steps two
  // and three, or a *failing* run leaves the database dirtier than a passing one. So every
  // step runs and the errors are rethrown together at the end.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  await step(() => fx.cleanup());
  if (createdUserIds.length > 0) {
    // Explicit, not via cascade. `OrganiserProfile.user` is `onDelete: Cascade`, but
    // the account made without a profile — the one this suite exists to test — has
    // nothing to cascade through.
    await step(() => prisma.organiserProfile.deleteMany({ where: { userId: { in: createdUserIds } } }));
    await step(() => prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `teardown left the database dirty (${failures.length} step(s) failed)`);
  }
});

describe('organiserProfileForUser', () => {
  it('resolves the profile for an organiser', async () => {
    const profile = await organiserProfileForUser(organiserUserId);
    expect(profile?.displayName).toBe('Sam Organiser');
    // Decimal → number at the boundary, like the merchant floor.
    expect(typeof profile?.commissionPct).toBe('number');
    expect(profile?.commissionPct).toBe(5);
  });

  it('returns null for an organiser with no profile instead of throwing', async () => {
    // The FR-906 defect, as a page concern: this account signs in and reaches
    // /organiser. A throw here is a 500 on a page that should say one sentence.
    const bare = await makeUser('bare');
    expect(await organiserProfileForUser(bare)).toBeNull();
  });
});

describe('listShareableDrops', () => {
  it('lists a live drop with the numbers a share message needs', async () => {
    const rows = await listShareableDrops({ organiserProfileId });
    const row = rows.find((candidate) => candidate.id === liveDropId);

    expect(row).toBeDefined();
    expect(row?.publicCode).toBe(livePublicCode);
    expect(row?.dealPriceCents).toBe(DEAL_PRICE);
    expect(row?.merchantName).toContain(PREFIX);
    expect(row?.minQty).toBe(5);
    // No link yet, so the button must offer to create one.
    expect(row?.existingToken).toBeNull();
    expect(row?.existingClicks).toBe(0);
  });

  it('sums joined plates from participants, not from a counter', async () => {
    const drop = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 3,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 4 * HOUR),
    });
    await fx.participant({ dropId: drop, qty: 2 });
    await fx.participant({ dropId: drop, qty: 3 });

    const rows = await listShareableDrops({ organiserProfileId });
    const row = rows.find((candidate) => candidate.id === drop);

    // Five plates, not two participants.
    expect(row?.joinedQty).toBe(5);
  });

  it('omits drops that are locked, failed, or past their cutoff', async () => {
    const locked = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 3,
      status: 'LOCKED',
      cutoffAt: new Date(Date.now() + 2 * HOUR),
    });
    const expired = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 3,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() - HOUR),
    });
    const draft = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 3,
      status: 'DRAFT',
      cutoffAt: new Date(Date.now() + 2 * HOUR),
    });

    const ids = (await listShareableDrops({ organiserProfileId })).map((row) => row.id);

    expect(ids).not.toContain(locked);
    expect(ids).not.toContain(expired);
    expect(ids).not.toContain(draft);
  });

  it('exposes no participant phone number, because the row has no field for one', async () => {
    // FR-805, P0. A diner joined the drop above, so a phone number is in the database
    // and one join away from this query.
    const serialised = JSON.stringify(await listShareableDrops({ organiserProfileId }));

    const customer = await prisma.customer.findFirstOrThrow({ select: { phone: true } });
    expect(customer.phone).toBeTruthy();
    expect(serialised).not.toContain(customer.phone);
    // Not even the last four, which the admin screen does show — organisers get counts.
    expect(serialised).not.toContain(customer.phone.slice(-4));
  });
});

describe('ensureShareLink', () => {
  it('creates one link with a well-formed token', async () => {
    const link = await ensureShareLink({ organiserProfileId, dropId: liveDropId });

    expect(link).not.toBeNull();
    expect(link?.token).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const stored = await prisma.shareLink.findUniqueOrThrow({
      where: { token: link?.token ?? '' },
      select: { dropId: true, merchantId: true, organiserId: true, clicks: true },
    });
    expect(stored.dropId).toBe(liveDropId);
    // The merchant is recorded from the drop, not from the caller — a caller-supplied
    // merchant could attribute a drop to a restaurant that has nothing to do with it.
    expect(stored.merchantId).toBe(merchantId);
    expect(stored.organiserId).toBe(organiserProfileId);
    expect(stored.clicks).toBe(0);
  });

  it('returns the same token on a second call, which is the double-tap', async () => {
    const first = await ensureShareLink({ organiserProfileId, dropId: liveDropId });
    const second = await ensureShareLink({ organiserProfileId, dropId: liveDropId });

    expect(second?.token).toBe(first?.token);

    // And the property behind it: one row, not two. `clicks` would otherwise split and
    // a link already pasted into a group chat would count on a row nobody reads.
    const count = await prisma.shareLink.count({
      where: { organiserId: organiserProfileId, dropId: liveDropId },
    });
    expect(count).toBe(1);
  });

  it('reports which tap inserted the row, so the log event is not a lie', async () => {
    // The event was `organiser.share_link_created` on *every* tap, including the second
    // one that created nothing — so "how many links did Sam make" counted taps. Gap 18
    // added a second emitter, which would have doubled the fiction, so `created` exists.
    const drop = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 2 * HOUR),
    });

    const first = await ensureShareLink({ organiserProfileId, dropId: drop });
    const second = await ensureShareLink({ organiserProfileId, dropId: drop });

    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    // Same token either way — `created` describes the call, not the link.
    expect(second?.token).toBe(first?.token);
  });

  it('reports `created: false` for an organiser who already has a link', async () => {
    // The row exists from an earlier test in this file. A `created: true` here would
    // mean the flag is derived from something other than the read.
    const link = await ensureShareLink({ organiserProfileId, dropId: liveDropId });
    expect(link?.created).toBe(false);
  });

  it('survives a genuinely concurrent pair without creating two rows', async () => {
    // The unique index, not a `findFirst`. Two tabs, one slow connection.
    const drop = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 3,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 5 * HOUR),
    });

    const [a, b] = await Promise.all([
      ensureShareLink({ organiserProfileId, dropId: drop }),
      ensureShareLink({ organiserProfileId, dropId: drop }),
    ]);

    expect(a?.token).toBe(b?.token);
    expect(await prisma.shareLink.count({ where: { dropId: drop } })).toBe(1);
  });

  it('gives two organisers different tokens for the same drop', async () => {
    const otherUser = await makeUser('other');
    const otherProfile = await prisma.organiserProfile.create({
      data: { userId: otherUser, displayName: 'Other Organiser' },
      select: { id: true },
    });

    const mine = await ensureShareLink({ organiserProfileId, dropId: liveDropId });
    const theirs = await ensureShareLink({ organiserProfileId: otherProfile.id, dropId: liveDropId });

    expect(mine?.token).not.toBe(theirs?.token);
  });

  it('refuses a drop that has locked since the page was rendered', async () => {
    // A tab open since before the cutoff must not mint a link for a drop that can no
    // longer take a join. The list already filters for this, so this is the check that
    // a stale page cannot bypass.
    const drop = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 3,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + HOUR),
    });

    // While it is live, a link is minted.
    expect(await ensureShareLink({ organiserProfileId, dropId: drop })).not.toBeNull();

    // Then the sweep locks it, and the same tap must now produce nothing.
    await prisma.drop.update({ where: { id: drop }, data: { status: 'LOCKED' } });
    expect(await ensureShareLink({ organiserProfileId, dropId: drop })).toBeNull();
  });

  it('refuses a drop whose cutoff has already passed', async () => {
    const drop = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 3,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + HOUR),
    });

    // Still `PUBLISHED` — the sweep has not run — but nobody can join any more. The
    // status alone would say yes here, which is why the cutoff is checked too.
    expect(
      await ensureShareLink({
        organiserProfileId,
        dropId: drop,
        now: new Date(Date.now() + 2 * HOUR),
      }),
    ).toBeNull();
  });

  it('refuses a drop id that does not exist', async () => {
    expect(
      await ensureShareLink({
        organiserProfileId,
        dropId: '00000000-0000-0000-0000-000000000000',
      }),
    ).toBeNull();
  });

  it('shows up on the list afterwards, so the button becomes a copy button', async () => {
    const rows = await listShareableDrops({ organiserProfileId });
    const row = rows.find((candidate) => candidate.id === liveDropId);

    expect(row?.existingToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('resolveShareToken', () => {
  it('resolves a token that belongs to the drop', async () => {
    const link = await ensureShareLink({ organiserProfileId, dropId: liveDropId });
    const resolved = await resolveShareToken({ token: link?.token ?? '', dropId: liveDropId });

    expect(resolved?.organiserId).toBe(organiserProfileId);
    expect(resolved?.shareLinkId).toBeTruthy();
    // FR-302: the page prints this next to the offer. It is the organiser's public
    // display name, not participant information.
    expect(resolved?.organiserName).toBe('Sam Organiser');
  });

  it('refuses a real token pointed at a different drop', async () => {
    // Attribution is a payment input (FR-804). A token that works anywhere could be
    // farmed: share one link, then paste it onto every other drop in the corridor.
    const link = await ensureShareLink({ organiserProfileId, dropId: liveDropId });
    const otherDrop = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 3,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 3 * HOUR),
    });

    expect(
      await resolveShareToken({ token: link?.token ?? '', dropId: otherDrop }),
    ).toBeNull();
  });

  it('refuses malformed, unknown, and empty tokens without a query', async () => {
    for (const token of ['', 'short', 'abcdefghijklmnopqrstu!', 'abcdefghijklmnopqrstuv']) {
      expect(await resolveShareToken({ token, dropId: liveDropId })).toBeNull();
    }
  });
});

describe('likelyFill ordering (gap 16)', () => {
  // These live here, not in the page suite, for one reason: producing a *real* ranking
  // difference needs past drops and a second organiser, and the page suite asserts an
  // exact count of live drops. Constructing history here costs nothing there.
  //
  // The fixture below is chosen so the cutoff order and the score order genuinely
  // disagree — that is the whole point. If both agreed, a page that ignored the rank
  // entirely would pass.

  const DAY = 24 * 60 * 60 * 1000;

  /**
   * A past drop, already decided, for the pair-history axis.
   *
   * `status` is the history: `FAILED` is a miss, `LOCKED` is a fill. Nothing else about
   * the row matters to the rank, which is why `fx.drop` with a past cutoff is enough.
   */
  async function pastDrop(args: {
    merchantId: string;
    menuItemId: string;
    status: 'FAILED' | 'LOCKED';
  }): Promise<string> {
    return fx.drop({
      merchantId: args.merchantId,
      menuItemId: args.menuItemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: args.status,
      // Inside the 90-day history window and before `now`, so it counts.
      cutoffAt: new Date(Date.now() - 10 * DAY),
    });
  }

  it('ranks a drop with a good merchant record above one with a bad record, against the cutoff order', async () => {
    // Two merchants, two items, two live drops. The cutoffs are arranged so the *worse*
    // drop closes first — so `cutoffAt` ascending and `likelyFill` disagree, and only
    // one of them can be what the page shows.
    const goodMerchant = await fx.merchant(`acct_${PREFIX}_good`);
    const badMerchant = await fx.merchant(`acct_${PREFIX}_bad`);
    const goodItem = await fx.item(goodMerchant);
    const badItem = await fx.item(badMerchant);

    // Four decided drops each, so the blend is at half strength rather than a fifth.
    for (let i = 0; i < 4; i += 1) {
      await pastDrop({ merchantId: goodMerchant, menuItemId: goodItem, status: 'LOCKED' });
      await pastDrop({ merchantId: badMerchant, menuItemId: badItem, status: 'FAILED' });
    }

    const soonButBad = await fx.drop({
      merchantId: badMerchant,
      menuItemId: badItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 2 * HOUR),
    });
    const laterButGood = await fx.drop({
      merchantId: goodMerchant,
      menuItemId: goodItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      // 3 days out. The gap is chosen against the weights, not picked to look tidy:
      // the merchant term spans 0.15 across the full 0→1 range, and the deadline term
      // spans 0.2 over five days, so a *four*-day gap (0.157) slightly outvotes a
      // perfect record versus a terrible one. Three days leaves 0.12 of deadline
      // against 0.15 of record, and the ranking wins with less than a point of margin.
      // That is a real property of §9.3's weights, and it is why this fixture is
      // specific about the gap rather than picking a round number.
      cutoffAt: new Date(Date.now() + 72 * HOUR),
    });

    const rows = await listShareableDrops({ organiserProfileId });
    const order = rows.map((row) => row.id);

    // The premise, asserted rather than assumed: the cutoff order between *these two*
    // is the opposite. Scoped to the pair on purpose — this suite's other tests leave
    // live drops in the database (`liveDropId` among them), and asserting the global
    // first element made this fail on somebody else's fixture rather than on the claim.
    expect(soonButBad).not.toBe(laterButGood);
    const soonCutoff = rows.find((row) => row.id === soonButBad)?.cutoffAt;
    const laterCutoff = rows.find((row) => row.id === laterButGood)?.cutoffAt;
    expect(soonCutoff?.getTime() ?? 0).toBeLessThan(laterCutoff?.getTime() ?? 0);

    // And the ranking overrides it.
    expect(order.indexOf(laterButGood)).toBeLessThan(order.indexOf(soonButBad));

    const good = rows.find((row) => row.id === laterButGood);
    expect(good?.likelyFill.reason.kind).toBe('merchant-record');
    expect(good?.likelyFill.score).toBeGreaterThan(
      rows.find((row) => row.id === soonButBad)?.likelyFill.score ?? 0,
    );
  });

  it('reads history from status, so a FAILED drop is a miss and a LOCKED one is a fill', async () => {
    // The claim `outcomeOf` makes. Both drops are identical except for the status of
    // their history, so a difference in score can only come from the status mapping.
    const merchantA = await fx.merchant(`acct_${PREFIX}_statusA`);
    const merchantB = await fx.merchant(`acct_${PREFIX}_statusB`);
    const itemA = await fx.item(merchantA);
    const itemB = await fx.item(merchantB);

    for (let i = 0; i < 4; i += 1) {
      await pastDrop({ merchantId: merchantA, menuItemId: itemA, status: 'LOCKED' });
      await pastDrop({ merchantId: merchantB, menuItemId: itemB, status: 'FAILED' });
    }

    const filled = await fx.drop({
      merchantId: merchantA,
      menuItemId: itemA,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 20 * HOUR),
    });
    const missed = await fx.drop({
      merchantId: merchantB,
      menuItemId: itemB,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 20 * HOUR),
    });

    const rows = await listShareableDrops({ organiserProfileId });
    const filledScore = rows.find((row) => row.id === filled)?.likelyFill.score ?? 0;
    const missedScore = rows.find((row) => row.id === missed)?.likelyFill.score ?? 0;

    expect(filledScore).toBeGreaterThan(missedScore);
  });

  it('does not count a CANCELLED drop as a miss', async () => {
    // A merchant closing their kitchen says nothing about demand. If `outcomeOf` mapped
    // CANCELLED to `missed`, this merchant would look like it never fills.
    //
    // Probe I caught the CANCELLED mapping; probe J walked the same hole for PUBLISHED
    // and stayed green, because the assertion below is `not.toBe('merchant-record')` and
    // that is satisfied by *any* structural reason. The two fixes are a positive
    // assertion (below) and a second test comparing the two against the same baseline.
    const cancelledMerchant = await fx.merchant(`acct_${PREFIX}_cancel`);
    const cancelledItem = await fx.item(cancelledMerchant);

    for (let i = 0; i < 4; i += 1) {
      await fx.drop({
        merchantId: cancelledMerchant,
        menuItemId: cancelledItem,
        dealPriceCents: DEAL_PRICE,
        minQty: 5,
        status: 'CANCELLED',
        cutoffAt: new Date(Date.now() - 10 * DAY),
      });
    }

    const live = await fx.drop({
      merchantId: cancelledMerchant,
      menuItemId: cancelledItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 20 * HOUR),
    });

    const rows = await listShareableDrops({ organiserProfileId });
    const row = rows.find((candidate) => candidate.id === live);

    // No decided history at all, so the reason falls through to a structural one.
    expect(row?.likelyFill.reason.kind).not.toBe('merchant-record');
  });

  it('scores an all-CANCELLED history identically to no history at all', async () => {
    // The assertion probe J needed. `not.toBe('merchant-record')` cannot distinguish
    // "cancellations were ignored" from "cancellations were counted as misses and the
    // reason got masked by the score threshold" — so this compares the *score* against a
    // merchant with no history whatsoever at the same cutoff. If CANCELLED mapped to
    // `missed`, the score would fall below the clean baseline.
    const cancelledMerchant = await fx.merchant(`acct_${PREFIX}_cancel2`);
    const cancelledItem = await fx.item(cancelledMerchant);
    const cleanMerchant = await fx.merchant(`acct_${PREFIX}_clean`);
    const cleanItem = await fx.item(cleanMerchant);

    for (const status of ['CANCELLED', 'CANCELLED', 'CANCELLED'] as const) {
      await fx.drop({
        merchantId: cancelledMerchant,
        menuItemId: cancelledItem,
        dealPriceCents: DEAL_PRICE,
        minQty: 5,
        status,
        cutoffAt: new Date(Date.now() - 10 * DAY),
      });
    }

    // **A past `PUBLISHED` drop, which is the case probe J exploited.** The first version
    // of this test claimed in a comment to cover PUBLISHED and did not — the loop only
    // created CANCELLED rows, and the "undecided" drop was the live one being scored,
    // not history. So `case 'PUBLISHED': return 'missed'` sailed through.
    //
    // This row is the one that matters: a drop whose cutoff passed while it was still
    // `PUBLISHED` (the sweep had not run) has made no decision and must not be a miss.
    await fx.drop({
      merchantId: cancelledMerchant,
      menuItemId: cancelledItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() - 20 * DAY),
    });

    const cutoff = new Date(Date.now() + 20 * HOUR);
    const undecided = await fx.drop({
      merchantId: cancelledMerchant,
      menuItemId: cancelledItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      cutoffAt: cutoff,
    });
    const clean = await fx.drop({
      merchantId: cleanMerchant,
      menuItemId: cleanItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      cutoffAt: cutoff,
    });

    const rows = await listShareableDrops({ organiserProfileId });
    const undecidedScore = rows.find((row) => row.id === undecided)?.likelyFill.score;
    const cleanScore = rows.find((row) => row.id === clean)?.likelyFill.score;

    // Identical, not merely close: both histories are empty, so both merchants fall back
    // to the neutral prior and the structural terms are the same to the millisecond.
    expect(undecidedScore).toBe(cleanScore);
  });

  it('ignores history older than the window', async () => {
    // Ninety days. A drop from last season describes a different corridor, and the
    // bound is `HISTORY_WINDOW_DAYS` rather than something each caller picks.
    const staleMerchant = await fx.merchant(`acct_${PREFIX}_stale`);
    const staleItem = await fx.item(staleMerchant);

    for (let i = 0; i < 4; i += 1) {
      await fx.drop({
        merchantId: staleMerchant,
        menuItemId: staleItem,
        dealPriceCents: DEAL_PRICE,
        minQty: 5,
        status: 'LOCKED',
        cutoffAt: new Date(Date.now() - 200 * DAY),
      });
    }

    const live = await fx.drop({
      merchantId: staleMerchant,
      menuItemId: staleItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 20 * HOUR),
    });

    const rows = await listShareableDrops({ organiserProfileId });
    const row = rows.find((candidate) => candidate.id === live);

    expect(row?.likelyFill.reason.kind).not.toBe('merchant-record');
  });

  it('carries the rank on the row, so the page and the API cannot order it differently', async () => {
    const rows = await listShareableDrops({ organiserProfileId });
    for (const row of rows) {
      expect(typeof row.likelyFill.score).toBe('number');
      expect(Number.isFinite(row.likelyFill.score)).toBe(true);
      expect(row.likelyFill.reason.kind).toBeTruthy();
    }

    // The API mapper must forward it rather than recompute — an omission there would
    // silently drop the ordering field from the wire and leave the page as the only
    // client that ranks, which is the drift gap 17 recorded.
    const json = shareableDropJson(rows[0]!);
    expect(json.likelyFill).toEqual(rows[0]?.likelyFill);
  });
});

describe('countShareLinkClick', () => {
  it('increments exactly one row', async () => {
    const link = await ensureShareLink({ organiserProfileId, dropId: liveDropId });
    const before = await prisma.shareLink.findUniqueOrThrow({
      where: { token: link?.token ?? '' },
      select: { id: true, clicks: true },
    });

    await countShareLinkClick(before.id);
    await countShareLinkClick(before.id);

    const after = await prisma.shareLink.findUniqueOrThrow({
      where: { id: before.id },
      select: { clicks: true },
    });
    expect(after.clicks).toBe(before.clicks + 2);
  });

  it('swallows a failure rather than failing a diner’s page load', async () => {
    // A click counter is not worth an error page. The id does not exist, so this is a
    // real failure, and it must not reject.
    await expect(
      countShareLinkClick('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });
});
