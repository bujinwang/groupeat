import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

import { findDropsAwaitingVoid } from '../cutoff-decision';
import {
  ALL_DROP_STATUSES,
  type DropStatusLiteral,
  type SettlementFixtures,
  settlementFixtures,
} from './settlement-fixtures';
import { VOID_SWEEP_STATUSES, isVoidSweepStatus } from '../drop-status';
import { fakeChargePort } from '../fake-charge-port';
import { runCutoffTick } from '../run-tick';
import { voidRemainingAuthorisations } from '../settle';

/**
 * The status list, checked against the enum rather than against itself.
 *
 * `void-queue.cross-product.test.ts` proved the queue and the guard agree — but it
 * proved it over two statuses, `['CAPTURED', 'FAILED']`, which is the same pair
 * the code hardcoded. A test whose input list is copied from the implementation
 * cannot notice a status that both halves are missing.
 *
 * So this file starts from `ALL_DROP_STATUSES` — every value in
 * `prisma/schema.prisma`'s `DropStatus` enum — and asks, for each one, two
 * questions that are answered independently of `VOID_SWEEP_STATUSES`:
 *
 *   1. **Can a drop in this state hold a live authorisation?** Decided by reading
 *      the status machine: before the cutoff nothing is decided; at `LOCKED` the
 *      holds are about to be used; after the capture decision (`FAILED`,
 *      `CAPTURED`, and everything downstream) a hold can survive a decline or a
 *      failed release. This is a judgement about money, written out per status.
 *   2. **Does the code actually sweep it?** Asked of both halves separately — the
 *      queue (a DB query) and the guard (a status read) — so a disagreement
 *      between them fails here even if `VOID_SWEEP_STATUSES` is internally
 *      consistent.
 *
 * The list is then required to equal the judgement. Adding a status to the enum
 * without deciding whether it is sweepable fails this test at the point of
 * addition, which is the only moment anybody has the context to decide it.
 */

