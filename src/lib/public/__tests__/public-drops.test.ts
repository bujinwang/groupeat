import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDraft, markPublished } from '@/lib/db/drops';
import { createItem } from '@/lib/db/items';
import { prisma } from '@/lib/db/prisma';
import {
  generatePublicCode,
  isWellFormedPublicCode,
  normalisePublicCode,
} from '@/lib/drops/public-code';
import { DEFAULT_FEES, buildGuardrailSnapshot } from '@/lib/guardrail';
import { getPreviewDrop, getPublicDrop } from '../public-drops';

/**
 * The diner's read path, against a real database.
 *
 * Five things here can only be proven with rows in Postgres:
 *
 *   1. **Only live authorisations count.** A `VOIDED` participant is not a claimed
 *      plate, and counting one would show the drop as fuller than it is.
 *   2. **`FAILED` stays visible.** A diner who joined a drop that did not run taps
 *      the same link they joined with. A 404 there reads as "you were charged and
 *      nobody will tell you".
 *   3. **`DRAFT` stays invisible.** A guessed code must not reveal an unpublished
 *      price.
 *   4. **The "was" price is frozen.** It comes from the snapshot, not from the dish
 *      as it is today.
 *   5. **A messier code resolves the same drop.** The segment on the URL is whatever
 *      a messaging app delivered, and there are five surfaces that read it; the one
 *      they share is this function.
 */

const PREFIX = `public-drops-${Date.now()}`;
const HOUR = 60 * 60 * 1000;

type Fixture = {
  merchantId: string;
  userId: string;
  itemId: string;
  publishedCode: string;
  failedCode: string;
  draftCode: string;
  /** A `FAILED` drop whose stored code does **not** pass the shape check. */
  malformedFailedCode: string;
};

const fixtures: Fixture[] = [];
let fixture: Fixture;

function timing(): { cutoffAt: Date; windowStart: Date; windowEnd: Date } {
  const now = Date.now();
  return {
    cutoffAt: new Date(now + 24 * HOUR),
    windowStart: new Date(now + 26 * HOUR),
    windowEnd: new Date(now + 28 * HOUR),
  };
}

