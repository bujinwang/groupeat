import { z } from 'zod';

/**
 * The two request bodies the pickup counter sends.
 *
 * ## Why a separate module from `rules.ts`
 *
 * `rules.ts` is the domain: it decides whether food may change hands, and it is
 * imported by the route, the tests and (eventually) the offline scanner in V1.1.
 * This file is the wire format: what arrives over HTTP, and what shape it is
 * allowed to be in. Keeping them apart means a change to the request body cannot
 * accidentally change a refusal rule, and `rules.ts` stays importable in a context
 * that has no `zod`.
 *
 * ## The code is length-capped, not pattern-capped
 *
 * A hard `v1.…` regex here would be a second, weaker copy of the signature check:
 * it would reject valid future versions and accept `v1.a.b` as "well formed". The
 * cap exists for a different reason — a scanner that reads a 4 MB QR payload, or a
 * paste of an entire browser window, must be rejected before it reaches an HMAC
 * over the whole string. 2048 bytes is far beyond any token this system mints and
 * far below anything that makes a difference to the CPU.
 */

export const MAX_SCANNED_CODE_LENGTH = 2048;

const redeemSchema = z.object({
  code: z.string().min(1, 'Scan or type a code.').max(MAX_SCANNED_CODE_LENGTH, 'That code is too long.'),
  /**
   * How many plates to hand over. Omitted means all of them, which is the normal
   * scan: a staff member scans a code, not a quantity.
   */
  requested: z.number().int().min(1).max(99).optional(),
});

export type RedeemInput = {
  readonly code: string;
  readonly requested?: number;
};

export type ParsedRedeem =
  | { ok: true; value: RedeemInput }
  | { ok: false; fieldErrors: Record<string, string> };

export function parseRedeemInput(raw: unknown): ParsedRedeem {
  const parsed = redeemSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  // `requested` is passed through only when present: `undefined` means "all
  // remaining", and `resolveRedeemQuantity` distinguishes that from an explicit
  // number. Coercing a missing value to 1 would hand over one plate to a party of
  // four and call it a success.
  return {
    ok: true,
    value:
      parsed.data.requested === undefined
        ? { code: parsed.data.code }
        : { code: parsed.data.code, requested: parsed.data.requested },
  };
}
