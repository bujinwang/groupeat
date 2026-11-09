import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES } from '@/lib/guardrail';
import { platformFeeCentsForOrder } from '@/lib/settlement/platform-fee';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

import { fakeJoinPaymentPort } from '../fake-payment-port';
import type * as PaymentPort from '../payment-port';
import { joinDrop } from '../service';

/**
 * The join service against real Postgres.
 *
 * ## Why these are not unit tests
 *
 * Three of the four claims the slice has to make are about **the database**, not
 * about the code:
 *
 *   - a double submit produces one participant (a unique index plus a behaviour);
 *   - two diners cannot both take the last plate (row-level locking under
 *     concurrency, which no mock can exhibit);
 *   - a refused join writes nothing at all (rollback, which only a real
 *     transaction can demonstrate).
 *
 * A fake Prisma client would pass all three and prove none of them.
 *
 * ## The oracle rule
 *
 * Every expected money figure is either a literal or computed by
 * `platformFeeCentsForOrder()` — the function ADR-004 designates — and never by
 * the code under test. `joinDrop` reads the fee; the test computes it
 * independently and compares. If both called the same helper the assertion would
 * be a tautology.
 *
 * `fileParallelism: false` in `vitest.config.ts` is what makes these safe: the
 * fixtures create real rows, and two files writing one database in parallel would
 * interfere. Fixtures are prefixed per file and torn down in `afterAll`.
 */

const PREFIX = `join-svc-${Date.now()}`;

/**
 * The phone numbers this file issues, recorded as they are issued.
 *
 * ## The three defects this replaces
 *
 * 1. **The drift.** The teardown deleted `phone: { startsWith: '+17805559' }` while
 *    `phone()` built `780555…`, which `joinDrop` normalises to `+1780555…`. The two
 *    literals disagreed at the ninth character, so the filter matched almost nothing
 *    this file created. Measured against a database wiped to zero for these prefixes:
 *    the first run left **24 `Customer` rows and 1 `ConsentRecord`** behind, and each
 *    later run added 1–2 more customers and 1 more consent row — which is why the leak
 *    read as "+1 per run" once the pool had filled. Only the customer half was ever
 *    visible, because `scripts/check-residue.mjs` counts `Customer` and does not count
 *    `ConsentRecord`.
 *
 * 2. **The escape.** A single shared prefix constant is the obvious repair, and on its
 *    own it is not enough. The consent pair used to be `phone(0o2 + 9000)` /
 *    `phone(0o3 + 9000)`, i.e. `+17805559002` / `+17805559003`. A nine-character prefix
 *    ending in an 0 — `+17805550` — only describes suffixes below 1000, so those two
 *    numbers fell outside the very prefix the rest of the file lives under. They are
 *    now `phone(902)` / `phone(903)`, inside the block; `PHONE_BLOCK_MAX` enforces that
 *    and explains why.
 *
 * 3. **The collision.** `threshold-notify-wiring.test.ts` builds
 *    `'+17805559' + String(seq).padStart(3, '0')`, so its second number is
 *    `+17805559002` — character-for-character this file's old `phone(9002)`. Two files
 *    were minting the same diner, and a teardown that deletes by phone deletes the
 *    other file's row too. The residue gate caught exactly that: running this file
 *    alone moved `customers` **46 → 44**. Moving the pair to 902/903 is what fixes it;
 *    `+17805550` is the one block no sibling builder can reach.
 *
 * So the teardown does not guess at a pattern — it deletes exactly the numbers this
 * run minted. That is the same rule `settlementFixtures` already states for ids:
 * "tracked as they are created rather than discovered by pattern at teardown". A
 * string can drift from another string, and a set that the builder writes and the
 * teardown reads cannot.
 */
const issuedPhones = new Set<string>();

/** National significant number stem — the 780-555 Alberta exchange. */
const PHONE_STEM = '780555';

/** Digits the builder appends. `padStart` does not truncate, so this bounds the width. */
const PHONE_SEQ_DIGITS = 4;

/**
 * The highest suffix this file may use, and the reason it is 1000 rather than 10,000.
 *
 * `+17805550` is nine characters and its last character is a digit of the suffix, so
 * the prefix only describes suffixes below 1000: `phone(999)` is `+17805550999` and
 * `phone(1000)` is `+17805551000`, which has left the block. Staying inside it matters
 * because it is the only four-digit-tail block in the 780-555 exchange that no other
 * test file builds into — `+17805557`, `+17805558` and `+17805559` are all taken
 * (commission, the join route, attribution and threshold-notify). A number that
 * escapes to 1000+ is a number whose neighbours this file does not know about.
 */
const PHONE_BLOCK_MAX = 1000;