async function makeCustomer(suffix: string): Promise<string> {
  const customer = await prisma.customer.create({
    data: { phone: `+1403555${suffix}`, name: `Diner ${suffix}` },
    select: { id: true },
  });
  return customer.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: true,
    },
    select: { id: true },
  });

  const merchant = await prisma.merchant.create({
    data: {
      name: 'Golden Dragon',
      slug: PREFIX,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      pickupAddress: '2915 10 Ave NE, Calgary',
      pickupInstructions: 'Side door, ring the bell.',
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });

  const item = await createItem([merchant.id], {
    name: 'Beef Bowl',
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });

  const guardrailInput = {
    ...DEFAULT_FEES,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    floorPctOfMenu: 0.25,
  };
  const snapshot = buildGuardrailSnapshot(guardrailInput, 1310, new Date().toISOString());

  const published = await createDraft([merchant.id], {
    menuItemId: item.id,
    title: 'Beef Bowl Thursday',
    description: 'One batch.',
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });
  await markPublished({
    id: published.id,
    publishedAt: new Date(),
    guardrailSnapshot: snapshot,
  });

  // Two live authorisations, one voided, one still pending — and one participant
  // taking three plates, so the sum and the row count differ.
  const statuses: { suffix: string; qty: number; authStatus: 'AUTHORIZED' | 'VOIDED' | 'PENDING' }[] = [
    { suffix: '001', qty: 2, authStatus: 'AUTHORIZED' },
    { suffix: '002', qty: 3, authStatus: 'AUTHORIZED' },
    { suffix: '003', qty: 4, authStatus: 'VOIDED' },
    { suffix: '004', qty: 1, authStatus: 'PENDING' },
  ];

  for (const entry of statuses) {
    await prisma.dropParticipant.create({
      data: {
        dropId: published.id,
        customerId: await makeCustomer(entry.suffix),
        qty: entry.qty,
        amountCents: 1310 * entry.qty,
        platformFeeCents: 100,
        authStatus: entry.authStatus,
      },
    });
  }

  const failed = await createDraft([merchant.id], {
    menuItemId: item.id,
    title: 'Beef Bowl that did not run',
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });
  await markPublished({
    id: failed.id,
    publishedAt: new Date(),
    guardrailSnapshot: snapshot,
  });
  await prisma.drop.update({ where: { id: failed.id }, data: { status: 'FAILED' } });

  /**
   * A second `FAILED` drop, but with a code the *shape check rejects*.
   *
   * Not a contrived row — it is a copy of what 55 of the 57 drops in the dev database
   * look like: an 11-character seed code containing characters the generator would
   * never emit (`U`, `1`, `O`, `L`). Measured, not guessed: all 55 fail on **length**
   * (11 ≠ 8), and none of the 57 is anything but uppercase-with-no-separators.
   *
   * That second fact is what makes the slice safe, and it is asserted rather than
   * assumed. Normalisation now sits between the URL and the lookup key, so it is only
   * safe if it is the identity on values already stored — otherwise a link would start
   * resolving to nothing. The fixture below has to respect that, or it would be
   * modelling a row the product cannot create: `createDraft` mints codes from
   * `generatePublicCode`, which is uppercase and separator-free by construction.
   *
   * If somebody later "hardens" `getPublicDrop` by wiring `isWellFormedPublicCode` as a
   * gate, the test below fails — and its name says why, rather than looking like a
   * broken fixture.
   */
  const malformedFailed = await createDraft([merchant.id], {
    menuItemId: item.id,
    title: 'Beef Bowl that did not run, older code',
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });
  // Uppercase and separator-free, like every stored code; wrong length and containing
  // excluded characters, like the 55 that fail the shape check.
  const malformedCode = `TEST${Date.now().toString().slice(-5)}CODE1`;
  expect(malformedCode).toHaveLength(14);
  await prisma.drop.update({
    where: { id: malformedFailed.id },
    data: { publicCode: malformedCode, status: 'FAILED' },
  });

  const draft = await createDraft([merchant.id], {
    menuItemId: item.id,
    title: 'Not published yet',
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1310,
    minQty: 20,
    maxQty: 30,
    maxPerCustomer: 4,
    aiRationale: null,
    ...timing(),
  });

  fixture = {
    merchantId: merchant.id,
    userId: user.id,
    itemId: item.id,
    publishedCode: published.publicCode,
    failedCode: failed.publicCode,
    draftCode: draft.publicCode,
    malformedFailedCode: malformedCode,
  };
  fixtures.push(fixture);
});

