import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * AC-8 — the import-graph assertion.
 *
 * This test is the reason the guardrail can be trusted as "the product": it
 * proves the folder has no dependency on this application, this framework, this
 * database, or this clock. It is also the reason the module can be lifted into
 * another product unchanged.
 *
 * `__tests__/` is excluded deliberately: the harness needs `vitest` and
 * `node:fs`. The guarantee is about production code.
 */

const GUARDRAIL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const EXPECTED_FILES = [
  'constants.ts',
  'errors.ts',
  'evaluateDeal.ts',
  'fees.ts',
  'index.ts',
  'minViablePrice.ts',
  'money.ts',
  'plausibility.ts',
  'states.ts',
  'types.ts',
  'validate.ts',
  'view.ts',
] as const;

/** Ambient capabilities a pure function may not reach for. */
const FORBIDDEN_GLOBALS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'Date.now()', pattern: /\bDate\s*\.\s*now\b/ },
  { name: 'new Date()', pattern: /\bnew\s+Date\b/ },
  { name: 'Math.random()', pattern: /\bMath\s*\.\s*random\b/ },
  { name: 'fetch()', pattern: /\bfetch\s*\(/ },
  { name: 'process.env', pattern: /\bprocess\s*\.\s*env\b/ },
  { name: 'process (any)', pattern: /\bprocess\s*\./ },
  { name: 'performance.now()', pattern: /\bperformance\s*\.\s*now\b/ },
  { name: 'require()', pattern: /\brequire\s*\(/ },
  { name: 'window', pattern: /\bwindow\s*\./ },
  { name: 'document', pattern: /\bdocument\s*\./ },
  { name: 'console', pattern: /\bconsole\s*\./ },
  { name: 'crypto', pattern: /\bcrypto\s*\./ },
  { name: 'setTimeout', pattern: /\bsetTimeout\s*\(/ },
  { name: 'setInterval', pattern: /\bsetInterval\s*\(/ },
  { name: 'globalThis', pattern: /\bglobalThis\s*\./ },
  { name: 'localStorage', pattern: /\blocalStorage\b/ },
];

function sourceFiles(): string[] {
  return readdirSync(GUARDRAIL_DIR)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts'))
    .filter((entry) => statSync(join(GUARDRAIL_DIR, entry)).isFile())
    .sort();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import … from 'x' / export … from 'x'
    /\bimport\s*['"]([^'"]+)['"]/g, // import 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('x')
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

describe('AC-8 · the guardrail folder is dependency-free', () => {
  it('contains exactly the twelve expected modules', () => {
    expect(sourceFiles()).toEqual([...EXPECTED_FILES]);
  });

  it('imports nothing but its own files', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(join(GUARDRAIL_DIR, file), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const isRelativeInternal = specifier.startsWith('./') || specifier.startsWith('../');
        if (!isRelativeInternal) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never reaches for a framework, a database, a clock or a random source', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(join(GUARDRAIL_DIR, file), 'utf8');
      for (const { name, pattern } of FORBIDDEN_GLOBALS) {
        if (pattern.test(source)) {
          offenders.push(`${file} uses ${name}`);
        }
      }
      // The architecture's literal substring list, applied to import statements
      // only — prose in a comment must not trip the check.
      for (const specifier of importSpecifiers(source)) {
        if (/^(next|react|react-dom|@prisma|prisma|fs|node:)/.test(specifier)) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('has no default exports (naming rule §7.1)', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(join(GUARDRAIL_DIR, file), 'utf8');
      if (/\bexport\s+default\b/.test(source)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