/** What `normalisePhone()` prepends to a ten-digit North American number. */
const E164_COUNTRY_PREFIX = '+1';

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant('acct_test_join');
  itemId = await fixtures.item(merchantId);
});

afterAll(async () => {
  // Every step attempted, and the run still fails if any of them did — a throw in step
  // one must not skip the rest, or a failing run leaks more than a passing one. The
  // previous version ended with `.catch(() => undefined)` on the consent delete, which
  // is the same thing as a step that cannot fail: a teardown that silently stopped
  // working is precisely how the `+17805559` typo survived undetected.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // `ConsentRecord` has no foreign key to anything — deliberately, because a consent
  // record must outlive the join it records — so nothing cascades to it and
  // `fixtures.cleanup()` cannot reach it. Deleted here from `issuedPhones`, the same
  // set `phone()` writes to, so the two cannot disagree about what this run created.
  await step(() =>
    prisma.consentRecord.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  // The fixtures next, and the order is load-bearing rather than stylistic:
  // `DropParticipant.customer` declares no `onDelete`, so it defaults to Restrict and
  // refuses to let a `Customer` that still has participants be deleted. Verified by
  // putting the customer delete first and watching it fail with
  // `DropParticipant_customerId_fkey`. `fixtures.cleanup()` is what takes the
  // participants away (it deletes the tracked drops, which cascades to them), so it
  // must run *before* the customer delete.
  await step(() => fixtures.cleanup());

  // Last, once nothing references them. `Customer` is the row the residue gate counts
  // — `scripts/check-residue.mjs` — so this is the delete whose absence turned the
  // gate red.
  await step(() =>
    prisma.customer.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  if (failures.length > 0) {
    throw new AggregateError(failures, `teardown left the database dirty (${failures.length} step(s) failed)`);
  }
});

/**
 * A published drop, two hours before its cutoff, with a known price.
 *
 * `dealPriceCents: 1112` is PRD-v1 §7.4 vector A — the number the fee table in
 * ADR-004 is built from, so a wrong fee here can be seen against a published
 * figure rather than against another computed one.
 */
async function publishedDrop(overrides: {
  minQty?: number;
  maxQty?: number;
  maxPerCustomer?: number;
  dealPriceCents?: number;
} = {}): Promise<{ id: string; publicCode: string }> {
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

  // The drop's own cap, when the test does not care about it.
  if (overrides.maxPerCustomer !== undefined) {
    await prisma.drop.update({
      where: { id },
      data: { maxPerCustomer: overrides.maxPerCustomer },
    });
  }

  return { id, publicCode: row.publicCode };
}

/**
 * A phone number unique to this test run, so fixtures cannot collide.
 *
 * Returns the ten-digit national form, which is what a diner would type and what
 * `joinDrop` normalises. The E.164 form the database ends up holding is
 * `e164(phone(n))` — derived by the same rule the normaliser applies, rather than
 * written out a second time, because a second literal is how the teardown drifted in
 * the first place.
 *
 * The range is checked rather than assumed, because `padStart` does not truncate: a
 * `seq` too large for the suffix would silently render a different number than the
 * caller asked for, and `PHONE_BLOCK_MAX` explains why the bound is not simply the
 * width of the padding.
 */
function phone(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0 || seq >= PHONE_BLOCK_MAX) {
    throw new Error(
      `phone(${seq}) leaves the ${PHONE_STEM} block that this file's teardown owns. Use 0..${PHONE_BLOCK_MAX - 1} — see PHONE_BLOCK_MAX for why the block stops there.`,
    );
  }
  const national = `${PHONE_STEM}${String(seq).padStart(PHONE_SEQ_DIGITS, '0')}`;

  // Recorded at the moment of issue, in the form the database will store. Everything
  // this file creates arrives through here; the teardown deletes exactly this set.
  issuedPhones.add(`${E164_COUNTRY_PREFIX}${national}`);

  return national;
}

/**
 * The stored form of a number `phone()` returned.
 *
 * Ten bare digits are a North American number and the normaliser prefixes `+1`
 * (`src/lib/join/rules.ts`), so assertions that count rows by phone must ask for this
 * rather than for the ten-digit form.
 */
function e164(national: string): string {
  return `${E164_COUNTRY_PREFIX}${national}`;
}

describe('joinDrop — the happy path', () => {
  it('holds the card without charging it, and stores the fee the snapshot implies', async () => {
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();

    const result = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(1), qty: 3, consented: true },
      { paymentPort: port },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.qty).toBe(3);
    // 3 × 1112, written out rather than recomputed.
    expect(result.amountCents).toBe(3336);
    expect(result.amountLabel).toBe('$33.36');
    expect(result.status).toBe('AUTHORIZED');
    expect(result.alreadyJoined).toBe(false);

    // The row. `AUTHORIZED` with a `paymentIntentId` and no charge.
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: result.participantId },
      select: {
        authStatus: true,
        chargeStatus: true,
        paymentIntentId: true,
        amountCents: true,
        platformFeeCents: true,
        qty: true,
      },
    });

    expect(row.authStatus).toBe('AUTHORIZED');
    // FR-404: a join never charges. `NONE` is the only correct value here.
    expect(row.chargeStatus).toBe('NONE');
    expect(row.paymentIntentId).toMatch(/^pi_fake_join_/);

    // The fee, computed by the designated function against the drop's own frozen
    // snapshot — an independent oracle, not the value under test.
    const expectedFee = platformFeeCentsForOrder({
      qty: 3,
      dealPriceCents: 1112,
      fees: DEFAULT_FEES,
    });
    expect(row.platformFeeCents).toBe(expectedFee);

    // And nothing was captured: the ledger has no CHARGE row.
    const charges = await prisma.ledgerEntry.count({
      where: { dropId: drop.id, type: 'CHARGE' },
    });
    expect(charges).toBe(0);
  });

  it('writes a consent record only when consent was given', async () => {
    const drop = await publishedDrop();
    // Two numbers nobody else in this file uses. `ConsentRecord` has no foreign key
    // to clean up through (it is keyed on phone, and it must outlive the join it
    // records — that is the point of a consent record), so a shared phone number
    // would accumulate rows across test runs and make this count drift.
    //
    // 902/903, not 9002/9003. `phone(9002)` renders `+17805559002`, and
    // `threshold-notify-wiring.test.ts`'s own builder produces exactly that string for
    // its second number (`+17805559` + three digits). The two files were minting the
    // same diner, so whichever tore down first deleted the other's `Customer` — the
    // residue gate caught it as `customers 46 → 44` on a run of this file alone. Every
    // number here stays inside `+17805550`, which is the one block no sibling builder
    // can reach; 902 and 903 are below 1000, the point where that prefix stops holding.
    const consentedPhone = phone(902);
    const silentPhone = phone(903);

    const withConsent = await joinDrop(
      { publicCode: drop.publicCode, phone: consentedPhone, qty: 1, consented: true },
      { paymentPort: fakeJoinPaymentPort() },
    );
    const withoutConsent = await joinDrop(
      { publicCode: drop.publicCode, phone: silentPhone, qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(withConsent.ok).toBe(true);
    expect(withoutConsent.ok).toBe(true);

    const e164Consented = e164(consentedPhone);
    const e164Silent = e164(silentPhone);

    const granted = await prisma.consentRecord.count({ where: { phone: e164Consented } });
    const absent = await prisma.consentRecord.count({ where: { phone: e164Silent } });

    expect(granted).toBe(1);
    // An unticked box is not consent. This is the CASL assertion.
    expect(absent).toBe(0);

    const record = await prisma.consentRecord.findFirstOrThrow({
      where: { phone: e164Consented },
      select: { basis: true, source: true },
    });
    expect(record.basis).toBe('EXPRESS');
    expect(record.source).toBe('drop_join');
  });

  it('reuses one customer row for a repeat diner', async () => {
    const first = await publishedDrop();
    const second = await publishedDrop();

    const a = await joinDrop(
      { publicCode: first.publicCode, phone: phone(4), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );
    const b = await joinDrop(
      { publicCode: second.publicCode, phone: phone(4), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(a.ok && b.ok).toBe(true);

    // Written out rather than derived from `phone(4)`: this literal is the independent
    // oracle for the builder. If the two were the same expression the assertion would
    // only prove `phone()` equals itself, and the teardown's original bug was exactly a
    // number that nobody had written down in full.
    const customers = await prisma.customer.count({ where: { phone: '+17805550004' } });
    expect(customers).toBe(1);
  });
});

describe('joinDrop — idempotency (FR-405)', () => {
  it('answers a double submit with one participant and one hold', async () => {
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();

    const first = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(10), qty: 2 },
      { paymentPort: port },
    );
    const second = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(10), qty: 2 },
      { paymentPort: port },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Same participant, and the second call says so rather than pretending it did
    // something new.
    expect(second.participantId).toBe(first.participantId);
    expect(second.alreadyJoined).toBe(true);
    expect(second.status).toBe('AUTHORIZED');

    const rows = await prisma.dropParticipant.count({ where: { dropId: drop.id } });
    expect(rows).toBe(1);

    // The number that matters to a diner: their card is held once, for one amount.
    expect(port.authorisedCount()).toBe(1);
    expect(port.authorisedTotalCents()).toBe(2224);
  });

  it('does not authorise a second time when the same person double-taps concurrently', async () => {
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();

    const results = await Promise.all([
      joinDrop({ publicCode: drop.publicCode, phone: phone(11), qty: 1 }, { paymentPort: port }),
      joinDrop({ publicCode: drop.publicCode, phone: phone(11), qty: 1 }, { paymentPort: port }),
      joinDrop({ publicCode: drop.publicCode, phone: phone(11), qty: 1 }, { paymentPort: port }),
    ]);

    // Some may be refused as a race on the customer upsert; what must not happen is
    // more than one participant, or more than one hold.
    for (const result of results) {
      expect(result.ok).toBe(true);
    }

    const rows = await prisma.dropParticipant.count({ where: { dropId: drop.id } });
    expect(rows).toBe(1);
    expect(port.authorisedCount()).toBe(1);
  });
});

