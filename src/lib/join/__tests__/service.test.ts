import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES } from '@/lib/guardrail';
import { platformFeeCentsForOrder } from '@/lib/settlement/platform-fee';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

import { fakeJoinPaymentPort } from '../fake-payment-port';
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

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant('acct_test_join');
  itemId = await fixtures.item(merchantId);
});

afterAll(async () => {
  // `ConsentRecord` has no foreign key to anything — deliberately, because a
  // consent record must outlive the join it records — so nothing cascades to it and
  // the fixture teardown cannot reach it. Cleaned here by the phone prefix this
  // file's numbers all share, so a re-run starts from zero rather than accumulating
  // rows that make a count assertion drift.
  await prisma.consentRecord
    .deleteMany({ where: { phone: { startsWith: '+17805559' } } })
    .catch(() => undefined);
  await fixtures.cleanup();
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

/** A phone number unique to this test run, so fixtures cannot collide. */
function phone(seq: number): string {
  return `780555${String(seq).padStart(4, '0')}`;
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
    const consentedPhone = phone(0o2 + 9000);
    const silentPhone = phone(0o3 + 9000);

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

    const e164Consented = `+1${consentedPhone}`;
    const e164Silent = `+1${silentPhone}`;

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
