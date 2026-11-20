import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/prisma';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { observedBracket, scopedCounts, type FixtureScope } from '@/lib/testing/scoped-counts';

/**
 * Proves `scopedCounts` does two things that an `id in [...]` rewrite would only
 * do one of:
 *
 *  1. It ignores a stranger's rows. A separate merchant/drop/participant created
 *     by another fixture (i.e. committed, real rows) does not change any count —
 *     that is the whole point of the rewrite: a concurrent writer's rows stop
 *     breaking the "nothing writes" suites.
 *  2. It still sees a row the code under test writes. A new participant attached
 *     to a *fixture* drop is counted, because the scope is a namespace
 *     (merchantId / dropId / customerId), not a frozen id list. A frozen id list
 *     would have made the assertion vacuous.
 *
 * Everything that mutates is inside one rollback-only interactive transaction, so
 * the file leaves no residue even though it writes rows. The two fixture instances
 * seeded in `beforeAll` are the only committed data and are removed in `afterAll`.
 */

const ROLLBACK = 'scoped-counts-rollback';

async function inRollback<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const box: { value?: T } = {};
  try {
    await prisma.$transaction(
      async (tx) => {
        box.value = await fn(tx);
        throw new Error(ROLLBACK);
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  if (!('value' in box)) {
    throw new Error('rollback-only transaction produced no result');
  }
  return box.value as T;
}

// The two prefixes must differ in their *leading* digits, not just letters: the
// fixture derives each customer's phone from `prefix.replace(/\D/g, '')`, so a
// letter-only difference (e.g. `-stranger` suffix) collapses to the same digits
// and the two instances collide on the unique `phone` column. A leading `0` vs `1`
// makes the derived phones diverge at the first character.
const PREFIX = `scoped-counts-0-${Date.now()}`;
const STRANGER_PREFIX = `scoped-counts-1-${Date.now()}`;

describe('scopedCounts', () => {
  let fx: SettlementFixtures;
  let strangerFx: SettlementFixtures;
  let scope: FixtureScope;
  let strangerScope: FixtureScope;

  beforeAll(async () => {
    fx = settlementFixtures(PREFIX);
    const merchantId = await fx.merchant('acct_scoped_counts_test');
    const itemId = await fx.item(merchantId);
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
    });
    await fx.participant({ dropId, qty: 1 });
    scope = fx.scope();

    // A fully separate fixture: different merchant, drop, customer, participant.
    strangerFx = settlementFixtures(STRANGER_PREFIX);
    const sm = await strangerFx.merchant('acct_scoped_counts_stranger');
    const si = await strangerFx.item(sm);
    const sd = await strangerFx.drop({
      merchantId: sm,
      menuItemId: si,
      dealPriceCents: 1000,
      minQty: 1,
    });
    await strangerFx.participant({ dropId: sd, qty: 1 });
    strangerScope = strangerFx.scope();
  });

  afterAll(async () => {
    await fx.cleanup();
    await strangerFx.cleanup();
  });

  it('ignores the stranger namespace but still sees a new row on a fixture drop', async () => {
    await inRollback(async (tx) => {
      const before = await scopedCounts(tx, scope, [
        'orders',
        'drops',
        'participants',
        'shareLinks',
        'audits',
        'ledger',
        'customers',
      ]);
      // The stranger fixture has committed a drop + participant + customer, yet the
      // fixture scope sees only its own: one drop, one participant, one customer.
      expect(before.orders).toBe(0);
      expect(before.drops).toBe(1);
      expect(before.participants).toBe(1);
      expect(before.shareLinks).toBe(0);
      expect(before.audits).toBe(0);
      expect(before.ledger).toBe(0);
      expect(before.customers).toBe(1);

      const fixtureDropId = scope.dropIds[0]!;
      const strangerDropId = strangerScope.dropIds[0]!;

      // A brand-new row written during the call but attached to the stranger drop
      // is invisible to the fixture scope.
      const strangerCustomer = await tx.customer.create({
        data: {
          phone: `+1555${String(Date.now()).slice(-6)}0003`,
          name: 'call-time stranger customer',
        },
        select: { id: true },
      });
      await tx.dropParticipant.create({
        data: {
          dropId: strangerDropId,
          customerId: strangerCustomer.id,
          qty: 1,
          amountCents: 100,
          platformFeeCents: 0,
        },
      });

      const afterStrangerWrite = await scopedCounts(tx, scope, [
        'drops',
        'participants',
        'customers',
      ]);
      expect(afterStrangerWrite.drops).toBe(1);
      expect(afterStrangerWrite.participants).toBe(1);
      expect(afterStrangerWrite.customers).toBe(1);

      // A new row attached to a *fixture* drop is seen — the scope is a namespace,
      // so a write the code under test makes is not hidden.
      const ownCustomer = await tx.customer.create({
        data: {
          phone: `+1555${String(Date.now()).slice(-6)}0004`,
          name: 'call-time own customer',
        },
        select: { id: true },
      });
      await tx.dropParticipant.create({
        data: {
          dropId: fixtureDropId,
          customerId: ownCustomer.id,
          qty: 1,
          amountCents: 100,
          platformFeeCents: 0,
        },
      });

      const afterOwnWrite = await scopedCounts(tx, scope, [
        'drops',
        'participants',
        'customers',
      ]);
      expect(afterOwnWrite.drops).toBe(1);
      expect(afterOwnWrite.participants).toBe(2);
      expect(afterOwnWrite.customers).toBe(2);
    });
  });
});

describe('observedBracket', () => {
  it('returns the min/max of the two readings, regardless of order', () => {
    expect(observedBracket(3, 5)).toEqual({ min: 3, max: 5 });
    expect(observedBracket(5, 3)).toEqual({ min: 3, max: 5 });
  });
});
