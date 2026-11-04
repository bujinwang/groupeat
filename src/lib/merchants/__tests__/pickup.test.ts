import { describe, expect, it } from 'vitest';

import { PICKUP_MAX_LENGTH, parsePickupInput } from '../pickup';

/**
 * FR-103 — pickup input normalisation.
 *
 * The rule that matters is the last one: `null` is the single representation of
 * "empty". The M4 deal page renders "No pickup instructions yet" or the text,
 * and it must not have to check for `''`, `'   '` and `null` separately.
 */

describe('parsePickupInput', () => {
  it('accepts a normal address and instructions', () => {
    const result = parsePickupInput({
      pickupAddress: '123 10 Ave NE, Calgary',
      pickupInstructions: 'Side door, ring the bell.',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pickupAddress).toBe('123 10 Ave NE, Calgary');
      expect(result.value.pickupInstructions).toBe('Side door, ring the bell.');
    }
  });

  it('trims surrounding whitespace', () => {
    const result = parsePickupInput({
      pickupAddress: '  123 10 Ave NE  ',
      pickupInstructions: '\n Side door \n',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pickupAddress).toBe('123 10 Ave NE');
      expect(result.value.pickupInstructions).toBe('Side door');
    }
  });

  it('normalises empty and whitespace-only values to null', () => {
    // The single-empty rule: three representations collapse to one.
    for (const value of ['', '   ', '\n\t', null, undefined]) {
      const result = parsePickupInput({ pickupAddress: value, pickupInstructions: value });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pickupAddress).toBeNull();
        expect(result.value.pickupInstructions).toBeNull();
      }
    }
  });

  it('allows clearing one field while keeping the other', () => {
    const result = parsePickupInput({
      pickupAddress: '123 10 Ave NE',
      pickupInstructions: '',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pickupAddress).toBe('123 10 Ave NE');
      expect(result.value.pickupInstructions).toBeNull();
    }
  });

  it(`rejects a value over ${PICKUP_MAX_LENGTH} characters`, () => {
    const result = parsePickupInput({
      pickupAddress: 'a'.repeat(PICKUP_MAX_LENGTH + 1),
      pickupInstructions: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.pickupAddress).toMatch(new RegExp(`${PICKUP_MAX_LENGTH}`));
    }
  });

  it(`accepts exactly ${PICKUP_MAX_LENGTH} characters`, () => {
    const result = parsePickupInput({
      pickupAddress: 'a'.repeat(PICKUP_MAX_LENGTH),
      pickupInstructions: null,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-string value rather than coercing it', () => {
    const result = parsePickupInput({ pickupAddress: 12345, pickupInstructions: null });
    expect(result.ok).toBe(false);
  });

  it('reports both field errors at once, so the form can show both', () => {
    const result = parsePickupInput({
      pickupAddress: 'a'.repeat(PICKUP_MAX_LENGTH + 1),
      pickupInstructions: 'b'.repeat(PICKUP_MAX_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.fieldErrors).sort()).toEqual([
        'pickupAddress',
        'pickupInstructions',
      ]);
    }
  });

  it('ignores unknown keys entirely — a floor change cannot ride along', () => {
    // FR-103's route exists separately from the floor route so that editing an
    // address cannot submit a margin. This pins that the parser drops extras
    // rather than passing them through to a spread.
    const result = parsePickupInput({
      pickupAddress: '123 10 Ave NE',
      pickupInstructions: null,
      floorPctOfMenu: 0.01,
      floorFloor: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(['pickupAddress', 'pickupInstructions']);
    }
  });
});

/**
 * Presence semantics — the difference between "leave it alone" and "empty it".
 *
 * ## Why this is a separate subject from normalisation
 *
 * The tests above are about *values*: trimming, caps, and collapsing `''`, `'  '`
 * and `null` into one `null`. These are about *keys*. A `PATCH` body has three
 * states per field and they are all different:
 *
 *   | body | meaning |
 *   |---|---|
 *   | `{}` | change nothing |
 *   | `{ pickupInstructions: null }` | empty it |
 *   | `{ pickupInstructions: 'Door 3.' }` | set it |
 *
 * The old parser returned a `PickupInput` with both keys always present, so state
 * 1 and state 2 were indistinguishable downstream and the writer erased the field
 * the caller had not mentioned. The fix is that the result carries **only the keys
 * the body carried**, which is why these assertions are `toEqual` on the whole
 * object rather than per-field: the absence of a key is the claim.
 */
describe('parsePickupInput — which keys come back', () => {
  it('returns an empty object for an empty body, so nothing is written', () => {
    const result = parsePickupInput({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
      // `toEqual({})` alone would also pass for `{ a: undefined }` in some
      // comparison modes, so the key count is asserted separately. This is the
      // assertion that fails if the implementation ever goes back to
      // `pickupAddress: clean(...)` for both fields.
      expect(Object.keys(result.value)).toEqual([]);
    }
  });

  it('returns only the key the body named', () => {
    const result = parsePickupInput({ pickupAddress: '1 New Rd' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ pickupAddress: '1 New Rd' });
      expect('pickupInstructions' in result.value).toBe(false);
    }
  });

  it('distinguishes a present null from an absent key', () => {
    // The two states the defect collapsed. Both bodies below are "no instructions"
    // to a naive reader and completely different instructions to a PATCH.
    const cleared = parsePickupInput({ pickupInstructions: null });
    const untouched = parsePickupInput({});

    expect(cleared.ok && 'pickupInstructions' in cleared.value).toBe(true);
    expect(untouched.ok && 'pickupInstructions' in untouched.value).toBe(false);
  });

  it('keeps a present empty string as a cleared key rather than dropping it', () => {
    // `''` is a present key, so it must survive as `null` — not vanish. If
    // presence were tested by truthiness, this would silently become a no-op and
    // a merchant could never clear their instructions.
    const result = parsePickupInput({ pickupInstructions: '' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('pickupInstructions' in result.value).toBe(true);
      expect(result.value.pickupInstructions).toBeNull();
    }
  });

  it('drops an unknown key without inventing the known ones', () => {
    // A body of pure typos is not a body that clears both fields. The route turns
    // the resulting `{}` into a 422; the parser's job is only to not lie about it.
    const result = parsePickupInput({ pickupAdress: '1 New Rd' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
    }
  });

  it('still validates the fields a body does name', () => {
    // Presence handling must not have opened a hole in the per-field rules.
    const result = parsePickupInput({ pickupAddress: 'a'.repeat(PICKUP_MAX_LENGTH + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.pickupAddress).toMatch(new RegExp(`${PICKUP_MAX_LENGTH}`));
    }
  });
});
