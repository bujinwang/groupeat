import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { redeemCode } from '@/lib/redemption/redeem';
import { signRedemptionCode } from '@/lib/settlement/redemption-code';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

import { applyPickupTransition, findPickupDue } from '../pickup-window';

/**
 * The end-to-end claim: a paid order becomes collectable, and only when it should.
 *
 * ## Why this file is the important one
 *
 * `pickup-window.test.ts` proves the arithmetic. It cannot prove that
 * `redeemCode` — which reads `isRedeemableStatus(drop.status)` and **no clock at
 * all** — actually changes its answer when the status moves. That is the whole
 * point of writing the status: if redemption still refused after a transition, the
 * module would be a very well-argued no-op.
 *
 * So this test does the thing a diner does: it asks the scanner. Before the
 * transition the code is refused with `NOT_YET`; after it, the same code with the
 * same participant is accepted. Nothing else changes between the two calls except
 * the drop's status — which is what makes the comparison evidence.
 *
 * ## The regression it locks down
 *
 * Before this module existed, the "after" half of that test could not be written at
 * all, because nothing in the build ever produced `PICKUP_OPEN`. A drop that
 * captured successfully sat in `CAPTURED` forever and every scan was `NOT_YET` —
 * money taken, food never handed over, and no error anywhere to notice it by.
 */

const PREFIX = `pk${Date.now().toString(36).slice(-6)}`;

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;
let userId: string;

/**
 * A drop in `CAPTURED` with a paid participant holding a real signed code.
 *
 * The code is signed with the real key rather than a fixture string, because
 * `redeemCode` verifies the signature first: a fake code would be refused with
 * `BAD_CODE` and the test would pass for the wrong reason — asserting nothing about
 * the status at all.
 */
async function capturedDrop(args: {
  windowStartOffsetMs: number;
  windowEndOffsetMs: number;
}): Promise<{ dropId: string; participantId: string; code: string }> {
  const now = Date.now();
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1250,
    minQty: 2,
    maxQty: 10,
    status: 'CAPTURED',
    cutoffAt: new Date(now - 4 * 60 * 60 * 1000),
    windowStart: new Date(now + args.windowStartOffsetMs),
    windowEnd: new Date(now + args.windowEndOffsetMs),
    lockedAt: new Date(now - 4 * 60 * 60 * 1000),
  });

  const participantId = await fx.participant({
    dropId,
    qty: 2,
    chargeStatus: 'CAPTURED',
    redemptionCode: null,
  });

  const code = signRedemptionCode({ participantId, dropId, qty: 2 });
  await prisma.dropParticipant.update({
    where: { id: participantId },
    data: { redemptionCode: code },
  });

  return { dropId, participantId, code };
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant('acct_test_pickup');
  itemId = await fx.item(merchantId);

  const owner = await prisma.merchantUser.findFirstOrThrow({
    where: { merchantId, role: 'OWNER' },
    select: { userId: true },
  });
  userId = owner.userId;
});

afterAll(async () => {
  await fx.cleanup();
});

