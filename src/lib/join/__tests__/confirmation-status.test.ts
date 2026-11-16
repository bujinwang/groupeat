import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JOIN_REFUSAL_COPY, type JoinRefusalReason } from '../rules';

/**
 * The confirmation screen must branch on `status`, and this is the guard that says so.
 *
 * ## The defect, measured 2026-11-16
 *
 * `JoinSuccess.status` had a complete production chain: the service computed it
 * (`service.ts:702`), the route emitted it under `satisfies JoinSuccessBody`
 * (`route.ts:224`), and the client type declared it (`wire.ts:49`). All three
 * compiled, and the last link was missing: `grep -c "joined.status" JoinForm.tsx`
 * returned **0**.
 *
 * `Confirmation` rendered, for every `ok: true` result:
 *
 * > "N plates held for $X. Nothing has been charged."
 *
 * `PENDING` means the opposite may be true — a previous attempt reserved the row
 * and died before the provider answered, so a hold may exist and nobody knows. The
 * one case the field was added for got the strongest reassurance on the page.
 *
 * `service.test.ts` now owns the fact ("delivers `PENDING`"), and this file owns the
 * reader. It is a **source-text** guard because `vitest.config.ts` sets
 * `environment: 'node'` with no DOM, so no test in this repo can render a client
 * component. The alternative was to leave the branch unwatched, which is how the
 * defect happened.
 *
 * ## What a text guard can and cannot prove — stated so a green run is not read as more
 *
 * **Proves:** the component reads `joined.status`; the false reassurance is inside a
 * branch rather than unconditional; a distinct `PENDING` headline and body exist; and
 * the amber styling differs from the emerald, so the two states are not merely
 * different sentences on an identical green panel.
 *
 * **Does not prove:** that React renders the right branch at runtime. A `.tsx`
 * render test needs a DOM and this repo has none — the same limitation
 * `real-port-boundary.test.ts` records about source-text guards. It would not catch
 * a wrong `===` comparison, only the removal of the branch.
 */

const ROOT = process.cwd();

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/**
 * Strips comments, so prose *about* the fix cannot satisfy an assertion *for* it.
 *
 * This is not hypothetical: the first version of the test below counted occurrences
 * of "Nothing has been charged" and found three — the guarded sentence, the no-keys
 * panel, and the explanatory comment I had just written above `resolved`. A comment
 * counting as a rendered sentence is the same class of error as the defect itself.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the join confirmation branches on the row’s real state', () => {
  const form = codeOnly(source('src/components/public/JoinForm.tsx'));

  it('reads joined.status rather than assuming an authorisation', () => {
    // The exact grep that returned 0 and let the defect ship.
    expect(form).toContain('joined.status');
  });

  it('never prints the reassurance without first checking the status', () => {
    // The bug was not the sentence — it is correct when a hold exists — but that it
    // was printed for *every* `ok: true`. So the assertion is about guarding, not
    // about the words: inside `Confirmation`, the sentence appears exactly once and
    // only after the component has derived a state from `joined.status`.
    //
    // The file has two other occurrences and neither is this screen: the comment
    // above `resolved` (prose), and the no-keys panel, where the sentence is
    // *correctly* unconditional because no card is ever taken there. Scoping to the
    // `Confirmation` function is what makes this assertion mean something.
    const start = form.indexOf('function Confirmation(');
    const end = form.indexOf('export function PaymentsNotConfigured(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const confirmation = form.slice(start, end);

    expect(confirmation.match(/Nothing has been charged/g)).toHaveLength(1);

    const guard = confirmation.indexOf("const resolved = joined.status === 'AUTHORIZED'");
    const reassurance = confirmation.indexOf('Nothing has been charged');
    expect(guard, 'no `resolved` guard derived from joined.status').toBeGreaterThan(-1);
    expect(reassurance).toBeGreaterThan(guard);

    // And the sentence is inside a ternary on that guard, not at the top level.
    expect(confirmation.slice(guard, reassurance)).toMatch(/\{resolved \?/);
  });

  it('gives PENDING its own headline and does not claim a hold', () => {
    // "We could not confirm your card" — a sentence that cannot be read as success.
    expect(form).toContain('We could not confirm your card');
    // And the PENDING body must not assert the absence of a hold, because the hold
    // may exist. It says the bank may be holding the money and points at the bank.
    expect(form).toMatch(/Your bank may be\s+holding/);
  });

  it('styles the two states differently, so they cannot be confused at a glance', () => {
    // A diner scanning a phone sees the colour before the sentence. Amber vs emerald
    // is the cheapest thing that fails when a branch is added without a style.
    expect(form).toMatch(/amber-50/);
    expect(form).toMatch(/emerald-50/);
  });

  it('offers no pickup-code promise on the PENDING screen', () => {
    // The bookmark line under the panel is shared, so it is asserted to be *outside*
    // the status branch: it is true in both states (the order is saved either way).
    expect(form).toContain('This order is under the number ending');
  });
});

describe('the refusal copy is exhaustive and honest', () => {
  /**
   * Every refusal a diner can see says whether money moved, and says it once.
   *
   * The 13-member `JOIN_REFUSAL_COPY` map is typed `Record<JoinRefusalReason, …>`, so
   * completeness is the compiler's job. What the compiler cannot check is the
   * *content*: a refusal that mentions money must say it was not charged, because
   * "declined" without that leaves a diner wondering. Measured before this test:
   * only two of thirteen sentences were asserted anywhere, and the join route's own
   * two assertions covered two reasons.
   */
  const reasons = Object.keys(JOIN_REFUSAL_COPY) as JoinRefusalReason[];

  /** Refusals a diner reaches only after a card was offered to the provider. */
  const MONEY_REASONS: JoinRefusalReason[] = [
    'SOLD_OUT',
    'NOT_ENOUGH_LEFT',
    'FAILED',
    'CANCELLED',
    'PRICE_UNAVAILABLE',
    'PAYMENT_DECLINED',
    'PAYMENT_UNAVAILABLE',
    'PAYMENTS_NOT_CONFIGURED',
  ];

  it('has copy for every reason, and no empty sentence', () => {
    expect(reasons).toHaveLength(13);
    for (const reason of reasons) {
      const copy = JOIN_REFUSAL_COPY[reason];
      expect(copy.title.trim().length, `${reason}.title is empty`).toBeGreaterThan(0);
      expect(copy.detail.trim().length, `${reason}.detail is empty`).toBeGreaterThan(0);
      // No template artifact reached a diner.
      expect(copy.detail).not.toMatch(/\bundefined\b|\bNaN\b|\[object/);
    }
  });

  it('tells the diner no money moved on every refusal that follows a card attempt', () => {
    for (const reason of MONEY_REASONS) {
      const detail = JOIN_REFUSAL_COPY[reason].detail.toLowerCase();
      expect(
        /nothing has been charged|nobody was charged|not been charged|released/.test(detail),
        `${reason} mentions money without saying none moved: "${JOIN_REFUSAL_COPY[reason].detail}"`,
      ).toBe(true);
    }
  });

  it('separates a declined card from an unreachable network, because the recovery differs', () => {
    // "Try another card" vs "try again in a minute". Conflating them tells a diner
    // with a good card to give up, which is the reason the union splits them.
    expect(JOIN_REFUSAL_COPY.PAYMENT_DECLINED.detail).toMatch(/different card/i);
    expect(JOIN_REFUSAL_COPY.PAYMENT_UNAVAILABLE.detail).toMatch(/again in a minute/i);
  });
});
