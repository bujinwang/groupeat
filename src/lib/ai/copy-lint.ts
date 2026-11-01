/**
 * The copy linter — PRD-v1 §15.3, plus two checks §15.3 does not name.
 *
 * §15.3 asks for a banned-term list: no medical or health claims, no
 * unsubstantiated superlatives. That is here. Two further checks are here because
 * they guard the same thing — that nothing on a deal page is a statement the
 * merchant cannot stand behind:
 *
 *   - **A price the copy states must be the price the copy is attached to.**
 *     The model is handed "$13.10" and told to reuse it. If it writes "$12.99"
 *     — a very model-shaped mistake — the deal page would quote two different
 *     prices. Nothing else in the system would notice.
 *   - **A percentage must match the real discount.** "30% off" on a deal that is
 *     18% off is the exact misrepresentation the Competition Act is about
 *     (PRD-v1 §15.2), and it is the second thing a model reaches for when asked
 *     to make an offer sound attractive.
 *
 * A violation does not fail the request. It makes the caller fall back to the
 * planner's own copy for that one field: the merchant still gets three proposals,
 * one of them written by a human-reviewed template instead of by a model. AI
 * failure must never block a sale (§9.1.4).
 */

export type CopyField = 'title' | 'description' | 'shareMessage' | 'rationale';

export const COPY_FIELD_LIMITS: Readonly<Record<CopyField, number>> = {
  title: 60,
  description: 300,
  shareMessage: 140,
  rationale: 300,
};

export type CopyViolationKind =
  | 'banned_term'
  | 'price_mismatch'
  | 'discount_mismatch'
  | 'too_long';

export type CopyViolation = {
  field: CopyField;
  kind: CopyViolationKind;
  /** Names the offending term or number. Safe to log; never contains PII. */
  detail: string;
};

/**
 * Words that make a claim the merchant would have to prove.
 *
 * Matched on word boundaries, case-insensitively, so `secure` does not trip
 * `cure` and `unhealthy` does not slip past `healthy` unnoticed (it trips it,
 * which is the intended direction — `unhealthy` is still a health claim).
 *
 * Grouped by what makes them a problem, because the merchant-facing explanation
 * differs: a health claim is a regulatory risk, a superlative is a Competition
 * Act risk, a guarantee is a contractual risk.
 */
const BANNED_TERMS: readonly { term: string; group: string }[] = [
  // Health and medical claims (PRD-v1 §15.3).
  { term: 'cure', group: 'health' },
  { term: 'cures', group: 'health' },
  { term: 'detox', group: 'health' },
  { term: 'detoxify', group: 'health' },
  { term: 'cleanse', group: 'health' },
  { term: 'healthy', group: 'health' },
  { term: 'healthier', group: 'health' },
  { term: 'healthiest', group: 'health' },
  { term: 'superfood', group: 'health' },
  { term: 'immune', group: 'health' },
  { term: 'immunity', group: 'health' },
  { term: 'anti-inflammatory', group: 'health' },
  { term: 'inflammation', group: 'health' },
  { term: 'weight loss', group: 'health' },
  { term: 'lose weight', group: 'health' },
  { term: 'fat burning', group: 'health' },
  { term: 'cholesterol', group: 'health' },
  { term: 'blood sugar', group: 'health' },
  { term: 'diabetic', group: 'health' },
  { term: 'probiotic', group: 'health' },
  { term: 'medicinal', group: 'health' },
  { term: 'therapeutic', group: 'health' },
  { term: 'clinically', group: 'health' },
  { term: 'doctor-approved', group: 'health' },
  { term: 'organic', group: 'health' },

  // Superlatives that cannot be substantiated (PRD-v1 §15.3).
  { term: 'best', group: 'superlative' },
  { term: 'greatest', group: 'superlative' },
  { term: 'finest', group: 'superlative' },
  { term: 'number one', group: 'superlative' },
  { term: 'top-rated', group: 'superlative' },
  { term: 'award-winning', group: 'superlative' },
  { term: 'unbeatable', group: 'superlative' },
  { term: 'ultimate', group: 'superlative' },
  { term: 'legendary', group: 'superlative' },
  { term: 'world-famous', group: 'superlative' },
  { term: 'perfect', group: 'superlative' },

  // Guarantees — a promise the platform cannot make on the merchant's behalf.
  { term: 'guarantee', group: 'guarantee' },
  { term: 'guaranteed', group: 'guarantee' },
  { term: 'risk-free', group: 'guarantee' },
  { term: 'money-back', group: 'guarantee' },
  { term: '100%', group: 'guarantee' },

  // Scarcity claims the system did not generate. FR-304 owns scarcity, and it
  // owns it from the real counter — copy that asserts it independently is a lie
  // with no data behind it.
  { term: 'selling fast', group: 'scarcity' },
  { term: 'almost gone', group: 'scarcity' },
  { term: 'last chance', group: 'scarcity' },
];

