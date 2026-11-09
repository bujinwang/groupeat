import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import {
  contributionAt,
  DEFAULT_FEES,
  platformFeeAt,
  readGuardrailSnapshot,
  roundHalfUp,
} from '@/lib/guardrail';

import type { ChargePort } from '../charge-port';
import { fakeChargePort } from '../fake-charge-port';
import type { NotifyIntent, NotifyPort } from '../notify-port';
import { platformFeeCentsForOrder } from '../platform-fee';
import { deriveRedemptionSecret, verifyRedemptionCode } from '../redemption-code';
import { settle } from '../settle';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * An independent reading of the ledger, written from the database alone.
 *
 * This file deliberately does **not** import `assertLedgerReconciles` or
 * `dropLedgerTotals`. The engineer's `settle.test.ts` proves that the production
 * assertion passes; that is a different claim from "the numbers in the database
 * satisfy L1–L4". If `assertLedgerReconciles` were wrong in the same way the
 * writer is wrong, its own test would still be green. So the identities are
 * re-derived here from `SELECT`s and plain arithmetic, and the production helper
 * is never called.
 *
 * The second thing this file adds is the **multi-unit** order. Per-unit rounding
 * then `× qty` and per-order rounding agree at qty 1 and diverge above it, so a
 * single-unit fixture cannot tell them apart. At `dealPriceCents = 1112`, five
 * plates: per-unit gives `5 × 89 = 445`, per-order gives
 * `roundHalfUp(platformFeeAt(5560)) = 200` (the per-plate cap binds once for the
 * whole order instead of five times). The test asserts 445 and names 200 as the
 * number it must not be.
 */

