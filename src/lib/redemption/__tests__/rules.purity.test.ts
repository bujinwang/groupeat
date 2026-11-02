import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `rules.ts` must stay importable from a client component.
 *
 * ## The bug this exists for
 *
 * The scanner screen needs `MAX_SCANNED_CODE_LENGTH` for its `maxLength`. That
 * constant was first declared in `input.ts`, next to the zod schema that uses it —
 * so importing the integer into a `'use client'` component pulled **all of zod**
 * into the page's JavaScript. `/merchant/pickup` went from 104 kB to 122 kB of
 * first-load JS and carried a 56 kB chunk of validation code that runs only on the
 * server.
 *
 * The bundler cannot help here: `input.ts` defines schemas at module scope, so the
 * whole module is live and tree-shaking has nothing to remove. Expressing the
 * constraint as a lint rule for "client files may not import this" would need a
 * per-import allowlist that the next constant would slip through. A dependency
 * check on the module itself is the version that does not rot.
 *
 * ## The rule
 *
 * `rules.ts` imports **nothing**. It is the pure half: no database, no zod, no
 * `server-only`, no Node built-ins. That is what makes it safe to ship to a phone
 * and what makes its unit tests run in 10 ms.
 *
 * Verified by reading the source rather than by walking the module graph: a graph
 * walk would need to resolve aliases and would pass for a transitive import of zod
 * through a re-export. The text is the ground truth for "imports nothing".
 */

const RULES_PATH = join(process.cwd(), 'src/lib/redemption/rules.ts');

function importLines(source: string): string[] {
  return source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /^import\s/.test(line) || /^export\s.*\bfrom\s/.test(line))
    .map(({ line, number }) => `${number}: ${line}`);
}

describe('lib/redemption/rules.ts', () => {
  it('imports nothing at all', () => {
    const source = readFileSync(RULES_PATH, 'utf8');
    const imports = importLines(source);

    // Reported with line numbers so a failure points at the offending import rather
    // than at "this file has an import".
    expect(imports).toEqual([]);
  });

  it('has no side-effecting top-level statement that would make it un-shakeable', () => {
    const source = readFileSync(RULES_PATH, 'utf8');

    // A `require`, a `process.env` read or a `new Date()` at module scope would all
    // defeat the point: the module must be a bag of pure functions. `Date.now()`
    // inside a function is fine and is why this checks the start of the line only.
    expect(source).not.toMatch(/^require\(/m);
    expect(source).not.toMatch(/^\s*process\.env/m);
    expect(source).not.toMatch(/^new Date\(\)/m);
    expect(source).not.toMatch(/^const\s+\w+\s*=\s*new Date\(/m);
  });

  it('is not imported with zod by any client component', () => {
    // The actual regression. `input.ts` is where zod lives, so the rule that keeps
    // the browser bundle clean is "no `'use client'` file imports `input.ts`" — and
    // the constant a client needs must come from `rules.ts`.
    //
    // Checked by walking the component tree, because a future screen importing the
    // schema module is exactly how this came back the first time. Asserting on the
    // *word* zod in `rules.ts` would be worse than useless: the module's own
    // docblock explains this bug and therefore contains the word.
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
        const isClient = /^\s*['"]use client['"]/m.test(source);
        if (!isClient) continue;

        if (/from\s+['"]@\/lib\/redemption\/input['"]/.test(source)) {
          offenders.push(full.replace(process.cwd() + '/', ''));
        }
      }
    };

    walk(join(process.cwd(), 'src'));

    expect(offenders).toEqual([]);
  });
});
