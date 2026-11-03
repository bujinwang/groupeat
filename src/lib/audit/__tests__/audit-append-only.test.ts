import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FR-902/FR-904's guarantee: **the audit trail is append-only, and the source tree
 * proves it.**
 *
 * `lib/audit/log.ts` says the guarantee is structural — one writer, no mutator — and
 * promises this file as the thing that keeps it structural. A docblock cannot keep a
 * promise; a grep can.
 *
 * ## Why the scan covers all of `src/`, not just `lib/audit/`
 *
 * The interesting violation is not somebody adding an `updateAuditEntry` next to the
 * writer. It is a route handler that decides a bad row should be tidied up, or a test
 * helper that resets the table between cases, or a "cleanup" cron that ages rows out.
 * All three live somewhere else, and all three would leave `lib/audit/` looking
 * perfectly innocent.
 *
 * ## Why the patterns are shaped like that
 *
 * `prisma.auditLog.update` is one spelling. `tx.auditLog.deleteMany`, `db.auditLog
 * .upsert`, and `auditLog.updateMany({ where: { id } })` are the same violation with a
 * different receiver or a bulk suffix, so the receiver is a wildcard and the method is
 * a prefix match. Comments are stripped first, because the docblock in `log.ts` names
 * `.update` and `.delete` in prose and a test that fails on its own documentation is a
 * test somebody deletes.
 */

const SRC_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '..');

/** Every `.ts`/`.tsx` file under `src/`, excluding this test file. */
function sourceFiles(): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // `__tests__` is scanned too: a test that deletes audit rows to make itself
        // repeatable is exactly the violation this is looking for.
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
      if (full === fileURLToPath(import.meta.url)) continue;
      out.push(full);
    }
  };

  walk(SRC_DIR);
  return out.sort();
}

/**
 * Strips line and block comments so prose about `.delete` does not trip the scan.
 *
 * Deliberately naive about strings: a string containing `//` (a URL) loses its tail,
 * which can only ever *hide* a violation inside a string literal — and a mutation
 * spelled inside a string literal is not a mutation. Erring toward under-reporting
 * keeps the test honest about what it actually proves, rather than failing on a
 * `'https://…'` and getting suppressed.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Mutating Prisma calls on the audit table, however the client variable is named. */
const FORBIDDEN_CALLS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'auditLog.update', pattern: /\bauditLog\s*\.\s*update\b/ },
  { name: 'auditLog.updateMany', pattern: /\bauditLog\s*\.\s*updateMany\b/ },
  { name: 'auditLog.upsert', pattern: /\bauditLog\s*\.\s*upsert\b/ },
  { name: 'auditLog.delete', pattern: /\bauditLog\s*\.\s*delete\b/ },
  { name: 'auditLog.deleteMany', pattern: /\bauditLog\s*\.\s*deleteMany\b/ },
  // Raw SQL is the obvious way around a Prisma-level check.
  { name: 'raw SQL against AuditLog', pattern: /\$(?:executeRaw|queryRaw)[\s\S]{0,400}?AuditLog/i },
];