const PREFIX = `vs${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1112;

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

/**
 * The judgement, stated per status and independent of the constant.
 *
 * Written as an exhaustive `Record` over the enum on purpose: adding a member to
 * `ALL_DROP_STATUSES` makes this object fail to type-check, so the new status
 * cannot be introduced without somebody writing down what it means for a held
 * authorisation. That is the whole mechanism — TypeScript is the reminder, not a
 * comment in a file nobody opens.
 */
const CAN_HOLD_A_LIVE_AUTH: Record<DropStatusLiteral, { sweep: boolean; why: string }> = {
  DRAFT: { sweep: false, why: 'never joined; no authorisation exists.' },
  PUBLISHED: { sweep: false, why: 'joins are still open; the authorisation is doing its job.' },
  LOCKED: {
    sweep: false,
    why: 'the holds are about to be CAPTURED. Voiding one releases money we are about to take — the one mistake here that loses money rather than failing to release it.',
  },
  CAPTURED: {
    sweep: true,
    why: 'a declined diner’s cancellation can fail in `finaliseCaptured`, leaving their hold live on a successful drop.',
  },
  PICKUP_OPEN: { sweep: true, why: 'post-capture, carrying the same residual as CAPTURED.' },
  COMPLETED: { sweep: true, why: 'post-capture, same residual again.' },
  FAILED: {
    sweep: true,
    why: 'below threshold or below tolerance; authorisations are voided and a void can fail transiently.',
  },
  CANCELLED: {
    sweep: true,
    why: 'merchant or admin cancelled (FR-902). Nobody will ever capture those holds.',
  },
};

describe('the sweepable status list, checked against the enum', () => {
  it('covers every status in the schema, and no status that is not in it', () => {
    // The enum in `schema.prisma`, transcribed. If this drifts, the test says so
    // rather than quietly testing a subset — which is the failure this file exists
    // to prevent.
    expect([...ALL_DROP_STATUSES].sort()).toEqual(
      ['CANCELLED', 'CAPTURED', 'COMPLETED', 'DRAFT', 'FAILED', 'LOCKED', 'PICKUP_OPEN', 'PUBLISHED'],
    );

    const judged = ALL_DROP_STATUSES.filter((status) => CAN_HOLD_A_LIVE_AUTH[status].sweep);
    expect([...VOID_SWEEP_STATUSES].sort()).toEqual([...judged].sort());
  });

  it('and the judgement is not vacuous in either direction', () => {
    // A list that was all-true or all-false would satisfy the equality above and
    // mean nothing.
    expect(VOID_SWEEP_STATUSES.length).toBeGreaterThan(1);
    expect(VOID_SWEEP_STATUSES.length).toBeLessThan(ALL_DROP_STATUSES.length);
    expect(isVoidSweepStatus('LOCKED')).toBe(false);
    expect(isVoidSweepStatus('PUBLISHED')).toBe(false);
  });
});

describe('both halves agree with the list, status by status', () => {
  it('queues a drop only when the list says it is sweepable', async () => {
    // One drop per status, each holding an authorisation that genuinely needs
    // releasing (`AUTHORIZED` / `NONE`). The only thing that varies is the status,
    // so the queue's answer is a statement about the status and nothing else.
    const byStatus = new Map<DropStatusLiteral, string>();

    for (const status of ALL_DROP_STATUSES) {
      const dropId = await fx.drop({
        merchantId,
        menuItemId: itemId,
        dealPriceCents: DEAL_PRICE,
        minQty: 5,
        status,
        cutoffAt: new Date(Date.now() - 60 * 60 * 1000),
        lockedAt: new Date(Date.now() - 60 * 1000),
      });
      byStatus.set(status, dropId);
      await fx.participant({ dropId, qty: 1, authStatus: 'AUTHORIZED', chargeStatus: 'NONE' });
    }

    const queue = new Set(await findDropsAwaitingVoid({ limit: 5_000 }));

    const wrong: string[] = [];
    for (const status of ALL_DROP_STATUSES) {
      const selected = queue.has(byStatus.get(status) ?? '');
      const expected = CAN_HOLD_A_LIVE_AUTH[status].sweep;
      if (selected !== expected) {
        wrong.push(
          `${status}: queued=${selected} expected=${expected} — ${CAN_HOLD_A_LIVE_AUTH[status].why}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('lets the guard void a drop only when the list says it is sweepable', async () => {
    // The guard is asked directly, with the drop id, bypassing the queue — which
    // is how `finaliseCaptured` and the tick's own loop reach it. A guard that
    // refused a sweepable status would leave the work queued for ever; one that
    // accepted `LOCKED` would release money about to be captured.
    const wrong: string[] = [];

    for (const status of ALL_DROP_STATUSES) {
      const dropId = await fx.drop({
        merchantId,
        menuItemId: itemId,
        dealPriceCents: DEAL_PRICE,
        minQty: 5,
        status,
        cutoffAt: new Date(Date.now() - 60 * 60 * 1000),
        lockedAt: new Date(Date.now() - 60 * 1000),
      });
      const participantId = await fx.participant({
        dropId,
        qty: 1,
        authStatus: 'AUTHORIZED',
        chargeStatus: 'NONE',
      });

      const port = fakeChargePort();
      const result = await voidRemainingAuthorisations({ dropId, port });

      const expected = CAN_HOLD_A_LIVE_AUTH[status].sweep;
      const voided = result.voided === 1;
      const calledPort = port.calls.length > 0;

      if (voided !== expected || calledPort !== expected) {
        wrong.push(
          `${status}: voided=${String(voided)} portCalled=${String(calledPort)} expected=${String(expected)} — ${CAN_HOLD_A_LIVE_AUTH[status].why}`,
        );
      }

      // And the money actually moved, in the direction the answer claims: a
      // swept hold is `VOIDED` at the provider and in the row; a refused one is
      // untouched, which is what makes `LOCKED` safe.
      const row = await prisma.dropParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { authStatus: true },
      });
      expect(row.authStatus, `${status}: authStatus after the sweep`).toBe(
        expected ? 'VOIDED' : 'AUTHORIZED',
      );
    }

    expect(wrong).toEqual([]);
  });

  it('sweeps PICKUP_OPEN, COMPLETED and CANCELLED through the tick, which is the path production takes', async () => {
    // The specific gap this round closed, and the reason the queue test above is
    // not enough on its own: a status the *tick* never asks about is still never
    // swept, however correct the query is. These three are statuses no code in
    // this build writes yet, so a regression would be invisible until M6 added the
    // transition — at which point the hold would already be stranded.
    //
    // Each drop carries a *declined* participant, i.e. the state a real
    // `finaliseCaptured` leaves behind: `authStatus = AUTHORIZED` with
    // `chargeStatus = FAILED`, which is a live hold at the provider with nothing
    // that will ever use it.
    const expected: Record<string, string> = {};

    for (const status of ['PICKUP_OPEN', 'COMPLETED', 'CANCELLED'] as const) {
      const dropId = await fx.drop({
        merchantId,
        menuItemId: itemId,
        dealPriceCents: DEAL_PRICE,
        minQty: 5,
        status,
        cutoffAt: new Date(Date.now() - 60 * 60 * 1000),
        lockedAt: new Date(Date.now() - 60 * 1000),
      });
      const participantId = await fx.participant({
        dropId,
        qty: 1,
        authStatus: 'AUTHORIZED',
        chargeStatus: 'FAILED',
      });
      expected[participantId] = status;
    }

    const tick = await runCutoffTick({ now: new Date(), port: fakeChargePort() });
    expect(tick.voided).toBeGreaterThanOrEqual(3);

    const rows = await prisma.dropParticipant.findMany({
      where: { id: { in: Object.keys(expected) } },
      select: { id: true, authStatus: true },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.authStatus, `${expected[row.id] ?? '?'} hold must be released by the tick`).toBe('VOIDED');
    }
  });
});
