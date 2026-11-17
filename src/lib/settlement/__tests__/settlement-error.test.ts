import { describe, expect, it } from 'vitest';

import {
  SettlementIntegrityError,
  isSettlementIntegrityError,
} from '../settlement-error';

/**
 * The one predicate used by the tick's containment rule.
 *
 * `run-tick.ts` used to classify by `error.name` alone while this exported type
 * guard had zero callers. Those two spellings disagree on the important case:
 * an unrelated error can borrow the name, and a terminal integrity failure is
 * supposed to be the *only* thing containing a per-drop failure. The first test
 * below pins the class that production throws; the next two pin the two ways a
 * non-integrity error used to pass the old local check.
 */
describe('isSettlementIntegrityError', () => {
  it('accepts the error class thrown by the settlement path', () => {
    const error = new SettlementIntegrityError({
      dropId: 'drop_predicate_1',
      check: 'AMOUNT_MISMATCH',
      detail: 'expected 100, found 90',
    });

    expect(isSettlementIntegrityError(error)).toBe(true);
    if (isSettlementIntegrityError(error)) {
      expect(error.check).toBe('AMOUNT_MISMATCH');
      expect(error.dropId).toBe('drop_predicate_1');
    }
  });

  it('rejects an ordinary error that only borrows the class name', () => {
    const impostor = Object.assign(new Error('synthetic db failure'), {
      name: 'SettlementIntegrityError',
    });

    expect(isSettlementIntegrityError(impostor)).toBe(false);
  });

  it('rejects a plain object that borrows the name and the check field', () => {
    const impersonation = {
      name: 'SettlementIntegrityError',
      check: 'LEDGER_MISMATCH',
      dropId: 'drop_predicate_2',
    };

    expect(isSettlementIntegrityError(impersonation)).toBe(false);
  });
});
