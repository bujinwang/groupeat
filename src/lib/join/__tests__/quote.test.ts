import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

import { fakeJoinPaymentPort } from '../fake-payment-port';
import { quoteJoin } from '../quote';
import { joinDrop } from '../service';

/**
 * The quote the Payment Element renders, against real Postgres.
 *
 * ## The assertion this file exists for
 *
 * `quoteJoin` and `joinDrop` are two functions that must produce **one number**. The
 * page shows the diner `amountCents` from the quote and the card is authorised for
 * `amountCents` from the join, and if they ever disagree the diner is shown one
 * price and charged another. That is the single worst bug this flow can have, and it
 * is invisible to both functions' own tests.
 *
 * So the central test quotes a quantity, joins at that quantity, and asserts the two
 * figures are equal — reading the join's figure from the participant row rather than
 * from the return value, because the row is what settlement will act on.
 *
 * ## Why the quote must not write
 *
 * `PENDING` counts toward capacity so that a drop cannot oversell. If quoting created
 * a `PENDING` row, every abandoned page view would consume a plate and drops would
 * close out from under real diners. Two tests hold that line: a quote creates no rows,
 * and a quote does not change the next quote's answer.
 */

const PREFIX = `qm${Date.now().toString(36).slice(-6)}`;

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;

/**
 * The phone numbers this file issues, recorded as they are issued.
 *
 * Added because the teardown below deleted `ConsentRecord` rows by prefix and **never
 * touched `Customer` at all**, leaving four customers per run (`+17805557001`, `002`,
 * `011`, `012`). The leak was invisible for as long as it was because the residue gate
 * compared counts around a run that started from a database already holding them: four
 * rows created every run and deleted never is a delta of zero, which the gate reported
 * as `no residue`. Measured from a wiped database, the suite leaked 27 customers across
 * four files: 16 in `threshold-notify-wiring`, 4 here, 4 in `attribution` and 3 in
 * `order-link`. (`funnel-wiring` and `confirmation-wiring` were part of the same defect
 * and were fixed earlier, which is why the count is 27 and not 46.)
 *
 * A set cannot drift from itself, so the builder writes here and the teardown reads
 * here — the same mechanism as `join/__tests__/service.test.ts`.
 */
const issuedPhones = new Set<string>();

/** What `normalisePhone()` prepends to a ten-digit North American number. */
const E164_COUNTRY_PREFIX = '+1';

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant('acct_test_quote');
  itemId = await fixtures.item(merchantId);
});

afterAll(async () => {
  // Every step attempted, and the run still fails if any did. The previous version
  // ended `.catch(() => undefined)` on the only statement that could fail, which is how
  // a teardown that never deleted `Customer` kept passing review.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // `ConsentRecord` has no foreign key to anything, so nothing cascades to it.
  await step(() =>
    prisma.consentRecord.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  // The fixtures next: this removes the drops and cascades to the participants, and
  // `DropParticipant.customer` has no `onDelete` so it defaults to Restrict.
  await step(() => fixtures.cleanup());

  // Then the customers, which `fixtures.cleanup()` does NOT reach: it only deletes
  // customers whose ids it minted itself through `fixtures.participant()`. Every diner
  // here is created by `joinDrop` under test via `tx.customer.upsert`, which the
  // fixtures never see.
  await step(() =>
    prisma.customer.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `teardown left the database dirty (${failures.length} step(s) failed)`,
    );
  }
});

async function publishedDrop(
  overrides: {
    minQty?: number;
    maxQty?: number;
    dealPriceCents?: number;
  } = {},
): Promise<{ id: string; publicCode: string; dealPriceCents: number }> {
  const dealPriceCents = overrides.dealPriceCents ?? 1112;

  const id = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents,
    minQty: overrides.minQty ?? 4,
    maxQty: overrides.maxQty ?? 10,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
    windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });

  const row = await prisma.drop.findUniqueOrThrow({
    where: { id },
    select: { publicCode: true },
  });

  return { id, publicCode: row.publicCode, dealPriceCents };
}

