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

export type PickupInput = {
  pickupAddress: string | null;
  pickupInstructions: string | null;
};

export type ParsedPickup =
  | { ok: true; value: PickupInput }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Parses and normalises. An all-whitespace string becomes `null` rather than
 * `''`: an empty instruction and a blank instruction are the same thing to the
 * deal page, and storing two representations of it means the page has to check
 * both. `null` is the one empty.
 */
export function parsePickupInput(raw: unknown): ParsedPickup {
  const parsed = pickupSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const clean = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    ok: true,
    value: {
      pickupAddress: clean(parsed.data.pickupAddress),
      pickupInstructions: clean(parsed.data.pickupInstructions),
    },
  };
}
