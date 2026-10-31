import { z } from 'zod';

import { validateItemCosts } from '@/lib/guardrail';
import type { ValidationIssue } from '@/lib/guardrail';

import type { ItemInput } from '@/lib/db/items';

/**
 * Request-body parsing and validation for the item write path (S1-016, AC-9).
 *
 * The invariant itself is **not** re-implemented here: `validateItemCosts()` from
 * the pure module is called, the same function the client form calls. This file
 * only turns its `ValidationIssue[]` into the merchant-facing strings, so the
 * browser and the server cannot disagree about what is valid (assumption A-1).
 */

export const itemInputSchema = z.object({
  name: z.string().min(1, 'Give the dish a name.').max(80, 'Use 80 characters or fewer.'),
  description: z.string().max(300, 'Use 300 characters or fewer.').nullish(),
  menuPriceCents: z.number({ invalid_type_error: 'Enter a price.' }),
  foodCostCents: z.number({ invalid_type_error: 'Enter the ingredient cost.' }),
  packagingCents: z.number({ invalid_type_error: 'Enter the container cost.' }),
  batchYield: z.number({ invalid_type_error: 'Enter how many you can make at once.' }),
  prepMinutes: z.number().nullish(),
  isBatchable: z.boolean().optional(),
  containsAlcohol: z.boolean().optional(),
  category: z.string().max(40, 'Use 40 characters or fewer.').nullish(),
});

/** Merchant-facing text per issue code (PRD-sprint1 §5.1 wording). */
const ISSUE_MESSAGES: Record<ValidationIssue['code'], string> = {
  REQUIRED: "We need this. Without it we can't tell you whether a deal makes money.",
  NOT_A_NUMBER: 'Enter a number.',
  NEGATIVE: "This can't be negative.",
  TOO_LARGE: 'That number is too large.',
  COST_EXCEEDS_PRICE:
    "Ingredients and container cost more than the dish sells for. A discount can't fix that.",
  OUT_OF_RANGE: 'That number is outside the range we can use.',
};

export type ParsedItemInput =
  | { ok: true; value: ItemInput }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Parses and validates. Returns field errors rather than throwing, so both the
 * create and the update route can return a 422 with the same shape.
 */
export function parseItemInput(raw: unknown): ParsedItemInput {
  const parsed = itemInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      fieldErrors[key] = issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const data = parsed.data;
  const issues = validateItemCosts({
    menuPriceCents: data.menuPriceCents,
    foodCostCents: data.foodCostCents,
    packagingCents: data.packagingCents,
    batchYield: data.batchYield,
    prepMinutes: data.prepMinutes ?? null,
  });

  if (issues.length > 0) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      // First issue per field wins: a second message under the same input is noise.
      fieldErrors[issue.field] ??= ISSUE_MESSAGES[issue.code];
    }
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    value: {
      name: data.name.trim(),
      description: data.description?.trim() || null,
      menuPriceCents: data.menuPriceCents,
      foodCostCents: data.foodCostCents,
      packagingCents: data.packagingCents,
      batchYield: data.batchYield,
      prepMinutes: data.prepMinutes ?? null,
      isBatchable: data.isBatchable ?? true,
      containsAlcohol: data.containsAlcohol ?? false,
      category: data.category?.trim() || null,
    },
  };
}
