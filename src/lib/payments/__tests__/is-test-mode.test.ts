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

  /**
   * A live suite is one that *reads* the opt-in flag, not one that names it.
   *
   * An earlier draft matched the bare identifier and flagged
   * `real-charge-port.wire.test.ts`, which mentions `RUN_STRIPE_LIVE_TESTS` only
   * inside a docblock describing a different suite — it makes no live call and has
   * no gate to guard. Matching `process.env.<NAME>` is the read; the name alone is
   * a mention.
   */
  const LIVE_GATE = /process\.env\.RUN_STRIPE_LIVE_TESTS/;

  /** This file, which necessarily quotes both forbidden shapes in its own prose. */
  const SELF = 'lib/payments/__tests__/is-test-mode.test.ts';

  /** One file's source, as the scans see it. Injectable so the scans can be tested. */
  type SourceFile = { readonly path: string; readonly text: string };

  /** The repo as the scans see it: every `.ts`/`.tsx` under `src/`, minus this file. */
  function repoFiles(): SourceFile[] {
    return walk(SRC)
      .map((file) => ({ path: relative(SRC, file), text: readFileSync(file, 'utf8') }))
      .filter((file) => file.path !== SELF);
  }

  /** Files whose *code* re-derives the test-mode rule by substring. */
  function handRolledOffenders(files: readonly SourceFile[]): string[] {
    return files
      .filter((file) => HAND_ROLLED.test(stripComments(file.text)))
      .map((file) => file.path);
  }

  /** Files whose *code* reads the live opt-in flag without referencing the guard. */
  function unguardedLiveSuites(files: readonly SourceFile[]): string[] {
    return files
      .filter((file) => {
        const code = stripComments(file.text);
        return LIVE_GATE.test(code) && !/\bisTestMode\b/.test(code);
      })
      .map((file) => file.path);
  }

  it('no file under src/ re-derives the test-mode rule by substring', () => {
    expect(handRolledOffenders(repoFiles())).toEqual([]);
  });

  it('every suite that can make a live call imports isTestMode', () => {
    expect(unguardedLiveSuites(repoFiles())).toEqual([]);
  });

  /**
   * The two scans are only honest if they look at code, not prose — and that has to
   * be *tested*, not asserted in a comment.
   *
   * The Gate 31 certifier caught the first version of scan 2 reading raw text while
   * its comment claimed both scans stripped comments. Removing `stripComments` from
   * the code alone fixes the instance but not the trap: a future edit could drop it
   * again and every test would still pass, because no file in the repo currently
   * trips it. The synthetic files below flow through the *same* scan functions, so
   * the stripping is load-bearing rather than decorative.
   */
  it('the scans ignore a forbidden or gated expression that appears only in a comment', () => {
    const proseOnly: SourceFile = {
      path: 'lib/fake/comment-only.ts',
      // A docblock quoting the substring rule and naming the live gate, in a file
      // that does neither in code. Without stripping this is two false positives.
      text: [
        '/** This suite used to check `key.includes(\'_test_\')` and read',
        ' *  process.env.RUN_STRIPE_LIVE_TESTS before doing so. It no longer does either. */',
        'export const nothing = 1;',
        "// trailing mention: key.includes('_test_') and process.env.RUN_STRIPE_LIVE_TESTS",
      ].join('\n'),
    };

    expect(handRolledOffenders([proseOnly])).toEqual([]);
    expect(unguardedLiveSuites([proseOnly])).toEqual([]);

    // And the same file with the expressions in code is caught, so the strip is not
    // simply ignoring everything.
    const inCode: SourceFile = {
      path: 'lib/fake/real-offence.ts',
      text: [
        proseOnly.text,
        "export const g = key.includes('_test_');",
        'export const r = process.env.RUN_STRIPE_LIVE_TESTS;',
      ].join('\n'),
    };

    expect(handRolledOffenders([inCode])).toEqual(['lib/fake/real-offence.ts']);
    expect(unguardedLiveSuites([inCode])).toEqual(['lib/fake/real-offence.ts']);
  });
});
