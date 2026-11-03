import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';
import { fakeChargePort, type FakeChargePort } from '@/lib/settlement/fake-charge-port';
import type { NotifyIntent } from '@/lib/settlement/notify-port';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

import { forceFailDrop, forceFailRefusal } from '../force-fail';

/**
 * FR-902 — force-fail a drop and refund all, against real Postgres.
 *
 * ## What these tests protect, in descending order of how much it would cost to get
 * wrong
 *
 *   1. **Everybody gets their money back, and the ledger still balances.** A
 *      force-fail is the largest money-moving operation in the product: one call can
 *      refund an entire drop. `assertLedgerReconciles` runs inside it, so a drop that
 *      survives one is a drop whose L1–L4 still hold.
 *   2. **The audit row exists before a cent moves.** `writeAuditEntry` throws rather
 *      than swallowing, and the ordering is what makes that guarantee structural: if
 *      the insert fails, no provider call has happened.
 *   3. **The status is `CANCELLED`, never `FAILED`.** `FAILED` would tell every diner
 *      and every report that the drop missed its minimum — a false statement about
 *      demand printed next to a true statement about their money.
 *   4. **A `LOCKED` drop is refused.** It is mid-capture; refunding it races the
 *      settlement job and writes the ledger twice.
 *   5. **The phone number comes from the customer, not the join.** A participant row
 *      has no phone; a first draft of the service read one and would have sent every
 *      notification to `undefined`.
 */

