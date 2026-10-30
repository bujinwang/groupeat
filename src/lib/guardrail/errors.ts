/**
 * Error codes produced by the pure guardrail module.
 *
 * Exactly one code exists today (ARCHITECTURE-sprint1 §7.4). The module throws
 * for *missing* cost data only; a bad cost *relationship* is a validation
 * outcome and a price that cannot clear the floor is a `null` return, not an
 * exception.
 */
export enum GuardrailErrorCode {
  /** `foodCostCents` is `null`, `undefined`, `NaN` or non-finite. */
  INCOMPLETE_COST_DATA = 'INCOMPLETE_COST_DATA',
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
      default:
        return 'Guardrail evaluation failed.';
    }
  }
}

/** Narrowing helper, so callers can `catch` without `instanceof` gymnastics. */
export function isGuardrailError(value: unknown): value is GuardrailError {
  return value instanceof GuardrailError;
}
