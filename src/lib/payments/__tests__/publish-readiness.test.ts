import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The publish write-boundary rule, and the rule that its call sites must use it.
 *
 * ## Why this file exists
 *
 * `canPublishDrop()` (2026-11-20 Gate 32) had **zero production callers**. Its
 * docblock says it exists so a publish action does not re-derive
 * `state === 'READY'` in a page component. Meanwhile both live publish call
 * sites did exactly that:
 *
 *     // api/merchant/drops/[id]/publish/route.ts:43   (before)
 *     const payoutsReady = onboarding.state === 'READY';
 *     // (merchant)/merchant/drops/[id]/page.tsx:170   (before)
 *     payoutsReady={(await readOnboarding(...)).state === 'READY'}
 *
 * A third shape, `assertCanPublish()` (onboarding-service.ts:220), re-derived
 * the refusal with `state !== 'READY'` and had zero callers too. It is deleted.
 *
 * The two spellings are not equivalent under source drift: the canonical rule
 * requires `state === 'READY' && canAcceptPayments`; the hand-rolled one only
 * asks for `READY`. Today `assessOnboarding` makes READY imply
 * `canAcceptPayments`, so the two are behaviourally identical — which is exactly
 * why no runtime test caught this and why the invariant has to be a *source*
 * invariant. There is no runtime assertion for "which function produced this
 * boolean"; the expression either exists in the file or it does not.
 *
 * Same shape, and same reason, as the two Gate 31 scans:
 * `lib/payments/__tests__/is-test-mode.test.ts` and
 * `lib/settlement/__tests__/no-inline-fee-rounding.test.ts`.
 *
 * ## Why the scan is scoped to the `payoutsReady` flag
 *
 * A third `.state === 'READY'` lives at `merchant/payouts/page.tsx:64`. It drives
 * a *read-only status badge*, not a publish decision, and the lead explicitly
 * kept it out of Gate 32's scope. A scan that flagged every `.state === 'READY'`
 * under `src/` would force an unrelated file change just to go green. So scan 1
 * asks for the conjunction: a `payoutsReady` flag **and** a hand-rolled READY
 * comparison in the same file's code. That is the named invariant — the flag
 * that reaches `publishDrop` and `PublishButton` must come from
 * `canPublishDrop` — without pretending the rendering read is the same rule.
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

/**
 * Strips comments so the scan sees code, not prose.
 *
 * This is load-bearing: the correction itself has to *name* the forbidden
 * expressions in dated comments at each fixed site, and this docblock quotes
 * both of them. Without stripping, documenting the fix would fail the test that
 * enforces it, which would push the next reader to delete the explanation.
 *
 * Deliberately naive — it removes `/* … *\/` and `// …` without parsing strings,
 * so a `//` inside a string literal would over-strip. The scan only asks whether
 * two short expressions survive, and an over-strip can only produce a false pass
 * on a line that also contains a URL — none of the files in scope do. The
 * synthetic-input test below proves the strip actually happens.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The canonical rule's home — the only file allowed to spell the comparison. */
const CANONICAL = 'lib/payments/onboarding.ts';

/** This file, which necessarily quotes both forbidden shapes in its own prose. */
const SELF = 'lib/payments/__tests__/publish-readiness.test.ts';

/** The publish-readiness flag both live call sites pass down. */
const PAYOUTS_READY_FLAG = /\bpayoutsReady\b/;

/** A hand-rolled `READY` grant, outside the canonical rule. */
const HAND_ROLLED_READY = /\.state\s*===\s*['"]READY['"]/;

/** A hand-rolled `READY` refusal — the deleted `assertCanPublish` shape. */
const HAND_ROLLED_REFUSAL = /\.state\s*!==\s*['"]READY['"]/;

describe('publish write-boundary uses the canonical readiness rule', () => {
  /** One file's source, as the scans see it. Injectable so the scans can be tested. */
  type SourceFile = { readonly path: string; readonly text: string };

  /** The repo as the scans see it: every `.ts`/`.tsx` under `src/`, minus the two exemptions. */
  function repoFiles(): SourceFile[] {
    return walk(SRC)
      .map((file) => ({ path: relative(SRC, file), text: readFileSync(file, 'utf8') }))
      .filter((file) => file.path !== CANONICAL && file.path !== SELF);
  }

  /** Files whose *code* builds the publish flag from a hand-rolled READY check. */
  function handRolledPayoutsReady(files: readonly SourceFile[]): string[] {
    return files
      .filter((file) => {
        const code = stripComments(file.text);
        return PAYOUTS_READY_FLAG.test(code) && HAND_ROLLED_READY.test(code);
      })
      .map((file) => file.path);
  }

  /** Files whose *code* re-derives the publish refusal with `state !== 'READY'`. */
  function handRolledRefusals(files: readonly SourceFile[]): string[] {
    return files
      .filter((file) => HAND_ROLLED_REFUSAL.test(stripComments(file.text)))
      .map((file) => file.path);
  }

  it('no payoutsReady flag is derived from a hand-rolled state === READY check', () => {
    expect(handRolledPayoutsReady(repoFiles())).toEqual([]);
  });

  it('no file re-derives the publish refusal with state !== READY', () => {
    expect(handRolledRefusals(repoFiles())).toEqual([]);
  });

  /**
   * The scans are only honest if they look at code, not prose — and that has to
   * be *tested*, not asserted in a comment.
   *
   * The prose-only file below quotes both forbidden expressions and names the
   * flag, in a file that does neither in code. Without stripping this is three
   * false positives. The same file with the expressions in code is caught by
   * both scans, so the strip is not simply ignoring everything — and the
   * injected `SourceFile[]` is the same type `repoFiles()` returns.
   */
  it('the scans ignore the forbidden expressions in comments but bite on code', () => {
    const proseOnly: SourceFile = {
      path: 'lib/fake/comment-only.ts',
      text: [
        '/** 2026-11-20: this file used to compute',
        ' *   const payoutsReady = onboarding.state === \'READY\';',
        ' * and refuse with assessment.state !== \'READY\'. It now calls canPublishDrop. */',
        'export const nothing = 1;',
        '// trailing mention: payoutsReady, state === \'READY\', state !== \'READY\'',
      ].join('\n'),
    };

    expect(handRolledPayoutsReady([proseOnly])).toEqual([]);
    expect(handRolledRefusals([proseOnly])).toEqual([]);

    const inCode: SourceFile = {
      path: 'lib/fake/real-offence.ts',
      text: [
        proseOnly.text,
        'const payoutsReady = onboarding.state === \'READY\';',
        'if (assessment.state !== \'READY\') throw new Error("payouts");',
      ].join('\n'),
    };

    expect(handRolledPayoutsReady([inCode])).toEqual(['lib/fake/real-offence.ts']);
    expect(handRolledRefusals([inCode])).toEqual(['lib/fake/real-offence.ts']);
  });
});
