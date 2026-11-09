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
