import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * One implementation of the per-unit fee rule, in production code.
 *
 * ADR-004 §4 decides that the platform fee is rounded **per unit, then
 * multiplied**. `platform-fee.ts` implements it. Nothing else in `src/` may
 * re-derive it, because a second implementation is a second rounding rule and the
 * failure is silent: the merchant's per-plate figure simply stops matching what
 * their balance says, and no test written against either implementation alone can
 * see it.
 *
 * This is a source-text test rather than a unit test, which is unusual, and it is
 * the right shape here for a specific reason: the thing being forbidden is an
 * *expression*, not a behaviour. A behavioural test cannot express "nobody may
 * write `qty * roundHalfUp(...)`" — the code either exists somewhere or it does
 * not, and the only place to look is the source.
 *
 * Test files are exempt, and the exemption is the point of the oracle argument in
 * `platform-fee.ts`'s docblock: an expected value computed by the implementation
 * under test proves nothing.
 */

/** `src/` — four levels up from `src/lib/settlement/__tests__/this-file`. */
const SRC = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const PLATFORM_FEE = 'lib/settlement/platform-fee.ts';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** A test file, or a fixture a test uses. Both may legitimately restate the rule. */
function isTestCode(relPath: string): boolean {
  return relPath.includes('__tests__/') || /\.test\.tsx?$/.test(relPath) || relPath.endsWith('settlement-fixtures.ts');
}

/**
 * Strips comments before scanning, **preserving line numbers**.
 *
 * Without this the scan reports the docblock in `settle.ts` that *states* the rule
 * (`> DropParticipant.platformFeeCents = qty × roundHalfUp(...)`) rather than code
 * computing it. A check that fires on documentation is a check that gets deleted
 * or `eslint-disable`d within a week.
 *
 * Each comment is replaced by its own newlines, so a reported line still points at
 * the line a reader would open. A scan whose line numbers are off by forty is a
 * scan nobody follows.
 */
function stripComments(source: string): string {
  const blank = (block: string): string => block.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the per-unit fee rule has exactly one implementation', () => {
  it('nothing outside platform-fee.ts multiplies a rounded platform fee by a quantity', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const relFromLib = relative(SRC, file);
      if (relFromLib === PLATFORM_FEE || isTestCode(relFromLib)) {
        continue;
      }

      const source = stripComments(readFileSync(file, 'utf8'));

      // The shape ADR-004 forbids: **multiplying** a rounded platform fee. The
      // multiplication is what makes it the order-total rule rather than the
      // per-plate one — `roundHalfUp(platformFeeAt(...))` on its own is exactly
      // what the guardrail panel is supposed to compute (`view.ts`,
      // `snapshotBreakdown`), so matching that alone would flag correct code and
      // force someone to weaken this check.
      const patterns: { name: string; pattern: RegExp }[] = [
        {
          name: 'multiplies a rounded platform fee',
          pattern:
            /(?:qty|quantity|[\w.?[\]]*\bqty\b)\s*\*\s*roundHalfUp\s*\(\s*platformFeeAt\s*\(|roundHalfUp\s*\(\s*platformFeeAt\s*\([^)]*\)\s*\)\s*\*\s*(?:qty|quantity)/,
        },
        {
          name: 'multiplies platformFeeCentsPerUnit(...)',
          pattern: /\bplatformFeeCentsPerUnit\s*\([^)]*\)\s*\*/,
        },
        {
          name: 'multiplies a stored platform fee by a quantity',
          pattern: /\b(?:qty|quantity)\s*\*\s*[\w.?[\]]*platformFeeCents\b/i,
        },
        {
          name: 'multiplies a stored platform fee by a quantity (reversed)',
          pattern: /\bplatformFeeCents\b[\w.?[\]]*\s*\*\s*(?:qty|quantity)\b/i,
        },
      ];

      for (const { name, pattern } of patterns) {
        const match = pattern.exec(source);
        if (match) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`src/${relFromLib}:${String(line)} ${name}`);
        }
      }
    }

    expect(
      offenders,
      'ADR-004 §4: use platformFeeCentsForOrder() rather than re-deriving the per-unit rule',
    ).toEqual([]);
  });

  it('the scan would have caught the old hand-written expression', () => {
    // A control, because a scan that matches nothing is indistinguishable from a
    // scan that is broken. This is the exact string the tests used before
    // `platform-fee.ts` existed; if the patterns above do not flag it, they are not
    // doing anything.
    const oldExpression = 'const fee = qty * roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));';
    const reversed = 'const fee = roundHalfUp(platformFeeAt(1112, DEFAULT_FEES)) * qty;';
    const pattern =
      /(?:qty|quantity|[\w.?[\]]*\bqty\b)\s*\*\s*roundHalfUp\s*\(\s*platformFeeAt\s*\(|roundHalfUp\s*\(\s*platformFeeAt\s*\([^)]*\)\s*\)\s*\*\s*(?:qty|quantity)/;

    expect(pattern.test(oldExpression)).toBe(true);
    expect(pattern.test(reversed)).toBe(true);

    // And it does not fire on the per-plate computation the panel legitimately
    // does, or this test would be arguing against the guardrail.
    expect(pattern.test('const fee = roundHalfUp(platformFeeAt(priceCents, constants));')).toBe(false);

    // Stated limit: `roundHalfUp(platformFeeAt(p)) * 3` with a *literal* quantity
    // is not caught, because "any integer multiplied by a rounded fee" is
    // indistinguishable from ordinary arithmetic without a type system. That is
    // acceptable — the join path's quantity is a variable, so the realistic form is
    // covered — but it is a limit, not a gap somebody should assume is closed.
    expect(pattern.test('const fee = roundHalfUp(platformFeeAt(1112)) * 3;')).toBe(false);
  });

  it('the guardrail itself is allowed to round a per-plate figure, and does', () => {
    // `snapshotBreakdown` and `buildDealView` compute the *per-unit* fee for the
    // panel — `roundHalfUp(platformFeeAt(price))` with no multiplication. That is
    // the same rule at qty 1 and is not a second implementation, so the scan above
    // must not be widened in a way that makes it a false positive and forces
    // someone to bypass it.
    const view = readFileSync(join(SRC, 'lib/guardrail/view.ts'), 'utf8');
    expect(view).toContain('roundHalfUp(platformFeeAt(');
    expect(view).not.toMatch(/(?:qty|quantity)\s*\*\s*platformFeeCents/i);
  });
});