const PREFIX = `ff${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1250;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

/** Collects intents so the copy half can be asserted without a sender. */
function recordingNotify(): { port: { notify(i: readonly NotifyIntent[]): Promise<void> }; intents: NotifyIntent[] } {
  const intents: NotifyIntent[] = [];
  return {
    intents,
    port: {
      async notify(batch) {
        intents.push(...batch);
      },
    },
  };
}

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { stripeAccountId: `acct_${PREFIX}` },
  });
});

afterAll(async () => {
  await fx.cleanup();
});

type BuiltDrop = {
  dropId: string;
  publicCode: string;
  captured: { participantId: string; orderId: string; chargeId: string; subtotalCents: number; feeCents: number }[];
  authorisedOnly: string[];
};

/**
 * A drop with `captured` orders and `holds` live authorisations.
 *
 * Built by hand for the same reason the refund tests do it: a test about force-fail
 * should not fail because capture broke. The `Order` rows and their two ledger rows
 * are exactly what `recordCapture` writes, so the ledger assertions mean something.
 */
async function builtDrop(args: {
  captured?: number;
  holds?: number;
  status?: 'PUBLISHED' | 'CAPTURED' | 'PICKUP_OPEN' | 'COMPLETED' | 'FAILED' | 'LOCKED' | 'DRAFT' | 'CANCELLED';
  qty?: number;
} = {}): Promise<BuiltDrop> {
  const qty = args.qty ?? 2;
  const capturedCount = args.captured ?? 2;
  const holdCount = args.holds ?? 0;

  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: args.status ?? 'CAPTURED',
  });
  const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { publicCode: true } });

  const captured: BuiltDrop['captured'] = [];

  for (let index = 0; index < capturedCount; index += 1) {
    const subtotalCents = qty * DEAL_PRICE;
    const feeCents = qty * FEE_PER_UNIT;
    const chargeId = `ch_${PREFIX}_${index}_${Math.random().toString(36).slice(2, 8)}`;

    const participantId = await fx.participant({
      dropId,
      qty,
      platformFeeCents: feeCents,
      chargeStatus: 'CAPTURED',
      redemptionCode: 'v1.test.test',
    });

    const order = await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty,
        unitPriceCents: DEAL_PRICE,
        subtotalCents,
        platformFeeCents: feeCents,
        stripeChargeId: chargeId,
      },
      select: { id: true },
    });

    await prisma.ledgerEntry.createMany({
      data: [
        { orderId: order.id, dropId, type: 'CHARGE', amountCents: subtotalCents, stripeRef: chargeId, note: 'capture' },
        { orderId: order.id, dropId, type: 'PLATFORM_FEE', amountCents: feeCents, stripeRef: chargeId, note: 'capture' },
      ],
    });

    captured.push({ participantId, orderId: order.id, chargeId, subtotalCents, feeCents });
  }

  const authorisedOnly: string[] = [];
  for (let index = 0; index < holdCount; index += 1) {
    authorisedOnly.push(
      await fx.participant({
        dropId,
        qty,
        chargeStatus: 'NONE',
        authStatus: 'AUTHORIZED',
      }),
    );
  }

  return { dropId, publicCode: drop.publicCode, captured, authorisedOnly };
}

/** A port that knows every charge in the drop, so the fake can report reversals. */
function portFor(built: BuiltDrop): FakeChargePort {
  const chargesByChargeId: Record<string, { chargeCents: number; feeCents: number }> = {};
  for (const entry of built.captured) {
    chargesByChargeId[entry.chargeId] = { chargeCents: entry.subtotalCents, feeCents: entry.feeCents };
  }
  return fakeChargePort({ chargesByChargeId });
}

/**
 * A real `User` row, because `AuditLog.actorUserId` is a foreign key.
 *
 * Created once per test rather than in `beforeAll` so a failing test cannot leave the
 * rest pointing at a deleted actor; `onDelete: SetNull` would silently null it and
 * the assertions about the actor would pass for the wrong reason.
 */
async function auditActor(): Promise<{ userId: string; email: string }> {
  const email = `${PREFIX}-${Math.random().toString(36).slice(2, 8)}@groupeat.test`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: 'not-a-real-hash',
      role: 'ADMIN',
    },
    select: { id: true },
  });
  return { userId: user.id, email };
}

describe('forceFailRefusal — the pure guards', () => {
  it('refuses a drop that does not exist', () => {
    expect(forceFailRefusal({ drop: null, confirmPublicCode: 'X' })).toEqual({ kind: 'NOT_FOUND' });
  });

  it('refuses a LOCKED drop, because settlement holds it', () => {
    // The one refusal that loses money rather than just failing: a refund issued
    // while the cutover job is capturing writes the ledger twice.
    expect(
      forceFailRefusal({ drop: { status: 'LOCKED', publicCode: 'ABC' }, confirmPublicCode: 'ABC' }),
    ).toEqual({ kind: 'LOCKED_MID_CAPTURE' });
  });

  it('refuses a DRAFT, which has never been published', () => {
    expect(
      forceFailRefusal({ drop: { status: 'DRAFT', publicCode: 'ABC' }, confirmPublicCode: 'ABC' }),
    ).toEqual({ kind: 'NOT_CANCELLABLE', status: 'DRAFT' });
  });

  it('refuses when the echoed public code does not match — the server half of the confirmation', () => {
    expect(
      forceFailRefusal({ drop: { status: 'CAPTURED', publicCode: 'ABC' }, confirmPublicCode: 'XYZ' }),
    ).toEqual({ kind: 'CODE_MISMATCH' });
  });

  it('permits a captured drop whose code matches', () => {
    expect(
      forceFailRefusal({ drop: { status: 'CAPTURED', publicCode: 'ABC' }, confirmPublicCode: 'ABC' }),
    ).toBeNull();
  });

  it('permits an already-CANCELLED drop, so a retry is a no-op rather than a conflict', () => {
    // The caller's first attempt may have timed out after the money moved. Reporting
    // a conflict there would invite an operator to press the button again.
    expect(
      forceFailRefusal({ drop: { status: 'CANCELLED', publicCode: 'ABC' }, confirmPublicCode: 'ABC' }),
    ).toBeNull();
  });
});

describe('force-failing a captured drop', () => {
  it('refunds every captured order and writes CANCELLED, not FAILED', async () => {
    const built = await builtDrop({ captured: 2, qty: 2 });
    const actor = await auditActor();
    const notify = recordingNotify();

    const outcome = await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'kitchen flooded',
      port: portFor(built),
      notify: notify.port,
      actor,
    });

    expect(outcome.kind).toBe('CANCELLED');
    expect(outcome.alreadyCancelled).toBe(false);
    expect(outcome.refundedParticipants).toBe(2);
    expect(outcome.refundedCents).toBe(2 * 2 * DEAL_PRICE);
    // A full refund reverses each order's whole fee.
    expect(outcome.platformFeeReversedCents).toBe(2 * 2 * FEE_PER_UNIT);

    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: built.dropId } });
    expect(drop.status).toBe('CANCELLED');

    const participants = await prisma.dropParticipant.findMany({ where: { dropId: built.dropId } });
    expect(participants.every((participant) => participant.chargeStatus === 'REFUNDED')).toBe(true);

    const orders = await prisma.order.findMany({ where: { dropId: built.dropId } });
    for (const order of orders) {
      expect(order.refundedCents).toBe(order.subtotalCents);
      expect(order.platformFeeReversedCents).toBe(order.platformFeeCents);
    }
  });

  it('leaves the ledger reconciling — L1 through L4 hold after the refunds', async () => {
    const built = await builtDrop({ captured: 3, qty: 1 });
    const actor = await auditActor();

    // `forceFailDrop` calls `assertLedgerReconciles` internally, so reaching here at
    // all is the assertion. This repeats the arithmetic from the stored rows as an
    // independent check that the internal call was not silently skipped.
    await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'gas leak',
      port: portFor(built),
      notify: recordingNotify().port,
      actor,
    });

    const entries = await prisma.ledgerEntry.findMany({ where: { dropId: built.dropId } });
    const charges = entries.filter((entry) => entry.type === 'CHARGE').reduce((t, e) => t + e.amountCents, 0);
    const refunds = entries.filter((entry) => entry.type === 'REFUND').reduce((t, e) => t + e.amountCents, 0);
    const fees = entries.filter((entry) => entry.type === 'PLATFORM_FEE').reduce((t, e) => t + e.amountCents, 0);
    const adjustments = entries.filter((entry) => entry.type === 'ADJUSTMENT').reduce((t, e) => t + e.amountCents, 0);

    // L1: charges net of refunds is the captured gross that remains — zero here.
    expect(charges + refunds).toBe(0);
    // L2: fees net of adjustments is what the platform kept — zero here.
    expect(fees + adjustments).toBe(0);
    // Refunds are stored negative; the signs are what L1 and L2 depend on.
    expect(refunds).toBeLessThan(0);
    expect(adjustments).toBeLessThan(0);
  });

  it('releases the remaining authorisations, so nobody keeps a hold on a dead drop', async () => {
    const built = await builtDrop({ captured: 1, holds: 2, qty: 1 });
    const actor = await auditActor();

    const outcome = await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'restaurant closed for the week',
      port: portFor(built),
      notify: recordingNotify().port,
      actor,
    });

    expect(outcome.voidedAuthorisations).toBe(2);

    const holds = await prisma.dropParticipant.findMany({
      where: { id: { in: built.authorisedOnly } },
    });
    expect(holds.every((participant) => participant.authStatus === 'VOIDED')).toBe(true);
    // A voided participant was never charged, so no Order row and no refund.
    expect(holds.every((participant) => participant.chargeStatus === 'NONE')).toBe(true);
  });

  it('writes the audit row BEFORE any money moves, and a second row when it completes', async () => {
    const built = await builtDrop({ captured: 1, qty: 1 });
    const actor = await auditActor();

    const outcome = await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'power cut',
      port: portFor(built),
      notify: recordingNotify().port,
      actor,
      ipAddress: '203.0.113.9',
    });

    const rows = await prisma.auditLog.findMany({
      where: { targetType: 'drop', targetId: built.dropId },
      orderBy: { createdAt: 'asc' },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.action).toBe('drop.force_fail');
    expect(rows[0]?.actorEmail).toBe(actor.email);
    expect(rows[0]?.ipAddress).toBe('203.0.113.9');

    const requested = rows[0]?.detail as Record<string, unknown>;
    expect(requested.stage).toBe('REQUESTED');
    expect(requested.reason).toBe('power cut');
    expect(requested.previousStatus).toBe('CAPTURED');
    // The intent, stated before the money moved — this is the number an operator can
    // compare against what the provider actually did.
    expect(requested.participantsToRefund).toBe(1);
    expect(requested.intendedRefundCents).toBe(DEAL_PRICE);

    const completed = rows[1]?.detail as Record<string, unknown>;
    expect(completed.stage).toBe('COMPLETED');
    expect(completed.requestedAuditId).toBe(outcome.auditId);
    expect(completed.refundedCents).toBe(DEAL_PRICE);
  });

  it('does not refund twice when the same drop is force-failed again', async () => {
    const built = await builtDrop({ captured: 1, qty: 1 });
    const actor = await auditActor();
    const port = portFor(built);

    const first = await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'first attempt',
      port,
      notify: recordingNotify().port,
      actor,
    });
    expect(first.refundedCents).toBe(DEAL_PRICE);

    const second = await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'second attempt',
      port,
      notify: recordingNotify().port,
      actor,
    });

    expect(second.alreadyCancelled).toBe(true);
    expect(second.refundedCents).toBe(0);
    expect(second.refundedParticipants).toBe(0);

    // Exactly one REFUND row, and the order's total is unchanged by the second call.
    const refunds = await prisma.ledgerEntry.findMany({
      where: { dropId: built.dropId, type: 'REFUND' },
    });
    expect(refunds).toHaveLength(1);
    const order = await prisma.order.findFirstOrThrow({ where: { dropId: built.dropId } });
    expect(order.refundedCents).toBe(DEAL_PRICE);

    // The no-op writes no audit row: two rows from the first call, none from this one.
    const rows = await prisma.auditLog.count({ where: { targetType: 'drop', targetId: built.dropId } });
    expect(rows).toBe(2);
  });

  it('refuses a LOCKED drop without moving any money', async () => {
    const built = await builtDrop({ captured: 1, qty: 1, status: 'LOCKED' });
    const actor = await auditActor();

    await expect(
      forceFailDrop({
        dropId: built.dropId,
        confirmPublicCode: built.publicCode,
        reason: 'too early',
        port: portFor(built),
        notify: recordingNotify().port,
        actor,
      }),
    ).rejects.toThrow(/being settled right now/i);

    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: built.dropId } });
    expect(drop.status).toBe('LOCKED');
    // No audit row either: the refusal is before the record, which is correct — an
    // attempt that never got past the guards has nothing to disclose.
    const rows = await prisma.auditLog.count({ where: { targetType: 'drop', targetId: built.dropId } });
    expect(rows).toBe(0);
  });

  it('refuses when the echoed public code is wrong, and refunds nothing', async () => {
    const built = await builtDrop({ captured: 1, qty: 1 });
    const actor = await auditActor();

    await expect(
      forceFailDrop({
        dropId: built.dropId,
        confirmPublicCode: 'NOT-THE-CODE',
        reason: 'wrong drop',
        port: portFor(built),
        notify: recordingNotify().port,
        actor,
      }),
    ).rejects.toMatchObject({ fieldErrors: { confirmPublicCode: expect.stringMatching(/does not match/i) } });

    const refunds = await prisma.ledgerEntry.count({ where: { dropId: built.dropId, type: 'REFUND' } });
    expect(refunds).toBe(0);
  });

  it('moves no money when the audit row cannot be written', async () => {
    // The ordering claim, asserted rather than described. `writeAuditEntry` throws
    // rather than swallowing, and its docblock says a caller must not refund everyone
    // if the record of who authorised it could not be written. That is only true if
    // the insert comes **first** — this fails if somebody moves it after the loop,
    // which is the natural thing to do when tidying the function up.
    //
    // The failure is induced honestly: `AuditLog.actorUserId` is a foreign key, so an
    // actor id with no `User` row makes the insert fail the way a real one would. A
    // `vi.spyOn` on `prisma.auditLog.create` was the first attempt and it poisoned
    // every later test in the file — Prisma's client is a proxy, and the spy's
    // restore did not put the method back.
    const built = await builtDrop({ captured: 2, qty: 1 });

    await expect(
      forceFailDrop({
        dropId: built.dropId,
        confirmPublicCode: built.publicCode,
        reason: 'power cut',
        port: portFor(built),
        notify: recordingNotify().port,
        actor: { userId: '00000000-0000-0000-0000-000000000000', email: 'ghost@groupeat.test' },
      }),
    ).rejects.toThrow();

    // No refund reached Stripe, no ledger row was written, no participant moved, and
    // the drop is untouched — the whole point of the ordering.
    const refunds = await prisma.ledgerEntry.count({ where: { dropId: built.dropId, type: 'REFUND' } });
    expect(refunds).toBe(0);

    const orders = await prisma.order.findMany({ where: { dropId: built.dropId } });
    expect(orders.every((order) => order.refundedCents === 0)).toBe(true);

    const participants = await prisma.dropParticipant.findMany({ where: { dropId: built.dropId } });
    expect(participants.every((participant) => participant.chargeStatus === 'CAPTURED')).toBe(true);

    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: built.dropId } });
    expect(drop.status).toBe('CAPTURED');
  });
});

describe('the messages', () => {
  it('says "refunded" to a diner whose card was charged and "nobody was charged" to one who was not', async () => {
    const built = await builtDrop({ captured: 1, holds: 1, qty: 1 });
    const actor = await auditActor();
    const notify = recordingNotify();

    await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'called off',
      port: portFor(built),
      notify: notify.port,
      actor,
    });

    // One intent per participant, both kinds present.
    const kinds = notify.intents.map((intent) => intent.kind).sort();
    expect(kinds).toEqual(['DROP_CANCELLED_NO_CHARGE', 'DROP_CANCELLED_REFUNDED']);

    const refunded = notify.intents.find((intent) => intent.kind === 'DROP_CANCELLED_REFUNDED');
    expect(refunded).toMatchObject({
      kind: 'DROP_CANCELLED_REFUNDED',
      chargedCents: DEAL_PRICE,
      qty: 1,
    });

    // The phone number must come from the customer relation. A draft of this service
    // read `participant.phone`, which does not exist, and would have sent every
    // message to `undefined` — this is the assertion that catches that.
    for (const intent of notify.intents) {
      expect(intent.phone).toMatch(/^\+1/);
    }
  });

  it('does not say the drop missed its minimum, which would be a false claim about demand', async () => {
    const built = await builtDrop({ captured: 1, qty: 1 });
    const actor = await auditActor();
    const notify = recordingNotify();

    await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'called off',
      port: portFor(built),
      notify: notify.port,
      actor,
    });

    const { compose } = await import('@/lib/notify/compose-port');
    const message = compose(notify.intents[0]!);
    expect(message?.body).toContain('called off');
    expect(message?.body).not.toMatch(/reach|minimum|didn't run/i);
    expect(message?.body).toContain('refunded in full');
  });
});

describe('a drop that had already been partly refunded by hand', () => {
  it('skips the already-refunded participant and still cancels the drop', async () => {
    // The realistic sequence: an operator refunds one diner through FR-903 while
    // investigating a complaint, then calls the whole drop off. A second refund would
    // hit `@@unique([orderId, type])`, so the path must count it as done.
    const built = await builtDrop({ captured: 2, qty: 1 });
    const actor = await auditActor();

    const first = built.captured[0]!;
    await prisma.order.update({
      where: { id: first.orderId },
      data: { refundedCents: first.subtotalCents, platformFeeReversedCents: first.feeCents },
    });
    await prisma.dropParticipant.update({
      where: { id: first.participantId },
      data: { chargeStatus: 'REFUNDED' },
    });
    await prisma.ledgerEntry.createMany({
      data: [
        { orderId: first.orderId, dropId: built.dropId, type: 'REFUND', amountCents: -first.subtotalCents, stripeRef: first.chargeId, note: 'manual' },
        { orderId: first.orderId, dropId: built.dropId, type: 'ADJUSTMENT', amountCents: -first.feeCents, stripeRef: first.chargeId, note: 'manual' },
      ],
    });

    const outcome = await forceFailDrop({
      dropId: built.dropId,
      confirmPublicCode: built.publicCode,
      reason: 'calling the rest off',
      port: portFor(built),
      notify: recordingNotify().port,
      actor,
    });

    // Only the second participant's order needed a refund now.
    expect(outcome.refundedParticipants).toBe(1);
    expect(outcome.refundedCents).toBe(DEAL_PRICE);
    // The earlier one is reported separately and never folded into the figure above.
    // An operator comparing `refundedCents` against what Stripe returned for *this*
    // call must get a number that means what it says.
    expect(outcome.alreadyRefundedParticipants).toBe(1);
    expect(outcome.alreadyRefundedCents).toBe(DEAL_PRICE);

    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: built.dropId } });
    expect(drop.status).toBe('CANCELLED');

    // Exactly two REFUND rows: one manual, one from this call.
    const refunds = await prisma.ledgerEntry.count({ where: { dropId: built.dropId, type: 'REFUND' } });
    expect(refunds).toBe(2);
  });
});
