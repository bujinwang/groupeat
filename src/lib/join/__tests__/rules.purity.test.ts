import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `join/rules.ts` must stay importable from a client component.
 *
 * This is the M6 lesson applied before the bug rather than after it. In M6 the
 * scanner screen needed one integer from `input.ts`, that module imports zod, and
 * `/merchant/pickup` jumped from 104 kB to 122 kB of first-load JavaScript for the
 * sake of a `maxLength`. M4's join page will need `MAX_JOIN_QTY_LABEL` for exactly
 * the same reason, so the constant lives in the pure module and this test stops
 * anyone moving it back.
 *
 * ## Why the whole module and not just the constants
 *
 * "No zod" is today's instance of the rule, not the rule. The rule is that this
 * module is a bag of pure functions: no database, no clock, no environment, no
 * Prisma, no `server-only`. That is what lets a phone import it, and it is also
 * what lets the 47 assertions in `rules.test.ts` run in four milliseconds with no
 * Postgres. A rule phrased as "does not import zod" would pass a module that
 * imported Prisma, which would break the second property silently.
 */

const RULES_PATH = join(process.cwd(), 'src/lib/join/rules.ts');

function importLines(source: string): string[] {
  return source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /^import\s/.test(line) || /^export\s.*\bfrom\s/.test(line))
    .map(({ line, number }) => `${number}: ${line}`);
}

describe('lib/join/rules.ts', () => {
  it('imports nothing at all', () => {
    const source = readFileSync(RULES_PATH, 'utf8');

    // Reported with line numbers so a failure points at the offending import.
    expect(importLines(source)).toEqual([]);
  });

  it('has no module-scope work that a bundler cannot split away', () => {
    const source = readFileSync(RULES_PATH, 'utf8');

    expect(source).not.toMatch(/^require\(/m);
    expect(source).not.toMatch(/^\s*process\.env/m);
    // A module-scope `new Date()` would bake the build time; `Date.now()` inside a
    // function is fine, which is why this anchors to the start of the line.
    expect(source).not.toMatch(/^new Date\(\)/m);
    expect(source).not.toMatch(/^const\s+\w+\s*=\s*new Date\(/m);
  });

  it('is the only module a client component may take the quantity limit from', () => {
    // The regression guard. `input.ts` is where zod will live, so a `'use client'`
    // file importing `input.ts` re-creates the M6 bundle defect. Walked over the
    // tree rather than asserted on the word "zod" in this module, because that
    // word appears in this file's own docblocks and would fail for the wrong
    // reason — a mistake made and corrected in M6.
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) continue;

        const source = readFileSync(full, 'utf8');
        if (!/^\s*['"]use client['"]/m.test(source)) continue;

        if (/from\s+['"]@\/lib\/join\/(input|service|payment-port)['"]/.test(source)) {
          offenders.push(full.replace(process.cwd() + '/', ''));
        }
      }
    };

    walk(join(process.cwd(), 'src'));

    expect(offenders).toEqual([]);
  });

  it('is the leaf of the dependency graph, importing neither port nor service', () => {
    // The direction, asserted rather than described: `payment-port.ts` and
    // `service.ts` may import `rules.ts`, and `rules.ts` may import neither. A cycle
    // would let the pure module pull a Prisma client — or the network client behind
    // the port — into a client component through a chain nobody would think to
    // check.
    //
    // Note the assertion is on **`rules.ts`**, not on the other files. An earlier
    // draft of this test checked the wrong end and failed against correct code.
    const source = readFileSync(RULES_PATH, 'utf8');

    expect(source).not.toMatch(/from\s+['"]\.\/(payment-port|service|fake-payment-port)['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/db\//);
  });
});
