import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import {
  createMerchantWithOwner,
  primaryMerchantFloor,
  getFloor,
  slugify,
  toPct,
  updateFloor,
} from '@/lib/db/merchants';
import { DEFAULT_FLOOR_PCT, minViablePrice } from '@/lib/guardrail';
import type { GuardrailInput } from '@/lib/guardrail';

/**
 * The `Decimal` boundary — the single largest technical risk in the sprint
 * (ARCHITECTURE-sprint1 §3.5, and the lead's call-out).
 *
 * `Merchant.floorPctOfMenu` is `@db.Decimal(5,2)`, so Prisma returns a `Decimal`
 * **object**. Fed straight into the guardrail, every `>=` comparison is `false`,
 * `minViablePrice()` returns `null` for every dish, and every item silently
 * renders INFEASIBLE — which looks like a product judgement rather than a bug.
 *
 * These tests pin the two things that prevent it: the conversion is exact, and a
 * floor that went through the database still reproduces vector A.
 *
 * The second half of the file covers `createMerchantWithOwner`, which had no
 * tests at all — see the block comment above that suite for why a docblock that
 * over-promises attracts none.
 */

const SLUG_PREFIX = 'test-decimal-';
let merchantId: string;

/**
 * Creation fixtures, kept separate from `merchantId` so the Decimal suite's
 * single-row assumption cannot be disturbed by anything below.
 */
const MCH_PREFIX = `mch${Date.now()}`;
const createdMerchantIds: string[] = [];
const createdUserIds: string[] = [];

function uniqueEmail(tag: string): string {
  return `${MCH_PREFIX}-${tag}@example.test`;
}

async function createMerchant(args: { tag: string; name?: string; ownerName?: string | null }) {
  const created = await createMerchantWithOwner({
    name: args.name ?? `Merchant ${args.tag}`,
    pickupAddress: '123 Test Street',
    pickupInstructions: 'Ring the bell',
    ownerEmail: uniqueEmail(args.tag),
    ownerName: args.ownerName ?? null,
    ownerPasswordHash: 'not-a-real-hash',
  });
  createdMerchantIds.push(created.merchantId);
  createdUserIds.push(created.ownerId);
  return created;
}

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: {
      name: 'Decimal Boundary Test',
      slug: `${SLUG_PREFIX}${Date.now()}`,
      status: 'PENDING',
      floorPctOfMenu: DEFAULT_FLOOR_PCT,
    },
    select: { id: true },
  });
  merchantId = merchant.id;
});

