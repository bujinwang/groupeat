import { z } from 'zod';

import type { DraftInput } from '@/lib/db/drops';

/**
 * Request-body parsing for the drop draft write path.
 *
 * Same shape as `lib/items/input.ts`: return field errors rather than throwing,
 * so create and update return an identical 422. The *policy* rules (timing,
 * quantities, price against the floor) are **not** here — they live in
 * `lib/drops/rules.ts` and `lib/drops/publish.ts`, and run against the database
 * rather than the body. This file only establishes that the body is shaped like
 * a drop.
 */

/**
 * ISO-8601 with an offset, or a plain date-time the browser produced.
 *
 * A bare `z.string()` would accept `"next tuesday"`, which `new Date()` then
 * turns into `Invalid Date` — a value that compares `false` against everything
 * and would sail through naive validation.
 */
const dateTime = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: 'Enter a valid date and time.',
  })
  .transform((value) => new Date(value));

export const draftInputSchema = z.object({
  menuItemId: z.string().min(1, 'Choose a dish.'),
  /**
   * `.trim()` before `.min(1)` — see `lib/items/input.ts` for the full reasoning.
   * With the checks in the other order, `'   '` validated and was then trimmed to
   * `''`, so a drop could be saved with no title at all.
   */
  title: z.string().trim().min(1, 'Give the drop a title.').max(60, 'Use 60 characters or fewer.'),
  description: z.string().max(300, 'Use 300 characters or fewer.').nullish(),
  heroImageUrl: z.string().url('Enter a valid image URL.').max(500).nullish(),
  /**
   * `.min(0)` is the only price bound here, and it is deliberately not "positive".
   *
   * `dealPriceCents` is an `Int`, so `-5000` is a perfectly storable row, and
   * neither `parseDraftInput` nor `collectDraftFieldErrors` used to look at the
   * sign — the latter skips price on purpose, because a draft is *allowed* to be
   * unprofitable (that is what FR-203's slider needs). Probed: a draft body with
   * `dealPriceCents: -5000` was accepted and written to the database. Publishing
   * such a drop is refused, so no diner was ever charged — but "you cannot save a
   * row that says a plate costs minus fifty dollars" is a cheaper rule to state
   * than to reason about downstream.
   *
   * Not `.positive()`: `DropForm` initialises an untouched price to `0`, and
   * `PATCH` sends the whole body, so a `.positive()` bound would 422 a merchant
   * on a field they never edited. `0` is a placeholder; a negative number is a
   * corruption.
   */
  dealPriceCents: z
    .number({ invalid_type_error: 'Set a price.' })
    .int('Enter a whole number of cents.')
    .min(0, "A price can't be negative."),
  minQty: z.number({ invalid_type_error: 'Set how many you need.' }).int('Enter a whole number.'),
  maxQty: z.number({ invalid_type_error: 'Set how many you will make.' }).int('Enter a whole number.'),
  maxPerCustomer: z.number().int().min(1).max(4).optional(),
  windowStart: dateTime,
  windowEnd: dateTime,
  cutoffAt: dateTime,
  aiRationale: z.string().max(300).nullish(),
});

export type ParsedDraftInput =
  | { ok: true; value: DraftInput }
  | { ok: false; fieldErrors: Record<string, string> };

export function parseDraftInput(raw: unknown): ParsedDraftInput {
  const parsed = draftInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      // First message per field wins; a second one under the same input is noise.
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const data = parsed.data;

  return {
    ok: true,
    value: {
      menuItemId: data.menuItemId,
      title: data.title.trim(),
      description: data.description?.trim() || null,
      heroImageUrl: data.heroImageUrl ?? null,
      dealPriceCents: data.dealPriceCents,
      minQty: data.minQty,
      maxQty: data.maxQty,
      maxPerCustomer: data.maxPerCustomer ?? 4,
      windowStart: data.windowStart,
      windowEnd: data.windowEnd,
      cutoffAt: data.cutoffAt,
      aiRationale: data.aiRationale?.trim() || null,
    },
  };
}