describe('the transition is what makes a code collectable', () => {
  it('refuses the scan before, accepts the same scan after', async () => {
    // The window is open right now, but the drop is still `CAPTURED` — the exact
    // state this build was stuck in.
    const { dropId, participantId, code } = await capturedDrop({
      windowStartOffsetMs: -30 * 60 * 1000,
      windowEndOffsetMs: 90 * 60 * 1000,
    });

    const before = await redeemCode({ code, merchantIds: [merchantId], userId });
    expect(before.kind).toBe('REFUSED');
    if (before.kind !== 'REFUSED') throw new Error('expected REFUSED');
    // `NOT_YET` is the refusal that means "the window has not opened" — shown here
    // to a diner who is standing inside it. That mismatch is the defect.
    expect(before.reason).toBe('NOT_YET');

    const now = new Date();
    const due = await findPickupDue({ now, limit: 50 });
    expect(due.find((item) => item.dropId === dropId)).toEqual({
      dropId,
      transition: 'OPENED',
    });

    expect(await applyPickupTransition({ dropId, transition: 'OPENED', now })).toBe(true);

    const after = await redeemCode({ code, merchantIds: [merchantId], userId });
    expect(after.kind).toBe('REDEEMED');
    if (after.kind !== 'REDEEMED') throw new Error('expected REDEEMED');
    expect(after.taken).toBe(2);

    // And the plates really moved, in the row the manifest reads.
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { redeemedQty: true },
    });
    expect(row.redeemedQty).toBe(2);
  });

  it('writes completedAt on COMPLETED and not on OPENED', async () => {
    // `completedAt` answers "when did this drop end". Writing it on the open
    // transition would make it answer "when did it start", and on the skip path
    // (window already past) it would equal `windowStart` — a number true of nothing.
    const opened = await capturedDrop({
      windowStartOffsetMs: -30 * 60 * 1000,
      windowEndOffsetMs: 10 * 60 * 1000,
    });
    const now = new Date();

    await applyPickupTransition({ dropId: opened.dropId, transition: 'OPENED', now });
    expect(
      (
        await prisma.drop.findUniqueOrThrow({
          where: { id: opened.dropId },
          select: { completedAt: true, status: true },
        })
      ).completedAt,
    ).toBeNull();

    await applyPickupTransition({
      dropId: opened.dropId,
      transition: 'COMPLETED',
      now: new Date(now.getTime() + 20 * 60 * 1000),
    });
    const closed = await prisma.drop.findUniqueOrThrow({
      where: { id: opened.dropId },
      select: { completedAt: true, status: true },
    });
    expect(closed.status).toBe('COMPLETED');
    expect(closed.completedAt).not.toBeNull();
  });

  it('refuses the scan again once COMPLETED and the window has elapsed', async () => {
    // A code shown after pickup ends is a code that cannot be honoured. The diner's
    // page hides it (order-view.ts); the scanner must agree.
    const { dropId, code } = await capturedDrop({
      windowStartOffsetMs: -8 * 60 * 60 * 1000,
      windowEndOffsetMs: -1 * 60 * 60 * 1000,
    });

    const now = new Date();
    const due = await findPickupDue({ now, limit: 50 });
    expect(due.find((item) => item.dropId === dropId)?.transition).toBe('COMPLETED');
    await applyPickupTransition({ dropId, transition: 'COMPLETED', now });

    const after = await redeemCode({ code, merchantIds: [merchantId], userId });
    expect(after.kind).toBe('REFUSED');
  });
});

describe('the queries and writes are guarded', () => {
  it('does not select a drop whose window has not opened', async () => {
    const future = await capturedDrop({
      windowStartOffsetMs: 2 * 60 * 60 * 1000,
      windowEndOffsetMs: 4 * 60 * 60 * 1000,
    });

    const due = await findPickupDue({ now: new Date(), limit: 50 });

    expect(due.find((item) => item.dropId === future.dropId)).toBeUndefined();
  });

  it('does not select a FAILED drop even though its windowStart is in the past', async () => {
    // The dangerous selection: a failed drop has real dates. Opening it would make
    // unpaid orders collectable, so the status filter is the guard.
    const now = Date.now();
    const failedId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1250,
      minQty: 2,
      status: 'FAILED',
      cutoffAt: new Date(now - 4 * 60 * 60 * 1000),
      windowStart: new Date(now - 60 * 60 * 1000),
      windowEnd: new Date(now + 60 * 60 * 1000),
    });

    const due = await findPickupDue({ now: new Date(), limit: 50 });
    expect(due.find((item) => item.dropId === failedId)).toBeUndefined();
  });

  it('reports false when the row is not in the from-status, without throwing', async () => {
    // Two ticks racing: the loser must report "someone else did it", not crash and
    // not write again. This also covers the manual data fix that moves a row
    // between the read and the write.
    const { dropId } = await capturedDrop({
      windowStartOffsetMs: -30 * 60 * 1000,
      windowEndOffsetMs: 90 * 60 * 1000,
    });
    const now = new Date();

    expect(await applyPickupTransition({ dropId, transition: 'OPENED', now })).toBe(true);
    expect(await applyPickupTransition({ dropId, transition: 'OPENED', now })).toBe(false);

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('PICKUP_OPEN');
  });

  it('cannot complete a drop that never opened, except via the skip path', async () => {
    // `COMPLETED` requires `PICKUP_OPEN` as its from-status. A direct
    // `CAPTURED → COMPLETED` write is refused by the guard — the skip path goes
    // through `findPickupDue`, which returns `COMPLETED` *and* the caller writes it
    // from `CAPTURED`, so that one case is handled by the caller choosing the right
    // transition, not by loosening the guard.
    const { dropId } = await capturedDrop({
      windowStartOffsetMs: -30 * 60 * 1000,
      windowEndOffsetMs: 90 * 60 * 1000,
    });

    expect(
      await applyPickupTransition({ dropId, transition: 'COMPLETED', now: new Date() }),
    ).toBe(false);
  });
});
