import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { findDropsAwaitingVoid } from '../cutoff-decision';
import { fakeChargePort } from '../fake-charge-port';
import type { NotifyIntent, NotifyPort } from '../notify-port';
import { deriveRedemptionSecret, verifyRedemptionCode } from '../redemption-code';
import { runCutoffTick } from '../run-tick';
import { settle, voidRemainingAuthorisations } from '../settle';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * The two deviations the engineer made during implementation, attacked.
 *
 * ## 1. The void sweep
 *
 * Design §2.1 lists `FAILED → FAILED` (release authorisations) as a transition
 * this job performs, and §4.3 routes only `LOCKED` drops into `settle`. The
 * engineer added `findDropsAwaitingVoid` + `voidRemainingAuthorisations` to close
 * that. Both directions are exercised here:
 *
 *   - a `FAILED` drop's live authorisations really are released, and the drop
 *     stops being selected once it has none left;
 *   - the sweep **cannot** release an authorisation that a `LOCKED` drop still
 *     needs, including when the sweep is called directly with the drop id of a
 *     `LOCKED` drop, and including the mixed state (one declined participant, one
 *     still pending) that a crash mid-settlement leaves behind.
 *
 * ## 2. The repair path
 *
 * §4.2: an existing `Order` row means the charge happened, so repair
 * `chargeStatus` and skip the port. The engineer found this broke L1 (the repaired
 * order had no `CHARGE`/`PLATFORM_FEE` rows) and added a backfill with
 * `skipDuplicates`. Tested here: the repaired drop reaches `CAPTURED` with a ledger
 * that satisfies L1–L4, and a second repair over rows that already exist posts
 * nothing.
 */

const PREFIX = `qa-void${Date.now()}`;
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

async function dropIn(
  status: 'PUBLISHED' | 'LOCKED' | 'CAPTURED' | 'FAILED',
  minQty: number,
  opts: { lockedAt?: Date; cutoffAt?: Date } = {},
): Promise<string> {
  return fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty,
    status,
    lockedAt: opts.lockedAt ?? (status === 'LOCKED' || status === 'CAPTURED' ? new Date(Date.now() - 60_000) : null),
    cutoffAt: opts.cutoffAt,
  });
}

async function authStatusOf(participantId: string): Promise<string> {
  const row = await prisma.dropParticipant.findUniqueOrThrow({
    where: { id: participantId },
    select: { authStatus: true },
  });
  return row.authStatus;
}

describe('the void sweep, in the direction it is supposed to work', () => {
  it('releases every live authorisation on a FAILED drop and then stops selecting it', async () => {
    const dropId = await dropIn('FAILED', 20);
    const first = await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    const second = await fx.participant({ dropId, qty: 4, platformFeeCents: 4 * FEE_PER_UNIT });
    // A participant whose authorisation already lapsed: not work, and not an error.
    const expired = await fx.participant({
      dropId,
      qty: 1,
      platformFeeCents: FEE_PER_UNIT,
      authStatus: 'VOIDED',
    });

    expect(await findDropsAwaitingVoid({ limit: 500 })).toContain(dropId);

    const port = fakeChargePort();
    const result = await voidRemainingAuthorisations({ dropId, port });

    expect(result).toEqual({ voided: 2, alreadyExpired: 0, pending: 0 });
    expect(await authStatusOf(first)).toBe('VOIDED');
    expect(await authStatusOf(second)).toBe('VOIDED');
    expect(await authStatusOf(expired)).toBe('VOIDED');

    // The queue is derived from the data, so it must now be empty of this drop.
    expect(await findDropsAwaitingVoid({ limit: 500 })).not.toContain(dropId);

    // Idempotent: a second sweep costs one query and changes nothing.
    const again = await voidRemainingAuthorisations({ dropId, port });
    expect(again).toEqual({ voided: 0, alreadyExpired: 0, pending: 0 });
    expect(port.calls.filter((call) => call.kind === 'void')).toHaveLength(2);
    expect(port.calls.filter((call) => call.kind === 'capture')).toHaveLength(0);
  });

  it('treats an already-expired authorisation as released, not as a failure', async () => {
    const dropId = await dropIn('FAILED', 20);
    const participantId = await fx.participant({
      dropId,
      qty: 3,
      platformFeeCents: 3 * FEE_PER_UNIT,
    });
    const pi = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { paymentIntentId: true },
    });

    const port = fakeChargePort({ expiredPaymentIntentIds: [pi.paymentIntentId ?? ''] });
    const result = await voidRemainingAuthorisations({ dropId, port });

    expect(result).toEqual({ voided: 0, alreadyExpired: 1, pending: 0 });
    // The diner's money is released either way, so the row is marked released.
    expect(await authStatusOf(participantId)).toBe('VOIDED');
  });
});