describe('joinDrop — the code arrives from a URL, not from a form', () => {
  /**
   * ## Why the join service is the seam that would have hurt most
   *
   * `joinDrop` looks the drop up **once**, and that once is a raw
   * `SELECT … FOR UPDATE` inside the transaction. `FOR UPDATE` locks the row it
   * *matches*, so a code that is not the stored form locks nothing, falls through to
   * `NOT_FOUND`, and tells a diner a live drop does not exist. The refusal is
   * byte-identical to the one a mistyped code gets, which is exactly why it would
   * never have been reported: it looks like a dead offer, not a bug.
   *
   * The code is then read **four more times** after the lookup — three `orderPath()`
   * calls and one `orderUrl()` — to compose the link that goes into the confirmation
   * SMS. Those failures are quieter still: the join succeeds, and simply mints a
   * second URL for an order that already has one.
   *
   * None of this was reachable before, because every existing test in this file passes
   * `drop.publicCode` straight from the database, which is already normal. The cases
   * below deliberately pass a code that is *not* the stored form.
   */

  it('joins from the lowercase form a messaging app may deliver', async () => {
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();
    // Guarded, because a digits-only code is its own lowercase form and the rest of
    // this test would then be measuring nothing. The shared fixture writes letters on
    // purpose; this keeps that contract visible where it is relied on.
    expect(drop.publicCode.toLowerCase()).not.toBe(drop.publicCode);

    const result = await joinDrop(
      { publicCode: drop.publicCode.toLowerCase(), phone: phone(60), qty: 2 },
      { paymentPort: port },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The row exists on the right drop, which is the only assertion that proves the
    // `FOR UPDATE` matched. A lock that matched nothing would have refused.
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: result.participantId },
      select: { dropId: true, qty: true },
    });
    expect(row.dropId).toBe(drop.id);
    expect(row.qty).toBe(2);
    expect(port.authorisedCount()).toBe(1);
  });

  it('joins from a pasted link, query string and all', async () => {
    // The whole point of arriving from a group chat: the thing in the clipboard is a
    // URL, not a code.
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();
    const pasted = `https://groupeat.ca/d/${drop.publicCode}?o=share-token#top`;

    const result = await joinDrop(
      { publicCode: pasted, phone: phone(61), qty: 1 },
      { paymentPort: port },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amountCents).toBe(1112);
  });

  it('refuses a code that normalises to something that is not a drop, and writes nothing', async () => {
    // Normalising must widen what resolves, never invent a drop. This is the same
    // `NOT_FOUND` a mistyped code gets, which is the property that keeps a guessed
    // code from revealing a draft.
    const port = fakeJoinPaymentPort();

    const result = await joinDrop(
      { publicCode: 'ZZZZZZZZ', phone: phone(62), qty: 1 },
      { paymentPort: port },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NOT_FOUND');
    expect(port.authorisedCount()).toBe(0);
  });

  it('mints the order link from the canonical code, not the segment the diner arrived on', async () => {
    /**
     * The second-URL problem, at the seam where it matters most.
     *
     * The order link is delivered by SMS and opened later. If the join echoed the
     * segment it received, a diner who arrived on `/d/abc2345` (lowercase) would get
     * an order link containing `abc2345`. That URL works — the order page normalises —
     * but it is now a *different string* for the same order, which splits share
     * counts, puts a lowercased code in a transaction log, and means the link in the
     * message disagrees with the link on the page.
     *
     * Asserted on the composed path rather than on a rendered page, because the path
     * is what is stored and sent.
     */
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();

    const result = await joinDrop(
      { publicCode: drop.publicCode.toLowerCase(), phone: phone(63), qty: 1 },
      { paymentPort: port },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Not `/d/abc2345/…`. Guarded on the two forms actually differing, because a
    // digits-only fixture code is its own lowercase form and the assertion below would
    // then pass without measuring anything.
    const lowercased = drop.publicCode.toLowerCase();
    expect(lowercased).not.toBe(drop.publicCode);
    expect(result.orderPath).toContain(`/d/${drop.publicCode}/mine`);
    expect(result.orderPath).not.toContain(lowercased);
  });
});

