import { describe, expect, it } from 'vitest';

import { isUniqueViolation } from '../drops';

/**
 * `isUniqueViolation` — the predicate the public-code retry loop depends on.
 *
 * ## Why this file exists
 *
 * The function executed **zero** statements across the whole suite before this
 * file. It has exactly one production caller (`createDraft`'s `publicCode` retry
 * at `drops.ts:206`), and that caller only reaches it when Prisma actually throws
 * `P2002` — which no existing test provokes, because provoking a real unique
 * collision on `publicCode` requires the generator to collide. So the branch that
 * decides "retry with a new code" vs "give up and rethrow" was never measured.
 *
 * ## The contract this file pins
 *
 * It is *not* "returns true for a unique violation". It is the narrower rule the
 * docblock states: a `P2002` counts only when it names **this** field, except that
 * a `P2002` with **no** target is treated as ours, because `publicCode` is the only
 * unique column the code generates. Those are three separate decisions (field match,
 * field mismatch, missing target) and each has a different consequence in the retry
 * loop:
 *
 *   - match      -> retry with a fresh code (progress)
 *   - mismatch   -> rethrow; someone else's unique column broke (a real bug)
 *   - no target  -> retry; the cheaper assumption, documented at the return
 *
 * A predicate that collapsed mismatch into match would silently retry forever on a
 * collision it cannot fix. That is the failure this file exists to make impossible.
 */

const P2002 = { code: 'P2002' } as const;

describe('isUniqueViolation — what counts as *our* unique collision', () => {
  describe('non-violations are rejected before any field is considered', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'P2002'],
      ['a number', 42],
      ['a boolean', true],
    ])('returns false for %s', (_label, value) => {
      expect(isUniqueViolation(value, 'publicCode')).toBe(false);
    });

    it('returns false for an object with no code at all', () => {
      expect(isUniqueViolation({ message: 'boom' }, 'publicCode')).toBe(false);
    });

    it('returns false for a different Prisma error code', () => {
      // P2003 is a foreign-key violation; retrying the generator would not help.
      expect(isUniqueViolation({ code: 'P2003' }, 'publicCode')).toBe(false);
    });
  });

  describe('a P2002 is ours only when it names the field', () => {
    it('matches when meta.target is the field name (string form)', () => {
      expect(isUniqueViolation({ code: 'P2002', meta: { target: 'publicCode' } }, 'publicCode')).toBe(
        true,
      );
    });

    it('matches when meta.target is a list containing the field (array form)', () => {
      expect(
        isUniqueViolation({ code: 'P2002', meta: { target: ['publicCode'] } }, 'publicCode'),
      ).toBe(true);
    });

    it('matches when the field is one entry of a compound target', () => {
      // A composite unique index reports every column; ours being present is enough.
      expect(
        isUniqueViolation(
          { code: 'P2002', meta: { target: ['merchantId', 'publicCode'] } },
          'publicCode',
        ),
      ).toBe(true);
    });

    it('rejects a P2002 that names a different field (string form)', () => {
      expect(isUniqueViolation({ code: 'P2002', meta: { target: 'slug' } }, 'publicCode')).toBe(false);
    });

    it('rejects a P2002 whose list does not contain the field', () => {
      expect(
        isUniqueViolation({ code: 'P2002', meta: { target: ['merchantId', 'slug'] } }, 'publicCode'),
      ).toBe(false);
    });

    it('does not treat a substring of the field as a match', () => {
      // `Code` is a proper substring of `publicCode`, and `includes` must be asked
      // the right way round: `target.includes(field)` is false for target `Code` and
      // field `publicCode`, whereas `field.includes(target)` would be true.
      //
      // The case matters and is not decoration. An earlier version of this vector
      // used `code` (lower-case), which is *not* a substring of `publicCode` — the
      // capital C separates them — so both spellings returned false and the vector
      // could not tell the correct implementation from the reversed one. Found by
      // mutation: reversing the arguments in the string branch survived, which is
      // the only reason this line says `Code`.
      expect(
        isUniqueViolation({ code: 'P2002', meta: { target: 'Code' } }, 'publicCode'),
      ).toBe(false);

      // And the positive control for the same asymmetry: asked correctly, that pair
      // is a genuine substring *of the target*, so it is not ours either way —
      // demonstrating that the assertion above is about direction, not about `Code`
      // being special.
      expect(isUniqueViolation({ code: 'P2002', meta: { target: 'publicCode' } }, 'Code')).toBe(
        true,
      );
    });
  });

  describe('a P2002 with no usable target is presumed ours', () => {
    it('matches when meta is absent entirely', () => {
      expect(isUniqueViolation(P2002, 'publicCode')).toBe(true);
    });

    it('matches when meta.target is undefined', () => {
      expect(isUniqueViolation({ code: 'P2002', meta: {} }, 'publicCode')).toBe(true);
    });

    it('matches when meta.target is neither a string nor an array', () => {
      // A driver that reports the target as some other shape should not defeat the
      // retry loop — that is the "cannot be defeated by a driver detail" promise.
      expect(isUniqueViolation({ code: 'P2002', meta: { target: 7 } }, 'publicCode')).toBe(true);
    });
  });
});
