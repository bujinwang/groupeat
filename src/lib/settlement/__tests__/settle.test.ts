import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { fakeChargePort } from '../fake-charge-port';
import {
  assertLedgerReconciles,
  dropLedgerTotals,
  type LedgerEntryShape,
  type LedgerOrder,
} from '../ledger';
import type { NotifyIntent, NotifyPort } from '../notify-port';
import { deriveRedemptionSecret, verifyRedemptionCode } from '../redemption-code';
import { settle } from '../settle';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * Phases 2 and 3 against real Postgres, with the deterministic port.
 *
 * The four-way sum in the first test is the point of the whole file (§6.4): the
 * same figure, 6672, reached from the ledger, from the `Order` rows, from the
 * `DropParticipant` rows, and from the fixture. A rounding change in any one of
 * them — per-unit vs per-order, `roundHalfUp` vs `Math.round` — breaks exactly one
 * and this test names which.
 */

const PREFIX = `settle${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1112;
/** `roundHalfUp(platformFeeAt(1112)) = roundHalfUp(88.96) = 89`, per unit. */
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
  expect(FEE_PER_UNIT).toBe(89);
});

afterAll(async () => {
  await fx.cleanup();
});

type Recorder = NotifyPort & { readonly intents: NotifyIntent[] };

function recordingNotify(): Recorder {
  const intents: NotifyIntent[] = [];
  return {
    intents,
    async notify(batch) {
      intents.push(...batch);
    },
  };
}

async function lockedDrop(args: {
  minQty: number;
  dealPriceCents?: number;
}): Promise<string> {
  return fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: args.dealPriceCents ?? DEAL_PRICE,
    minQty: args.minQty,
    status: 'LOCKED',
    lockedAt: new Date(Date.now() - 60_000),
  });
}

async function ledgerShapeOf(dropId: string): Promise<LedgerEntryShape[]> {
  const rows = await prisma.ledgerEntry.findMany({ where: { dropId } });
  return rows.map((row) => ({
    orderId: row.orderId,
    dropId: row.dropId ?? dropId,
    type: row.type,
    amountCents: row.amountCents,
    stripeRef: row.stripeRef,
    note: row.note,
  }));
}

async function orderShapeOf(dropId: string): Promise<LedgerOrder[]> {
  const rows = await prisma.order.findMany({
    where: { dropId },
    select: { id: true, participantId: true, subtotalCents: true, platformFeeCents: true },
  });
  const refunded = await prisma.dropParticipant.findMany({
    where: { dropId, chargeStatus: 'REFUNDED' },
    select: { id: true },
  });
  const refundedIds = new Set(refunded.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    subtotalCents: row.subtotalCents,
    platformFeeCents: row.platformFeeCents,
    refunded: refundedIds.has(row.participantId),
  }));
}

describe('the happy path, and the four-way sum', () => {
  it('captures every participant and the ledger agrees with the orders, four ways', async () => {
    // §6.4's exact vector: 1112 per unit, minQty 5, qty 2 + 1 + 3.
    const dropId = await lockedDrop({ minQty: 5 });
    await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 1, platformFeeCents: 1 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });

    const port = fakeChargePort();
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });

    expect(outcome).toEqual({ kind: 'CAPTURED', dropId, capturedQty: 6, declinedQty: 0 });

    const drop = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(drop.status).toBe('CAPTURED');

    const orders = await prisma.order.findMany({ where: { dropId } });
    const participants = await prisma.dropParticipant.findMany({ where: { dropId } });
    const entries = await ledgerShapeOf(dropId);
    const totals = dropLedgerTotals(entries);

    expect(orders).toHaveLength(3);
    expect(entries).toHaveLength(6);
    // 2224 + 1112 + 3336
    expect(totals.chargedCents).toBe(6672);
    expect(totals.platformFeeCents).toBe(534);
    expect(totals.capturedGrossCents).toBe(6672);
    expect(orders.reduce((total, order) => total + order.subtotalCents, 0)).toBe(6672);
    expect(orders.reduce((total, order) => total + order.platformFeeCents, 0)).toBe(534);
    expect(participants.reduce((total, row) => total + row.amountCents, 0)).toBe(6672);
    expect(participants.reduce((total, row) => total + row.platformFeeCents, 0)).toBe(534);

    const orderShapes = await orderShapeOf(dropId);
    expect(() => assertLedgerReconciles({ dropId, entries, orders: orderShapes })).not.toThrow();

    // FR-505: every charged diner has a code, and the code verifies offline.
    expect(participants.filter((row) => row.redemptionCode !== null)).toHaveLength(3);
    for (const participant of participants) {
      const payload = verifyRedemptionCode(
        participant.redemptionCode ?? '',
        deriveRedemptionSecret(process.env.JWT_SECRET ?? ''),
      );
      expect(payload).toEqual({
        participantId: participant.id,
        dropId,
        qty: participant.qty,
      });
    }

    expect(notify.intents.filter((intent) => intent.kind === 'DROP_CONFIRMED_CHARGED')).toHaveLength(3);
    expect(port.calls.filter((call) => call.kind === 'void')).toHaveLength(0);
  });
});

describe('a decline the drop can absorb', () => {
  it('captures the rest, voids the declined authorisation, and records nothing for it', async () => {
    // minQty 5 → tolerance ceil(4.5) = 5. Captured 3 + 2 = 5 is enough.
    const dropId = await lockedDrop({ minQty: 5 });
    await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    const declinedId = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const port = fakeChargePort({ declineParticipantIds: [declinedId] });
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });

    expect(outcome).toEqual({ kind: 'CAPTURED', dropId, capturedQty: 5, declinedQty: 1 });

    const declined = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: declinedId },
      select: { chargeStatus: true, authStatus: true, redemptionCode: true },
    });
    expect(declined.chargeStatus).toBe('FAILED');
    // The authorisation still had to be *cancelled* at the provider, and it was.
    expect(declined.authStatus).toBe('VOIDED');
    expect(declined.redemptionCode).toBeNull();
    expect(await prisma.order.count({ where: { participantId: declinedId } })).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { orderId: null } })).toBe(0);

    expect(notify.intents.filter((intent) => intent.kind === 'DROP_CONFIRMED_CARD_DECLINED')).toHaveLength(1);
    expect(port.calls.filter((call) => call.kind === 'void')).toHaveLength(1);
  });
});

describe('a drop that falls below the capture tolerance', () => {
  it('refunds every capture, reverses our fee, voids the rest, and only then writes FAILED', async () => {
    // minQty 10 → tolerance 9. Captured 4 is not enough.
    const dropId = await lockedDrop({ minQty: 10 });
    await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    const declinedId = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const port = fakeChargePort({ declineParticipantIds: [declinedId] });
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });

    expect(outcome.kind).toBe('FAILED');
    if (outcome.kind !== 'FAILED') {
      throw new Error('expected FAILED');
    }
    expect(outcome.reason).toBe('BELOW_CAPTURE_TOLERANCE');
    expect(outcome.refundedCents).toBe(4 * DEAL_PRICE);

    const drop = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(drop.status).toBe('FAILED');

    const entries = await ledgerShapeOf(dropId);
    const totals = dropLedgerTotals(entries);
    // 4 capture rows + 4 refund rows.
    expect(entries).toHaveLength(8);
    expect(totals.refundedCents).toBe(totals.chargedCents);
    // Our fee is fully reversed: we keep nothing on a drop that did not run.
    expect(totals.platformFeeCents).toBe(0);
    expect(totals.capturedGrossCents).toBe(0);

    const orderShapes = await orderShapeOf(dropId);
    expect(() => assertLedgerReconciles({ dropId, entries, orders: orderShapes })).not.toThrow();

    const refunds = port.calls.filter((call) => call.kind === 'refund');
    expect(refunds).toHaveLength(2);
    for (const call of refunds) {
      if (call.kind === 'refund') {
        // ADR-001 §3.2 — the type makes `false` impossible, and this asserts the
        // value actually reached the port as `true`.
        expect(call.request.reverseApplicationFee).toBe(true);
      }
    }

    expect(notify.intents.filter((intent) => intent.kind === 'DROP_FAILED_REFUNDED')).toHaveLength(2);
    expect(notify.intents.filter((intent) => intent.kind === 'DROP_FAILED_NO_CHARGE')).toHaveLength(1);

    const everyone = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: { id: true, authStatus: true, chargeStatus: true },
    });
    expect(everyone.find((row) => row.id === declinedId)?.authStatus).toBe('VOIDED');
    expect(everyone.filter((row) => row.chargeStatus === 'REFUNDED')).toHaveLength(2);
  });

  it('stays LOCKED when a refund is retryably unavailable, and finishes on the next call', async () => {
    const dropId = await lockedDrop({ minQty: 10 });
    const firstId = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });

    const port = fakeChargePort({ refundUnavailableOnceFor: [firstId] });

    const first = await settle({ dropId, now: new Date(), port });
    expect(first.kind).toBe('IN_PROGRESS');

    // §4.5: `FAILED` asserts "everyone who paid has been refunded in full". Until
    // that is true the only honest status is LOCKED.
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('LOCKED');

    const second = await settle({ dropId, now: new Date(), port });
    expect(second.kind).toBe('FAILED');
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('FAILED');

    // One REFUND row per order, not two: the retry did not double-post.
    expect(await prisma.ledgerEntry.count({ where: { dropId, type: 'REFUND' } })).toBe(2);
  });
});

describe('a capture the provider could not answer', () => {
  it('leaves that participant at NONE, stays LOCKED, and finishes on the next call with one charge', async () => {
    const dropId = await lockedDrop({ minQty: 5 });
    const flakyId = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });

    const port = fakeChargePort({ unavailableOnceFor: [flakyId] });

    const first = await settle({ dropId, now: new Date(), port });
    expect(first).toEqual({ kind: 'IN_PROGRESS', dropId, capturedQty: 3, pendingParticipants: 1 });

    const afterFirst = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: flakyId },
      select: { chargeStatus: true },
    });
    expect(afterFirst.chargeStatus).toBe('NONE');
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('LOCKED');

    const second = await settle({ dropId, now: new Date(), port });
    expect(second).toEqual({ kind: 'CAPTURED', dropId, capturedQty: 5, declinedQty: 0 });

    // Two capture calls for that participant, both with the same idempotency key,
    // and exactly one charge id between them.
    const attempts = port.calls.filter(
      (call) => call.kind === 'capture' && call.request.participantId === flakyId,
    );
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((call) => (call.kind === 'capture' ? call.request.idempotencyKey : ''))).size).toBe(1);

    const orders = await prisma.order.findMany({
      where: { dropId },
      select: { stripeChargeId: true },
    });
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((order) => order.stripeChargeId)).size).toBe(2);
  });

  it('reuses an existing Order row instead of re-charging, closing the 24-hour window', async () => {
    // §4.2: a worker captured at Stripe and died before the write committed. The
    // Order row is the evidence; the port must not be called again.
    const dropId = await lockedDrop({ minQty: 5 });
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });
    await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty: 5,
        unitPriceCents: DEAL_PRICE,
        subtotalCents: 5 * DEAL_PRICE,
        platformFeeCents: 5 * FEE_PER_UNIT,
        stripeChargeId: 'ch_from_the_crash',
      },
    });

    const port = fakeChargePort();
    const outcome = await settle({ dropId, now: new Date(), port });

    expect(outcome.kind).toBe('CAPTURED');
    expect(port.calls.filter((call) => call.kind === 'capture')).toHaveLength(0);
    const participant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { chargeStatus: true },
    });
    expect(participant.chargeStatus).toBe('CAPTURED');
  });
});

describe('the drops settle must not touch', () => {
  it('returns NOT_LOCKED for a PUBLISHED drop and never reaches the port', async () => {
    // The P0 sentence: never charge when the threshold is missed. A PUBLISHED drop
    // past its cutoff with the threshold met has no LockedDrop, so there is no
    // path from here to a charge.
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: DEAL_PRICE, minQty: 5 });
    await fx.participant({ dropId, qty: 10, platformFeeCents: 10 * FEE_PER_UNIT });

    const port = fakeChargePort();
    const outcome = await settle({ dropId, now: new Date(), port });

    expect(outcome).toEqual({ kind: 'NOT_LOCKED', dropId });
    expect(port.calls).toHaveLength(0);
    expect(await prisma.order.count({ where: { dropId } })).toBe(0);
  });

  it('returns NOT_LOCKED for CAPTURED and FAILED drops, and writes nothing', async () => {
    const capturedId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'CAPTURED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const failedId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'FAILED',
    });
    await fx.participant({ dropId: capturedId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });
    await fx.participant({ dropId: failedId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });

    const port = fakeChargePort();

    expect(await settle({ dropId: capturedId, now: new Date(), port })).toEqual({
      kind: 'NOT_LOCKED',
      dropId: capturedId,
    });
    expect(await settle({ dropId: failedId, now: new Date(), port })).toEqual({
      kind: 'NOT_LOCKED',
      dropId: failedId,
    });
    expect(port.calls).toHaveLength(0);
    expect(await prisma.ledgerEntry.count({ where: { dropId: { in: [capturedId, failedId] } } })).toBe(0);
  });

  it('is idempotent end to end: a second settle after a success writes nothing', async () => {
    const dropId = await lockedDrop({ minQty: 5 });
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });

    const port = fakeChargePort();
    expect((await settle({ dropId, now: new Date(), port })).kind).toBe('CAPTURED');
    const ordersAfterFirst = await prisma.order.count({ where: { dropId } });
    const entriesAfterFirst = await prisma.ledgerEntry.count({ where: { dropId } });

    expect(await settle({ dropId, now: new Date(), port })).toEqual({ kind: 'NOT_LOCKED', dropId });

    expect(await prisma.order.count({ where: { dropId } })).toBe(ordersAfterFirst);
    expect(await prisma.ledgerEntry.count({ where: { dropId } })).toBe(entriesAfterFirst);
    expect(port.calls).toHaveLength(1);
  });
});

describe('integrity', () => {
  it('stops the drop when an amount does not match the deal, and charges nothing', async () => {
    const dropId = await lockedDrop({ minQty: 5 });
    await fx.participant({ dropId, qty: 5, amountCents: 5 * DEAL_PRICE + 1, platformFeeCents: 5 * FEE_PER_UNIT });

    const port = fakeChargePort();

    await expect(settle({ dropId, now: new Date(), port })).rejects.toMatchObject({
      check: 'AMOUNT_MISMATCH',
    });

    // Nothing was charged and nothing was written: the diner never saw this number.
    expect(port.calls).toHaveLength(0);
    expect(await prisma.order.count({ where: { dropId } })).toBe(0);
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('LOCKED');
  });

  it('refuses a LOCKED drop whose merchant lost its connected account', async () => {
    const brokenMerchant = await fx.merchant(null);
    const brokenItem = await fx.item(brokenMerchant);
    const dropId = await fx.drop({
      merchantId: brokenMerchant,
      menuItemId: brokenItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });

    const port = fakeChargePort();
    await expect(settle({ dropId, now: new Date(), port })).rejects.toMatchObject({
      check: 'MISSING_STRIPE_ACCOUNT',
    });
    expect(port.calls).toHaveLength(0);
  });
});

describe('the ledger idempotency index', () => {
  it('refuses a second CHARGE for the same order, and allows two drop-level rows', async () => {
    // §4.2 guard 3: the third, independent barrier against a double-post. Postgres
    // treats NULLs as distinct in a unique index, so a drop-level row
    // (`orderId IS NULL`) stays unconstrained — which is the property that lets a
    // future adjustment hang off a drop rather than an order.
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: DEAL_PRICE, minQty: 5 });

    await prisma.ledgerEntry.create({
      data: { orderId: 'order-idempotency', dropId, type: 'CHARGE', amountCents: 100, note: 'capture' },
    });

    await expect(
      prisma.ledgerEntry.create({
        data: { orderId: 'order-idempotency', dropId, type: 'CHARGE', amountCents: 100, note: 'capture' },
      }),
    ).rejects.toThrow();

    // A different type for the same order is allowed: that is the PLATFORM_FEE row.
    await prisma.ledgerEntry.create({
      data: { orderId: 'order-idempotency', dropId, type: 'PLATFORM_FEE', amountCents: 8, note: 'capture' },
    });

    await prisma.ledgerEntry.create({
      data: { orderId: null, dropId, type: 'ADJUSTMENT', amountCents: -1 },
    });
    await prisma.ledgerEntry.create({
      data: { orderId: null, dropId, type: 'ADJUSTMENT', amountCents: -1 },
    });

    expect(await prisma.ledgerEntry.count({ where: { dropId } })).toBe(4);
  });
});

describe('bounded per tick', () => {
  it('captures at most maxParticipants and reports IN_PROGRESS', async () => {
    const dropId = await lockedDrop({ minQty: 5 });
    for (const qty of [2, 2, 2]) {
      await fx.participant({ dropId, qty, platformFeeCents: qty * FEE_PER_UNIT });
    }

    const port = fakeChargePort();
    const outcome = await settle({ dropId, now: new Date(), port, maxParticipants: 2 });

    expect(outcome).toEqual({ kind: 'IN_PROGRESS', dropId, capturedQty: 4, pendingParticipants: 1 });
    expect(await prisma.order.count({ where: { dropId } })).toBe(2);
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('LOCKED');

    // The next tick finishes it — progress beats finishing (§4.4).
    expect((await settle({ dropId, now: new Date(), port, maxParticipants: 2 })).kind).toBe('CAPTURED');
  });
});
