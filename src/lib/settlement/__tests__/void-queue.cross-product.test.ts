import 'dotenv/config';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';

import { findDropsAwaitingVoid } from '../cutoff-decision';
import { fakeChargePort } from '../fake-charge-port';
import { settle, voidRemainingAuthorisations } from '../settle';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * Round 2 — the fix in `358f59d`, attacked.
 *
 * The fix widened `findDropsAwaitingVoid` from `status: 'FAILED'` to
 * `['FAILED', 'CAPTURED']` and, because a captured participant keeps
 * `authStatus = 'AUTHORIZED'` for ever, tightened the participant predicate to
 * `authStatus = 'AUTHORIZED' AND chargeStatus IN ('NONE', 'FAILED')`.
 *
 * Narrowing a queue predicate is how work gets silently dropped, so this file does
 * not check that the predicate matches the sweep — it does, by construction, and
 * that is the weakest possible test. It checks the predicate against an
 * **independently stated** judgement of when an authorisation actually needs
 * releasing, over the whole `authStatus × chargeStatus` grid, and then checks that
 * the queue still drains and cannot be starved.
 */

const PREFIX = `qx${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

const AUTH_STATUSES = ['PENDING', 'AUTHORIZED', 'FAILED', 'VOIDED', 'EXPIRED'] as const;
const CHARGE_STATUSES = ['NONE', 'CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED'] as const;

type AuthStatus = (typeof AUTH_STATUSES)[number];
type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/**
 * Does a live hold at the provider exist that nothing is going to use?
 *
 * Stated as a fact about the *provider*, not about our filter — that is the whole
 * point of writing it out:
 *
 *   - `authStatus` must be `AUTHORIZED`. `PENDING` has not been confirmed, so there
 *     is no hold; `FAILED` never held; `VOIDED` and `EXPIRED` are already released.
 *     No row in any of those four states has money held against it, whatever
 *     `chargeStatus` says.
 *   - `chargeStatus = 'NONE'` — nothing was attempted, so the hold is untouched.
 *   - `chargeStatus = 'FAILED'` — the capture was *declined*. A decline does not
 *     release the authorisation; the issuer keeps the hold until someone cancels
 *     it. This is the case the sweep exists for.
 *   - `chargeStatus = 'CAPTURED' | 'REFUNDED' | 'PARTIALLY_REFUNDED'` — all three
 *     are downstream of a successful capture, and a capture *consumes* the
 *     authorisation. There is nothing left to cancel; a void call would be wrong.
 */
function holdNeedsReleasing(auth: AuthStatus, charge: ChargeStatus): boolean {
  if (auth !== 'AUTHORIZED') {
    return false;
  }
  return charge === 'NONE' || charge === 'FAILED';
}

/**
 * Combinations the application can actually produce.
 *
 * The three post-capture charge states imply the authorisation was consumed by a
 * capture, which the application only performs from `AUTHORIZED`; the DB permits
 * the other combinations but no code path writes them. They are still asserted
 * below, because the queue is a query and does not get to assume.
 */
function reachable(auth: AuthStatus, charge: ChargeStatus): boolean {
  if (charge === 'CAPTURED' || charge === 'REFUNDED' || charge === 'PARTIALLY_REFUNDED') {
    return auth === 'AUTHORIZED';
  }
  return true;
}

async function dropIn(status: 'CAPTURED' | 'FAILED', args: { cutoffAt?: Date; minQty?: number } = {}): Promise<string> {
  return fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: args.minQty ?? 5,
    status,
    cutoffAt: args.cutoffAt,
    lockedAt: new Date(Date.now() - 60_000),
  });
}

/** Drops created by the grid test, drained afterwards so later tests see a clean queue. */
const gridDropIds: string[] = [];

afterEach(async () => {
  if (gridDropIds.length === 0) {
    return;
  }
  // Release every hold the grid created, so the starvation tests below are not
  // reading a queue this file filled with artificial work.
  await prisma.dropParticipant.updateMany({
    where: { dropId: { in: gridDropIds } },
    data: { authStatus: 'VOIDED' },
  });
  gridDropIds.length = 0;
});

describe('the cross product: does any live authorisation escape the queue?', () => {
  it('selects exactly the combinations that hold money, over all 25 pairs and both terminal statuses', async () => {
    const observed: {
      status: 'CAPTURED' | 'FAILED';
      auth: AuthStatus;
      charge: ChargeStatus;
      needsVoid: boolean;
      selected: boolean;
    }[] = [];

    for (const status of ['CAPTURED', 'FAILED'] as const) {
      for (const auth of AUTH_STATUSES) {
        for (const charge of CHARGE_STATUSES) {
          const dropId = await dropIn(status);
          gridDropIds.push(dropId);
          await fx.participant({
            dropId,
            qty: 1,
            platformFeeCents: FEE_PER_UNIT,
            authStatus: auth,
            chargeStatus: charge,
          });
          observed.push({ status, auth, charge, needsVoid: holdNeedsReleasing(auth, charge), selected: false });
        }
      }
    }

    const queue = new Set(await findDropsAwaitingVoid({ limit: 5_000 }));

    // `gridDropIds` is pushed in the same order as `observed`, so the two arrays
    // line up index for index.
    const mismatches: string[] = [];
    let selectedCount = 0;
    for (const [index, row] of observed.entries()) {
      const dropId = gridDropIds[index] ?? '';
      const selected = queue.has(dropId);
      row.selected = selected;
      if (selected) {
        selectedCount += 1;
      }
      if (selected !== row.needsVoid) {
        mismatches.push(
          `${row.status} ${row.auth}/${row.charge}: needsVoid=${row.needsVoid} selected=${selected}`,
        );
      }
    }

    expect(mismatches, 'the queue and the money must agree on every combination').toEqual([]);

    // And the grid was not vacuous: 2 statuses × {NONE, FAILED} × AUTHORIZED.
    expect(selectedCount).toBe(2 * 2);

    // Every unreachable pair was asserted above too; say so out loud once.
    const unreachable = observed.filter((row) => !reachable(row.auth, row.charge));
    expect(unreachable.length).toBeGreaterThan(0);
    for (const row of unreachable) {
      expect(row.needsVoid, `unreachable ${row.auth}/${row.charge} must not need a void`).toBe(false);
    }
  });
});

describe('the queue drains, and a drained queue cannot starve a new failure', () => {
  it('never selects a drop whose authorisations are all spent', async () => {
    // Ten successful drops: every participant captured, so every row is
    // `AUTHORIZED`/`CAPTURED` — the combination the old predicate would have
    // selected on every tick for ever.
    const capturedIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const dropId = await dropIn('CAPTURED', { cutoffAt: new Date(Date.now() - 10 * HOUR) });
      capturedIds.push(dropId);
      await fx.participant({
        dropId,
        qty: 2,
        platformFeeCents: 2 * FEE_PER_UNIT,
        authStatus: 'AUTHORIZED',
        chargeStatus: 'CAPTURED',
      });
    }

    // Ten failed drops whose captures were refunded — the second combination the
    // old predicate re-selected every tick.
    const refundedIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const dropId = await dropIn('FAILED', { cutoffAt: new Date(Date.now() - 9 * HOUR), minQty: 20 });
      refundedIds.push(dropId);
      await fx.participant({
        dropId,
        qty: 2,
        platformFeeCents: 2 * FEE_PER_UNIT,
        authStatus: 'AUTHORIZED',
        chargeStatus: 'REFUNDED',
      });
    }

    const queue = await findDropsAwaitingVoid({ limit: 5_000 });
    for (const dropId of [...capturedIds, ...refundedIds]) {
      expect(queue, `drained drop ${dropId} must not be queued`).not.toContain(dropId);
    }

    // A newly failed drop, newest in the table, is still found — the twenty drained
    // drops above cannot consume the budget because they are not in the result set
    // at all.
    const freshId = await dropIn('FAILED', { cutoffAt: new Date(), minQty: 20 });
    await fx.participant({ dropId: freshId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });

    expect(await findDropsAwaitingVoid({ limit: 3 })).toContain(freshId);
  });

  it('does let genuinely pending work fill the limit, so the test above is not vacuous', async () => {
    // The control. Three drops that really do hold money, with the oldest cutoffs in
    // the table, must fill `limit: 3` and push out a newer one. If this failed, the
    // "drained cannot starve" result above would mean nothing.
    const oldest: string[] = [];
    for (const hours of [100, 99, 98]) {
      const dropId = await dropIn('FAILED', { cutoffAt: new Date(Date.now() - hours * HOUR), minQty: 20 });
      oldest.push(dropId);
      await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });
    }

    const newestId = await dropIn('CAPTURED', { cutoffAt: new Date() });
    await fx.participant({
      dropId: newestId,
      qty: 1,
      platformFeeCents: FEE_PER_UNIT,
      chargeStatus: 'FAILED',
    });

    const queue = await findDropsAwaitingVoid({ limit: 3 });

    expect(queue).toHaveLength(3);
    for (const dropId of oldest) {
      expect(queue).toContain(dropId);
    }
    expect(queue).not.toContain(newestId);
  });
});

describe('the boundary of the queue status list', () => {
  it('stops selecting a drop that leaves CAPTURED for a post-pickup status', async () => {
    // Not a defect today: `grep -rn "PICKUP_OPEN|COMPLETED|CANCELLED" src/` finds no
    // writer outside a status-label map, so nothing moves a drop out of `CAPTURED`.
    // It is the boundary the next slice must not cross silently — the moment M6 or
    // M7 adds that transition, a `CAPTURED` drop still holding an un-voided
    // authorisation drops out of the queue on the way, which is the same silent
    // failure this round fixed, one status further along. Pinned so it is a
    // decision rather than a discovery.
    const dropId = await dropIn('CAPTURED');
    await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT, chargeStatus: 'FAILED' });

    expect(await findDropsAwaitingVoid({ limit: 5_000 })).toContain(dropId);

    await prisma.drop.updateMany({ where: { id: dropId }, data: { status: 'PICKUP_OPEN' } });

    expect(await findDropsAwaitingVoid({ limit: 5_000 })).not.toContain(dropId);
    // The guard refuses it too — both lists say `FAILED`/`CAPTURED`, so they agree
    // today and the release simply stops. When M6 adds the transition, both lists
    // have to be widened together; widening only one reproduces this round's defect
    // in whichever direction is left open.
    const port = fakeChargePort();
    expect(await voidRemainingAuthorisations({ dropId, port })).toEqual({
      voided: 0,
      alreadyExpired: 0,
      pending: 0,
    });
    expect(port.calls).toHaveLength(0);
  });
});

describe('the retry warning', () => {
  function pendingWarnings(spy: { mock: { calls: unknown[][] } }, dropId: string) {
    return spy.mock.calls.filter(
      (call) => call[0] === 'settlement.void_pending' && (call[1] as { dropId?: string })?.dropId === dropId,
    );
  }

  it('fires once per sweep that leaves work behind, with a count and nothing else', async () => {
    const dropId = await dropIn('CAPTURED');
    const capturedId = await fx.participant({
      dropId,
      qty: 2,
      platformFeeCents: 2 * FEE_PER_UNIT,
      chargeStatus: 'CAPTURED',
      redemptionCode: 'v1.secret-code-that-must-not-be-logged.sig',
    });
    const declinedA = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT, chargeStatus: 'FAILED' });
    const declinedB = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT, chargeStatus: 'FAILED' });

    const phone = (
      await prisma.dropParticipant.findUniqueOrThrow({
        where: { id: declinedA },
        select: { customer: { select: { phone: true } } },
      })
    ).customer.phone;

    const warn = vi.spyOn(logger, 'warn');
    const port = fakeChargePort({ voidUnavailableOnceFor: [declinedA, declinedB] });

    const result = await voidRemainingAuthorisations({ dropId, port });

    expect(result).toEqual({ voided: 0, alreadyExpired: 0, pending: 2 });

    const calls = pendingWarnings(warn, dropId);
    // Once per sweep, not once per participant.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ dropId, pendingParticipants: 2 });

    // Exactly two keys, and the serialised line carries neither the diner's phone
    // number nor the other participant's redemption code.
    const fields = calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(['dropId', 'pendingParticipants']);
    const serialised = JSON.stringify(calls[0]);
    expect(serialised).not.toContain(phone);
    expect(serialised).not.toContain('secret-code-that-must-not-be-logged');
    expect(serialised).not.toContain(capturedId);

    warn.mockRestore();
  });

  it('does not fire when the sweep leaves nothing behind', async () => {
    const dropId = await dropIn('FAILED', { minQty: 20 });
    await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });

    const warn = vi.spyOn(logger, 'warn');
    const result = await voidRemainingAuthorisations({ dropId, port: fakeChargePort() });

    expect(result).toEqual({ voided: 1, alreadyExpired: 0, pending: 0 });
    expect(pendingWarnings(warn, dropId)).toHaveLength(0);

    warn.mockRestore();
  });

  it('fires for a CAPTURED drop reached through settle, which is the path the defect lived on', async () => {
    // The original defect end to end: `finaliseCaptured` sweeps and used to discard
    // the result. The warning must appear without any caller doing anything.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });
    const declinedId = await fx.participant({ dropId, qty: 1, platformFeeCents: FEE_PER_UNIT });

    const warn = vi.spyOn(logger, 'warn');
    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort({ declineParticipantIds: [declinedId], voidUnavailableOnceFor: [declinedId] }),
    });

    expect(outcome).toEqual({ kind: 'CAPTURED', dropId, capturedQty: 5, declinedQty: 1 });
    const calls = pendingWarnings(warn, dropId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ dropId, pendingParticipants: 1 });

    warn.mockRestore();
  });
});