describe('the void sweep, in the direction it must not work', () => {
  it('refuses a LOCKED drop even when called directly with its id', async () => {
    const dropId = await dropIn('LOCKED', 5);
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });

    const port = fakeChargePort();
    const result = await voidRemainingAuthorisations({ dropId, port });

    expect(result).toEqual({ voided: 0, alreadyExpired: 0, pending: 0 });
    expect(port.calls).toHaveLength(0);
    expect(await authStatusOf(participantId)).toBe('AUTHORIZED');

    // And the authorisation it refused to touch is still capturable.
    const outcome = await settle({ dropId, now: new Date(), port });
    expect(outcome.kind).toBe('CAPTURED');
  });

  it('cannot steal an authorisation from a LOCKED drop that is mid-settlement', async () => {
    // The state a crash mid-settlement leaves: one participant already declined
    // (`chargeStatus = FAILED`, authorisation still live because it has to be
    // cancelled), one still pending and owed a capture. A sweep that keyed on
    // `authStatus` alone would void the pending one and turn a confirmed order into
    // a silent failure.
    const dropId = await dropIn('LOCKED', 5);
    const declinedId = await fx.participant({
      dropId,
      qty: 1,
      platformFeeCents: FEE_PER_UNIT,
      chargeStatus: 'FAILED',
    });
    const pendingId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });

    const port = fakeChargePort();
    expect(await voidRemainingAuthorisations({ dropId, port })).toEqual({
      voided: 0,
      alreadyExpired: 0,
      pending: 0,
    });
    expect(await authStatusOf(pendingId)).toBe('AUTHORIZED');

    // Now let the tick do its job: the pending one is captured, the declined one
    // is released, and the drop reaches CAPTURED with 5 of 6 units.
    const result = await runCutoffTick({ now: new Date(), port });
    expect(result.settled).toBeGreaterThanOrEqual(1);

    const after = await prisma.dropParticipant.findMany({
      where: { id: { in: [declinedId, pendingId] } },
      select: { id: true, authStatus: true, chargeStatus: true },
    });
    const byId = new Map(after.map((row) => [row.id, row]));
    expect(byId.get(pendingId)?.chargeStatus).toBe('CAPTURED');
    expect(byId.get(declinedId)?.chargeStatus).toBe('FAILED');
    expect(byId.get(declinedId)?.authStatus).toBe('VOIDED');
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('CAPTURED');
  });

  it('leaves a LOCKED drop alone when its captures are temporarily unavailable', async () => {
    const dropId = await dropIn('LOCKED', 5);
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });

    const port = fakeChargePort({ unavailableOnceFor: [participantId] });
    const result = await runCutoffTick({ now: new Date(), port });

    expect(result.inProgress).toBeGreaterThanOrEqual(1);
    // The tick's void queue is `failedNow ∪ findDropsAwaitingVoid`, and this drop is
    // in neither. The hold survives, which is the whole point.
    expect(await authStatusOf(participantId)).toBe('AUTHORIZED');
    expect(port.calls.filter((call) => call.kind === 'void')).toHaveLength(0);
  });
});

