import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeJoinPaymentPort } from '@/lib/join/fake-payment-port';
import { quoteJoin } from '@/lib/join/quote';
import { joinDrop } from '@/lib/join/service';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

import { resolveDropView } from '../drop-view';
import { getPublicDrop } from '../public-drops';

/**
 * Two questions, two populations.
 *
 * ## The defect these tests were written against
 *
 * A `PENDING` row is a plate taken but not paid for. Two callers need a number about
 * plates, and they need *different* numbers:
 *
 *   - **Capacity** — "is there room for another order?" — must count `PENDING`,
 *     because a plate being authorised is a plate the kitchen cannot sell twice.
 *     Excluding it oversells by the number of joins in flight.
 *   - **Threshold** — "has this drop got its minimum?" — must count `AUTHORIZED`
 *     only, because a row whose card was never held has not committed anybody to
 *     anything. Counting it lets a drop "reach" its minimum on money nobody paid.
 *
 * Both questions were being answered from one `joinedQty`, and the two production
 * callers disagreed about which population to put in it. The public page summed
 * `AUTHORIZED`; `service.ts` and `quote.ts` summed `PENDING + AUTHORIZED`. Measured
 * against real Postgres on 2026-11-16, that produced two distinct lies:
 *
 *   1. a drop with 2 held plates and one 2-plate orphan showed **"2 left"** on the
 *      page while the API answered `SOLD_OUT` to a diner asking for those 2;
 *   2. a drop with 2 held plates and a 2-plate orphan reported
 *      `isConfirmedAlready: true` to the next diner at **3 claimed of 4 required**.
 *
 * Each case below is one of those, and each fails on the pre-fix code.
 */

const PREFIX = `cap-pop-${Date.now()}`;

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;
let seq = 0;

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant();
  itemId = await fixtures.item(merchantId);
});

afterAll(async () => {
  await fixtures.cleanup();
});

/** A published drop whose cutoff is comfortably ahead. */
async function liveDrop(spec: { minQty: number; maxQty: number }): Promise<{
  id: string;
  publicCode: string;
}> {
  const id = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1112,
    minQty: spec.minQty,
    maxQty: spec.maxQty,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
    windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id },
    select: { publicCode: true },
  });
  return { id, publicCode: row.publicCode };
}

/**
 * A number in this file's own block, so teardown can find it.
 *
 * `+17805560xx` is this file's allocation and it is **not** free choice: the first version
 * of this file used `780559`, which normalises to `+1780559…` — the block
 * `api/admin/commission/route.test.ts` had already claimed for its diners. Nothing
 * collided until both files ran in one process, at which point that file's `beforeAll`
 * threw `Unique constraint failed on the fields: (phone)` and all 13 of its tests were
 * reported as **skipped**. Measured, not predicted: the run before the collision showed
 * `2910 passed | 8 skipped` and the run after showed `2897 passed | 21 skipped`, and the
 * 13-test difference was entirely that file.
 *
 * That is the failure mode worth recording here: a phone collision does not look like a
 * collision. It looks like thirteen quietly skipped tests and a green suite.
 */
function nextPhone(): string {
  seq += 1;
  return `780560${String(seq).padStart(4, '0')}`;
}

/** A port that never answers, which is what leaves a row `PENDING`. */
function unavailablePort() {
  return {
    async createJoinAuthorisation() {
      const { JoinProviderUnavailableError } = await import('@/lib/join/payment-port');
      throw new JoinProviderUnavailableError('timeout', 'capacity-populations: test');
    },
  };
}

/** A join that leaves an orphan: reserved, provider silent, row `PENDING`. */
async function orphan(
  drop: { publicCode: string },
  qty: number,
): Promise<void> {
  const result = await joinDrop(
    { publicCode: drop.publicCode, phone: nextPhone(), qty, consented: true },
    { paymentPort: unavailablePort() },
  );
  expect(result.ok).toBe(false);
}

async function held(drop: { publicCode: string }, qty: number): Promise<void> {
  const result = await joinDrop(
    { publicCode: drop.publicCode, phone: nextPhone(), qty, consented: true },
    { paymentPort: fakeJoinPaymentPort() },
  );
  expect(result.ok).toBe(true);
}

async function populations(dropId: string): Promise<{ claimed: number; held: number }> {
  const rows = await prisma.dropParticipant.findMany({
    where: { dropId, authStatus: { in: ['PENDING', 'AUTHORIZED'] } },
    select: { authStatus: true, qty: true },
  });
  let claimed = 0;
  let all = 0;
  for (const row of rows) {
    all += row.qty;
    if (row.authStatus === 'AUTHORIZED') claimed += row.qty;
  }
  return { claimed, held: all };
}

