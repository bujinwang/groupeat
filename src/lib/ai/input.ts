import { z } from 'zod';

/**
 * Request-body parsing for the deal-builder interview.
 *
 * Returns field errors rather than throwing, matching `lib/drops/input.ts` and
 * `lib/items/input.ts`, so every write path in the app answers a bad body the
 * same way.
 *
 * ## Why `quietStart` must carry an offset
 *
 * `new Date("2026-11-05T14:00")` is parsed in the *server's* timezone. On a
 * developer's Mac that is Edmonton and the value is accidentally right; in a
 * container it is UTC and every proposal is six or seven hours wrong — a defect
 * that cannot reproduce locally and only shows up on the deal page. So the
 * browser sends `toISOString()` (always `…Z`) and this schema rejects anything
 * without an offset rather than guessing.
 */

/** `2026-11-05T21:00:00.000Z` or `2026-11-05T14:00:00-07:00`. */
const ISO_WITH_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;

const quietStart = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: 'Pick a day and time.',
  })
  .refine((value) => ISO_WITH_OFFSET.test(value), {
    // Deliberately not "invalid date": the value parsed fine, it is just
    // ambiguous, and the fix is in the client rather than in the merchant's head.
    message: 'That time is missing a timezone. Reload the page and try again.',
  });

export const dealBuilderInputSchema = z.object({
  menuItemId: z.string().min(1, 'Choose a dish.'),
  quietStart,
  intent: z.enum(['FILL_QUIET_HOUR', 'NEW_CUSTOMERS', 'EITHER'], {
    errorMap: () => ({ message: 'Say what you want out of this drop.' }),
  }),
  maxQty: z
    .number({ invalid_type_error: 'Say how many you can make.' })
    .int('Enter a whole number.')
    .min(1, 'At least one.')
    .max(200, 'That is more than one batch.'),
});

export type DealBuilderAnswers = {
  menuItemId: string;
  quietStart: string;
  intent: 'FILL_QUIET_HOUR' | 'NEW_CUSTOMERS' | 'EITHER';
  maxQty: number;
};

export type ParsedDealBuilderInput =
  | { ok: true; value: DealBuilderAnswers }
  | { ok: false; fieldErrors: Record<string, string> };

export function parseDealBuilderInput(raw: unknown): ParsedDealBuilderInput {
  const parsed = dealBuilderInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }
  return { ok: true, value: parsed.data };
}
