import { z } from 'zod';

/**
 * Pickup details (FR-103).
 *
 * The limits are not arbitrary: `Merchant.pickupAddress` and
 * `pickupInstructions` both feed the **public deal page** in M4, and the address
 * also feeds the OG preview card. A 400-character instruction is not a data
 * problem, it is a broken layout problem on a 360px phone, so the cap lives at
 * the write boundary rather than being discovered at render time.
 *
 * Shared by the merchant settings route and the merchant settings form, for the
 * same reason `validateItemCosts` is shared: two copies of a rule is how the
 * browser and the server end up disagreeing about what is valid.
 */

/** 300 chars, matching the admin editor's existing limit. */
export const PICKUP_MAX_LENGTH = 300;

export const pickupSchema = z.object({
  pickupAddress: z
    .string()
    .trim()
    .max(PICKUP_MAX_LENGTH, `Use ${PICKUP_MAX_LENGTH} characters or fewer.`)
    .nullish(),
  pickupInstructions: z
    .string()
    .trim()
    .max(PICKUP_MAX_LENGTH, `Use ${PICKUP_MAX_LENGTH} characters or fewer.`)
    .nullish(),
});

/**
 * What a `PATCH` body asked to change — only the keys that were present.
 *
 * ## Why this type exists, and what it replaces
 *
 * It was `PickupInput`, which had a value for both fields. That is right for a
 * full write and **wrong for a `PATCH`**, and it was the shape that made the
 * defect expressible: `pickupSchema` marks both fields `.nullish()`, and
 * `clean()` collapsed "absent" and "blank" into the same `null`, so
 *
 *     { "pickupAddress": "1 New Rd" }
 *
 * parsed to `{ pickupAddress: '1 New Rd', pickupInstructions: null }` — a body
 * that said nothing about instructions and a parser that answered "delete them".
 * `updateOwnPickup` then wrote both columns, and the route replied `200`
 * describing the erasure as the new state. `{}` deleted both.
 *
 * The distinction the old shape could not express is the one `PATCH` is built on:
 *
 *   - **absent** — the caller did not mention this field; leave it alone.
 *   - **`null`** — the caller mentioned it and wants it empty.
 *   - **a string** — the caller wants it set to this (trimmed) value.
 *
 * An optional property carries all three, which is why this is not `| undefined`
 * bolted onto the old type: with `strict` (but without
 * `exactOptionalPropertyTypes`) TypeScript cannot tell `{}` from
 * `{ pickupAddress: undefined }`, so both mean "absent" here — and that is the
 * correct reading of both bodies.
 */
export type PickupPatch = {
  pickupAddress?: string | null;
  pickupInstructions?: string | null;
};

export type ParsedPickup =
  | { ok: true; value: PickupPatch }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Parses and normalises a `PATCH` body.
 *
 * An all-whitespace string becomes `null` rather than `''`: an empty instruction
 * and a blank instruction are the same thing to the deal page, and storing two
 * representations of it means the page has to check both. `null` is the one empty.
 *
 * A **key that is absent from the body stays absent from the result** — it is not
 * normalised to `null`, because those are different instructions. That is the
 * defect this function used to have; see `PickupPatch`.
 *
 * `pickupSchema.partial()` rather than a second schema literal: the per-field
 * rules (trim, 300-char cap, nullish) exist in exactly one place, so a change to
 * one field's limit cannot apply to the full write and miss the partial one. The
 * base object is not `.strict()`, so unknown keys are still stripped rather than
 * rejected, which is the behaviour the route already had.
 */
export function parsePickupInput(raw: unknown): ParsedPickup {
  const parsed = pickupSchema.partial().safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const clean = (value: string | null): string | null => {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  };

  /**
   * Built by presence, not by value.
   *
   * `key in data` is the whole fix. Writing
   * `pickupAddress: data.pickupAddress === undefined ? null : clean(...)` would
   * reintroduce the defect with extra steps — `undefined` is what an absent key
   * already looks like, so the two must be tested with `in`, which asks the
   * question the protocol is asking: was this key in the body?
   */
  const value: PickupPatch = {};
  if ('pickupAddress' in parsed.data) {
    value.pickupAddress = clean(parsed.data.pickupAddress ?? null);
  }
  if ('pickupInstructions' in parsed.data) {
    value.pickupInstructions = clean(parsed.data.pickupInstructions ?? null);
  }

  return { ok: true, value };
}