describe('joinDrop — capacity (FR-406)', () => {
  it('lets exactly one of two diners take the last plate', async () => {
    // One plate left: minQty 1, maxQty 1.
    const drop = await publishedDrop({ minQty: 1, maxQty: 1 });

    const results = await Promise.all([
      joinDrop(
        { publicCode: drop.publicCode, phone: phone(20), qty: 1 },
        { paymentPort: fakeJoinPaymentPort() },
      ),
      joinDrop(
        { publicCode: drop.publicCode, phone: phone(21), qty: 1 },
        { paymentPort: fakeJoinPaymentPort() },
      ),
    ]);

    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    if (losers[0]?.ok === false) {
      // The loser is told the truth, and told which truth.
      expect(['SOLD_OUT', 'NOT_ENOUGH_LEFT']).toContain(losers[0].reason);
    }

    const rows = await prisma.dropParticipant.count({
      where: { dropId: drop.id, authStatus: { in: ['PENDING', 'AUTHORIZED'] } },
    });
    expect(rows).toBe(1);
  });

  it('never oversells under sixteen simultaneous joins on a four-plate drop', async () => {
    // The M6 redemption lesson applied to the other side: a concurrency test that
    // does not actually contend proves nothing. Sixteen simultaneous requests for a
    // four-plate batch is one too many to pass by luck.
    const drop = await publishedDrop({ minQty: 1, maxQty: 4 });
    const port = fakeJoinPaymentPort();

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        joinDrop(
          { publicCode: drop.publicCode, phone: phone(30 + index), qty: 1 },
          { paymentPort: port },
        ),
      ),
    );

    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(4);

    const soldRows = await prisma.$queryRaw<{ sold: number }[]>`
      SELECT COALESCE(SUM("qty"), 0)::int AS "sold"
        FROM "DropParticipant"
       WHERE "dropId" = ${drop.id}
         AND "authStatus" IN ('PENDING', 'AUTHORIZED')`;
    expect(Number(soldRows[0]?.sold ?? 0)).toBe(4);

    // Four holds, not sixteen.
    expect(port.authorisedCount()).toBe(4);
  });

  it('refuses a quantity above the drop under a concurrent ask, not just the cap', async () => {
    // Eight plates; one person asks for four, another asks for five. Most of the
    // batch is unsold, so the cap is not the binding limit — what is left is.
    const drop = await publishedDrop({ minQty: 1, maxQty: 8, maxPerCustomer: 4 });

    const result = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(40), qty: 5 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Five is above the per-customer cap of four.
    expect(result.reason).toBe('BAD_QTY');
  });

  it('counts a person’s existing plates against their own cap', async () => {
    const drop = await publishedDrop({ minQty: 1, maxQty: 20, maxPerCustomer: 4 });

    const first = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(41), qty: 3 },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(first.ok).toBe(true);

    // Already holds three of four. A second join for one more is a *new* join of
    // the same customer, which the idempotency rule answers instead of adding to it.
    const second = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(41), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // One join per person per drop, so this is the existing three, not four.
    expect(second.alreadyJoined).toBe(true);
    expect(second.qty).toBe(3);
  });
});

