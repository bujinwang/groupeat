import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isStripeConfigured, isTestMode } from '../stripe';

/**
 * The test-mode guard, and the rule that live-money suites must actually use it.
 *
 * ## Why this file exists
 *
 * `isTestMode()` had **zero tests and zero callers**. Meanwhile two opt-in
 * live-money suites — `fee-bearer.live.test.ts` and `real-charge-port.live.test.ts` —
 * each carried a docblock saying "`isTestMode()` is asserted before any charge",
 * and neither imported it. Both hand-rolled their own predicate instead:
 *
 *     const canRun =
 *       process.env.RUN_STRIPE_LIVE_TESTS === '1' &&
 *       isStripeConfigured() &&
 *       (process.env.STRIPE_SECRET_KEY ?? '').includes('_test_');
 *
 * The prose was therefore false in the most expensive direction: it told a reader
 * that the shipped guard was the thing standing between an opt-in run and a real
 * charge, when the thing actually standing there was a substring test.
 *
 * ## Why a substring test is not equivalent
 *
 * `includes('_test_')` asks whether the string contains those six characters
 * anywhere. `isTestMode()` asks whether the key *is a test key* — `sk_test_` or
 * `rk_test_` prefix. Measured divergence (below, and pinned):
 *
 *   - `sk_live_test_51abc` → substring gate **open**, `isTestMode()` **false**
 *   - `rk_live_test_9`     → substring gate **open**, `isTestMode()` **false**
 *
 * A live secret key whose opaque body happens to contain `_test_` would let an
 * operator who typed `RUN_STRIPE_LIVE_TESTS=1` create connected accounts and move
 * real money while the docblock promised a test-mode assertion. Unlikely, but the
 * whole point of a guard is that it does not depend on the accident.
 *
 * ## Why the second half is a source-text test
 *
 * The forbidden thing is an *expression*, not a behaviour: "no live suite may
 * re-derive the test-mode rule". There is no runtime assertion that can express
 * that — the code either exists in the file or it does not, and the only place to
 * look is the source. Same shape, and same reason, as
 * `src/lib/settlement/__tests__/no-inline-fee-rounding.test.ts`.
 */

/** `src/` — four levels up from `src/lib/payments/__tests__/this-file`. */
const SRC = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('isTestMode', () => {
  const original = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = original;
    vi.restoreAllMocks();
  });

  it('accepts a test-mode secret key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_51abcdef';
    expect(isTestMode()).toBe(true);
  });

  it('accepts a test-mode restricted key', () => {
    process.env.STRIPE_SECRET_KEY = 'rk_test_51abcdef';
    expect(isTestMode()).toBe(true);
  });

  it('rejects a live secret key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_51abcdef';
    expect(isTestMode()).toBe(false);
  });

  it('rejects a live key whose body merely contains "_test_"', () => {
    // The case the hand-rolled substring gate got wrong. Both of these pass
    // `includes('_test_')` and are NOT test-mode keys.
    process.env.STRIPE_SECRET_KEY = 'sk_live_test_51abcdef';
    expect(isTestMode()).toBe(false);

    process.env.STRIPE_SECRET_KEY = 'rk_live_test_9abcdef';
    expect(isTestMode()).toBe(false);
  });

  it('rejects a missing key rather than treating absence as test mode', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(isTestMode()).toBe(false);
  });

  it('distinguishes "configured" from "test mode" — a publishable key satisfies neither', () => {
    // `isStripeConfigured` gates on `sk_`/`rk_`; a `pk_` key is not a secret key.
    process.env.STRIPE_SECRET_KEY = 'pk_test_51abcdef';
    expect(isStripeConfigured()).toBe(false);
    expect(isTestMode()).toBe(false);
  });
});

/**
 * Strips comments so the scan sees code, not prose.
 *
 * This matters because the correction itself has to *name* the forbidden
 * expression to explain why it was forbidden — the comment in each live suite
 * quotes `includes('_test_')`. Without stripping, the documentation of the fix
 * would fail the test that enforces the fix, which would push the next person to
 * delete the explanation rather than keep it.
 *
 * Deliberately naive: it removes `/* … *\/` and `// …` without parsing strings, so
 * a `//` inside a string literal would over-strip. The scan only asks whether a
 * six-character expression survives, and an over-strip can only produce a false
 * pass on a line that also contains a URL — none of the files in scope do.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('live-money suites use the shared test-mode guard', () => {
  /**
   * Any test file that can make a real provider call must not spell the test-mode
   * rule itself. Detected by the substring literal, which is the only way this rule
   * has ever been written by hand here.
   */
  const HAND_ROLLED = /\.includes\(\s*['"]_test_['"]\s*\)/;

  it('no file under src/ re-derives the test-mode rule by substring', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      // Skip this file: its own docblock quotes the forbidden expression.
      if (relative(SRC, file) === 'lib/payments/__tests__/is-test-mode.test.ts') continue;
      if (HAND_ROLLED.test(text)) {
        offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every suite that can make a live call imports isTestMode', () => {
    /**
     * A live suite is one that *reads* the opt-in flag, not one that names it.
     *
     * An earlier draft matched the bare identifier and flagged
     * `real-charge-port.wire.test.ts`, which mentions `RUN_STRIPE_LIVE_TESTS` only
     * inside a docblock describing a different suite — it makes no live call and
     * has no gate to guard. Matching `process.env.<NAME>` is the read; matching the
     * name alone is a mention, and conflating them would have demanded an import
     * for a variable that file never looks at.
     */
    const LIVE_GATE = /process\.env\.RUN_STRIPE_LIVE_TESTS/;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!LIVE_GATE.test(text)) continue;
      if (relative(SRC, file) === 'lib/payments/__tests__/is-test-mode.test.ts') continue;
      if (!/\bisTestMode\b/.test(text)) {
        offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