describe('the audit trail is append-only', () => {
  it('finds the source tree it is meant to be scanning', () => {
    // A guard that silently scans nothing passes forever. This pins that the walk
    // reaches production code and this very file.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(join('audit', 'log.ts')))).toBe(true);
  });

  it('has no writer other than lib/audit/log.ts', () => {
    // One writer, and the count is the assertion. A second `auditLog.create` is how
    // an un-audited path gets added: it looks like compliance and skips the log line,
    // the type constraint on `action`, and the denormalised email.
    const writers = sourceFiles().filter((file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      return /\bauditLog\s*\.\s*create\b/.test(source);
    });

    expect(writers.map((f) => relative(SRC_DIR, f))).toEqual([
      join('lib', 'audit', 'log.ts'),
    ]);
  });

  it('never updates, upserts or deletes an audit row anywhere in src/', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const { name, pattern } of FORBIDDEN_CALLS) {
        if (pattern.test(source)) {
          offenders.push(`${relative(SRC_DIR, file)} calls ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * The append-only property lives in the source, but the row it writes has to be
 * correct, or the trail is faithful about the wrong things. These run against a
 * mocked client because there is no test database in this harness.
 */
const create = vi.fn();

vi.mock('@/lib/db/prisma', () => ({
  prisma: { auditLog: { create } },
}));

vi.mock('@/lib/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * The `data` argument of the single `create` call, typed.
 *
 * `noUncheckedIndexedAccess` makes `mock.calls[0][0]` possibly-undefined, and a test
 * that sprinkles `!` around is a test that will not notice when the call stops
 * happening at all. This helper throws with a readable message instead — and the
 * `toHaveBeenCalledTimes(1)` in the tests that need it stays, because "the call
 * happened once" and "the arguments were right" are two different claims.
 */
function writtenData(): Record<string, unknown> {
  const call = create.mock.calls[0];
  if (!call) throw new Error('writeAuditEntry did not call create');
  return (call[0] as { data: Record<string, unknown> }).data;
}

describe('writeAuditEntry', () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ id: 'audit-1' });
  });

  it('writes the actor email alongside the id, so the row survives a user deletion', async () => {
    const { writeAuditEntry } = await import('../log');

    await writeAuditEntry({
      actorUserId: 'user-1',
      actorEmail: 'owner@merchant.test',
      action: 'drop.force_fail',
      targetType: 'drop',
      targetId: 'drop-1',
      detail: { refundedParticipants: 12, refundedCents: 31_440 },
      ipAddress: '203.0.113.7',
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(writtenData()).toMatchObject({
      actorUserId: 'user-1',
      actorEmail: 'owner@merchant.test',
      action: 'drop.force_fail',
      targetType: 'drop',
      targetId: 'drop-1',
      detail: { refundedParticipants: 12, refundedCents: 31_440 },
      ipAddress: '203.0.113.7',
    });
  });

  it('accepts a null actor for an action taken by a since-deleted user', async () => {
    const { writeAuditEntry } = await import('../log');

    await writeAuditEntry({
      actorUserId: null,
      actorEmail: 'gone@merchant.test',
      action: 'participant.refund',
      targetType: 'participant',
      targetId: 'p-1',
      detail: {},
    });

    const data = writtenData();
    expect(data.actorUserId).toBeNull();
    // The email is the record at this point, not a convenience.
    expect(data.actorEmail).toBe('gone@merchant.test');
  });

  it('omits the ip column entirely when the caller has none, rather than writing null', async () => {
    // `undefined` lets the column default apply; an explicit `null` would claim a
    // known absence. The distinction matters for an operator asking later whether
    // the address was captured or simply not available.
    const { writeAuditEntry } = await import('../log');

    await writeAuditEntry({
      actorUserId: 'user-1',
      actorEmail: 'owner@merchant.test',
      action: 'session.impersonate',
      targetType: 'user',
      targetId: 'user-2',
      detail: {},
    });

    expect(writtenData()).not.toHaveProperty('ipAddress');
  });

  it('throws rather than swallowing, because a silent failure authorises nothing', async () => {
    // FR-902's caller refunds every participant next. Proceeding without the record
    // is the exact outcome the requirement exists to prevent, so a caller must be
    // able to see the failure and stop.
    create.mockRejectedValue(new Error('insert failed'));
    const { writeAuditEntry } = await import('../log');

    await expect(
      writeAuditEntry({
        actorUserId: 'user-1',
        actorEmail: 'owner@merchant.test',
        action: 'drop.force_fail',
        targetType: 'drop',
        targetId: 'drop-1',
        detail: {},
      }),
    ).rejects.toThrow('insert failed');
  });

  it('returns the row id so a caller can reference it in its own log line', async () => {
    const { writeAuditEntry } = await import('../log');

    await expect(
      writeAuditEntry({
        actorUserId: 'user-1',
        actorEmail: 'owner@merchant.test',
        action: 'drop.force_fail',
        targetType: 'drop',
        targetId: 'drop-1',
        detail: {},
      }),
    ).resolves.toBe('audit-1');
  });
});