describe('joinDrop — refusals write nothing', () => {
  it('refuses a drop whose cutoff has passed and says it failed, not just closed', async () => {
    const drop = await publishedDrop({ minQty: 4 });
    // Move the cutoff into the past with nobody joined.
    await prisma.drop.update({
      where: { id: drop.id },
      data: { cutoffAt: new Date(Date.now() - 60 * 1000) },
    });

    const result = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(50), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `FAILED`, not `CLOSED`. This is FR-306 doing its job: a drop past its cutoff
    // that never reached its minimum did not merely close, it did not run — and the
    // diner is owed that specific sentence, because the next thing they want to know
    // is whether they were charged. `drop-view.ts` makes the same call and for the
    // same reason, and this test pins the join path to it.
    expect(result.reason).toBe('FAILED');
    expect(result.status).toBe(409);

    const rows = await prisma.dropParticipant.count({ where: { dropId: drop.id } });
    expect(rows).toBe(0);
  });

  it('refuses a confirmed drop past its cutoff as closed, not failed', async () => {
    // The other side of the same distinction: this drop reached its minimum, so its
    // cutoff merely closed it. Reporting `FAILED` here would tell a diner who is
    // about to be charged that nobody was charged.
    const drop = await publishedDrop({ minQty: 1, maxQty: 10 });

    const joined = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(58), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(joined.ok).toBe(true);

    await prisma.drop.update({
      where: { id: drop.id },
      data: { cutoffAt: new Date(Date.now() - 60 * 1000) },
    });

    const result = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(59), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('CLOSED');
    expect(result.status).toBe(409);
  });

  it('refuses a drop that failed its threshold, and says nobody was charged', async () => {
    const drop = await publishedDrop();
    await prisma.drop.update({ where: { id: drop.id }, data: { status: 'FAILED' } });

    const result = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(51), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('FAILED');
  });

  it('answers a nonexistent code and a draft identically', async () => {
    const missing = await joinDrop(
      { publicCode: 'NOSUCHCODE', phone: phone(52), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    // A draft is invisible too: a guessed code must not reveal an unpublished drop.
    const drop = await publishedDrop();
    await prisma.drop.update({ where: { id: drop.id }, data: { status: 'DRAFT' } });
    const draft = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(53), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(missing.ok).toBe(false);
    expect(draft.ok).toBe(false);
    if (missing.ok || draft.ok) return;
    // Byte-identical: a caller cannot tell the two apart.
    expect(draft.reason).toBe(missing.reason);
    expect(draft.status).toBe(missing.status);
  });

  it('refuses a bad phone number before touching the database', async () => {
    const drop = await publishedDrop();

    const result = await joinDrop(
      { publicCode: drop.publicCode, phone: 'call me', qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('BAD_PHONE');
    expect(result.status).toBe(422);
  });

  it('writes a FAILED participant and holds nothing when the provider declines', async () => {
    const drop = await publishedDrop();

    // A small inline port rather than `fakeJoinPaymentPort`'s `declineParticipantIds`:
    // the service generates the participant id inside the transaction, so the test
    // cannot know it in advance to name it. Declining unconditionally is the same
    // behaviour without needing to predict an id.
    let calls = 0;
    const declining = {
      async createJoinAuthorisation() {
        calls += 1;
        return { status: 'DECLINED' as const, declineCode: 'insufficient_funds' };
      },
    };

    const declined = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(55), qty: 2 },
      { paymentPort: declining },
    );

    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.reason).toBe('PAYMENT_DECLINED');
    // 402: payment required. A decline is a payment outcome, not a bad request.
    expect(declined.status).toBe(402);
    expect(calls).toBe(1);

    // The row exists but is `FAILED`, and it holds no plate: the capacity sum in
    // the reserve transaction excludes it, so a declined card does not block the
    // batch for the next diner.
    const row = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: drop.id },
      select: { authStatus: true, paymentIntentId: true, chargeStatus: true },
    });
    expect(row.authStatus).toBe('FAILED');
    expect(row.paymentIntentId).toBeNull();
    expect(row.chargeStatus).toBe('NONE');
  });

  it('leaves the row PENDING when the provider cannot answer', async () => {
    const drop = await publishedDrop();

    const unavailable = {
      async createJoinAuthorisation() {
        const { JoinProviderUnavailableError } = await import('../payment-port');
        throw new JoinProviderUnavailableError('timeout', 'test: timeout');
      },
    };

    const result = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(56), qty: 1 },
      { paymentPort: unavailable },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('PAYMENT_UNAVAILABLE');
    expect(result.status).toBe(503);

    // `PENDING` on purpose: the hold may or may not exist, so the plate stays
    // reserved until reconciliation resolves it by idempotency key.
    const row = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: drop.id },
      select: { authStatus: true },
    });
    expect(row.authStatus).toBe('PENDING');
  });

  it('refuses when the merchant has no connected account', async () => {
    const unconnected = await fixtures.merchant(null);
    const unconnectedItem = await fixtures.item(unconnected);
    const id = await fixtures.drop({
      merchantId: unconnected,
      menuItemId: unconnectedItem,
      dealPriceCents: 1112,
      minQty: 1,
      maxQty: 10,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
      windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
    });
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id },
      select: { publicCode: true },
    });

    const result = await joinDrop(
      { publicCode: row.publicCode, phone: phone(57), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('PAYMENTS_NOT_CONFIGURED');
    expect(result.status).toBe(503);

    // The reserved row is released, not left dangling in `PENDING`.
    const participant = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: id },
      select: { authStatus: true },
    });
    expect(participant.authStatus).toBe('FAILED');
  });
});

