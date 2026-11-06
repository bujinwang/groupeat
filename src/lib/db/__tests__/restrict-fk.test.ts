/**
 * Pins the RESTRICT edge that the foreign-key-order teardown rule exists for.
 *
 * ## Why this is a mechanism test
 *
 * `docs/PROGRESS.md` recorded this as a *hypothesis*: six of the schema's fourteen
 * FKs are `RESTRICT`, and a teardown that deletes a parent before its children would
 * raise — but a trailing `.catch(() => undefined)` would hide the raise, leaving rows
 * with no symptom. Plausible is not measured. This test deletes a `Merchant` that a
 * `Drop` still references and shows the exact error, then shows the same delete with
 * the swallow returning normally. A grep for `.catch` could establish neither fact.
 *
 * ## Why it writes nothing
 *
 * Every row lives inside a Prisma interactive transaction that always throws a
 * sentinel, so Postgres rolls all of it back. "A probe is an operator" is the rule in
 * this repository; this one is not an operator by construction, and the residue gate
 * never sees an uncommitted row. The final assertion checks the probe merchant **by
 * id**, not with a global count: an unscoped `prisma.merchant.count()` before/after
 * would be one more of the 14 global-count hazards deliberately left deferred.
 *
 * Postgres aborts a transaction after a constraint violation, so no query may follow
 * the failed delete inside the transaction. The sentinel only asks Prisma to ROLLBACK.
 *
 * The client logs at `error` level (`src/lib/db/prisma.ts`), so a green run prints two
 * `prisma:error` lines for the deliberately rejected delete. They are the expected
 * `P2003`, not a failure: the test catches the error and asserts its code.
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

const ROLLBACK = 'INTENTIONAL_ROLLBACK_restrict-fk.test.ts';
type Tx = Prisma.TransactionClient;

type DeleteOutcome = {
  threw: boolean;
  code?: unknown;
  constraint?: unknown;
  returned?: 'undefined' | 'row';
};

/** Merchant -> MenuItem -> Drop, all inside the transaction that will be rolled back. */
async function seed(tx: Tx, tag: string): Promise<string> {
  const merchantId = randomUUID();
  const menuItemId = randomUUID();
  await tx.merchant.create({
    data: { id: merchantId, name: 'restrict-probe', slug: `restrict-${tag}` },
  });
  await tx.menuItem.create({
    data: {
      id: menuItemId,
      merchantId,
      name: 'probe dish',
      menuPriceCents: 1000,
      foodCostCents: 400,
      batchYield: 10,
    },
  });
  await tx.drop.create({
    data: {
      id: randomUUID(),
      merchantId,
      menuItemId,
      publicCode: `rp-${tag}`,
      title: 'RESTRICT probe',
      dealPriceCents: 800,
      minQty: 1,
      maxQty: 10,
      windowStart: new Date('2026-11-01T00:00:00Z'),
      windowEnd: new Date('2026-11-02T00:00:00Z'),
      cutoffAt: new Date('2026-10-31T00:00:00Z'),
      guardrailSnapshot: {},
    },
  });
  return merchantId;
}

/** Runs `fn` in a transaction that is *always* rolled back. */
async function inRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const box: { value?: T } = {};
  try {
    await prisma.$transaction(async (tx) => {
      box.value = await fn(tx);
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  if (!('value' in box)) {
    throw new Error('rollback-only transaction produced no result');
  }
  return box.value as T;
}

async function deleteParent(
  swallow: boolean,
): Promise<{ merchantId: string; outcome: DeleteOutcome }> {
  let merchantId = '';
  const outcome = await inRollback<DeleteOutcome>(async (tx) => {
    merchantId = await seed(tx, randomUUID().slice(0, 8));
    const deletion = tx.merchant.delete({ where: { id: merchantId } });

    if (!swallow) {
      try {
        await deletion;
        return { threw: false, returned: 'row' };
      } catch (error) {
        const failure = error as { code?: unknown; meta?: { constraint?: unknown } };
        return { threw: true, code: failure.code, constraint: failure.meta?.constraint };
      }
    }

    const value = await deletion.catch(() => undefined);
    return { threw: false, returned: value === undefined ? 'undefined' : 'row' };
  });
  return { merchantId, outcome };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('RESTRICT FK teardown trap', () => {
  it('a parent-first delete is rejected by the FK, and the probe leaves no row', async () => {
    const { merchantId, outcome } = await deleteParent(false);

    expect(outcome.threw).toBe(true);
    expect(outcome.code).toBe('P2003');
    // Measured as `Drop_merchantId_fkey`; either Drop edge proves the same RESTRICT.
    expect(String(outcome.constraint)).toMatch(/^Drop_(merchantId|menuItemId)_fkey$/);
    expect(await prisma.merchant.findUnique({ where: { id: merchantId } })).toBeNull();
  });

  it('.catch(() => undefined) turns that rejection into a normal return', async () => {
    const { merchantId, outcome } = await deleteParent(true);

    expect(outcome.threw).toBe(false);
    expect(outcome.returned).toBe('undefined');
    expect(await prisma.merchant.findUnique({ where: { id: merchantId } })).toBeNull();
  });
});