describe('capacity and threshold are different populations', () => {
  it('refuses the plate it offers, when an orphan holds it', async () => {
    // The page-vs-API disagreement, as a diner experiences it: the page says N
    // plates are left and the API refuses an order for N.
    const drop = await liveDrop({ minQty: 2, maxQty: 4 });
    await held(drop, 1);
    await held(drop, 1);
    await orphan(drop, 2);

    const { claimed, held: committed } = await populations(drop.id);
    expect(claimed).toBe(2);
    expect(committed).toBe(4);

    // What the page must show. `held` is what the kitchen has committed; `claimed`
    // is what has actually been authorised. Scarcity is a claim about plates, so it
    // is `held` that decides it — the page must not offer a plate the kitchen has
    // already given away.
    const view = resolveDropView({
      status: 'PUBLISHED',
      minQty: 2,
      maxQty: 4,
      cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
      windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
      claimedQty: claimed,
      heldQty: committed,
      now: new Date(),
    });

    expect(view.remainingQty).toBe(0);
    expect(view.soldOut).toBe(true);
    expect(view.joinBlockedReason).toBe('SOLD_OUT');

    // And the API agrees, which is the point: the same answer from both.
    const ask = await joinDrop(
      { publicCode: drop.publicCode, phone: nextPhone(), qty: 1, consented: true },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(ask.ok).toBe(false);
    if (!ask.ok) expect(ask.reason).toBe('SOLD_OUT');
  });

  it('does not call a drop confirmed on plates nobody paid for', async () => {
    // The threshold lie: 2 authorised + a 2-plate orphan is 3 claimed of 4 required,
    // and the pre-fix code told the next diner the drop was already confirmed.
    const drop = await liveDrop({ minQty: 4, maxQty: 10 });
    await held(drop, 1);
    await held(drop, 1);
    await orphan(drop, 2);

    const { claimed, held: committed } = await populations(drop.id);
    expect(claimed).toBe(2);
    expect(committed).toBe(4);

    // A third diner joins. He has NOT tipped the drop over its minimum: only 3
    // plates are claimed of 4, however many are reserved.
    const third = await joinDrop(
      { publicCode: drop.publicCode, phone: nextPhone(), qty: 1, consented: true },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.isConfirmedAlready).toBe(false);

    // And the page's phase agrees with the sentence the diner was just given.
    const after = await populations(drop.id);
    expect(after.claimed).toBe(3);
    const view = resolveDropView({
      status: 'PUBLISHED',
      minQty: 4,
      maxQty: 10,
      cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
      windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
      claimedQty: after.claimed,
      heldQty: after.held,
      now: new Date(),
    });
    expect(view.thresholdMet).toBe(false);
    expect(view.offerPhase).toBe('OPEN');
  });

  it('publishes the two populations as two numbers, not one', async () => {
    // `PublicDrop` is the only thing the page components read, so the split has to be
    // visible there or the page is back to one number. `joinedQty` drives the sentence
    // "N of M orders in" — a claim about committed orders — and must not count a
    // `PENDING` row; `heldQty` drives the remaining-plate claim and must.
    //
    // Measured without this test: making `joinedQty` count `PENDING` too left all 12
    // tests in this area green, i.e. the page's own population choice was unwatched.
    const drop = await liveDrop({ minQty: 2, maxQty: 10 });
    await held(drop, 1);
    await held(drop, 1);
    await orphan(drop, 3);

    const published = await getPublicDrop(drop.publicCode);
    expect(published).not.toBeNull();

    // Two authorised plates and an unclaimed 3.
    expect(published?.joinedQty).toBe(2);
    expect(published?.heldQty).toBe(5);
  });

  it('gives the quote and the join the same answer about capacity', async () => {
    // The third caller. A quote that offers a card form for a drop the join will
    // refuse is the same defect one layer earlier, in the screen before payment.
    const drop = await liveDrop({ minQty: 2, maxQty: 4 });
    await held(drop, 2);
    await orphan(drop, 2);

    const { claimed, held: committed } = await populations(drop.id);
    expect(claimed).toBe(2);
    expect(committed).toBe(4);

    const quote = await quoteJoin({ publicCode: drop.publicCode, qty: 1 });
    expect(quote.ok).toBe(false);
    if (!quote.ok) expect(quote.reason).toBe('SOLD_OUT');
  });
});