afterAll(async () => {
  if (merchantId) {
    await prisma.merchant.delete({ where: { id: merchantId } });
  }
  if (createdMerchantIds.length > 0) {
    await prisma.merchant
      .deleteMany({ where: { id: { in: createdMerchantIds } } })
      .catch(() => undefined);
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('toPct · the Decimal → number boundary', () => {
  it('round-trips 0.25 exactly, with no floating-point drift', async () => {
    await updateFloor(merchantId, 0.25);
    const floor = await getFloor(merchantId);

    // Strict equality: 0.25000000000000006 would fail here, and that is the point.
    expect(floor).toBe(0.25);
    expect(Object.is(floor, 0.25)).toBe(true);
    expect(typeof floor).toBe('number');
  });

  it('reads back what the database stores, not what Prisma hands over', async () => {
    const row = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { floorPctOfMenu: true },
    });

    // The raw value is a Decimal object, and comparing it to a number is the bug.
    expect(typeof row.floorPctOfMenu).toBe('object');
    expect(toPct(row.floorPctOfMenu)).toBe(0.25);
  });

  it('accepts every value the column can hold', async () => {
    for (const pct of [0.15, 0.2, 0.25, 0.3, 0.33, 0.5, 1]) {
      await updateFloor(merchantId, pct);
      expect(await getFloor(merchantId)).toBe(pct);
    }
    await updateFloor(merchantId, 0.25);
  });

  it('rejects a value outside (0, 1] loudly rather than silently', () => {
    expect(() => toPct(0)).toThrow();
    expect(() => toPct(1.5)).toThrow();
    expect(() => toPct(-0.25)).toThrow();
    expect(() => toPct(Number.NaN)).toThrow();
  });

  it('refuses to write an out-of-range floor', async () => {
    await expect(updateFloor(merchantId, 0)).rejects.toThrow();
    await expect(updateFloor(merchantId, 1.2)).rejects.toThrow();
  });
});

describe('the floor that came out of the database still produces vector A', () => {
  it('minViablePrice === 1112 for a $16.00 / $4.80 / $0.80 dish at 25%', async () => {
    await updateFloor(merchantId, 0.25);
    const floorPctOfMenu = await getFloor(merchantId);

    const input: GuardrailInput = {
      platformFeePct: 0.08,
      platformFeeFloorCents: 60,
      platformFeeCapCents: 200,
      stripePct: 0.029,
      stripeFixedCents: 30,
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      floorPctOfMenu,
    };

    expect(minViablePrice(input)).toBe(1112);
  });

  it('primaryMerchantFloor returns a number, not a Decimal', async () => {
    const result = await primaryMerchantFloor([merchantId]);

    expect(result.merchantId).toBe(merchantId);
    expect(typeof result.floorPctOfMenu).toBe('number');
    expect(result.floorPctOfMenu).toBe(0.25);
  });
});

/**
 * US-A1 — creating a merchant creates the establishment, its owner and the link
 * between them, or it creates nothing.
 *
 * ## What these tests protect
 *
 *   1. **The account is not orphaned.** The function's docblock claimed one
 *      transaction across three rows while the body made two statements. A failure
 *      between them left a `MERCHANT` account attached to no merchant: it passes the
 *      password check, passes the role check, and then has nowhere to go. This suite
 *      forces a genuine database error *after* the owner insert and asserts the
 *      account is gone.
 *   2. **The three rows really are three rows.** Owner role, `mustChangePassword`,
 *      `PENDING` status and the 25% floor are all part of "onboarded", and asserting
 *      only that the call resolved is the mistake this milestone keeps finding.
 *   3. **The slug is allocated, not assumed.** `Merchant.slug` is `@unique`, so a
 *      second merchant trading under the same name must get a different slug rather
 *      than an error the operator cannot act on from the form.
 *
 * ## Why there was no such suite before
 *
 * Gap 15 was recorded as a docblock that over-promised, and a docblock that
 * over-promises attracts no tests: nothing in the code reads as wrong, so nobody
 * looks. The suite is as much the fix as the `$transaction` is.
 */
describe('createMerchantWithOwner', () => {
  it('creates the merchant, the owner account and the OWNER link together', async () => {
    const created = await createMerchant({
      tag: 'happy',
      name: 'Happy Kitchen',
      ownerName: 'Dana Owner',
    });

    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: created.merchantId },
      select: {
        name: true,
        slug: true,
        status: true,
        floorPctOfMenu: true,
        pickupAddress: true,
        users: { select: { userId: true, role: true } },
      },
    });

    expect(merchant.name).toBe('Happy Kitchen');
    expect(merchant.slug).toBe(slugify('Happy Kitchen'));
    // Nothing is live until an admin has looked at it.
    expect(merchant.status).toBe('PENDING');
    // The `Decimal` boundary again: 0.25, not a Decimal-like object.
    expect(Number(merchant.floorPctOfMenu)).toBe(0.25);
    expect(merchant.pickupAddress).toBe('123 Test Street');

    // The link is the row that makes the merchant reachable at all.
    expect(merchant.users).toHaveLength(1);
    expect(merchant.users[0]?.userId).toBe(created.ownerId);
    expect(merchant.users[0]?.role).toBe('OWNER');

    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: created.ownerId },
      select: { email: true, role: true, mustChangePassword: true, name: true },
    });

    expect(owner.role).toBe('MERCHANT');
    expect(owner.email).toBe(uniqueEmail('happy'));
    // Every V1 account is bootstrapped with a temporary password.
    expect(owner.mustChangePassword).toBe(true);
    expect(owner.name).toBe('Dana Owner');
  });

  it('leaves no account behind when the merchant insert fails', async () => {
    // The transaction is the entire guarantee and the happy path cannot see it.
    //
    // The failure is a real Postgres rejection, not a mock: a NUL byte is not valid
    // in a UTF-8 `TEXT` column, so the `Merchant` insert raises SQLSTATE 22021
    // after the owner `User` insert has already succeeded inside the transaction.
    // That is precisely the sequence gap 15 described — a constraint failure
    // between the two writes.
    //
    // A spy on `prisma.merchant.create` would not do it: the transaction hands the
    // callback its own `tx` client, so the spy never fires and the test passes for
    // the wrong reason. That exact mistake was made once in `organisers.test.ts`.
    const email = uniqueEmail('rollback');

    await expect(
      createMerchantWithOwner({
        name: 'Bad\u0000Name',
        pickupAddress: null,
        pickupInstructions: null,
        ownerEmail: email,
        ownerName: 'Should Not Survive',
        ownerPasswordHash: 'not-a-real-hash',
      }),
    ).rejects.toThrow();

    // Zero, not one. A `MERCHANT` account with no merchant and no `MerchantUser`
    // row is the orphan this test exists for: it signs in and finds nothing.
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    // The merchant is checked by slug rather than by name: the NUL byte cannot be
    // sent in a `WHERE` literal either (Postgres rejects the query string for the
    // same encoding reason), and `slugify` strips it, so the slug is the value a
    // surviving merchant would actually be findable under.
    expect(await prisma.merchant.count({ where: { slug: 'bad-name' } })).toBe(0);
  });

  it('does not leave the owner behind when the slug read has to retry', async () => {
    // `uniqueSlug` retries against a `@unique` column. The retry happens inside the
    // same transaction as the inserts, so the owner row created for attempt N must
    // not survive an attempt that is abandoned. This is the concurrency half of the
    // same guarantee, asserted through the observable state rather than a mock.
    const first = await createMerchant({ tag: 'slug-a', name: 'Twin Peaks Diner' });
    const second = await createMerchant({ tag: 'slug-b', name: 'Twin Peaks Diner' });

    expect(first.slug).toBe('twin-peaks-diner');
    expect(second.slug).not.toBe(first.slug);
    expect(second.slug.startsWith('twin-peaks-diner')).toBe(true);

    // Two merchants, two owners, two links — no extra rows from the retry.
    for (const created of [first, second]) {
      const links = await prisma.merchantUser.count({ where: { merchantId: created.merchantId } });
      expect(links).toBe(1);
    }
  });

  it('refuses a duplicate owner email and leaves the first merchant untouched', async () => {
    const first = await createMerchant({ tag: 'dupe', name: `Dupe One ${MCH_PREFIX}` });

    await expect(
      createMerchantWithOwner({
        name: `Dupe Two ${MCH_PREFIX}`,
        pickupAddress: null,
        pickupInstructions: null,
        ownerEmail: uniqueEmail('dupe'),
        ownerName: null,
        ownerPasswordHash: 'not-a-real-hash',
      }),
    ).rejects.toThrow();

    const survivors = await prisma.merchant.findMany({
      where: { name: `Dupe One ${MCH_PREFIX}` },
      select: { id: true, users: { select: { userId: true } } },
    });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(first.merchantId);
    expect(survivors[0]?.users[0]?.userId).toBe(first.ownerId);

    // And the failed attempt created no merchant at all.
    expect(await prisma.merchant.count({ where: { name: `Dupe Two ${MCH_PREFIX}` } })).toBe(0);
  });
});