const PREFIX = `qa-recon${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
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

/** The fee constants that were frozen at publish, read back from the snapshot. */
async function frozenFeeInput(dropId: string) {
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: { guardrailSnapshot: true },
  });
  return readGuardrailSnapshot(row.guardrailSnapshot).input;
}

type OrderRow = {
  id: string;
  participantId: string;
  qty: number;
  subtotalCents: number;
  platformFeeCents: number;
  stripeChargeId: string | null;
};

type EntryRow = {
  orderId: string | null;
  type: string;
  amountCents: number;
};

/** Everything the ledger identities need, read fresh from Postgres. */
async function readBooks(dropId: string): Promise<{
  orders: OrderRow[];
  entries: EntryRow[];
  refundedParticipantIds: Set<string>;
}> {
  const [orders, entries, participants] = await Promise.all([
    prisma.order.findMany({
      where: { dropId },
      select: {
        id: true,
        participantId: true,
        qty: true,
        subtotalCents: true,
        platformFeeCents: true,
        stripeChargeId: true,
      },
      orderBy: { qty: 'asc' },
    }),
    prisma.ledgerEntry.findMany({
      where: { dropId },
      select: { orderId: true, type: true, amountCents: true },
    }),
    prisma.dropParticipant.findMany({
      where: { dropId, chargeStatus: 'REFUNDED' },
      select: { id: true },
    }),
  ]);

  return {
    orders,
    entries,
    refundedParticipantIds: new Set(participants.map((row) => row.id)),
  };
}

const totalOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);

/**
 * L1–L4, asserted from `readBooks()` with no help from `ledger.ts`.
 *
 * Returns the figures so a caller can assert the absolute numbers too — a
 * relative identity that holds at zero is not evidence that anything was
 * charged.
 */
function assertIdentitiesFromDatabase(args: {
  dropId: string;
  orders: OrderRow[];
  entries: EntryRow[];
  refundedParticipantIds: Set<string>;
}): { chargedCents: number; refundedCents: number; platformFeeCents: number } {
  const { dropId, orders, entries, refundedParticipantIds } = args;

  const sumType = (type: string): number =>
    totalOf(entries.filter((entry) => entry.type === type).map((entry) => entry.amountCents));

  const chargeSigned = sumType('CHARGE');
  const refundSigned = sumType('REFUND');
  const feeSigned = sumType('PLATFORM_FEE');
  const adjustmentSigned = sumType('ADJUSTMENT');

  const isRefunded = (order: OrderRow): boolean => refundedParticipantIds.has(order.participantId);
  const liveOrders = orders.filter((order) => !isRefunded(order));
  const refundedOrders = orders.filter(isRefunded);

  // L1 — Σ CHARGE + Σ REFUND == Σ subtotal of the orders that were not refunded.
  expect(
    chargeSigned + refundSigned,
    `L1 on drop ${dropId}: ledger ${chargeSigned} + (${refundSigned}) vs live orders ${totalOf(liveOrders.map((o) => o.subtotalCents))}`,
  ).toBe(totalOf(liveOrders.map((order) => order.subtotalCents)));

  // L2 — Σ PLATFORM_FEE + Σ ADJUSTMENT == Σ platformFee of the live orders.
  expect(
    feeSigned + adjustmentSigned,
    `L2 on drop ${dropId}: ledger ${feeSigned} + (${adjustmentSigned}) vs live orders ${totalOf(liveOrders.map((o) => o.platformFeeCents))}`,
  ).toBe(totalOf(liveOrders.map((order) => order.platformFeeCents)));

  // L3 — −Σ REFUND == Σ subtotal of the refunded orders. `Math.abs` because a
  // drop with no refunds sums to `-0`, which `toBe` distinguishes from `0`.
  expect(refundSigned, `L3: REFUND rows must be signed negative`).toBeLessThanOrEqual(0);
  expect(
    Math.abs(refundSigned),
    `L3 on drop ${dropId}: refunds ${refundSigned} vs refunded orders ${totalOf(refundedOrders.map((o) => o.subtotalCents))}`,
  ).toBe(totalOf(refundedOrders.map((order) => order.subtotalCents)));

  // L4 — per order, the CHARGE and PLATFORM_FEE rows that hang off it.
  for (const order of orders) {
    const charge = entries.filter((entry) => entry.orderId === order.id && entry.type === 'CHARGE');
    const fee = entries.filter((entry) => entry.orderId === order.id && entry.type === 'PLATFORM_FEE');
    expect(charge, `L4: order ${order.id} must have exactly one CHARGE row`).toHaveLength(1);
    expect(fee, `L4: order ${order.id} must have exactly one PLATFORM_FEE row`).toHaveLength(1);
    expect(charge[0]?.amountCents, `L4 CHARGE vs subtotal for order ${order.id}`).toBe(
      order.subtotalCents,
    );
    expect(fee[0]?.amountCents, `L4 PLATFORM_FEE vs platformFee for order ${order.id}`).toBe(
      order.platformFeeCents,
    );
  }

  // No entry may hang off an order that does not exist for this drop.
  for (const entry of entries) {
    if (entry.orderId === null) {
      continue;
    }
    expect(
      orders.some((order) => order.id === entry.orderId),
      `ledger row points at a foreign order ${entry.orderId}`,
    ).toBe(true);
  }

  return {
    chargedCents: chargeSigned,
    refundedCents: Math.abs(refundSigned),
    platformFeeCents: feeSigned + adjustmentSigned,
  };
}

describe('a mixed outcome: some captured, some declined, some voided', () => {
  it('reconciles L1–L4 from the database alone, and keeps the fee per plate', async () => {
    // minQty 10 → tolerance ceil(9) = 9. Captured 4 + 5 = 9 is exactly enough.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });

    const fourPlates = await fx.participant({
      dropId,
      qty: 4,
      platformFeeCents: 4 * FEE_PER_UNIT,
    });
    const fivePlates = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });
    const declinedTwo = await fx.participant({
      dropId,
      qty: 2,
      platformFeeCents: 2 * FEE_PER_UNIT,
    });
    const declinedOne = await fx.participant({
      dropId,
      qty: 1,
      platformFeeCents: FEE_PER_UNIT,
    });

    const port = fakeChargePort({ declineParticipantIds: [declinedTwo, declinedOne] });
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });

    expect(outcome).toEqual({ kind: 'CAPTURED', dropId, capturedQty: 9, declinedQty: 3 });

    const books = await readBooks(dropId);
    const figures = assertIdentitiesFromDatabase({ dropId, ...books });

    // Absolute numbers, so an identity that holds at zero cannot pass.
    expect(books.orders).toHaveLength(2);
    expect(books.entries).toHaveLength(4);
    expect(figures.chargedCents).toBe(4 * DEAL_PRICE + 5 * DEAL_PRICE);
    expect(figures.chargedCents).toBe(10008);
    expect(figures.refundedCents).toBe(0);
    expect(figures.platformFeeCents).toBe(4 * FEE_PER_UNIT + 5 * FEE_PER_UNIT);
    expect(figures.platformFeeCents).toBe(801);

    // --- the multi-unit order: per-unit rounding, not per-order ---
    //
    // Two expectations, deliberately from different sources. `perOrderRounding` is
    // the *wrong* answer computed the wrong way, so that "not 200" is a real
    // constraint rather than a restatement. `contracted` is the number the join
    // path is obliged to write, taken from the helper rather than retyped — this is
    // the one place in the suite where using `platformFeeCentsForOrder` is right,
    // because the question here is "did settlement store what the contract says",
    // not "is the contract arithmetically correct" (`platform-fee.test.ts` answers
    // that, against literal integers).
    const input = await frozenFeeInput(dropId);
    const perOrderRounding = roundHalfUp(platformFeeAt(5 * DEAL_PRICE, input));
    expect(perOrderRounding).toBe(200); // the cap, applied once to the whole order
    expect(perOrderRounding).not.toBe(5 * FEE_PER_UNIT); // 445

    expect(
      platformFeeCentsForOrder({ qty: 5, dealPriceCents: DEAL_PRICE, fees: input }),
    ).toBe(5 * FEE_PER_UNIT);

    const bigOrder = books.orders.find((order) => order.qty === 5);
    expect(bigOrder, 'the five-plate order must exist').toBeDefined();
    expect(bigOrder?.platformFeeCents).toBe(5 * FEE_PER_UNIT);
    expect(bigOrder?.platformFeeCents).not.toBe(perOrderRounding);

    // The merchant's per-plate figure must not depend on how many plates one
    // diner happened to order: this is the number the panel promises.
    for (const order of books.orders) {
      expect(
        order.platformFeeCents / order.qty,
        `order of ${order.qty} plates must carry the same fee per plate`,
      ).toBe(FEE_PER_UNIT);
    }
    // The figure the panel prints is the rounded per-plate contribution
    // (ADR-004 §4.2: "You keep $4.01 per plate … and our fee ($0.89)").
    const perPlateContribution = roundHalfUp(contributionAt(input, DEAL_PRICE));
    expect(perPlateContribution).toBe(401); // "$4.01 per plate"
    // It is a per-plate number: five plates keep five times it, and it is the
    // same figure the panel showed for one plate.
    expect(perPlateContribution * 5).toBe(2005);

    // The declined diners left no trace in the books and their holds were released.
    const declined = await prisma.dropParticipant.findMany({
      where: { id: { in: [declinedTwo, declinedOne] } },
      select: { chargeStatus: true, authStatus: true, redemptionCode: true },
    });
    expect(declined.map((row) => row.chargeStatus)).toEqual(['FAILED', 'FAILED']);
    expect(declined.map((row) => row.authStatus)).toEqual(['VOIDED', 'VOIDED']);
    expect(declined.map((row) => row.redemptionCode)).toEqual([null, null]);
    expect(await prisma.order.count({ where: { participantId: { in: [declinedTwo, declinedOne] } } })).toBe(0);
    expect(
      await prisma.ledgerEntry.count({
        where: {
          dropId,
          orderId: { notIn: books.orders.map((order) => order.id) },
        },
      }),
    ).toBe(0);

    // The two charged diners have codes that verify offline, and the declined two
    // got no code at all.
    const charged = await prisma.dropParticipant.findMany({
      where: { id: { in: [fourPlates, fivePlates] } },
      select: { id: true, qty: true, redemptionCode: true },
    });
    for (const participant of charged) {
      expect(
        verifyRedemptionCode(
          participant.redemptionCode ?? '',
          deriveRedemptionSecret(process.env.JWT_SECRET ?? ''),
        ),
      ).toEqual({ participantId: participant.id, dropId, qty: participant.qty });
    }

    // One intent per diner, and the declined ones say "declined", not "charged".
    expect(notify.intents.filter((intent) => intent.kind === 'DROP_CONFIRMED_CHARGED')).toHaveLength(2);
    expect(notify.intents.filter((intent) => intent.kind === 'DROP_CONFIRMED_CARD_DECLINED')).toHaveLength(2);
    expect(notify.intents).toHaveLength(4);
  });

  it('refunds every capture and reconciles to zero when the tolerance is missed', async () => {
    // minQty 10 → tolerance 9. Captured 4 + 3 = 7 is short.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 4, platformFeeCents: 4 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    const declinedId = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const port = fakeChargePort({ declineParticipantIds: [declinedId] });
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });
    expect(outcome.kind).toBe('FAILED');

    const books = await readBooks(dropId);
    const figures = assertIdentitiesFromDatabase({ dropId, ...books });

    expect(books.orders).toHaveLength(2);
    expect(books.entries).toHaveLength(8); // 2 captures + 2 refunds, two rows each
    expect(figures.chargedCents).toBe(7 * DEAL_PRICE);
    expect(figures.refundedCents).toBe(figures.chargedCents);
    // We keep nothing on a drop that did not run: every application fee reversed.
    expect(figures.platformFeeCents).toBe(0);
    expect(
      totalOf(
        books.entries.filter((entry) => entry.type === 'ADJUSTMENT').map((entry) => entry.amountCents),
      ),
    ).toBe(-(7 * FEE_PER_UNIT));

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('FAILED');
  });
});

describe('the edges of the tolerance', () => {
  it('proceeds when capturedQty is exactly ceil(minQty × 9/10)', async () => {
    // minQty 10 → ceil(90/10) = 9. Exactly 9 must proceed.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 4, platformFeeCents: 4 * FEE_PER_UNIT });
    const declinedId = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort({ declineParticipantIds: [declinedId] }),
    });

    expect(outcome).toEqual({ kind: 'CAPTURED', dropId, capturedQty: 9, declinedQty: 1 });
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('CAPTURED');
  });

  it('fails one unit below the tolerance, and refunds everything', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 4, platformFeeCents: 4 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 4, platformFeeCents: 4 * FEE_PER_UNIT });
    const declinedId = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });

    const port = fakeChargePort({ declineParticipantIds: [declinedId] });
    const outcome = await settle({ dropId, now: new Date(), port });

    expect(outcome.kind).toBe('FAILED');
    expect(port.calls.filter((call) => call.kind === 'refund')).toHaveLength(2);
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('FAILED');
  });
});

describe('a drop where every capture declines', () => {
  it('writes no ledger row, holds no money, and still reaches a terminal state', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const ids = [
      await fx.participant({ dropId, qty: 4, platformFeeCents: 4 * FEE_PER_UNIT }),
      await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT }),
      await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT }),
    ];

    const port = fakeChargePort({ declineParticipantIds: ids });
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });

    expect(outcome).toEqual({
      kind: 'FAILED',
      dropId,
      reason: 'BELOW_CAPTURE_TOLERANCE',
      refundedCents: 0,
    });

    // No money moved, so the ledger is empty and every identity is 0 == 0.
    const books = await readBooks(dropId);
    assertIdentitiesFromDatabase({ dropId, ...books });
    expect(books.orders).toHaveLength(0);
    expect(books.entries).toHaveLength(0);

    // No refunds were attempted — there was nothing to refund.
    expect(port.calls.filter((call) => call.kind === 'refund')).toHaveLength(0);

    // Every authorisation released, every participant terminal, no code handed out.
    const participants = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: { authStatus: true, chargeStatus: true, redemptionCode: true },
    });
    expect(participants.map((row) => row.authStatus)).toEqual(['VOIDED', 'VOIDED', 'VOIDED']);
    expect(participants.map((row) => row.chargeStatus)).toEqual(['FAILED', 'FAILED', 'FAILED']);
    expect(participants.map((row) => row.redemptionCode)).toEqual([null, null, null]);

    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('FAILED');

    // Three diners told "no charge", and nobody told "refunded".
    expect(notify.intents.filter((intent) => intent.kind === 'DROP_FAILED_NO_CHARGE')).toHaveLength(3);
    expect(notify.intents.filter((intent) => intent.kind === 'DROP_FAILED_REFUNDED')).toHaveLength(0);
  });
});

describe('re-running after a success', () => {
  it('charges once, posts one ledger row per type, and notifies once', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });

    const port = fakeChargePort();
    const notify = recordingNotify();

    expect((await settle({ dropId, now: new Date(), port, notify })).kind).toBe('CAPTURED');
    const captureCalls = port.calls.filter((call) => call.kind === 'capture').length;
    const intentsAfterFirst = notify.intents.length;
    const ordersAfterFirst = await prisma.order.count({ where: { dropId } });
    const entriesAfterFirst = await prisma.ledgerEntry.count({ where: { dropId } });

    // A second settle, then a third, on the same port.
    expect((await settle({ dropId, now: new Date(), port, notify })).kind).toBe('NOT_LOCKED');
    expect((await settle({ dropId, now: new Date(), port, notify })).kind).toBe('NOT_LOCKED');

    expect(port.calls.filter((call) => call.kind === 'capture')).toHaveLength(captureCalls);
    expect(notify.intents).toHaveLength(intentsAfterFirst);
    expect(await prisma.order.count({ where: { dropId } })).toBe(ordersAfterFirst);
    expect(await prisma.ledgerEntry.count({ where: { dropId } })).toBe(entriesAfterFirst);
    // Nothing was voided on the second pass either — the sweep is idempotent.
    expect(port.calls.filter((call) => call.kind === 'void')).toHaveLength(0);
  });
});

describe('the order of release and report', () => {
  /**
   * `finaliseFailed` used to notify **before** releasing the holds, while
   * `finaliseCaptured` does the opposite and `run-tick.ts`'s phase 8 docblock states the
   * rule explicitly: the sweep runs after the void "on purpose … saying that before the
   * release has been attempted would make the sentence a prediction rather than a
   * report".
   *
   * Nothing enforced it. Swapping the two lines in `finaliseFailed` left all **200**
   * settlement tests green — measured — because every existing assertion in this file is
   * about final state and the *set* of intents, and neither changes when the two calls
   * swap. A claim about order needs a test about order.
   *
   * ## Why both ports write to one log
   *
   * Separate logs can only establish "each happened". The claim is about relative
   * sequence, so the void port and the notify port both push into the same array and the
   * assertion reads the interleaving. A weaker shape — "voids happened, then notify
   * happened" checked against two independent counts — passes on a run where notify came
   * first, which is the defect itself.
   *
   * The charge port is the repo's `fakeChargePort`, wrapped rather than replaced: the
   * wrapper records into the shared log and then delegates, so the port's own behaviour
   * (including the `calls` bookkeeping other assertions rely on) is untouched.
   *
   * ## What the failure looks like
   *
   * With the old order, `events` is `['notify', 'void', 'void']` and this fails on the
   * first `expect` with the received array printed. Note what does *not* fail: the
   * participants are `VOIDED` either way by the time `settle` resolves. The defect was
   * never a leaked hold — it was a message asserting a release the code had not yet
   * attempted, which is a different and more insidious thing, because every end-state
   * assertion in the suite is blind to it.
   */
  it('releases every hold before the first diner is told it was released', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const firstId = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    const secondId = await fx.participant({ dropId, qty: 1, platformFeeCents: 1 * FEE_PER_UNIT });

    const events: string[] = [];

    // Both captures must **decline**, and this is the part I got wrong first. A drop
    // below tolerance whose captures *succeed* is charged and then refunded:
    // `chargeStatus` ends `REFUNDED`, the sweep's predicate is
    // `chargeStatus: { in: ['NONE', 'FAILED'] }` (`settle.ts:868-870`), and a refunded
    // participant's authorisation was consumed by the capture. So that fixture produces
    // **zero** void calls and the test fails on `expected [] to have a length of 2`.
    // Measured. The decline path is the one where a hold survives to be released.
    //
    // `ChargePort` has exactly three members (charge-port.ts:118-122), so the wrapper is
    // total: nothing can slip past the recording un-delegated.
    const inner = fakeChargePort({ declineParticipantIds: [firstId, secondId] });
    const port: ChargePort = {
      capture: inner.capture,
      refund: inner.refund,
      async voidAuthorization(request) {
        const result = await inner.voidAuthorization(request);
        events.push('void');
        return result;
      },
    };

    const notify: NotifyPort = {
      async notify(intents) {
        if (intents.length > 0) {
          events.push('notify');
        }
      },
    };

    const outcome = await settle({ dropId, now: new Date(), port, notify });
    expect(outcome.kind).toBe('FAILED');

    // Two diners, so two voids. Asserting the shape first means a failure below is
    // about order rather than about how many holds existed.
    expect(events.filter((event) => event === 'void')).toHaveLength(2);
    expect(events.filter((event) => event === 'notify')).toHaveLength(1);

    // The claim. Every void precedes the single notify.
    expect(events).toEqual(['void', 'void', 'notify']);

    // The holds really are released, so the assertion above is not describing a no-op —
    // if the sweep had silently done nothing, `events` would still have two 'void'
    // entries but this would fail.
    const rows = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: { authStatus: true, chargeStatus: true },
    });
    expect(rows.map((row) => row.authStatus)).toEqual(['VOIDED', 'VOIDED']);
    expect(rows.map((row) => row.chargeStatus)).toEqual(['FAILED', 'FAILED']);
  });
});

describe('the amount quoted in a refund message', () => {
  /**
   * `settle.ts:1024` puts a number into a sentence a diner reads:
   *
   * ```
   * `This drop could not go ahead, so your ${formatCents(args.chargedCents)} charge ` +
   * `has been refunded in full.`
   * ```
   *
   * Nothing asserted it. Setting it to `1` — so every refund message would read
   * "$0.01 has been refunded in full" — left all **202** settlement tests green.
   * Measured, by mutation. An earlier version of this sentence claimed the sibling
   * assertions covered `kind`, `qty`, `participantId` and `phone`; only the first and
   * third are true *here*. Across `src/lib/settlement/` intents are asserted on `kind`,
   * `dropId`, `participantId`, `orderUrl`, `redemptionCode` and now `chargedCents` — never
   * `qty` or `phone`. Those two *are* asserted elsewhere, on other intent kinds
   * (`drops/__tests__/cancel.test.ts:334` and `admin/__tests__/force-fail.test.ts:585`),
   * so "nobody asserts them" would be the same overclaim in the opposite direction.
   * `chargedCents` was simply never in an `expect`.
   *
   * ## What this test proves, and what it cannot
   *
   * The line is `order?.subtotalCents ?? participant.amountCents`. A mutation matrix was
   * run against it, and the survivors are reported here because a guard that claims more
   * than it does is worse than no guard:
   *
   * | mutation | result |
   * |---|---|
   * | `1` | **caught** |
   * | `locked.dealPriceCents` (per-unit price) | **caught** |
   * | sum of every order in the drop | **caught** |
   * | `qty × locked.dealPriceCents` (recompute) | survives |
   * | `participant.amountCents` (fallback arm alone) | survives |
   *
   * Both survivors are **equivalent mutants** on the shipped path, and that is a fact
   * about the production code rather than a gap in the test. `assertAmountsMatchTheDeal`
   * (`settle.ts:389`) throws unless `participant.amountCents === qty × dealPriceCents`,
   * and `settle.ts:510` writes that same amount into the order's `subtotalCents`. So all
   * three expressions are the same number for every drop that can settle:
   *
   * ```
   * AMOUNT_MISMATCH on drop …: amountCents is 3400 but 3 × 1112 = 3336.
   * ```
   *
   * That is what trying to make them differ produces — the fixture cannot express the
   * divergence because the guard forbids it. The first draft of this test asserted the
   * title "...not a recomputation" and passed the recompute mutation, i.e. the title was
   * making a claim the test did not check. Measured, then renamed.
   *
   * So the reachable defect is a number that is *not* this participant's charge: a
   * constant, a per-unit price, another participant's amount, or the drop's total. Those
   * are what this test pins. The fallback `??` is dead code on the shipped path and is
   * not, and cannot be, distinguished here.
   */
  it('quotes each diner their own charge, not a per-unit price or the drop total', async () => {
    // minQty 10 → tolerance 9. Two captures (qty 3 and 2 = 5) is short, so the drop
    // fails *after* charging, which is the only path to `REFUNDED`.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });

    // Distinct per-unit totals: 3 × 1112 = 3336 and 2 × 1112 = 2224. A constant, the
    // drop's per-unit price, or the first participant's amount is wrong for one of them.
    const bigId = await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    const smallId = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    // A third participant who declines: refunded nothing, told nothing about an amount.
    const declinedId = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const port = fakeChargePort({ declineParticipantIds: [declinedId] });
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });
    expect(outcome.kind).toBe('FAILED');

    const books = await readBooks(dropId);
    const chargedByParticipant = new Map(
      books.orders.map((order) => [order.participantId, order.subtotalCents]),
    );

    // Precondition, so a failure below is about the message and not about whether the
    // drop charged anyone. Both captured participants must have an order row.
    expect([...chargedByParticipant.keys()].sort()).toEqual([bigId, smallId].sort());
    expect(chargedByParticipant.get(bigId)).toBe(3 * DEAL_PRICE);
    expect(chargedByParticipant.get(smallId)).toBe(2 * DEAL_PRICE);

    const refundIntents = notify.intents.filter((intent) => intent.kind === 'DROP_FAILED_REFUNDED');
    expect(refundIntents).toHaveLength(2);

    for (const intent of refundIntents) {
      if (intent.kind !== 'DROP_FAILED_REFUNDED') {
        continue;
      }
      expect(
        intent.chargedCents,
        `the refund message for ${intent.participantId} must quote what the ledger charged`,
      ).toBe(chargedByParticipant.get(intent.participantId));
    }

    // Named absolutely as well, because two `undefined`s compare equal and the loop
    // above would then pass while asserting nothing. 3336 and 2224 are the two amounts;
    // 1112 (the per-unit price) and 5560 (the drop's total) are the two numbers a
    // careless implementation would print instead.
    expect(refundIntents.map((intent) => intent.chargedCents).sort((a, b) => a - b)).toEqual([
      2224, 3336,
    ]);

    // The declining participant is still told the drop is off — but in the
    // `NO_CHARGE` sentence, which carries **no** `chargedCents` at all. Asserting that
    // rather than asserting silence: I wrote "not in the batch at all" first and the
    // run corrected me on the product, not on the test. A diner whose card declined
    // still needs to hear the drop is cancelled; what they must not hear is an amount,
    // because none was taken.
    const declinedIntents = notify.intents.filter(
      (intent) => intent.participantId === declinedId,
    );
    expect(declinedIntents).toHaveLength(1);
    expect(declinedIntents[0]?.kind).toBe('DROP_FAILED_NO_CHARGE');
    expect(declinedIntents[0]).not.toHaveProperty('chargedCents');
  });
});

describe('who a card-declined message is addressed to', () => {
  /**
   * `settle.ts:1028-1034` is the *other* constructor of `DROP_FAILED_NO_CHARGE`.
   * `run-tick.ts:252-258` builds the same intent kind for a threshold miss and is
   * guarded by `run-tick.containment-edges.test.ts`; these are two independent
   * copies of five fields, so a guard on one says nothing about the other.
   *
   * Measured, by mutation: keeping `participantId` correct but replacing `phone`
   * with `'+15550000000'` and `qty` with `1` left the entire settlement subset
   * green — 28 files / 204 tests, EXIT=0. The three-field mutation that also
   * changed `participantId` *was* caught, but only incidentally: the refund test
   * above filters `notify.intents` on `participantId === declinedId` at line 746.
   * That is a lookup key, not an assertion about the message's addressee.
   *
   * `phone` is the delivery address and `qty` is printed in the sentence
   * "your N plates cost you nothing" (`notify/copy.ts:181-191`), so neither is
   * cosmetic. Two declined diners with different quantities means a constant
   * cannot pass, and reading ground truth from `dropParticipant` means the test
   * does not vouch for its own expected values.
   *
   * Mutation matrix on this file (8 runs, pristine control included so the harness
   * proves it can report a pass, not only a fail):
   *
   * | mutation | result |
   * |---|---|
   * | pristine control | **passes, 9/9** |
   * | `phone: '+15550000000'` | **caught** |
   * | `qty: 1` | **caught** |
   * | `phone: locked.participants[0]?.phone` | **caught** |
   * | `qty: locked.participants[0]?.qty` | **caught** |
   * | `dropId: 'settle'` | **caught** |
   * | `participantId: 'settle'` | **caught** (also by the refund test's lookup) |
   * | `String(phone)` / `Number(qty)` | survives, **equivalent mutant** |
   */
  it('gives each declined diner their own phone and quantity', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });

    const bigId = await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    const smallId = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    const declineA = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    const declineB = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const port = fakeChargePort({ declineParticipantIds: [declineA, declineB] });
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });
    expect(outcome.kind).toBe('FAILED');

    const rows = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: { id: true, qty: true, customer: { select: { phone: true } } },
    });
    const byId = new Map(
      rows.map((row) => [row.id, { phone: row.customer.phone, qty: row.qty }]),
    );
    expect(byId.size).toBe(4);
    expect(byId.get(declineA)?.qty).toBe(2);
    expect(byId.get(declineB)?.qty).toBe(1);
    expect(byId.get(declineA)?.phone).not.toBe(byId.get(declineB)?.phone);

    const noCharge = notify.intents.filter(
      (intent): intent is Extract<NotifyIntent, { kind: 'DROP_FAILED_NO_CHARGE' }> =>
        intent.kind === 'DROP_FAILED_NO_CHARGE',
    );
    expect(noCharge, 'both declined diners must still be told the drop is off').toHaveLength(2);

    for (const intent of noCharge) {
      expect(intent.dropId).toBe(dropId);
      const row = byId.get(intent.participantId);
      expect(row, `intent names an unknown participant ${intent.participantId}`).toBeDefined();
      expect(intent.participantId).not.toBe(bigId);
      expect(intent.participantId).not.toBe(smallId);
      expect(intent.phone, `phone for ${intent.participantId} must be their own`).toBe(row?.phone);
      expect(intent.qty, `qty for ${intent.participantId} must be their own`).toBe(row?.qty);
    }

    expect(noCharge.map((intent) => intent.qty).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(new Set(noCharge.map((intent) => intent.phone)).size).toBe(2);
    expect(new Set(noCharge.map((intent) => intent.participantId)).size).toBe(2);
  });
});

describe('who a "card declined" message is addressed to', () => {
  /**
   * `settle.ts:990-997` builds `DROP_CONFIRMED_CARD_DECLINED` — the drop filled,
   * this diner's card did not. Everything the suite says about this intent is a
   * count or an *absence*: `settle.reconciliation.test.ts:339` and `settle.test.ts:195`
   * assert `toHaveLength`, and `participant/__tests__/settle-order-link.test.ts:197-200`
   * asserts the batch has no `orderUrl` or `redemptionCode`. Absence assertions
   * cannot distinguish a skipped path from a broken report line.
   *
   * Measured, by mutation, over the **entire suite** rather than a subset: replacing
   * all four routing fields in this constructor with
   * `dropId: 'settle'`, `participantId: 'settle'`, `phone: '+15550000000'`,
   * `qty: 1` left **200 files / 2646 tests** green (`EXIT=0`). `phone` is the SMS
   * delivery address and `qty` is printed in "your N plates could not be confirmed"
   * (`notify/copy.ts:160-169`), so a constant here sends a wrong sentence to a
   * wrong number while every test passes.
   *
   * Two declined diners with different quantities and phones mean a constant cannot
   * satisfy the guard; ground truth comes from `dropParticipant`, not from the test's
   * own literals.
   *
   * Mutation matrix on this file (8 runs, pristine control included so the harness
   * proves it can report a pass, not only a fail):
   *
   * | mutation | result |
   * |---|---|
   * | pristine control | **passes, 10/10** |
   * | `dropId: 'settle'` | **caught** |
   * | `participantId: 'settle'` | **caught** |
   * | `phone: '+15550000000'` | **caught** |
   * | `qty: 1` | **caught** |
   * | `phone: locked.participants[0]?.phone` | **caught** |
   * | `qty: locked.participants[0]?.qty` | **caught** |
   * | `String(phone)` / `Number(qty)` | survives, **equivalent mutant** |
   */
  it('gives each declined diner their own drop id, participant id, phone and quantity', async () => {
    // minQty 10 → tolerance 9. Captured 4 + 5 = 9 is enough, so the drop succeeds
    // while the two declining diners still get DROP_CONFIRMED_CARD_DECLINED.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });

    const fourPlates = await fx.participant({ dropId, qty: 4, platformFeeCents: 4 * FEE_PER_UNIT });
    const fivePlates = await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });
    const declinedTwo = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    const declinedOne = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const port = fakeChargePort({ declineParticipantIds: [declinedTwo, declinedOne] });
    const notify = recordingNotify();

    const outcome = await settle({ dropId, now: new Date(), port, notify });
    expect(outcome.kind).toBe('CAPTURED');

    const rows = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: { id: true, qty: true, customer: { select: { phone: true } } },
    });
    const byId = new Map(
      rows.map((row) => [row.id, { phone: row.customer.phone, qty: row.qty }]),
    );
    expect(byId.size).toBe(4);
    expect(byId.get(declinedTwo)?.qty).toBe(2);
    expect(byId.get(declinedOne)?.qty).toBe(1);
    expect(byId.get(declinedTwo)?.phone).not.toBe(byId.get(declinedOne)?.phone);

    const declined = notify.intents.filter(
      (intent): intent is Extract<NotifyIntent, { kind: 'DROP_CONFIRMED_CARD_DECLINED' }> =>
        intent.kind === 'DROP_CONFIRMED_CARD_DECLINED',
    );
    expect(declined, 'both declining diners must be told').toHaveLength(2);

    for (const intent of declined) {
      expect(intent.dropId).toBe(dropId);
      const row = byId.get(intent.participantId);
      expect(row, `intent names an unknown participant ${intent.participantId}`).toBeDefined();
      expect(intent.participantId).not.toBe(fourPlates);
      expect(intent.participantId).not.toBe(fivePlates);
      expect(intent.phone, `phone for ${intent.participantId} must be their own`).toBe(row?.phone);
      expect(intent.qty, `qty for ${intent.participantId} must be their own`).toBe(row?.qty);
    }

    expect(declined.map((intent) => intent.qty).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(new Set(declined.map((intent) => intent.phone)).size).toBe(2);
    expect(new Set(declined.map((intent) => intent.participantId)).size).toBe(2);
  });
});

describe('who a refund message is addressed to', () => {
  /**
   * `settle.ts:1019-1026` builds `DROP_FAILED_REFUNDED` for a diner whose card was
   * captured and then refunded. `344160d` pinned `chargedCents` here, and its lookup
   * `chargedByParticipant.get(intent.participantId)` accidentally guards
   * `participantId` too. Nothing else about the batch was in an `expect`.
   *
   * Per-field **full-suite** sweep (200 files / 2648 tests per run), one constant at a
   * time, so "guarded" is measured rather than inferred from nearby assertions:
   *
   * | mutation | result |
   * |---|---|
   * | pristine control | **passes, 2648** |
   * | `dropId: 'settle'` | **survives** |
   * | `participantId: 'settle'` | caught — 1 failure, the chargedCents lookup |
   * | `phone: '+15550000000'` | **survives** |
   * | `qty: 1` | **survives** |
   *
   * `phone` addresses the SMS; `qty` is printed in "your $X charge for N plates has
   * been refunded in full" (`copy.ts:215-217`); `dropId` is the identifier every
   * downstream consumer treats as real. Two refunded diners with different quantities
   * and phones, ground truth from `dropParticipant`, so a constant cannot pass.
   */
  it('gives each refunded diner their own drop id, phone and quantity', async () => {
    // minQty 10 → tolerance 9. Captured 3 + 2 = 5 is short, so both captures are
    // refunded and the drop fails — the only path to DROP_FAILED_REFUNDED.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const bigId = await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    const smallId = await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });

    const notify = recordingNotify();
    const outcome = await settle({ dropId, now: new Date(), port: fakeChargePort(), notify });
    expect(outcome.kind).toBe('FAILED');

    const rows = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: { id: true, qty: true, customer: { select: { phone: true } } },
    });
    const byId = new Map(
      rows.map((row) => [row.id, { phone: row.customer.phone, qty: row.qty }]),
    );
    expect(byId.size).toBe(2);
    expect(byId.get(bigId)?.qty).toBe(3);
    expect(byId.get(smallId)?.qty).toBe(2);
    expect(byId.get(bigId)?.phone).not.toBe(byId.get(smallId)?.phone);

    const refunded = notify.intents.filter(
      (intent): intent is Extract<NotifyIntent, { kind: 'DROP_FAILED_REFUNDED' }> =>
        intent.kind === 'DROP_FAILED_REFUNDED',
    );
    expect(refunded, 'both captured-then-refunded diners must be told').toHaveLength(2);

    for (const intent of refunded) {
      expect(intent.dropId).toBe(dropId);
      const row = byId.get(intent.participantId);
      expect(row, `intent names an unknown participant ${intent.participantId}`).toBeDefined();
      expect(intent.phone, `phone for ${intent.participantId} must be their own`).toBe(row?.phone);
      expect(intent.qty, `qty for ${intent.participantId} must be their own`).toBe(row?.qty);
    }

    expect(refunded.map((intent) => intent.qty).sort((a, b) => a - b)).toEqual([2, 3]);
    expect(new Set(refunded.map((intent) => intent.phone)).size).toBe(2);
    expect(new Set(refunded.map((intent) => intent.participantId)).size).toBe(2);
  });
});
