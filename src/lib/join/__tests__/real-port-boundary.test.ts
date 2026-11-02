import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The real payment port must be reached only through `await import()`.
 *
 * ## Why this is a test and not a comment
 *
 * `real-payment-port.ts` imports `server-only`, which throws outside a React Server
 * Component graph. A **static** import of it from the route would make every
 * DB-backed test that transitively loads the route fail at module load, with an
 * error that names `server-only` rather than the import that caused it. That is the
 * failure mode `settlement/real-charge-port.ts` documented and `run-tick.ts` solved
 * with a dynamic import; this file pins the same rule for the join path before the
 * mistake is made rather than after.
 *
 * ## What "reached only dynamically" means precisely
 *
 * Exactly one non-test file may name the module, and in that file it must appear
 * inside `await import(`. Comments are excluded from the count, because both the
 * route and the port explain the rule in prose — an earlier draft of a similar
 * check in this project asserted on the *word* and failed against correct code.
 */

const ROOT = process.cwd();

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/** Strips line and block comments, so prose about the rule cannot trip it. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the real join payment port', () => {
  it('is imported statically nowhere outside its own file and its tests', () => {
    const route = codeOnly(source('src/app/api/public/drops/[code]/join/route.ts'));

    // The one reference in the route is dynamic.
    expect(route).toMatch(/await\s+import\(\s*['"]@\/lib\/join\/real-payment-port['"]\s*\)/);
    // And no static import of it exists in the route.
    expect(route).not.toMatch(/^\s*import\s[^;]*real-payment-port/m);
  });

  it('is not imported by the service, the rules, or the fake', () => {
    for (const relative of [
      'src/lib/join/service.ts',
      'src/lib/join/rules.ts',
      'src/lib/join/fake-payment-port.ts',
      'src/lib/join/payment-port.ts',
    ]) {
      const text = codeOnly(source(relative));
      expect(text).not.toMatch(/real-payment-port/);
    }
  });

  it('hard-codes capture_method: manual and never takes it as a parameter', () => {
    // FR-404 and AGENTS.md's first non-negotiable, asserted at the source. A
    // `capture_method` a caller could set is a capture a join could request.
    const text = codeOnly(source('src/lib/join/real-payment-port.ts'));

    expect(text).toContain('JOIN_CAPTURE_METHOD');
    // Never a field on the request type — that would make it a parameter.
    const port = codeOnly(source('src/lib/join/payment-port.ts'));
    expect(port).not.toMatch(/capture_method\s*[?:]/);
    // The constant itself is the literal, once.
    expect(port).toMatch(/JOIN_CAPTURE_METHOD\s*=\s*'manual'\s+as\s+const/);
  });

  it('constructs no Stripe client of its own', () => {
    // `src/lib/payments/stripe.ts` is the only constructor in the repo, and every
    // money-touching call goes through `forMerchant()` so the `stripeAccount`
    // option is carried at construction (ADR-001 §3.1).
    const text = codeOnly(source('src/lib/join/real-payment-port.ts'));

    expect(text).not.toMatch(/new\s+Stripe\s*\(/);
    expect(text).toContain('forMerchant(');
  });
});