describe('slugify', () => {
  it('produces a lowercase slug, and folds accents rather than splitting them', () => {
    expect(slugify('Happy Kitchen')).toBe('happy-kitchen');
    // `Déjà` used to become `de-ja`: NFKD splits `é` into `e` + a combining mark,
    // and replacing "not a-z0-9" with `-` split the word in two. A share link with
    // a hole in the merchant's name is the visible symptom.
    expect(slugify('  Café  Déjà Vu!  ')).toBe('cafe-deja-vu');
  });

  it('collapses punctuation instead of emitting it', () => {
    expect(slugify('Bob & Sons / Deli')).toBe('bob-sons-deli');
  });

  it('pads a name too short to be a slug, because 3 characters is the floor', () => {
    expect(slugify('A')).toBe('merchant-a');
    expect(slugify('')).toBe('merchant');
  });

  it('never ends in a hyphen, even when the name has nothing slug-worthy in it', () => {
    // `merchant-` was the old result: a trailing hyphen, and a value that changed
    // if the same name were slugified again.
    expect(slugify('---')).toBe('merchant');
    for (const name of ['---', '!!!', '···', 'A', 'a b']) {
      expect(slugify(name)).not.toMatch(/-$/);
      expect(slugify(name)).not.toMatch(/^-/);
    }
  });

  it('never exceeds 40 characters, because the column is the contract', () => {
    expect(slugify('a'.repeat(80)).length).toBe(40);
  });
});
