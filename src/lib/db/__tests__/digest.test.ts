import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import {
  digestAlreadySent,
  digestSettingsFor,
  merchantsForDigest,
  recordDigestDelivery,
  setDigestConsent,
} from '@/lib/db/digest';
import { reportSourcesFor } from '@/lib/db/reports';
import { DEFAULT_FEES, buildGuardrailSnapshot } from '@/lib/guardrail';

/**
 * FR-704's two database decisions, against real Postgres.
 *
 * ## Consent is a predicate, not a UI state
 *
 * The acceptance criterion has two words — **consenting** and **owners** — and both
 * are `MerchantUser` columns. The fixture below puts a consenting MANAGER beside a
 * non-consenting OWNER, so a query that filtered on one and forgot the other would
 * send to the wrong person on the first run. That is the one failure this feature
 * cannot recover from: a merchant who receives an email they did not ask for turns the
 * feature off, and the next Monday looks identical to a provider outage.
 *
 * ## The week filter is half-open
 *
 * `reportSourcesFor` gained optional `from`/`to` for this feature. The test puts one
 * drop exactly on each boundary as well as one inside, because `>=` and `>` are
 * indistinguishable across the whole fixture set until a drop sits on the edge.
 */

const PREFIX = `DIG${Date.now().toString(36).slice(-5)}`;
const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];
const createdDropIds: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function makeMerchant(tag: string): Promise<string> {
  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} ${tag}`,
      slug: `${PREFIX}-${tag}`,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

async function addMember(args: {
  merchantId: string;
  userId: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  digestOptIn: boolean;
}): Promise<void> {
  await prisma.merchantUser.create({
    data: {
      merchantId: args.merchantId,
      userId: args.userId,
      role: args.role,
      digestOptIn: args.digestOptIn,
      ...(args.digestOptIn ? { digestOptInAt: new Date() } : {}),
    },
  });
}

let merchantA = '';
let merchantB = '';
let ownerConsented = '';
let ownerSilent = '';
let managerConsented = '';

beforeAll(async () => {
  merchantA = await makeMerchant('a');
  merchantB = await makeMerchant('b');

  ownerConsented = await makeUser('owner-consented');
  ownerSilent = await makeUser('owner-silent');
  managerConsented = await makeUser('manager-consented');

  await addMember({ merchantId: merchantA, userId: ownerConsented, role: 'OWNER', digestOptIn: true });
  await addMember({ merchantId: merchantA, userId: ownerSilent, role: 'OWNER', digestOptIn: false });
  await addMember({
    merchantId: merchantA,
    userId: managerConsented,
    role: 'MANAGER',
    digestOptIn: true,
  });
});

afterAll(async () => {
  // `Drop.merchant` and `MenuItem.merchant` are not `onDelete: Cascade` in the
  // schema — the relations that carry money are deliberately restrictive. So the
  // teardown removes the children in dependency order rather than asking a merchant
  // delete to do something the schema forbids. Registering the drop ids is not enough
  // on its own: the items must go too.
  if (createdDropIds.length > 0) {
    await prisma.drop.deleteMany({ where: { id: { in: createdDropIds } } });
  }
  if (createdMerchantIds.length > 0) {
    await prisma.menuItem.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
    await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

describe('merchantsForDigest — consenting owners only', () => {
  it('returns one merchant with exactly the owner who consented', async () => {
    const merchants = await merchantsForDigest();
    const found = merchants.find((merchant) => merchant.id === merchantA);

    expect(found).toBeDefined();
    expect(found?.owners.map((owner) => owner.userId)).toEqual([ownerConsented]);
    // The manager consented, but a digest goes to owners. The silent owner is an
    // owner, but did not consent. Neither may appear.
    expect(found?.owners.map((owner) => owner.userId)).not.toContain(managerConsented);
    expect(found?.owners.map((owner) => owner.userId)).not.toContain(ownerSilent);
  });

  it('excludes a merchant whose only owner has not consented', async () => {
    const merchants = await merchantsForDigest();
    expect(merchants.some((merchant) => merchant.id === merchantB)).toBe(false);
  });
});

describe('setDigestConsent', () => {
  it('refuses a manager even when the form was rendered for them', async () => {
    const result = await setDigestConsent({
      merchantId: merchantA,
      userId: managerConsented,
      optIn: false,
    });

    expect(result).toEqual({ ok: false, reason: 'NOT_OWNER' });
    // And it did not write: a refusal that still flips the flag is the bug this
    // assertion exists for.
    const settings = await digestSettingsFor({
      merchantId: merchantA,
      userId: managerConsented,
    });
    expect(settings?.digestOptIn).toBe(true);
  });

  it('refuses a user who is not a member of the merchant', async () => {
    const stranger = await makeUser('stranger');
    const result = await setDigestConsent({ merchantId: merchantA, userId: stranger, optIn: true });
    expect(result).toEqual({ ok: false, reason: 'NOT_A_MEMBER' });
  });

  it('sets and clears the flag, and the timestamp follows it', async () => {
    const settingsBefore = await digestSettingsFor({
      merchantId: merchantA,
      userId: ownerSilent,
    });
    expect(settingsBefore).toMatchObject({ role: 'OWNER', digestOptIn: false, digestOptInAt: null });

    await setDigestConsent({ merchantId: merchantA, userId: ownerSilent, optIn: true });
    const settingsOn = await digestSettingsFor({
      merchantId: merchantA,
      userId: ownerSilent,
    });
    expect(settingsOn?.digestOptIn).toBe(true);
    expect(settingsOn?.digestOptInAt).toBeInstanceOf(Date);

    await setDigestConsent({ merchantId: merchantA, userId: ownerSilent, optIn: false });
    const settingsOff = await digestSettingsFor({
      merchantId: merchantA,
      userId: ownerSilent,
    });
    expect(settingsOff?.digestOptIn).toBe(false);
    // A timestamp that survived withdrawal would record consent that was taken back.
    expect(settingsOff?.digestOptInAt).toBeNull();
  });
});

describe('the delivery record', () => {
  it('is the idempotency key for one owner, one merchant, one week', async () => {
    const weekStart = new Date('2026-10-26T06:00:00.000Z');
    expect(
      await digestAlreadySent({ merchantId: merchantA, userId: ownerConsented, weekStart }),
    ).toBe(false);

    await recordDigestDelivery({
      merchantId: merchantA,
      userId: ownerConsented,
      weekStart,
      providerId: 'email-1',
    });

    expect(
      await digestAlreadySent({ merchantId: merchantA, userId: ownerConsented, weekStart }),
    ).toBe(true);

    // A different week is a different key: next Monday's digest is not suppressed by
    // this one.
    expect(
      await digestAlreadySent({
        merchantId: merchantA,
        userId: ownerConsented,
        weekStart: new Date('2026-11-02T07:00:00.000Z'),
      }),
    ).toBe(false);
  });
});

describe('reportSourcesFor — the week filter', () => {
  function snapshot(): unknown {
    return buildGuardrailSnapshot(
      {
        ...DEFAULT_FEES,
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        floorPctOfMenu: 0.25,
      },
      1112,
      '2026-10-01T00:00:00.000Z',
    );
  }

  async function makeDrop(windowStart: Date): Promise<string> {
    const item = await prisma.menuItem.create({
      data: {
        merchantId: merchantA,
        name: `${PREFIX} bowl`,
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 30,
      },
      select: { id: true },
    });

    const drop = await prisma.drop.create({
      data: {
        merchantId: merchantA,
        menuItemId: item.id,
        publicCode: `${PREFIX}${createdDropIds.length}${Date.now()}`.slice(0, 22).toUpperCase(),
        title: `${PREFIX} drop`,
        dealPriceCents: 1112,
        minQty: 5,
        maxQty: 10,
        cutoffAt: new Date(windowStart.getTime() - 3 * 60 * 60 * 1000),
        windowStart,
        windowEnd: new Date(windowStart.getTime() + 2 * 60 * 60 * 1000),
        status: 'COMPLETED',
        guardrailSnapshot: snapshot() as never,
        publishedAt: new Date(windowStart.getTime() - 48 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    createdDropIds.push(drop.id);
    return drop.id;
  }

  it('includes the start boundary, excludes the end boundary, and never returns a neighbour', async () => {
    const from = new Date('2026-10-26T06:00:00.000Z');
    const to = new Date('2026-11-02T06:00:00.000Z');

    const onStart = await makeDrop(from);
    const inside = await makeDrop(new Date('2026-10-29T23:00:00.000Z'));
    const onEnd = await makeDrop(to);
    const before = await makeDrop(new Date('2026-10-26T05:59:59.000Z'));
    const after = await makeDrop(new Date('2026-11-02T06:00:01.000Z'));

    const { sources } = await reportSourcesFor({ merchantId: merchantA, from, to });
    const ids = sources.map((source) => source.dropId);

    expect(ids).toContain(onStart);
    expect(ids).toContain(inside);
    expect(ids).not.toContain(onEnd);
    expect(ids).not.toContain(before);
    expect(ids).not.toContain(after);
  });
});
