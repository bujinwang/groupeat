import { describe, expect, it } from 'vitest';

import { lintCopy, lintCopyField } from '../copy-lint';

/**
 * The linter's job is to be the thing that stops a model's sentence from becoming
 * a claim the merchant has to defend. These tests are written as pairs — a phrase
 * that must trip, and a near-identical phrase that must not — because a banned
 * list that over-fires is as unusable as one that under-fires: the first makes
 * every rewrite fall back, the second lets a health claim through.
 */

const CONTEXT = { dealPriceCents: 1310, menuPriceCents: 1600 };

function kinds(field: 'title' | 'description' | 'shareMessage' | 'rationale', text: string) {
  return lintCopyField(field, text, CONTEXT).map((violation) => violation.kind);
}

describe('banned terms', () => {
  it('catches a health claim', () => {
    expect(kinds('description', 'A healthy bowl of greens.')).toContain('banned_term');
    expect(kinds('description', 'This detox broth cures the winter blues.')).toContain('banned_term');
  });

  it('does not fire on a word that merely contains a banned one', () => {
    // "secure" contains "cure". A substring match here would reject every
    // sentence about card payments.
    expect(kinds('description', 'Secure checkout, no account needed.')).not.toContain('banned_term');
    expect(kinds('description', 'Procurement is handled for you.')).not.toContain('banned_term');
  });

  it('catches an unsubstantiated superlative', () => {
    expect(kinds('title', 'Best in Calgary')).toContain('banned_term');
    expect(kinds('rationale', 'The ultimate lunch.')).toContain('banned_term');
  });

  it('catches a guarantee', () => {
    expect(kinds('shareMessage', 'Guaranteed to sell out.')).toContain('banned_term');
    expect(kinds('description', '100% fresh, always.')).toContain('banned_term');
  });

  it('catches scarcity the system did not generate', () => {
    // FR-304 owns scarcity, and it owns it from the real counter.
    expect(kinds('description', 'Selling fast — almost gone.')).toContain('banned_term');
  });

  it('leaves plain copy alone', () => {
    expect(
      kinds(
        'description',
        'Pickup Tuesday 2pm–4pm. Made in one batch. Joining closes Tuesday 11am.',
      ),
    ).toEqual([]);
  });
});

describe('price and discount arithmetic', () => {
  it('rejects a price that is not the deal price', () => {
    const violations = lintCopyField('shareMessage', 'Get it for $12.99 a plate.', CONTEXT);
    expect(violations.map((violation) => violation.kind)).toContain('price_mismatch');
    expect(violations[0]?.detail).toContain('$13.10');
  });

  it('accepts the real deal price and the real menu price', () => {
    // The menu price is allowed because a "was $16.00" reference is legitimate
    // and is the Competition Act's own requirement.
    expect(kinds('shareMessage', '$13.10 a plate, was $16.00.')).toEqual([]);
  });

  it('rejects a percentage that overstates the discount', () => {
    const violations = lintCopyField('description', '30% off for the group.', CONTEXT);
    expect(violations.map((violation) => violation.kind)).toContain('discount_mismatch');
  });

  it('accepts a percentage within one point of the truth', () => {
    // 18.1% real; copy may round to 18%.
    expect(kinds('description', '18% off.')).toEqual([]);
    expect(kinds('description', '18.1 percent off.')).toEqual([]);
  });

  it('does not read a number of hours as a percentage', () => {
    expect(kinds('rationale', '12 hours of notice, 20 orders minimum.')).toEqual([]);
  });
});

describe('length', () => {
  it('rejects a share message over 140 characters', () => {
    expect(kinds('shareMessage', 'x'.repeat(141))).toContain('too_long');
    expect(kinds('shareMessage', 'x'.repeat(140))).toEqual([]);
  });

  it('checks every field when given a whole proposal', () => {
    const violations = lintCopy(
      {
        title: 'Best bowl',
        description: 'A healthy option.',
        shareMessage: '$99.00 today only.',
        rationale: 'Short.',
      },
      CONTEXT,
    );

    expect(new Set(violations.map((violation) => violation.field))).toEqual(
      new Set(['title', 'description', 'shareMessage']),
    );
    // The rationale was fine, so it must not appear.
    expect(violations.some((violation) => violation.field === 'rationale')).toBe(false);
  });
});