describe('a CAPTURED drop whose void failed', () => {
  it('is released by the next tick rather than held until the bank lets it lapse', async () => {
    // `finaliseCaptured` sweeps after writing CAPTURED, so a transient provider
    // failure there leaves a declined diner's authorisation live. The deviation
    // added a durable queue for FAILED drops; this asserts the same queue covers
    // the CAPTURED path, because `voidRemainingAuthorisations` itself accepts both
    // statuses (settle.ts:675) — so the work queue is narrower than the guard it
    // feeds (cutoff-decision.ts:481 selects `status: 'FAILED'` only).
    const dropId = await dropIn('LOCKED', 5);
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });
    const declinedId = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const firstPort = fakeChargePort({
      declineParticipantIds: [declinedId],
      voidUnavailableOnceFor: [declinedId],
    });

    const outcome = await settle({ dropId, now: new Date(), port: firstPort });
    expect(outcome).toEqual({ kind: 'CAPTURED', dropId, capturedQty: 5, declinedQty: 1 });

    // The void timed out, so the hold is still live. This is the state under test.
    expect(await authStatusOf(declinedId)).toBe('AUTHORIZED');

    // A fresh, healthy tick: it must pick the work up and release the hold.
    const secondPort = fakeChargePort();
    await runCutoffTick({ now: new Date(), port: secondPort });

    expect(
      await authStatusOf(declinedId),
      'a declined diner on a CAPTURED drop keeps their authorisation held: no tick re-selects a CAPTURED drop, so the void is never retried',
    ).toBe('VOIDED');
  });
});

describe('the repair path', () => {
  it('reaches CAPTURED with a ledger that satisfies L1–L4, without calling the port', async () => {
    const dropId = await dropIn('LOCKED', 5);
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });
    // The crash window: the charge exists at the provider and the `Order` row was
    // written, but `chargeStatus` never moved off `NONE`.
    const order = await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty: 5,
        unitPriceCents: DEAL_PRICE,
        subtotalCents: 5 * DEAL_PRICE,
        platformFeeCents: 5 * FEE_PER_UNIT,
        stripeChargeId: 'ch_qa_from_the_crash',
      },
      select: { id: true },
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

    // The backfill wrote the two rows the repair path used to be missing, so L1
    // holds and the drop can reach a terminal state at all.
    const entries = await prisma.ledgerEntry.findMany({
      where: { orderId: order.id },
      select: { type: true, amountCents: true },
    });
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.type === 'CHARGE')?.amountCents).toBe(5 * DEAL_PRICE);
    expect(entries.find((entry) => entry.type === 'PLATFORM_FEE')?.amountCents).toBe(5 * FEE_PER_UNIT);

    const chargeSum = entries
      .filter((entry) => entry.type === 'CHARGE')
      .reduce((sum, entry) => sum + entry.amountCents, 0);
    expect(chargeSum).toBe(5 * DEAL_PRICE);
    expect(
      (await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { status: true } })).status,
    ).toBe('CAPTURED');
  });

  it('does not double-post when the repair runs over rows that already exist', async () => {
    const dropId = await dropIn('LOCKED', 5);
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });

    // The state a partially-applied repair leaves: `Order` and both ledger rows
    // committed, participant CAS lost.
    const order = await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty: 5,
        unitPriceCents: DEAL_PRICE,
        subtotalCents: 5 * DEAL_PRICE,
        platformFeeCents: 5 * FEE_PER_UNIT,
        stripeChargeId: 'ch_qa_already_posted',
      },
      select: { id: true },
    });
    await prisma.ledgerEntry.createMany({
      data: [
        { orderId: order.id, dropId, type: 'CHARGE', amountCents: 5 * DEAL_PRICE, note: 'capture' },
        { orderId: order.id, dropId, type: 'PLATFORM_FEE', amountCents: 5 * FEE_PER_UNIT, note: 'capture' },
      ],
    });

    const port = fakeChargePort();
    expect((await settle({ dropId, now: new Date(), port })).kind).toBe('CAPTURED');

    const entries = await prisma.ledgerEntry.findMany({
      where: { orderId: order.id },
      select: { type: true },
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.type).sort()).toEqual(['CHARGE', 'PLATFORM_FEE']);
    expect(await prisma.order.count({ where: { dropId } })).toBe(1);
    expect(port.calls.filter((call) => call.kind === 'capture')).toHaveLength(0);

    // Run the repair a second time from the same starting state. Reverting the two
    // columns is the only way to re-enter the repair branch, and it is exactly the
    // "the repair ran twice" case the `skipDuplicates` claim is about.
    await prisma.drop.updateMany({ where: { id: dropId }, data: { status: 'LOCKED' } });
    await prisma.dropParticipant.updateMany({
      where: { id: participantId },
      data: { chargeStatus: 'NONE' },
    });

    expect((await settle({ dropId, now: new Date(), port })).kind).toBe('CAPTURED');
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(2);
    expect(await prisma.order.count({ where: { dropId } })).toBe(1);
  });
});