/**
 * The hold exists and no row records it — `recorded.count !== 1` (`service.ts:799`).
 *
 * ## Why this branch needed its own test
 *
 * The service treats "the card is held but the row is not ours" as the worst outcome
 * available, and returns 503 rather than pretending the diner is in. Measured coverage
 * of `service.ts` listed `803-809` as uncovered: nothing had ever executed it.
 *
 * The trap is that this branch returns `PAYMENT_UNAVAILABLE`, which is also what the
 * provider-unavailable `catch` around `service.ts:741` returns — and that path *is*
 * tested, at `service.test.ts:804`. A careless test asserting only the reason and the
 * status would pass against the wrong branch. So this one asserts on the log line the
 * two paths do not share (`join.record_failed` vs `join.payment_unavailable`) and on
 * the row's final state, which the two paths leave different.
 *
 * ## How the branch is reached
 *
 * `recorded` comes from an `updateMany` matched on **`id` AND `authStatus: 'PENDING'`**,
 * so it reports `count: 0` when the row has left `PENDING` by the time the transaction
 * runs. The realistic writer is a concurrent one: a second join, or an administrative
 * action, resolving the row while this request is awaiting the provider. That is what
 * the port below simulates — it resolves the row to `FAILED` and then reports a
 * successful authorisation, which is exactly the interleaving where the hold is real
 * and the row is not.
 */
