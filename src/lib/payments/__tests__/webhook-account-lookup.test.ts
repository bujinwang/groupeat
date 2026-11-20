import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The webhook's account-to-merchant lookup has exactly one spelling.
 *
 * ## Why this file exists
 *
 * `findMerchantByAccountId()` (`lib/payments/real-connect-port.ts`) had **zero
 * callers**. Its docblock said so, its webhook test mock threw
 * "not reachable from the webhook", and the webhook carried its own inline copy
 * of the same lookup plus the same `logger.warn('stripe.webhook_rejected', {
 * reason: 'unknown_account' })`. That is two spellings of an auth-adjacent
 * decision — which merchant an authenticated Stripe account event belongs to —
 * with the shared one unreachable. Their behaviour could drift: a change to the
 * lookup or the reject policy in one place would silently miss the other.
 *
 * Gate 33 resolved this in favour of wiring: the webhook calls the shared helper
 * and no longer queries Prisma itself. The behaviour is identical either way
 * today, which is exactly why a runtime test alone cannot enforce the choice —
 * there is no assertion that can ask "which line produced this merchant id".
 * Like `lib/payments/__tests__/publish-readiness.test.ts` and
 * `lib/payments/__tests__/is-test-mode.test.ts`, the invariant is about source
 * text, so it is checked against source text.
 *
 * Two scans: the route must not spell its own `prisma.merchant.findUnique`
 * account lookup, and it must import *and* call `findMerchantByAccountId`.
 * Both look at code with comments stripped — this docblock and the dated
 * correction at the fixed sites quote the forbidden expressions, and the
 * synthetic test at the end proves the strip actually happens rather than
 * merely being claimed.
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
 * Strips comments so the scan sees code, not prose. Deliberately naive — it
 * removes `/* … *\/` and `// …` without parsing strings, so a `//` inside a
 * string literal would over-strip. The scan only asks whether a few short
 * expressions survive, and an over-strip can only produce a false pass on a
 * line that also contains a URL — the route does not contain one. The
 * synthetic-input test below proves the strip is load-bearing.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The only file the rule applies to. Other modules legitimately query merchants. */
const ROUTE = 'app/api/webhooks/stripe/route.ts';

/** This file, which necessarily quotes both forbidden shapes in its own prose. */
const SELF = 'lib/payments/__tests__/webhook-account-lookup.test.ts';

/** The duplicated lookup: an account-to-merchant Prisma read in the route. */
const INLINE_LOOKUP = /prisma\.merchant\.findUnique/;

/** The shared helper, imported from its one home… */
const SHARED_IMPORT = /import\s*\{[^}]*\bfindMerchantByAccountId\b[^}]*\}\s*from\s*['"]@\/lib\/payments\/real-connect-port['"]/;

/** …and actually called, not merely imported. */
const SHARED_CALL = /\bfindMerchantByAccountId\s*\(/;

describe('the webhook uses the shared account lookup', () => {
  /** One file's source, as the scans see it. Injectable so the scans can be tested. */
  type SourceFile = { readonly path: string; readonly text: string };

  /** The repo as the scans see it: every `.ts`/`.tsx` under `src/`, minus this file. */
  function repoFiles(): SourceFile[] {
    return walk(SRC)
      .map((file) => ({ path: relative(SRC, file), text: readFileSync(file, 'utf8') }))
      .filter((file) => file.path !== SELF);
  }

  /** Route files whose *code* still does its own merchant lookup. */
  function inlineLookups(files: readonly SourceFile[]): string[] {
    return files
      .filter((file) => file.path === ROUTE && INLINE_LOOKUP.test(stripComments(file.text)))
      .map((file) => file.path);
  }

  /** Route files whose *code* does not import and call the shared helper. */
  function missingSharedLookup(files: readonly SourceFile[]): string[] {
    return files
      .filter((file) => {
        if (file.path !== ROUTE) return false;
        const code = stripComments(file.text);
        return !(SHARED_IMPORT.test(code) && SHARED_CALL.test(code));
      })
      .map((file) => file.path);
  }

  it('the webhook route does not do its own prisma.merchant.findUnique account lookup', () => {
    expect(inlineLookups(repoFiles())).toEqual([]);
  });

  it('the webhook route imports and calls findMerchantByAccountId', () => {
    expect(missingSharedLookup(repoFiles())).toEqual([]);
  });

  /**
   * The scans are only honest if they look at code, not prose — and that has to
   * be *tested*, not asserted in a comment.
   *
   * The prose-only route below quotes both forbidden shapes and the required
   * import/call, in a file that does neither in code. Without stripping it is
   * two false positives at once: the inline lookup looks present and the shared
   * helper looks wired. The same file with both expressions in code is caught
   * by both scans the other way round, so the strip is not simply ignoring
   * everything — and the injected `SourceFile[]` is the type `repoFiles()` returns.
   */
  it('the scans ignore the expressions in comments but bite on code', () => {
    const proseOnly: SourceFile = {
      path: ROUTE,
      text: [
        '/** 2026-11-20: this route used to run its own',
        ' *   prisma.merchant.findUnique({ where: { stripeAccountId: account.id } })',
        " * instead of `import { findMerchantByAccountId } from '@/lib/payments/real-connect-port'`",
        ' * followed by `findMerchantByAccountId(account.id)`. That duplication is gone. */',
        'export const nothing = 1;',
        '// trailing mention: prisma.merchant.findUnique, findMerchantByAccountId',
      ].join('\n'),
    };

    expect(inlineLookups([proseOnly])).toEqual([]);
    expect(missingSharedLookup([proseOnly])).toEqual([ROUTE]);

    const inCode: SourceFile = {
      path: ROUTE,
      text: [
        proseOnly.text,
        "import { findMerchantByAccountId } from '@/lib/payments/real-connect-port';",
        'export async function POST() { return findMerchantByAccountId("acct_x"); }',
        "export const inline = prisma.merchant.findUnique({ where: { id: 'x' } });",
      ].join('\n'),
    };

    expect(inlineLookups([inCode])).toEqual([ROUTE]);
    expect(missingSharedLookup([inCode])).toEqual([]);
  });
});
