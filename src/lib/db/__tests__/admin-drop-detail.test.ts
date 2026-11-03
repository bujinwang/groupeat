import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

import { loadAdminDropDetail } from '../admin-drop-detail';

/**
 * FR-903's page query, against real Postgres.
 *
 * ## What these tests protect
 *
 *   1. **Eligibility is `refusalFor`'s verdict, not a second opinion.**
 *      `loadAdminDropDetail` calls the same function `issueParticipantRefund` refuses
 *      by. A local predicate (`chargeStatus === 'CAPTURED'`) would agree today and
 *      drift the first time a guard was added — and the failure mode is a button that
 *      can only produce a 409. The test that pins this builds a participant who is
 *      `CAPTURED` on a drop that has **not** settled, where the two predicates
 *      disagree, and asserts the row is refused.
 *   2. **The refusal is a sentence, not a boolean.** It is rendered verbatim beside a
 *      greyed control, so a `false` would force the UI to invent an explanation.
 *   3. **`capturedCents` is still money out there**, per participant, net of what has
 *      already been returned — the same rule the list applies per drop.
 *   4. **The phone number never leaves the database.** Only the last four, because a
 *      full number on an admin screen is a liability with no operational use.
 */

const PREFIX = `add${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

let merchantId = '';
let itemId = '';
let settledDropId = '';

const DEAL_PRICE = 1250;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);
  settledDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 2,
    maxQty: 40,
    status: 'CAPTURED',
    cutoffAt: new Date(Date.now() - HOUR),
  });
});

afterAll(async () => {
  await fx.cleanup();
});

/** A captured participant: the `DropParticipant` plus the `Order` settlement writes. */
async function capturedParticipant(args: {
  dropId: string;
  qty?: number;
  refundedCents?: number;
}): Promise<{ participantId: string; orderId: string; subtotalCents: number }> {
  const qty = args.qty ?? 2;
  const participantId = await fx.participant({
    dropId: args.dropId,
    qty,
    chargeStatus: 'CAPTURED',
    authStatus: 'AUTHORIZED',
    redemptionCode: null,
  });

  const subtotalCents = qty * DEAL_PRICE;
  const fee = 100;
  const order = await prisma.order.create({
    data: {
      dropId: args.dropId,
      participantId,
      qty,
      unitPriceCents: DEAL_PRICE,
      subtotalCents,
      platformFeeCents: fee,
      stripeChargeId: `ch_${PREFIX}_${Math.random().toString(36).slice(2, 8)}`,
      refundedCents: args.refundedCents ?? 0,
    },
    select: { id: true },
  });
  await prisma.ledgerEntry.createMany({
    data: [
      { orderId: order.id, dropId: args.dropId, type: 'CHARGE', amountCents: subtotalCents, note: 'capture' },
      { orderId: order.id, dropId: args.dropId, type: 'PLATFORM_FEE', amountCents: fee, note: 'capture' },
    ],
  });

  return { participantId, orderId: order.id, subtotalCents };
}

describe('loadAdminDropDetail', () => {
  it('returns null for an id that does not exist, rather than throwing at a page', async () => {
    // The caller is a server component that has to render `notFound()`. A thrown
    // AppError is the route convention, not the page's.
    expect(await loadAdminDropDetail('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lists every participant on the drop with the money attached to each', async () => {
    const first = await capturedParticipant({ dropId: settledDropId, qty: 2 });
    const second = await capturedParticipant({ dropId: settledDropId, qty: 3, refundedCents: 500 });

    const drop = await loadAdminDropDetail(settledDropId);
    expect(drop).not.toBeNull();

    const rows = drop?.participants ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const firstRow = rows.find((row) => row.id === first.participantId);
    expect(firstRow?.capturedCents).toBe(first.subtotalCents);
    expect(firstRow?.qty).toBe(2);

    // Still out there, net of what was already returned — the same rule the drop list
    // applies. This is the number a refund control offers to return.
    const secondRow = rows.find((row) => row.id === second.participantId);
    expect(secondRow?.refundedCents).toBe(500);
    expect(secondRow?.capturedCents).toBe(second.subtotalCents - 500);
  });

  it('counts only the rows a refund may actually be issued against', async () => {
    const drop = await loadAdminDropDetail(settledDropId);
    const refundable = (drop?.participants ?? []).filter((row) => row.refusal === null);

    expect(drop?.refundableCount).toBe(refundable.length);
    expect(drop?.refundableCount).toBeGreaterThan(0);

    // Every refused row carries a sentence, and every permitted row carries none.
    for (const row of drop?.participants ?? []) {
      if (row.refusal === null) {
        continue;
      }
      expect(row.refusal.length).toBeGreaterThan(10);
    }
  });

  it('refuses a captured participant on a drop that has not settled', async () => {
    // The case the local predicate would get wrong. `chargeStatus` says CAPTURED, so
    // `chargeStatus === 'CAPTURED'` would offer a refund button — but `refusalFor` also
    // checks the drop's status, because a refund issued while the sweep is about to
    // void or capture would race it. This is why the page calls the service's guard
    // instead of writing its own.
    const lockedDrop = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      maxQty: 40,
      status: 'LOCKED',
      cutoffAt: new Date(Date.now() - HOUR),
    });
    const participant = await capturedParticipant({ dropId: lockedDrop, qty: 1 });

    const drop = await loadAdminDropDetail(lockedDrop);
    const row = drop?.participants.find((candidate) => candidate.id === participant.participantId);

    expect(row?.chargeStatus).toBe('CAPTURED');
    expect(row?.refusal).not.toBeNull();
    expect(row?.refusal).toMatch(/not finished settling|has not finished/i);
    expect(drop?.refundableCount).toBe(0);
  });

  it('never exposes more than the last four digits of a phone number', async () => {
    const drop = await loadAdminDropDetail(settledDropId);
    const row = drop?.participants[0];

    expect(row?.phoneHint).toMatch(/^···\d{4}$/);

    // And the assertion that makes the projection meaningful: the full number is in
    // the database, so a `phoneHint` that accidentally returned it would be caught.
    const stored = await prisma.customer.findFirst({
      where: { participants: { some: { dropId: settledDropId } } },
      select: { phone: true },
    });
    expect(stored?.phone).toBeTruthy();
    expect(row?.phoneHint).not.toBe(stored?.phone);
    expect(row?.phoneHint).not.toContain(stored?.phone.slice(0, -4) ?? 'IMPOSSIBLE');
  });

  it('totals the drop from the orders, not from price × quantity', async () => {
    const drop = await loadAdminDropDetail(settledDropId);
    const rows = drop?.participants ?? [];

    const expectedCaptured = rows.reduce((sum, row) => sum + (row.capturedCents ?? 0), 0);
    const expectedRefunded = rows.reduce((sum, row) => sum + row.refundedCents, 0);

    expect(drop?.capturedCents).toBe(expectedCaptured);
    expect(drop?.refundedCents).toBe(expectedRefunded);
    // A participant who was never charged must contribute nothing rather than a
    // price-derived figure. `null` and `0` are the same here only because the sum
    // treats them alike — the row keeps `null` so the UI can say "nothing captured"
    // instead of "$0.00".
    expect(expectedCaptured).toBeGreaterThan(0);
  });

  it('sums joined plates from participant quantities, not participant count', async () => {
    const drop = await loadAdminDropDetail(settledDropId);
    const expected = (drop?.participants ?? []).reduce((sum, row) => sum + row.qty, 0);

    expect(drop?.joinedQty).toBe(expected);
    expect(drop?.joinedQty).toBeGreaterThan(drop?.participants.length ?? 0);
  });
});