/**
 * FR-505 owes a redemption code to **every** captured participant, and a repair is
 * a capture. `recordCapture` writes the code in the same transaction as the Order,
 * so a row that reaches the repair path has `chargeStatus = 'NONE'` and
 * `redemptionCode = NULL`. Before this was fixed, `settle` left it that way: the
 * diner became CAPTURED, `buildCapturedIntents` hit its `!state.redemptionCode`
 * skip, and someone whose card had been charged received neither a confirmation
 * nor any way to collect their plates.
 *
 * The two repair tests above call `settle` with no notify port and assert only
 * ledger and status facts, so the whole failure was dark. This guard supplies a
 * recorder and reads ground truth from the participant rows.
 */
describe('a repaired capture still owes its diner a code', () => {
  it('confirms the repaired diner with their own phone, amount and verifiable code', async () => {
    const dropId = await dropIn('LOCKED', 5);
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });
    // The crash window: the charge happened and its Order row was written, but the
    // participant update did not — so there is no redemption code either.
    await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty: 5,
        unitPriceCents: DEAL_PRICE,
        subtotalCents: 5 * DEAL_PRICE,
        platformFeeCents: 5 * FEE_PER_UNIT,
        stripeChargeId: 'ch_qa_repaired_without_a_code',
      },
    });

    const intents: NotifyIntent[] = [];
    const notify: NotifyPort = {
      async notify(batch) {
        intents.push(...batch);
      },
    };
    const outcome = await settle({ dropId, now: new Date(), port: fakeChargePort(), notify });
    expect(outcome.kind).toBe('CAPTURED');

    // Ground truth, read back rather than reconstructed from the fixture arguments.
    const rows = await prisma.dropParticipant.findMany({
      where: { dropId },
      select: {
        id: true,
        qty: true,
        chargeStatus: true,
        redemptionCode: true,
        customer: { select: { phone: true } },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const repaired = byId.get(participantId);
    expect(repaired, 'the repaired participant row must exist').toBeDefined();
    expect(repaired?.chargeStatus).toBe('CAPTURED');
    expect(repaired?.redemptionCode, 'FR-505: a captured diner must hold a code').toBeTruthy();
    expect(await prisma.order.count({ where: { participantId } })).toBe(1);

    const charged = intents.filter(
      (intent): intent is Extract<NotifyIntent, { kind: 'DROP_CONFIRMED_CHARGED' }> =>
        intent.kind === 'DROP_CONFIRMED_CHARGED',
    );
    expect(charged, 'a diner whose card was charged must be told').toHaveLength(1);
    for (const intent of charged) {
      expect(intent.dropId).toBe(dropId);
      const own = byId.get(intent.participantId);
      expect(own, `intent names an unknown participant ${intent.participantId}`).toBeDefined();
      expect(intent.phone).toBe(own?.customer.phone);
      expect(intent.qty).toBe(own?.qty);
      expect(intent.chargedCents).toBe((own?.qty ?? 0) * DEAL_PRICE);
      expect(intent.redemptionCode).toBe(own?.redemptionCode);
      expect(
        verifyRedemptionCode(
          intent.redemptionCode,
          deriveRedemptionSecret(process.env.JWT_SECRET ?? ''),
        ),
      ).toEqual({ participantId: intent.participantId, dropId, qty: own?.qty });
    }
  });
});