/**
 * `+17805557` is this file's block. `+17805550` is `join/service`'s, `+17805556` is
 * `funnel-wiring`'s, `+17805558` is `confirmation-wiring`'s, `+17805559` is
 * `attribution`/`threshold-notify`'s, `+17805571` is `order-link`'s and `+17805580` is
 * the join route's. Adding a file? Grep for a free block before choosing one, and
 * record it here.
 */
function phone(seq: number): string {
  const national = `7805557${String(seq).padStart(3, '0')}`;
  // Recorded in the form the database stores, at the moment of issue, so the teardown
  // deletes exactly what this run created and nothing a neighbour owns.
  issuedPhones.add(`${E164_COUNTRY_PREFIX}${national}`);
  return national;
}

describe('quoteJoin — the amount the Element shows', () => {
  it('quotes qty × price, and the same cents the join will authorise', async () => {
    const drop = await publishedDrop({ dealPriceCents: 1112, maxQty: 10 });

    const quoted = await quoteJoin({ publicCode: drop.publicCode, qty: 2 });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;

    // 2 × 1112 — a literal, not a recomputation by the code under test.
    expect(quoted.quote.amountCents).toBe(2224);
    expect(quoted.quote.amountLabel).toBe('$22.24');
    expect(quoted.quote.unitPriceCents).toBe(1112);

    // Now join at the same quantity and read the row settlement will use.
    const port = fakeJoinPaymentPort();
    const joined = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(1), qty: 2 },
      { paymentPort: port },
    );
    expect(joined.ok).toBe(true);

    const row = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: drop.id },
      select: { amountCents: true, platformFeeCents: true, qty: true },
    });

    // The whole point: the quote and the hold agree, to the cent.
    expect(row.amountCents).toBe(quoted.quote.amountCents);
    expect(row.platformFeeCents).toBe(quoted.quote.platformFeeCents);
    expect(row.qty).toBe(quoted.quote.qty);
  });

  it('agrees with the join at a price where per-unit rounding matters', async () => {
    // 1310 is the PRD's $13.10 in cents. The fee is rounded per unit and then
    // multiplied (ADR-004 §4), so a qty of 3 is where a round-after-multiply
    // implementation drifts by a cent. If the two paths ever used different orderings
    // this is the test that would notice.
    const drop = await publishedDrop({ dealPriceCents: 1310, maxQty: 10 });

    const quoted = await quoteJoin({ publicCode: drop.publicCode, qty: 3 });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;

    const port = fakeJoinPaymentPort();
    await joinDrop({ publicCode: drop.publicCode, phone: phone(2), qty: 3 }, { paymentPort: port });

    const row = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: drop.id },
      select: { amountCents: true, platformFeeCents: true },
    });

    expect(quoted.quote.amountCents).toBe(3 * 1310);
    expect(row.platformFeeCents).toBe(quoted.quote.platformFeeCents);
  });

  it('creates no participant row and no customer row', async () => {
    const drop = await publishedDrop();
    const before = await prisma.dropParticipant.count({ where: { dropId: drop.id } });
    const customersBefore = await prisma.customer.count();

    const quoted = await quoteJoin({ publicCode: drop.publicCode, qty: 1 });
    expect(quoted.ok).toBe(true);

    // Abandoned quotes must not consume plates: `PENDING` counts toward capacity, so a
    // row here would let a page view close a drop.
    expect(await prisma.dropParticipant.count({ where: { dropId: drop.id } })).toBe(before);
    // And no personal data is created before the diner decides to order.
    expect(await prisma.customer.count()).toBe(customersBefore);
  });

  it('gives the same answer twice, so a re-render is not a new price', async () => {
    const drop = await publishedDrop();
    const first = await quoteJoin({ publicCode: drop.publicCode, qty: 2 });
    const second = await quoteJoin({ publicCode: drop.publicCode, qty: 2 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.quote.amountCents).toBe(first.quote.amountCents);
    expect(second.quote.platformFeeCents).toBe(first.quote.platformFeeCents);
  });
});

