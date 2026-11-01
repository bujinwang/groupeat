/**
 * Error codes produced by the pure guardrail module.
 *
 * Two codes (ARCHITECTURE-sprint1 §7.4, extended at M3). The module throws for
 * *missing* cost data and for a nonsensical stored snapshot only; a bad cost
 * *relationship* is a validation outcome and a price that cannot clear the floor
 * is a `null` return, not an exception.
 */
export enum GuardrailErrorCode {
  /** `foodCostCents` is `null`, `undefined`, `NaN` or non-finite. */
  INCOMPLETE_COST_DATA = 'INCOMPLETE_COST_DATA',
  /**
   * A stored `guardrailSnapshot` is malformed: not an object, missing `version`,
   * or a `version` this build does not understand.
   *
   * Its own code rather than `INCOMPLETE_COST_DATA` because the fix is different
   * — this one means an unreadable row, not a merchant with a missing number.
   */
  SNAPSHOT_UNREADABLE = 'SNAPSHOT_UNREADABLE',
}

/** The only exception type the pure module is allowed to throw. */
export class GuardrailError extends Error {
  readonly code: GuardrailErrorCode;

  constructor(code: GuardrailErrorCode, message?: string) {
    super(message ?? GuardrailError.defaultMessage(code));
    this.name = 'GuardrailError';
    this.code = code;
    // Restores the prototype chain when the class is down-levelled by a bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  private static defaultMessage(code: GuardrailErrorCode): string {
    switch (code) {
      case GuardrailErrorCode.INCOMPLETE_COST_DATA:
        return 'foodCostCents is required to evaluate a deal price.';
      case GuardrailErrorCode.SNAPSHOT_UNREADABLE:
        return 'The stored guardrail snapshot cannot be read by this build.';
      default:
        return 'Guardrail evaluation failed.';
    }
  }
}

/** Narrowing helper, so callers can `catch` without `instanceof` gymnastics. */
export function isGuardrailError(value: unknown): value is GuardrailError {
  return value instanceof GuardrailError;
}