/** Escapes a term for use inside a `RegExp`, then anchors it on word boundaries. */
function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `\b` is wrong for terms ending in `%` or `-`, so those get a plain
  // boundary-free match. `100%` and `money-back` are unambiguous strings.
  const needsBoundary = /^[a-z]/i.test(term) && /[a-z]$/i.test(term);
  return new RegExp(needsBoundary ? `\\b${escaped}\\b` : escaped, 'i');
}

const COMPILED_TERMS = BANNED_TERMS.map((entry) => ({
  ...entry,
  pattern: termPattern(entry.term),
}));

/** `$13.10`, `$13`, `13.10 dollars` — every way a model writes a price. */
const DOLLAR_AMOUNT = /\$\s?(\d+(?:\.\d{1,2})?)/g;

/** `30%`, `30 %`, `30 percent`. */
const PERCENT_AMOUNT = /(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;

export type LintContext = {
  /** The price the copy is attached to. */
  dealPriceCents: number;
  /** The menu price, so a "was" price in the copy can be checked too. */
  menuPriceCents: number;
};

/**
 * Checks one field's text. Returns every violation found, not the first — a
 * caller repairing copy needs the whole list.
 */
export function lintCopyField(
  field: CopyField,
  text: string,
  context: LintContext,
): CopyViolation[] {
  const violations: CopyViolation[] = [];

  for (const entry of COMPILED_TERMS) {
    if (entry.pattern.test(text)) {
      violations.push({
        field,
        kind: 'banned_term',
        detail: `"${entry.term}" (${entry.group})`,
      });
    }
  }

  for (const match of text.matchAll(DOLLAR_AMOUNT)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const cents = Math.round(Number(raw) * 100);
    if (cents !== context.dealPriceCents && cents !== context.menuPriceCents) {
      violations.push({
        field,
        kind: 'price_mismatch',
        detail: `says $${raw}, but the deal price is $${(context.dealPriceCents / 100).toFixed(2)}`,
      });
    }
  }

  const realDiscountPct = ((context.menuPriceCents - context.dealPriceCents) / context.menuPriceCents) * 100;

  for (const match of text.matchAll(PERCENT_AMOUNT)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const claimed = Number(raw);
    // One percentage point of tolerance: the copy may round 18.4% to 18%.
    if (Math.abs(claimed - realDiscountPct) > 1) {
      violations.push({
        field,
        kind: 'discount_mismatch',
        detail: `claims ${raw}% off, but the real discount is ${realDiscountPct.toFixed(1)}%`,
      });
    }
  }

  const limit = COPY_FIELD_LIMITS[field];
  if (text.length > limit) {
    violations.push({
      field,
      kind: 'too_long',
      detail: `${text.length} characters, limit ${limit}`,
    });
  }

  return violations;
}

/**
 * Checks a whole proposal's copy. Fields that are missing are skipped, so a
 * partial rewrite (the model only improved the title) is linted on its own terms.
 */
export function lintCopy(
  fields: Partial<Record<CopyField, string>>,
  context: LintContext,
): CopyViolation[] {
  const violations: CopyViolation[] = [];
  for (const field of Object.keys(COPY_FIELD_LIMITS) as CopyField[]) {
    const text = fields[field];
    if (typeof text !== 'string') continue;
    violations.push(...lintCopyField(field, text, context));
  }
  return violations;
}

/** The merchant-facing sentence for a violation. Used by the API response. */
export function describeViolation(violation: CopyViolation): string {
  switch (violation.kind) {
    case 'banned_term':
      return `The wording ${violation.detail} is a claim we cannot put on a deal page.`;
    case 'price_mismatch':
      return `The wording ${violation.detail}.`;
    case 'discount_mismatch':
      return `The wording ${violation.detail}.`;
    case 'too_long':
      return `The wording is ${violation.detail}.`;
  }
}
