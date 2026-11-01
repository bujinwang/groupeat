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
