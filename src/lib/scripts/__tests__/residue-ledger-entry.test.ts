/**
 * Pins the residue gate's `LedgerEntry` blind spot closed.
 *
 * ## Why this test writes a row
 *
 * `LedgerEntry` is the one model with no relation field at all: `orderId` and `dropId`
 * are bare nullable strings, so no FK cascades to it and no parent count can stand in
 * for it. All seven teardowns select ledger rows by `dropId` — six with
 * `{ in: dropIds }`, one with a scalar — and neither shape can match NULL. Before this
 * counter existed, a row written without a `dropId` survived every teardown and no
 * instrument reported it. A test that only asserted "the script contains the string
 * `ledgerEntry`" would be a docblock with a test-shaped body: it would still pass if
 * the counter were scoped to a `dropId`, which is precisely the defect. So this writes
 * the row the filters miss and asks the gate whether its count moves.
 *
 * ## Why it owns its teardown, inside the test body
 *
 * The rows are deleted by `id` in `finally`, never by `dropId` — delegating to the
 * repo's usual teardown shape is the bug under test. Cleanup is in the test rather
 * than `afterAll` so a failed assertion cannot leave a row for the gate's `--compare`
 * to report as somebody else's residue. This file is a writer, so it owns a teardown.
 */
import 'dotenv/config';

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

/** `src/lib/scripts/__tests__/` → `src/lib/scripts` → `src/lib` → `src` → repo. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CHECK_RESIDUE = join(REPO_ROOT, 'scripts', 'check-residue.mjs');

/**
 * The dump path is deliberately lock-free, so calling it while an outer `npm run
 * verify` holds the database is safe. It runs the same `readCounts()` the gate uses,
 * which is the property being pinned.
 */
function counts(): Record<string, number> {
  const out = execFileSync(process.execPath, [CHECK_RESIDUE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`check-residue.mjs printed no JSON:\n${out}`);
  }
  return JSON.parse(out.slice(start, end + 1)) as Record<string, number>;
}

/**
 * A missing key is a regression, not a zero. Throwing here keeps the assertions below
 * about the *number of rows*, rather than quietly folding "the counter disappeared" into
 * the same bucket as "the database is clean".
 */
function ledgerCount(): number {
  const value = counts().ledgerEntry;
  if (typeof value !== 'number') {
    throw new Error('check-residue.mjs reported no ledgerEntry count');
  }
  return value;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('residue counter: LedgerEntry', () => {
  it('reports an unscoped ledgerEntry count, with no where clause to hide behind', () => {
    expect(typeof ledgerCount()).toBe('number');
  });

  it('sees dropId:null rows that every dropId-in teardown cannot', async () => {
    const before = ledgerCount();
    const ids: string[] = [];

    try {
      // Both rows share a type and a null orderId. `@@unique([orderId, type])` sits
      // on a nullable column, and Postgres treats NULLs as distinct — the index does
      // not stop the second insert either.
      for (let i = 0; i < 2; i += 1) {
        const row = await prisma.ledgerEntry.create({
          data: {
            type: 'ADJUSTMENT',
            amountCents: 1,
            orderId: null,
            dropId: null,
            note: 'residue-ledger-entry.test.ts — blind-spot probe',
          },
          select: { id: true },
        });
        ids.push(row.id);
      }

      expect(ledgerCount()).toBe(before + ids.length);

      // Six of the seven ledger teardowns use exactly this `{ in: [...] }` shape; the
      // seventh uses a scalar `dropId`. NULL is in neither, so it deletes nothing and
      // both rows survive.
      const swept = await prisma.ledgerEntry.deleteMany({
        where: { dropId: { in: [randomUUID()] } },
      });
      expect(swept.count).toBe(0);
      for (const id of ids) {
        expect(await prisma.ledgerEntry.findUnique({ where: { id } })).not.toBeNull();
      }
      expect(
        await prisma.ledgerEntry.count({ where: { dropId: null } }),
      ).toBeGreaterThanOrEqual(ids.length);
    } finally {
      // By id, never by dropId. No swallow: if cleanup fails the test must fail
      // loudly, which is the rule this slice enforces.
      if (ids.length > 0) {
        await prisma.ledgerEntry.deleteMany({ where: { id: { in: ids } } });
      }
    }

    expect(ledgerCount()).toBe(before);
  });
});
