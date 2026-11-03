import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';
import { fakeChargePort, type FakeChargePort } from '@/lib/settlement/fake-charge-port';
import { proportionalApplicationFeeRefund } from '@/lib/settlement/fake-charge-port';

import { issueParticipantRefund, refusalFor } from '../participant-refund';
import { type SettlementFixtures, settlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * FR-903 — a partial refund of one participant, against real Postgres.
 *
 * ## What these tests are actually protecting
 *
 * Three things, in descending order of how easy they are to get wrong:
 *
 *   1. **The reversed fee is Stripe's number.** A partial refund must record the
 *      proportional reversal, not the whole fee. The old `refundEntries` wrote the
 *      whole fee and this is the path that would have exposed it.
 *   2. **The ledger still reconciles afterwards.** A refund is the one operation
 *      that changes both sides of L1–L4 outside settlement, so it re-asserts them.
 *   3. **A second refund is refused, not attempted.** The unique index would throw
 *      a Prisma error; an operator needs a sentence.
 *
 * Every fixture is built to a `CAPTURED` order because that is the only state a
 * refund can start from — the guards are exercised separately through `refusalFor`,
 * which is pure and needs no database.
 */

const PREFIX = `refund${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

/**
 * The acting admin, as a real `User` row.
 *
 * Created rather than stubbed because `AuditLog.actorUserId` is a foreign key since
 * FR-902. Gap 13 gave this path an audit row, and the row's first act was to reject a
 * fabricated actor id — which is the constraint doing its job: an audit trail naming a
 * user who does not exist is not a record of anything.
 */
const ACTOR = {
  actorId: '',
  actorEmail: `${PREFIX}-admin@groupeat.test`,
  reason: 'test refund',
};

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);

  const user = await prisma.user.create({
    data: { email: ACTOR.actorEmail, passwordHash: 'not-a-real-hash', role: 'ADMIN' },
    select: { id: true },
  });
  ACTOR.actorId = user.id;
});

afterAll(async () => {
  await fx.cleanup();
});

/**
 * A drop that has already settled as `CAPTURED`, with one captured participant and
 * the `Order` + two ledger rows settlement would have written.
 *
 * Built by hand rather than by running `settle()`, for the same reason the
 * settlement fixtures bypass `publishDrop`: a test about refunds should not fail
 * because capture broke.
 */
async function capturedOrder(args: {
  qty?: number;
  dropStatus?: 'CAPTURED' | 'PICKUP_OPEN' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'LOCKED';
  chargeStatus?: 'CAPTURED' | 'REFUNDED' | 'FAILED' | 'NONE';
  refundedCents?: number;
  stripeAccountId?: string | null;
} = {}): Promise<{
  dropId: string;
  participantId: string;
  orderId: string;
  chargeId: string;
  subtotalCents: number;
  platformFeeCents: number;
}> {
  const qty = args.qty ?? 2;
  const subtotalCents = qty * DEAL_PRICE;
  const platformFeeCents = qty * FEE_PER_UNIT;
  const chargeId = `ch_${PREFIX}_${Math.random().toString(36).slice(2, 10)}`;

  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: args.dropStatus ?? 'CAPTURED',
  });

  const participantId = await fx.participant({
    dropId,
    qty,
    platformFeeCents,
    chargeStatus: args.chargeStatus ?? 'CAPTURED',
    redemptionCode: 'v1.test.test',
  });

  const order = await prisma.order.create({
    data: {
      dropId,
      participantId,
      qty,
      unitPriceCents: DEAL_PRICE,
      subtotalCents,
      platformFeeCents,
      stripeChargeId: chargeId,
      refundedCents: args.refundedCents ?? 0,
    },
    select: { id: true },
  });

  await prisma.ledgerEntry.createMany({
    data: [
      { orderId: order.id, dropId, type: 'CHARGE', amountCents: subtotalCents, stripeRef: chargeId, note: 'capture' },
      { orderId: order.id, dropId, type: 'PLATFORM_FEE', amountCents: platformFeeCents, stripeRef: chargeId, note: 'capture' },
    ],
  });

  if (args.stripeAccountId !== undefined) {
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { stripeAccountId: args.stripeAccountId },
    });
  }

  return { dropId, participantId, orderId: order.id, chargeId, subtotalCents, platformFeeCents };
}

/** A port that knows the charge, so the fake can report a proportional reversal. */
function portFor(args: { chargeId: string; subtotalCents: number; platformFeeCents: number }): FakeChargePort {
  return fakeChargePort({
    chargesByChargeId: {
      [args.chargeId]: { chargeCents: args.subtotalCents, feeCents: args.platformFeeCents },
    },
  });
}

/**
 * The acting admin, and the stated reason — see the declaration at the top of this
 * file. Spread into every call so a test cannot assert an audit row naming a different
 * actor than the one it passed, which would be asserting a bug.
 */

describe('a full refund, by an admin', () => {
  it('refunds the whole order and records a REFUND and a matching ADJUSTMENT', async () => {
    const fixture = await capturedOrder({ qty: 2 });
    const port = portFor(fixture);

    const outcome = await issueParticipantRefund({
      participantId: fixture.participantId,
      port,
      ...ACTOR,
      reason: 'restaurant closed early',
    });

    expect(outcome.kind).toBe('REFUNDED');
    expect(outcome.refundedCents).toBe(fixture.subtotalCents);
    // A full refund reverses the whole fee.
    expect(outcome.platformFeeReversedCents).toBe(fixture.platformFeeCents);

    const entries = await prisma.ledgerEntry.findMany({
      where: { orderId: fixture.orderId },
      orderBy: { type: 'asc' },
    });
    expect(entries.map((entry) => entry.type).sort()).toEqual(['ADJUSTMENT', 'CHARGE', 'PLATFORM_FEE', 'REFUND']);

    const refundRow = entries.find((entry) => entry.type === 'REFUND');
    const adjustmentRow = entries.find((entry) => entry.type === 'ADJUSTMENT');
    expect(refundRow?.amountCents).toBe(-fixture.subtotalCents);
    expect(adjustmentRow?.amountCents).toBe(-fixture.platformFeeCents);

    // The order's own totals moved with it — the other side of L1–L4.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } });
    expect(order.refundedCents).toBe(fixture.subtotalCents);
    expect(order.platformFeeReversedCents).toBe(fixture.platformFeeCents);

    const participant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: fixture.participantId },
    });
    expect(participant.chargeStatus).toBe('REFUNDED');
  });
});

describe('a partial refund, by an admin', () => {
  it('records the proportional fee reversal Stripe reported, not the whole fee', async () => {
    const fixture = await capturedOrder({ qty: 2 });
    const half = fixture.subtotalCents / 2;
    const port = portFor(fixture);

    const outcome = await issueParticipantRefund({
      participantId: fixture.participantId,
      amountCents: half,
      port,
      ...ACTOR,
    });

    // The number Stripe's model produces, which is the number the ledger must hold.
    const expectedReversal = proportionalApplicationFeeRefund({
      chargedCents: fixture.subtotalCents,
      feeCents: fixture.platformFeeCents,
      refundCents: half,
    });

    expect(outcome.refundedCents).toBe(half);
    expect(outcome.platformFeeReversedCents).toBe(expectedReversal);

    // THE regression assertion. The whole fee would be `fixture.platformFeeCents`;
    // on this repo's 8% fee that is roughly double the true reversal, and the
    // surplus would sit in ADJUSTMENT where nothing else looks.
    expect(outcome.platformFeeReversedCents).toBeLessThan(fixture.platformFeeCents);
    expect(outcome.platformFeeReversedCents).toBeGreaterThan(0);

    const adjustment = await prisma.ledgerEntry.findFirstOrThrow({
      where: { orderId: fixture.orderId, type: 'ADJUSTMENT' },
    });
    expect(adjustment.amountCents).toBe(-expectedReversal);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } });
    expect(order.refundedCents).toBe(half);
    expect(order.platformFeeReversedCents).toBe(expectedReversal);
  });

  it('still reconciles L1–L4, where the boolean ledger could not', async () => {
    // The point of the numeric identities: a half-refunded order is neither refunded
    // nor not, and `issueParticipantRefund` re-asserts the identities itself, so a
    // reconciliation failure here would throw out of the call.
    const fixture = await capturedOrder({ qty: 3 });
    const port = portFor(fixture);

    await expect(
      issueParticipantRefund({
        participantId: fixture.participantId,
        amountCents: Math.floor(fixture.subtotalCents / 3),
        port,
        ...ACTOR,
      }),
    ).resolves.toMatchObject({ kind: 'REFUNDED' });
  });

  it('leaves the participant as REFUNDED, so the code cannot be redeemed', async () => {
    // `redeem.ts` refuses REFUNDED and PARTIALLY_REFUNDED alike — but a partial
    // refund sets REFUNDED here on purpose: the order is closed, and V1 does not
    // model "some food is still theirs".
    const fixture = await capturedOrder({ qty: 2 });
    const port = portFor(fixture);

    await issueParticipantRefund({
      participantId: fixture.participantId,
      amountCents: 100,
      port,
      ...ACTOR,
    });

    const participant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: fixture.participantId },
    });
    expect(participant.chargeStatus).toBe('REFUNDED');
  });
});

describe('the guards', () => {
  it('refuses a second refund with a sentence, not a constraint violation', async () => {
    const fixture = await capturedOrder({ qty: 1 });
    const port = portFor(fixture);

    await issueParticipantRefund({ participantId: fixture.participantId, port, ...ACTOR });

    // Same participant again. The unique index on (orderId, type) would throw a
    // Prisma error; the guard must answer first.
    await expect(
      issueParticipantRefund({ participantId: fixture.participantId, port, ...ACTOR }),
    ).rejects.toThrow(/already been refunded/i);

    // And no second REFUND row exists.
    expect(
      await prisma.ledgerEntry.count({ where: { orderId: fixture.orderId, type: 'REFUND' } }),
    ).toBe(1);
  });

  it('refuses a refund on a participant who was never charged', async () => {
    const fixture = await capturedOrder({ qty: 1, chargeStatus: 'NONE' });
    // A row with no Order is a participant whose card was only ever held.
    await prisma.order.delete({ where: { id: fixture.orderId } });

    await expect(
      issueParticipantRefund({
        participantId: fixture.participantId,
        port: fakeChargePort(),
        ...ACTOR,
      }),
    ).rejects.toThrow(/never charged/i);
  });

  it('refuses a refund on a drop that is still LOCKED', async () => {
    const fixture = await capturedOrder({ qty: 1, dropStatus: 'LOCKED' });

    await expect(
      issueParticipantRefund({
        participantId: fixture.participantId,
        port: portFor(fixture),
        ...ACTOR,
      }),
    ).rejects.toThrow(/not finished settling/i);
  });

  it('refuses an amount larger than the charge, and names the charge', async () => {
    const fixture = await capturedOrder({ qty: 1 });

    // The sentence that names the amount is a field error, not the `publicMessage`:
    // `AppError.validation` carries the generic "check the values" line and puts
    // the specific one next to the field the operator can fix.
    await expect(
      issueParticipantRefund({
        participantId: fixture.participantId,
        amountCents: fixture.subtotalCents + 1,
        port: portFor(fixture),
        ...ACTOR,
      }),
    ).rejects.toMatchObject({
      fieldErrors: { amountCents: expect.stringMatching(/more than the .* originally charged/i) },
    });
  });

  it('refuses a zero or fractional amount', async () => {
    const fixture = await capturedOrder({ qty: 1 });

    await expect(
      issueParticipantRefund({
        participantId: fixture.participantId,
        amountCents: 0,
        port: portFor(fixture),
        ...ACTOR,
      }),
    ).rejects.toMatchObject({
      fieldErrors: { amountCents: expect.stringMatching(/greater than zero/i) },
    });

    await expect(
      issueParticipantRefund({
        participantId: fixture.participantId,
        amountCents: 12.5,
        port: portFor(fixture),
        ...ACTOR,
      }),
    ).rejects.toMatchObject({
      fieldErrors: { amountCents: expect.stringMatching(/greater than zero/i) },
    });
  });

  it('404s an unknown participant rather than 403', async () => {
    // `authorize.ts`'s rule: a foreign resource id must not be distinguishable from
    // a missing one.
    await expect(
      issueParticipantRefund({
        participantId: '00000000-0000-0000-0000-000000000000',
        port: fakeChargePort(),
        ...ACTOR,
      }),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe('refusalFor, without a database', () => {
  const base = {
    id: 'p1',
    dropId: 'd1',
    qty: 1,
    amountCents: 1112,
    chargeStatus: 'CAPTURED',
    dropStatus: 'CAPTURED',
    stripeAccountId: 'acct_1',
    order: {
      id: 'o1',
      subtotalCents: 1112,
      platformFeeCents: 89,
      stripeChargeId: 'ch_1',
      refundedCents: 0,
    },
  };

  it('allows a capture on a settled drop', () => {
    expect(refusalFor(base)).toBeNull();
  });

  it('refuses a captured order that already carries a refund total', () => {
    // The half-finished-transaction case: `chargeStatus` still says CAPTURED but the
    // order already moved. Attempting the refund would hit the unique index.
    const refusal = refusalFor({ ...base, order: { ...base.order, refundedCents: 500 } });
    expect(refusal?.publicMessage).toMatch(/already carries a refund/i);
  });

  it('refuses a captured order with no charge reference, and says to escalate', () => {
    const refusal = refusalFor({ ...base, order: { ...base.order, stripeChargeId: null } });
    expect(refusal?.publicMessage).toMatch(/escalate/i);
  });

  it('refuses when the merchant has no connected account', () => {
    expect(refusalFor({ ...base, stripeAccountId: null })?.publicMessage).toMatch(/connected Stripe account/i);
  });

  it('tells a declined card apart from an already-refunded one', () => {
    // One sentence for both would send an operator looking for money that never
    // left, or for a refund that already happened. They are different facts.
    expect(refusalFor({ ...base, chargeStatus: 'FAILED' })?.publicMessage).toMatch(/never successfully charged/i);
    expect(refusalFor({ ...base, chargeStatus: 'REFUNDED' })?.publicMessage).toMatch(/already been refunded/i);
  });
});

/**
 * Gap 13 — the audit trail this path never wrote.
 *
 * `AuditLog` has existed since FR-902 and `AuditAction` has declared
 * `'participant.refund'` since the same commit, but `issueParticipantRefund` wrote no
 * row for four slices. The omission was invisible to the type system because the union
 * member was simply unused, and invisible to the suite because nothing asserted a row
 * existed. Both halves of that are now closed.
 *
 * The ordering is the load-bearing part, and it is the same argument `forceFailDrop`
 * makes: `writeAuditEntry` throws rather than swallowing, so writing the record
 * **before** `port.refund` turns "no unaudited refund" into a structural guarantee. If
 * the insert fails, the provider was never called.
 */
describe('the audit trail, which this path did not have', () => {
  async function rowsFor(participantId: string) {
    return prisma.auditLog.findMany({
      where: { action: 'participant.refund', targetId: participantId },
      orderBy: { createdAt: 'asc' },
      select: { detail: true, actorEmail: true, actorUserId: true, targetType: true },
    });
  }

  it('writes two rows — what was asked and what moved', async () => {
    const fixture = await capturedOrder({ qty: 2 });
    const port = portFor(fixture);

    await issueParticipantRefund({
      participantId: fixture.participantId,
      port,
      ...ACTOR,
      reason: 'wrong dish',
    });

    const rows = await rowsFor(fixture.participantId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.targetType).toBe('participant');

    const requested = rows[0]?.detail as Record<string, unknown>;
    const completed = rows[1]?.detail as Record<string, unknown>;

    expect(requested.stage).toBe('REQUESTED');
    expect(requested.reason).toBe('wrong dish');
    expect(requested.requestedCents).toBe(fixture.subtotalCents);

    expect(completed.stage).toBe('COMPLETED');
    // The request row's id, so "asked" and "done" are linkable rather than merely
    // adjacent in a timestamp order that two concurrent refunds would interleave.
    expect(completed.requestedAuditId).toBeDefined();
    expect(completed.outcome).toBe('REFUNDED');
    expect(completed.refundedCents).toBe(fixture.subtotalCents);
  });

  it('records the actor’s email as well as the id, because the id can be deleted', async () => {
    const fixture = await capturedOrder({ qty: 1 });
    await issueParticipantRefund({
      participantId: fixture.participantId,
      port: portFor(fixture),
      ...ACTOR,
      reason: 'wrong dish',
    });

    const rows = await rowsFor(fixture.participantId);
    // `actorUserId` is `onDelete: SetNull`, so the email is what survives. Asserting
    // both is what stops somebody "simplifying" the denormalised column away.
    expect(rows[0]?.actorUserId).toBe(ACTOR.actorId);
    expect(rows[0]?.actorEmail).toBe(ACTOR.actorEmail);
  });

  it('writes the record before any provider call, so a failed insert moves no money', async () => {
    const fixture = await capturedOrder({ qty: 1 });

    // A port that fails the test if it is ever reached. This is the ordering
    // assertion stated as a trap rather than as a comment: if the audit insert moved
    // below the provider call, this test would still pass while the ordering claim
    // became false — so the probe below is what actually guards it.
    let providerCalls = 0;
    const watchingPort = portFor(fixture);
    const original = watchingPort.refund.bind(watchingPort);
    watchingPort.refund = async (args) => {
      providerCalls += 1;
      return original(args);
    };

    // Delete the actor mid-flight so the FK insert fails: the refund must not happen.
    const doomed = await prisma.user.create({
      data: { email: `${PREFIX}-doomed@groupeat.test`, passwordHash: 'x', role: 'ADMIN' },
      select: { id: true },
    });
    await prisma.user.delete({ where: { id: doomed.id } });

    await expect(
      issueParticipantRefund({
        participantId: fixture.participantId,
        port: watchingPort,
        actorId: doomed.id,
        actorEmail: `${PREFIX}-doomed@groupeat.test`,
        reason: 'should never get this far',
      }),
    ).rejects.toThrow();

    // The whole point: the provider was never called, and no ledger row was written.
    expect(providerCalls).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { orderId: fixture.orderId } })).toBe(2);
    expect(await rowsFor(fixture.participantId)).toHaveLength(0);
  });
});