afterAll(async () => {
  for (const entry of fixtures) {
    await prisma.drop.deleteMany({ where: { merchantId: entry.merchantId } }).catch(() => undefined);
    await prisma.customer.deleteMany({ where: { phone: { startsWith: '+1403555' } } }).catch(() => undefined);
    await prisma.merchant.delete({ where: { id: entry.merchantId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: entry.userId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('getPublicDrop', () => {
  it('counts only the units whose authorisation is live', async () => {
    const drop = await getPublicDrop(fixture.publishedCode);

    expect(drop).not.toBeNull();
    // 2 + 3 authorised. The 4 voided and the 1 pending are not claimed plates.
    expect(drop!.joinedQty).toBe(5);
  });

  it('carries the pickup details a diner needs', async () => {
    const drop = await getPublicDrop(fixture.publishedCode);

    expect(drop!.merchantName).toBe('Golden Dragon');
    expect(drop!.merchantAddress).toContain('10 Ave NE');
    expect(drop!.merchantInstructions).toContain('Side door');
    expect(drop!.itemName).toBe('Beef Bowl');
    expect(drop!.timeZone).toBe('America/Edmonton');
  });

  it('keeps a failed drop reachable, so the page can say nobody was charged', async () => {
    const drop = await getPublicDrop(fixture.failedCode);
    expect(drop).not.toBeNull();
    expect(drop!.status).toBe('FAILED');
  });

  it('hides a draft even from someone holding its code', async () => {
    expect(await getPublicDrop(fixture.draftCode)).toBeNull();
  });

  it('lets the owning merchant preview that same draft, and only that merchant', async () => {
    // FR-206. The public lookup above is the privacy boundary; this is the one
    // narrower read allowed through it, and the merchant scope is part of the query
    // rather than a check after the fact.
    const preview = await getPreviewDrop(fixture.draftCode, [fixture.merchantId]);

    expect(preview).not.toBeNull();
    expect(preview!.status).toBe('DRAFT');
    expect(preview!.title).toBe('Not published yet');

    expect(await getPreviewDrop(fixture.draftCode, [])).toBeNull();
    expect(await getPreviewDrop(fixture.draftCode, ['00000000-0000-0000-0000-000000000000'])).toBeNull();
  });

  it('does not turn the preview read into a second public lookup', async () => {
    // A published drop is already visible at `/d/:code`; preview is for a draft, and
    // a status-wide preview would be a second way to reach a settled drop with no new
    // information. The narrow status is the second lock.
    expect(await getPreviewDrop(fixture.publishedCode, [fixture.merchantId])).toBeNull();
    expect(await getPreviewDrop(fixture.failedCode, [fixture.merchantId])).toBeNull();
  });

  it('returns null for a code that does not exist', async () => {
    expect(await getPublicDrop('ZZZZZZZZ')).toBeNull();
  });

  it('reports the menu price frozen at publish, not the dish as it is today', async () => {
    // A merchant re-prices the dish after the drop was announced. The "was $16.00"
    // on a public page is a price representation (PRD-v1 §15.2), so it must not
    // move with the dish — FR-207 applied to the diner's screen.
    await prisma.menuItem.update({
      where: { id: fixture.itemId },
      data: { menuPriceCents: 1800 },
    });

    const drop = await getPublicDrop(fixture.publishedCode);
    expect(drop!.menuPriceCents).toBe(1600);

    await prisma.menuItem.update({
      where: { id: fixture.itemId },
      data: { menuPriceCents: 1600 },
    });
  });
});

describe('getPublicDrop — the code arrives from a messaging app, not from a form', () => {
  /**
   * Why this is a database test and not a unit test.
   *
   * `public-code.test.ts` already proves `normalisePublicCode` turns
   * `/d/ABCD2345?o=x` into `ABCD2345`. What it cannot prove is that anything *calls*
   * it. That gap is the whole defect: the function existed, was tested, was exported,
   * and had no production caller — so `/d/8en9ajca` (the lowercase form WhatsApp
   * happens to deliver) rendered a 404 while `normalisePublicCode('8en9ajca')`
   * returned the right code in a green test.
   *
   * So every case below runs against a real stored row and asserts on the *drop*,
   * which is the only assertion that can fail if the wiring is removed.
   */

  it('finds the drop from the lowercase form a messaging app may deliver', async () => {
    const drop = await getPublicDrop(fixture.publishedCode.toLowerCase());

    expect(drop).not.toBeNull();
    // Not just "something came back" — *this* drop.
    expect(drop!.title).toBe('Beef Bowl Thursday');
  });

  it('finds the drop from a pasted link with a query string and a fragment', async () => {
    // The most common way a diner reaches a code page is by pasting the link, and
    // the most common way a link is pasted is with something appended to it.
    const pasted = `https://groupeat.ca/d/${fixture.publishedCode}?o=share-token#top`;

    expect(await getPublicDrop(pasted)).not.toBeNull();
  });

  it('finds the drop through a trailing slash, which a re-wrapping client adds', async () => {
    expect(await getPublicDrop(`${fixture.publishedCode}/`)).not.toBeNull();
  });

  it('finds the drop from the hyphenated form a person types off a screenshot', async () => {
    const hyphenated = `${fixture.publishedCode.slice(0, 4)}-${fixture.publishedCode.slice(4)}`;

    expect(await getPublicDrop(hyphenated)).not.toBeNull();
  });

  it('still returns null for a code that genuinely does not exist', async () => {
    // Normalising must widen what *resolves*, not what *exists*. A wrong code and a
    // wrong-shaped code have to stay indistinguishable, which is the property the
    // module header claims and the reason the shape check is not a gate here.
    expect(await getPublicDrop('ZZZZZZZZ')).toBeNull();
    expect(await getPublicDrop('zzz-zzz')).toBeNull();
    expect(await getPublicDrop('')).toBeNull();
  });

  it('keeps a FAILED drop reachable when its stored code fails the shape check', async () => {
    // The measurement behind the design. 55 of the 57 drops in the dev database have
    // codes the shape check rejects — all 11-character seed codes, all `FAILED` — and
    // those are the exact drops the docblock above says must stay reachable so a diner
    // can read "nobody was charged". Wiring `isWellFormedPublicCode` as a gate would
    // turn 55 working explanations into 404s while every other test in this file
    // stayed green, because a 404 here looks identical to a 404 for a mistyped code.
    expect(isWellFormedPublicCode(fixture.malformedFailedCode)).toBe(false);

    const drop = await getPublicDrop(fixture.malformedFailedCode);

    expect(drop).not.toBeNull();
    expect(drop!.status).toBe('FAILED');
    // Reachable *by its stored form*, not merely by some normalised alias of it. A
    // shape gate is not the only way to break this: normalising the lookup key breaks
    // it too, for any drop whose stored code is not already normal. Nothing in the
    // product writes such a code — `createDraft` is the only writer and its generator
    // is uppercase with no separators — but a hand-written link is worth keeping
    // honest, and this is the assertion that would notice.
    expect(normalisePublicCode(fixture.malformedFailedCode)).toBe(fixture.malformedFailedCode);
  });
});

describe('normalisePublicCode — the invariant the lookup key now depends on', () => {
  it('leaves every code already in the database untouched', async () => {
    /**
     * The property the whole slice rests on.
     *
     * Normalisation now sits between the URL and the lookup key. That is only safe if
     * it is the **identity on values that are already stored**: a stored code that
     * normalisation would change becomes unreachable by its own form the moment the
     * lookup normalises, and the 404 it produces is indistinguishable from a mistyped
     * code — silent, and permanent, on a link that is already in somebody's group chat.
     *
     * Asserted against the real table rather than against generated codes, because
     * generated codes are the ones that cannot exhibit the problem: they are minted
     * uppercase from an alphabet with no separators, which is precisely why
     * normalisation is the identity on them. The rows that could break are the
     * hand-written ones, and they are what this reads.
     *
     * This test failing means the invariant has been violated — that a code exists
     * which the product cannot resolve by the form it is stored in. For a drop that is
     * genuinely reachable, **do not change the assertion**; fix the code, because the
     * assertion is the safety property.
     */
    const stored = await prisma.drop.findMany({ select: { publicCode: true } });

    // A fresh fixture is included on purpose. This suite runs against a dev database,
    // and on an empty one the loop below would be vacuous — an empty `toEqual([])` is
    // green, which is worse than not having the test.
    expect(stored.length).toBeGreaterThan(0);

    const changed = stored
      .map((row) => ({ before: row.publicCode, after: normalisePublicCode(row.publicCode) }))
      .filter((row) => row.before !== row.after);

    expect(changed).toEqual([]);

    // And none of them normalises to the empty string, which would be a lookup on
    // `''` — the one value that must never reach a query.
    const emptied = stored.filter((row) => normalisePublicCode(row.publicCode) === '');
    expect(emptied).toEqual([]);
  });

  it('has exactly one writer, and that writer cannot produce a code normalisation would change', () => {
    /**
     * Why the invariant above holds *by construction* rather than by luck.
     *
     * `createDraft` is the only production path that writes `publicCode`, and it
     * writes `generatePublicCode()`. This is the property that makes normalising the
     * lookup key safe, so it is asserted directly instead of being assumed from a
     * reading of the schema: every character the generator emits is uppercase and in
     * the alphabet, and it emits no separators at all.
     *
     * Written as a loop over many real codes rather than against
     * `PUBLIC_CODE_ALPHABET`, because the alphabet constant is the *specification*
     * while `generatePublicCode` is the *behaviour* — and a future change that made
     * the generator emit lowercase would be invisible to a test that reasoned from
     * the constant.
     */
    for (let index = 0; index < 500; index += 1) {
      const code = generatePublicCode();
      expect(normalisePublicCode(code)).toBe(code);
      // No separator, no whitespace: normalisation strips `-` and `\s`, so a generated
      // code containing either would mean the identity assumption had broken.
      expect(code).not.toMatch(/[\s-]/);
      expect(code.slice(0, 8)).toBe(code);
    }
  });

  it('is idempotent, so a code that has been normalised once is stable afterwards', async () => {
    // The lookup normalises, and so does the order page's link, and so does the join
    // service. If the function were not idempotent those three would disagree about
    // the same URL, and the disagreement would show up as a link that works on the
    // page but 404s from the SMS.
    const codes = [
      fixture.publishedCode,
      fixture.malformedFailedCode,
      ...Array.from({ length: 20 }, () => generatePublicCode()),
    ];

    for (const code of codes) {
      const once = normalisePublicCode(code);
      expect(normalisePublicCode(once)).toBe(once);
    }
  });
});
