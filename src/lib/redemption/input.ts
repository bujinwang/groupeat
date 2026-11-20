import { z } from 'zod';

import { MAX_SCANNED_CODE_LENGTH } from './rules';

/**
 * The two request bodies the pickup counter sends.
 *
 * ## Why a separate module from `rules.ts`
 *
 * `rules.ts` is the domain: it decides whether food may change hands, and it is
 * imported by the route, the tests and — importantly — the browser. This file is
 * the wire format: what arrives over HTTP, and what shape it is allowed to be in.
 * Keeping them apart means a change to the request body cannot accidentally change
 * a refusal rule, and `rules.ts` stays importable in a client component that has no
 * business carrying `zod`.
 *
 * That separation is load-bearing and was nearly lost: `MAX_SCANNED_CODE_LENGTH`
 * first lived here, and the scanner screen importing it pulled the whole validation
 * library into the page's JavaScript. The constant lives in `rules.ts` now, and the
 * rule is that **nothing in `rules.ts` may import anything outside itself**.
 *
 * ## The code is length-capped, not pattern-capped
 *
 * A hard `v1.…` regex here would be a second, weaker copy of the signature check:
 * it would reject valid future versions and accept `v1.a.b` as "well formed". The
 * cap exists for a different reason — a scanner that reads a 4 MB QR payload, or a
 * paste of an entire browser window, must be rejected before it reaches an HMAC
 * over the whole string.
 */

const redeemSchema = z.object({
  code: z.string().min(1, 'Scan or type a code.').max(MAX_SCANNED_CODE_LENGTH, 'That code is too long.'),
  /**
   * How many plates to hand over. Omitted means all of them, which is the normal
   * scan: a staff member scans a code, not a quantity.
   */
  requested: z.number().int().min(1).max(99).optional(),
  /**
   * FR-606 — the client's idempotency key for this scan.
   *
   * Omitted by callers that do not queue, which keeps the endpoint's behaviour
   * unchanged for them. A client that retries must send the same value on every
   * attempt; the server uses it to answer a replay instead of taking more plates.
   *
   * Capped at 128 because it is attacker-controlled and lands in an index. Not
   * validated as a UUID: the contract is "stable string", and pinning a format would
   * reject a future client for no security gain — the uniqueness constraint is what
   * protects anything here.
   */
  scanId: z.string().min(1).max(128).optional(),
});

export type RedeemInput = {
  readonly code: string;
  readonly requested?: number;
  readonly scanId?: string;
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
  //
  // `scanId` is the same shape for the same reason: absent means "do not dedupe",
  // which is what an unqueued client wants and what every pre-FR-606 caller does.
  return {
    ok: true,
    value: {
      code: parsed.data.code,
      ...(parsed.data.requested === undefined ? {} : { requested: parsed.data.requested }),
      ...(parsed.data.scanId === undefined ? {} : { scanId: parsed.data.scanId }),
    },
  };
}
