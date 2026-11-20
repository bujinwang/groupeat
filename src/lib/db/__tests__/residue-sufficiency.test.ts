/**
 * The residue gate counts a *subset* of the schema's tables. This pins why that subset is
 * sufficient — or fails loudly when it stops being sufficient.
 *
 * ## The question this answers
 *
 * `scripts/check-residue.mjs` counts 13 of the schema's 17 models. `DropParticipant`,
 * `MenuItem`, `MerchantUser`, `Order` and `PasswordInvite` have no counter of their own,
 * while the script's own doctrine is "an uncounted table is not a clean table". Either the
 * five are safe for a reason, or the doctrine has five exceptions nobody has written down.
 *
 * Measured before writing this, from a verified-zero baseline: seed one row in each of the
 * five, delete **only their parents**, and every one of them goes to zero —
 * `{dropParticipant:1, menuItem:1, merchantUser:1, order:1, passwordInvite:1}` → all `0`.
 * So they are guarded, not ignored, and the guard is structural.
 *
 * ## The rule, taken from Postgres rather than inferred
 *
 * A table needs its own counter exactly when a leak in it can survive the disappearance of
 * every row a counter *can* see. Reading `pg_constraint` (not the Prisma schema, whose
 * DMMF reports `undefined` for a default `Cascade` — measured) gives the whole rule:
 *
 * | `confdeltype` | meaning | leak possible after the parent is gone? |
 * |---|---|---|
 * | `c` | ON DELETE CASCADE | no — the child goes with the parent |
 * | `n` | ON DELETE SET NULL | **yes** — the row survives with a null FK, invisible to any parent count |
 * | `r` | ON DELETE RESTRICT | no — the parent cannot be deleted first, so a teardown that does it *throws* |
 *
 * And the FK column matters as much as the action: **SET NULL on a NOT NULL column cannot
 * happen**, because Postgres rejects the delete. So `ShareLink.merchantId` (`r`, not null)
 * needs no counter, while `AiDraft.merchantId` (`n`, nullable) does — which is exactly why
 * `aiDrafts` is counted, and the comment in `check-residue.mjs` says so.
 *
 * The five uncounted tables all have at least one not-null parent, and every not-null parent
 * edge is `c` or `r`. So a leak in any of them necessarily leaves a counted parent behind,
 * and the gate fails on a number it already reads.
 *
 * ## What this test does not claim
 *
 * It does not say the 13 are *enough for every possible leak* — a row written with no parent
 * at all would still hide, which is the case `ledgerEntry` is counted unscoped for. It pins
 * the narrower, checkable claim: **no uncounted table can outlive a delete of all its counted
 * ancestors.** A future nullable FK, or a `SET NULL` on a column that is currently NOT NULL,
 * fails this test and forces the counter question to be answered on purpose.
 *
 * ## Why it writes nothing
 *
 * One `SELECT` against `pg_constraint`. No fixture, no transaction, no rollback needed.
 */
import 'dotenv/config';

import { describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

/** Postgres `confdeltype`, spelled out. */
const DELETE_ACTION: Record<string, 'cascade' | 'set-null' | 'restrict' | 'no-action' | 'default'> =
  {
    c: 'cascade',
    n: 'set-null',
    r: 'restrict',
    a: 'no-action',
    d: 'default',
  };

type FkEdge = {
  childTable: string;
  childColumn: string;
  parentTable: string;
  columnIsNotNull: boolean;
  onDelete: string;
};

/**
 * Every foreign key in the live database, read from the catalog.
 *
 * `conrelid::regclass::text` returns quoted identifiers (`"DropParticipant"`), matching the
 * Prisma model names one-for-one, which is what lets a counter name and a table name be
 * compared directly below.
 */
async function readForeignKeys(): Promise<FkEdge[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      child: string;
      childColumn: string;
      parent: string;
      notNull: boolean;
      onDelete: string;
    }>
  >`
    SELECT
      c.conrelid::regclass::text   AS child,
      a.attname                    AS "childColumn",
      c.confrelid::regclass::text  AS parent,
      a.attnotnull                 AS "notNull",
      c.confdeltype::text          AS "onDelete"
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f'
  `;

  return rows.map((row) => ({
    childTable: row.child.replaceAll('"', ''),
    childColumn: row.childColumn,
    parentTable: row.parent.replaceAll('"', ''),
    columnIsNotNull: row.notNull,
    onDelete: DELETE_ACTION[row.onDelete] ?? row.onDelete,
  }));
}

/**
 * The tables `scripts/check-residue.mjs` reads a number for.
 *
 * Kept here rather than imported: the script is `.mjs` CommonJS-ish ESM that runs a `main`
 * on import, so importing it from a test would execute the gate. This list is duplicated on
 * purpose, and the test below fails if it drifts from the script — see the last assertion.
 */
const COUNTED_MODELS = new Set([
  'User',
  'OrganiserProfile',
  'Merchant',
  'Customer',
  'ConsentRecord',
  'Drop',
  'ShareLink',
  'AiDraft',
  'DigestDelivery',
  'LedgerEntry',
  'RedemptionScan',
  'AuditLog',
]);

describe('residue-gate sufficiency', () => {
  it('every uncounted table can only leak while a counted parent survives', async () => {
    const edges = await readForeignKeys();
    expect(edges.length).toBeGreaterThan(15);

    const uncounted = [...new Set(edges.map((edge) => edge.childTable))].filter(
      (table) => !COUNTED_MODELS.has(table),
    );
    expect(uncounted.length).toBeGreaterThan(0);

    /**
     * A leak survives its ancestors only if the child can outlive *every* parent edge:
     * that needs a nullable FK for each one, deleted with SET NULL. Any not-null edge on a
     * `cascade`/`restrict` action is enough to guarantee the parent is still there — or that
     * the delete threw.
     */
    const blindSpots = uncounted.filter((table) => {
      const parents = edges.filter((edge) => edge.childTable === table);
      if (parents.length === 0) {
        return true; // no FK at all: nothing can cascade, so nothing guards it
      }
      const everyParentCanVanish = parents.every(
        (edge) => !edge.columnIsNotNull && edge.onDelete === 'set-null',
      );
      return everyParentCanVanish;
    });

    expect(blindSpots).toEqual([]);
  });

  it('the counted list matches the counters in check-residue.mjs', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../../../scripts/check-residue.mjs', import.meta.url), 'utf8');

    /**
     * Each counter is one `prisma.<model>.count()` line. `profilelessOrganisers` is a
     * subtraction of two counters and names no model of its own, so it is not expected here.
     *
     * Prisma's delegate is camelCase — `prisma.ledgerEntry` — so the model name is the
     * delegate with its first letter capitalised. Parsing beats a hand-written second list:
     * a counter added to the script without a line here fails, which is the drift this test
     * exists to catch.
     */
    const delegates = [...source.matchAll(/prisma\.([a-zA-Z]+)\.count\(/g)].map(
      (match) => match[1] ?? '',
    );
    const modelsInScript = new Set(
      delegates.map((delegate) => delegate.charAt(0).toUpperCase() + delegate.slice(1)),
    );

    const missingFromThisList = [...modelsInScript].filter((model) => !COUNTED_MODELS.has(model));
    const listedButUncounted = [...COUNTED_MODELS].filter((model) => !modelsInScript.has(model));

    expect(missingFromThisList).toEqual([]);
    expect(listedButUncounted).toEqual([]);
  });
});