describe('quoteJoin — the code arrives from a URL, not from a form', () => {
  /**
   * The quote is the *first* request the browser makes for a drop, so it is the one a
   * diner hits first if normalisation is missing anywhere.
   *
   * It is also the milder half of the pair: a missing normalisation here shows up as
   * `NOT_FOUND` on the Payment Element, which at least fails visibly. The join is the
   * dangerous one, because its `FOR UPDATE` fails the same way *after* the page has
   * already told the diner the offer is real.
   */
  it('quotes from the lowercase form a messaging app may deliver', async () => {
    const drop = await publishedDrop({ dealPriceCents: 1112, maxQty: 10 });
    expect(drop.publicCode.toLowerCase()).not.toBe(drop.publicCode);

    const quoted = await quoteJoin({ publicCode: drop.publicCode.toLowerCase(), qty: 2 });

    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.quote.amountCents).toBe(2224);
  });

  it('quotes from a pasted link, query string and all', async () => {
    const drop = await publishedDrop({ dealPriceCents: 1112, maxQty: 10 });
    const pasted = `https://groupeat.ca/d/${drop.publicCode}?o=share-token`;

    const quoted = await quoteJoin({ publicCode: pasted, qty: 1 });

    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.quote.amountCents).toBe(1112);
  });

  it('still refuses a code that is not a drop, so normalising invents nothing', async () => {
    const quoted = await quoteJoin({ publicCode: 'ZZZZZZZZ', qty: 1 });

    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.reason).toBe('NOT_FOUND');
  });
});

describe('quoteJoin — refusals', () => {
  it('answers 404 for an unknown code, indistinguishable from a draft', async () => {
    const quoted = await quoteJoin({ publicCode: `nope-${PREFIX}`, qty: 1 });
    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.reason).toBe('NOT_FOUND');
    expect(quoted.status).toBe(404);
  });

  it('refuses a quantity past the per-person cap', async () => {
    const drop = await publishedDrop();
    // The fixture sets `maxPerCustomer: 4`; ask for more.
    const quoted = await quoteJoin({ publicCode: drop.publicCode, qty: 99 });
    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.reason).toBe('BAD_QTY');
    expect(quoted.status).toBe(422);
  });

  it('refuses when the drop is full', async () => {
    // A 1-plate drop, taken. `maxQty: 1` also caps the per-person limit.
    const drop = await publishedDrop({ maxQty: 1, minQty: 1 });
    await joinDrop(
      { publicCode: drop.publicCode, phone: phone(11), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    const quoted = await quoteJoin({ publicCode: drop.publicCode, qty: 1 });
    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.reason).toBe('SOLD_OUT');
    expect(quoted.status).toBe(409);
  });

  it('refuses when there are fewer plates left than asked for', async () => {
    // 4 plates, 3 taken, so 1 left; ask for 2.
    const drop = await publishedDrop({ maxQty: 4, minQty: 2 });
    await joinDrop(
      { publicCode: drop.publicCode, phone: phone(12), qty: 3 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    const quoted = await quoteJoin({ publicCode: drop.publicCode, qty: 2 });
    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.reason).toBe('NOT_ENOUGH_LEFT');
    expect(quoted.status).toBe(409);
  });

  it('refuses when the merchant cannot take a card', async () => {
    const drop = await publishedDrop();

    // Cleared *after* the fixture, and quoted before it is restored. The first draft
    // of this test cleared the account inside `publishedDrop` and put it straight
    // back, so the quote saw a working merchant and the test asserted the opposite of
    // what it had arranged — a green-looking setup proving nothing.
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { stripeAccountId: null },
    });

    try {
      const quoted = await quoteJoin({ publicCode: drop.publicCode, qty: 1 });
      expect(quoted.ok).toBe(false);
      if (quoted.ok) return;
      expect(quoted.reason).toBe('PAYMENTS_NOT_CONFIGURED');
      expect(quoted.status).toBe(503);
    } finally {
      await prisma.merchant.update({
        where: { id: merchantId },
        data: { stripeAccountId: 'acct_test_quote' },
      });
    }
  });
});
