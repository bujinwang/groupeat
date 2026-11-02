/**
 * The one terminal-error class of the settlement path — design §3.3, §11.4.
 *
 * ## Why it is not declared in `settle.ts`
 *
 * The design shows it there, and `settle.ts` re-exports it so that import path
 * still works. But `ledger.ts` must throw it too (§6.3 `LEDGER_MISMATCH`), and
 * `settle.ts` imports `ledger.ts`. Declaring the class in `settle.ts` would make
 * that a cycle — and a cycle around a class used at runtime is a temporal-dead-
 * zone bug waiting for the one import order nobody tested. A third file costs
 * one import and removes the possibility.
 *
 * ## What it means
 *
 * `SettlementIntegrityError` is never retried. Either the numbers on our own rows
 * do not describe a charge we are willing to make, or the drop is in a state
 * `settle()` must not touch. The response (§11.4) is: log at `error`, stop that
 * drop, continue with the others, page on-call. A retry would re-read the same
 * wrong number.
 */

export type SettlementIntegrityCheck =
  | 'AMOUNT_MISMATCH'
  | 'MISSING_PAYMENT_INTENT'
  | 'MISSING_STRIPE_ACCOUNT'
  | 'LEDGER_MISMATCH';

export class SettlementIntegrityError extends Error {
  readonly dropId: string;
  readonly participantId: string | null;
  readonly check: SettlementIntegrityCheck;

  constructor(args: {
    dropId: string;
    check: SettlementIntegrityCheck;
    /** Detail, appended to the message. For `LEDGER_MISMATCH` it carries both sides. */
    detail: string;
    participantId?: string | null;
  }) {
    super(`${args.check} on drop ${args.dropId}: ${args.detail}`);
    this.name = 'SettlementIntegrityError';
    this.dropId = args.dropId;
    this.check = args.check;
    this.participantId = args.participantId ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSettlementIntegrityError(error: unknown): error is SettlementIntegrityError {
  return error instanceof SettlementIntegrityError;
}