describe('joinDrop — a hold with no row recording it', () => {
  /**
   * Captures the logger's event stream, which is stdout: the real logger writes one JSON
   * object per line there (`logger.ts:666-678`), so this records what an operator would
   * see without stubbing the logger and without skipping `redact`.
   */
  async function captureEvents<T>(run: () => Promise<T>): Promise<{ log: string[]; result: T }> {
    const lines: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });

    try {
      const result = await run();
      return { log: lines, result };
    } finally {
      spy.mockRestore();
    }
  }

  it('answers 503 and leaves the row not-AUTHORIZED when the row resolved mid-authorisation', async () => {
    const drop = await publishedDrop();

    /**
     * The participant id is generated inside the reserve transaction, so the test
     * cannot name it up front. The port receives it in the request
     * (`service.ts:726-739`), which is where the concurrent writer gets it too.
     *
     * The request parameter is typed from the interface rather than written out as
     * `{ participantId: string }`: a hand-copied shape keeps compiling after the real
     * signature gains a field, which is how a test stops being about the real call.
     */
    let racingParticipantId = '';
    const racing = {
      async createJoinAuthorisation(
        request: Parameters<PaymentPort.JoinPaymentPort['createJoinAuthorisation']>[0],
      ) {
        racingParticipantId = request.participantId;
        // The concurrent writer wins while this request is awaiting the provider.
        await prisma.dropParticipant.update({
          where: { id: request.participantId },
          data: { authStatus: 'FAILED' },
        });
        // …and the provider still says yes. The hold is real; the row is gone.
        return {
          status: 'AUTHORIZED' as const,
          paymentIntentId: 'pi_test_record_race',
          providerStatus: 'requires_capture' as const,
        };
      },
    };

    const { log, result } = await captureEvents(() =>
      joinDrop(
        { publicCode: drop.publicCode, phone: phone(54), qty: 1 },
        { paymentPort: racing },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('PAYMENT_UNAVAILABLE');
    // 503, not 200: the diner is told nothing is confirmed, because nothing is.
    expect(result.status).toBe(503);

    // Exactly one line, and it is this branch's — not `join.payment_unavailable`, which
    // the provider-unavailable path logs and which also answers `PAYMENT_UNAVAILABLE`.
    const recordFailed = log
      .flatMap((line) => line.trim().split('\n'))
      .filter((line) => line.includes('join.record_failed'))
      .map((line) => JSON.parse(line) as { event: string; dropId: string; participantId: string });

    expect(recordFailed).toHaveLength(1);
    expect(recordFailed[0]?.event).toBe('join.record_failed');
    expect(recordFailed[0]?.dropId).toBe(drop.id);
    expect(recordFailed[0]?.participantId).toBe(racingParticipantId);

    // The row. It is `FAILED` because the concurrent writer put it there and the
    // `authStatus: 'PENDING'` predicate then matched nothing — the service did not, and
    // could not, write `AUTHORIZED`. That is the honest consequence: a hold may exist at
    // the provider (`pi_test_record_race`) while the row claims none of it, which is
    // precisely the condition reconciliation exists to find. `paymentIntentId` stays
    // null for the same reason — the failed update was the only statement that would
    // have written it.
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: racingParticipantId },
      select: { authStatus: true, paymentIntentId: true },
    });
    expect(row.authStatus).toBe('FAILED');
    expect(row.authStatus).not.toBe('AUTHORIZED');
    expect(row.paymentIntentId).toBeNull();
  });
});

