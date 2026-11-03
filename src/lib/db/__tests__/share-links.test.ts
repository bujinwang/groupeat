import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
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
  // `ShareLink` cascades from `Drop` and from `OrganiserProfile`; both are cleaned by
  // the fixture and by deleting the user.
  await prisma.shareLink.deleteMany({ where: { organiserId: organiserProfileId } }).catch(() => undefined);
  await prisma.organiserProfile.deleteMany({ where: { userId: organiserUserId } }).catch(() => undefined);
  await fx.cleanup();
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
