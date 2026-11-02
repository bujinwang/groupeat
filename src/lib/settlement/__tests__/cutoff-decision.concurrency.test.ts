import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

import { decideFor } from '../cutoff-decision';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * Two workers, one drop — design §4.1, §4.2, §8.
 *
 * The whole concurrency story is one statement: `SELECT … FOR UPDATE` with the
 * status predicate **in the same `WHERE`**, so Postgres re-evaluates the predicate
 * against the newly committed row after it wins the lock. If that is working,
 * exactly one worker sees the row and exactly one writes `lockedAt`.
 *
 * If both calls return `LOCKED`, the lock is not working and this test fails.
 */

const PREFIX = `cutoffrace${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('decideFor under two concurrent workers', () => {
  it('produces exactly one LOCKED and exactly one NO_OP, and one write', async () => {
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: 1000, minQty: 5 });
    await fx.participant({ dropId, qty: 6 });

    // Distinct `now` values, so the stored `lockedAt` names which worker wrote.
    const first = new Date();
    const second = new Date(first.getTime() + 5_000);

    const outcomes = await Promise.all([
      decideFor({ dropId, now: first }),
      decideFor({ dropId, now: second }),
    ]);

    const locked = outcomes.filter((outcome) => outcome.kind === 'LOCKED');
    const noop = outcomes.filter((outcome) => outcome.kind === 'NO_OP');

    expect(locked).toHaveLength(1);
    expect(noop).toHaveLength(1);

    const winner = locked[0];
    if (winner?.kind !== 'LOCKED') {
      throw new Error('expected exactly one LOCKED outcome');
    }

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true, lockedAt: true },
    });
    expect(row.status).toBe('LOCKED');
    // The winner's own `now`. If both workers had written, this would be the later
    // of the two and the assertion below would fail.
    expect(row.lockedAt?.getTime()).toBe(winner.drop.decidedAt.getTime());
  });

  it('does not lock a drop twice even when the second worker arrives while the first holds the lock', async () => {
    const dropId = await fx.drop({ merchantId, menuItemId: itemId, dealPriceCents: 1000, minQty: 5 });
    await fx.participant({ dropId, qty: 5 });

    // Four workers: the lock is either exclusive or it is not, and three extra
    // contenders make a partial failure obvious rather than a coin flip.
    const outcomes = await Promise.all(
      [0, 1, 2, 3].map((offset) =>
        decideFor({ dropId, now: new Date(Date.now() + offset * 1_000) }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'LOCKED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'NO_OP')).toHaveLength(3);
    expect(await prisma.order.count({ where: { dropId } })).toBe(0);
  });
});