/**
 * The card reaches the port.
 *
 * ## Why this test exists
 *
 * Slice 2a's real port refuses an authorisation with no `paymentMethodId`, on
 * purpose, so that shipping the UI without wiring the card through would fail
 * loudly. It would have. The gap was one layer down: `joinSchema` never accepted a
 * `paymentMethodId`, so the id was dropped at the wire and **every** real join would
 * have thrown before reaching Stripe — with the keys configured and the fake tests
 * all green, because a fake never needs a card.
 *
 * The fake-backed suite could not see it, the unit tests could not see it, and the
 * type checker could not see it (both fields were optional). Asserting on the fake's
 * recorded call is what closes that class of gap: it checks the *plumbing*, not the
 * behaviour, and plumbing is what a fake silently ignores.
 */
describe('joinDrop — the payment method reaches the port', () => {
  it('forwards the pm_ id from the request to createJoinAuthorisation', async () => {
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();

    const result = await joinDrop(
      {
        publicCode: drop.publicCode,
        phone: phone(81),
        qty: 1,
        paymentMethodId: 'pm_card_visa_from_element',
      },
      { paymentPort: port },
    );

    expect(result.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.request.paymentMethodId).toBe('pm_card_visa_from_element');
  });

  it('omits the field entirely when the request has no card, rather than sending undefined', async () => {
    // A fake accepts either. The real port branches on absence, and a serialising
    // layer that wrote `"paymentMethodId": undefined` would look like a card id.
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();

    await joinDrop({ publicCode: drop.publicCode, phone: phone(82), qty: 1 }, {
      paymentPort: port,
    });

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.request).not.toHaveProperty('paymentMethodId');
  });

  it('does not carry the card on a replayed join that touches no provider', async () => {
    // The existing-join path returns before the port, so there should be exactly one
    // call for two submits — and the second must not pretend to authorise.
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();
    const request = {
      publicCode: drop.publicCode,
      phone: phone(83),
      qty: 1,
      paymentMethodId: 'pm_card_visa_once',
    };

    const first = await joinDrop(request, { paymentPort: port });
    const second = await joinDrop(request, { paymentPort: port });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
  });
});

/**
 * The confirmation's sentence — the bug that rendered "undefined".
 *
 * `JoinSuccess` declared `cutoffLabel` client-side and the service never produced
 * it, so the confirmation read "people join by **undefined**." Nothing failed: the
 * component cast the response to its own type, so `tsc` had nothing to object to,
 * and no test read the sentence.
 *
 * These assert the two properties that make the sentence true — it is present, and
 * it is in the merchant's zone rather than the server's.
 */
describe('the confirmation cutoff label', () => {
  it('sends a formatted label, never undefined', async () => {
    const drop = await publishedDrop();

    const result = await joinDrop(
      { publicCode: drop.publicCode, phone: phone(90), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cutoffLabel).toBeTypeOf('string');
    expect(result.cutoffLabel).not.toContain('undefined');

    // A weekday and a clock time, not the ISO instant echoed back. The pattern is
    // deliberately loose about *which* day — the drop's cutoff is relative to now —
    // and strict about the shape a diner reads.
    expect(result.cutoffLabel).toMatch(
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) \d{1,2}:\d{2}\s(AM|PM)$/,
    );
  });

  it('names the cutoff in the merchant zone, not the server zone', async () => {
    // A merchant in Tokyo, a cutoff that is one instant everywhere. If the label were
    // formatted from the server's zone (or defaulted to Edmonton) this would print a
    // different day and a different hour, and a diner would be told the wrong
    // deadline — the same class of error as an unformatted money figure.
    const tokyo = await fixtures.merchant('acct_test_join_tokyo');
    await prisma.merchant.update({
      where: { id: tokyo },
      data: { timezone: 'Asia/Tokyo' },
    });
    const tokyoItem = await fixtures.item(tokyo);

    // 2027-07-15T03:00:00Z is 12:00 in Tokyo (UTC+9) and 21:00 the previous day in
    // Edmonton. July 2027 is chosen because its offset is stable under both tzdata
    // releases this repo is run against — the same reasoning as gap 6 in PROGRESS.
    const cutoffAt = new Date('2027-07-15T03:00:00Z');
    const id = await fixtures.drop({
      merchantId: tokyo,
      menuItemId: tokyoItem,
      dealPriceCents: 1112,
      minQty: 1,
      maxQty: 10,
      status: 'PUBLISHED',
      cutoffAt,
      windowStart: new Date('2027-07-15T06:00:00Z'),
      windowEnd: new Date('2027-07-15T09:00:00Z'),
    });
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id },
      select: { publicCode: true },
    });

    const result = await joinDrop(
      { publicCode: row.publicCode, phone: phone(91), qty: 1 },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Thursday 12:00 PM in Tokyo. Edmonton would say "Wednesday 9:00 PM".
    expect(result.cutoffLabel).toBe('Thursday 12:00 PM');
  });
});
