import { describe, expect, it } from 'vitest';

import {
  PUBLIC_CODE_ALPHABET,
  PUBLIC_CODE_LENGTH,
  generatePublicCode,
  isWellFormedPublicCode,
  normalisePublicCode,
} from '@/lib/drops/public-code';

/**
 * The public code is a bearer token: anybody holding `/d/{code}` can see the
 * deal. So these tests care about two things — that the alphabet cannot produce
 * a code a human will mistype, and that generation is not predictable.
 */

describe('the alphabet', () => {
  it('contains no character from a confusable pair', () => {
    // Both members of each pair are absent, which is what makes
    // `normalisePublicCode` honest: there is no lookalike to map onto.
    for (const forbidden of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(PUBLIC_CODE_ALPHABET).not.toContain(forbidden);
    }
  });

  it('is 30 symbols, and every one is unambiguous uppercase alphanumeric', () => {
    expect(PUBLIC_CODE_ALPHABET).toHaveLength(30);
    expect(new Set(PUBLIC_CODE_ALPHABET).size).toBe(30);
    expect(PUBLIC_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
  });

  it('has enough entropy at the chosen length', () => {
    // 30^8 ≈ 6.6e11. At a million drops the birthday-collision chance is ~0.07%.
    const space = Math.log10(PUBLIC_CODE_ALPHABET.length) * PUBLIC_CODE_LENGTH;
    expect(space).toBeGreaterThan(10);
  });
});

describe('generatePublicCode', () => {
  it('always produces a code of the declared length from the alphabet', () => {
    for (let index = 0; index < 500; index += 1) {
      const code = generatePublicCode();
      expect(code).toHaveLength(PUBLIC_CODE_LENGTH);
      for (const character of code) {
        expect(PUBLIC_CODE_ALPHABET).toContain(character);
      }
    }
  });

  it('does not repeat across many calls', () => {
    // Not a proof of randomness — a smoke test that the generator is not, say,
    // returning a constant or a clock-derived value.
    const codes = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      codes.add(generatePublicCode());
    }
    expect(codes.size).toBe(2_000);
  });

  it('uses the whole alphabet rather than a corner of it', () => {
    // Ties to `node:crypto.randomInt`. A `% alphabet.length` implementation on a
    // low-entropy source would still pass the tests above while clustering.
    const seen = new Set<string>();
    for (let index = 0; index < 400; index += 1) {
      for (const character of generatePublicCode()) {
        seen.add(character);
      }
    }
    expect(seen.size).toBe(PUBLIC_CODE_ALPHABET.length);
  });
});

describe('isWellFormedPublicCode', () => {
  it('accepts a generated code', () => {
    expect(isWellFormedPublicCode(generatePublicCode())).toBe(true);
  });

  it('rejects wrong lengths', () => {
    expect(isWellFormedPublicCode('')).toBe(false);
    expect(isWellFormedPublicCode('ABC')).toBe(false);
    expect(isWellFormedPublicCode('ABCDEFGHJ')).toBe(false);
  });

  it('rejects characters outside the alphabet, including the excluded ones', () => {
    for (const bad of ['ABCDEFG0', 'ABCDEFGO', 'ABCDEFG1', 'ABCDEFGI', 'ABCDEFGL', 'ABCDEFGU']) {
      expect(isWellFormedPublicCode(bad), bad).toBe(false);
    }
  });

  it('rejects lowercase and punctuation, so a path is never a valid code', () => {
    expect(isWellFormedPublicCode('abcdefgh')).toBe(false);
    expect(isWellFormedPublicCode('ABCD-EFG')).toBe(false);
    expect(isWellFormedPublicCode('<script>')).toBe(false);
  });
});

describe('normalisePublicCode', () => {
  it('uppercases and strips separators', () => {
    expect(normalisePublicCode('  abcd-2345 ')).toBe('ABCD2345');
    expect(normalisePublicCode('ABCD 2345')).toBe('ABCD2345');
  });

  it('extracts the code from a pasted path or full URL', () => {
    // The most common way to reach a code page is by pasting the link, and the
    // most common way to paste a link is with tracking or a query string on it.
    expect(normalisePublicCode('https://groupeat.ca/d/ABCD2345')).toBe('ABCD2345');
    expect(normalisePublicCode('/d/ABCD2345')).toBe('ABCD2345');
    expect(normalisePublicCode('https://groupeat.ca/d/ABCD2345?o=share-token')).toBe('ABCD2345');
    expect(normalisePublicCode('https://groupeat.ca/d/ABCD2345#top')).toBe('ABCD2345');
  });

  it('does not map lookalikes, because the alphabet cannot contain them', () => {
    // Deliberately leaves an O or I alone: inventing a value that no stored code
    // can hold would produce a code that fails the shape check with no
    // explanation the user could act on.
    expect(normalisePublicCode('ABCDEFGO')).toBe('ABCDEFGO');
    expect(isWellFormedPublicCode(normalisePublicCode('ABCDEFGO'))).toBe(false);
  });

  it('round-trips a generated code', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generatePublicCode();
      expect(normalisePublicCode(code)).toBe(code);
      expect(normalisePublicCode(code.toLowerCase())).toBe(code);
    }
  });

  it('returns an empty string for empty or whitespace input', () => {
    expect(normalisePublicCode('')).toBe('');
    expect(normalisePublicCode('   ')).toBe('');
    expect(normalisePublicCode('/d/')).toBe('');
  });
});
