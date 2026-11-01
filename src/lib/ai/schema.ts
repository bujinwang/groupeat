import { z } from 'zod';

import type { ProposalArchetype } from './plan';

/**
 * The model's output contract — copy only.
 *
 * Compare with PRD-v1 §9.2, which has the model returning `dealPriceCents`,
 * `minQty`, `maxQty` and the window as well. It does not, and the reason is in
 * `plan.ts` and `docs/ADR-002-ai-price-authorship.md`: a number the server is
 * going to recompute anyway is not a contribution, it is a liability.
 *
 * `z.object` strips unknown keys, which is the enforcement: if a model returns
 * `{ "archetype": "TRIAL", "dealPriceCents": 999, ... }`, the price is gone by the
 * time anything downstream sees it. `service.ts` additionally records that the
 * attempt happened, so the rate is visible rather than silent.
 *
 * Every length limit is the column limit from PRD-v1 §9.2, duplicated here on
 * purpose: the schema is what rejects an over-long title *before* it reaches the
 * linter, so a malformed response costs one retry rather than a truncated field.
 */

export const COPY_RESPONSE_SCHEMA_VERSION = 'deal-builder-copy/v1';

const ARCHETYPES = ['QUIET_HOUR', 'TRIAL', 'SURPLUS'] as const satisfies readonly ProposalArchetype[];

export const copyProposalSchema = z.object({
  archetype: z.enum(ARCHETYPES),
  title: z.string().min(1).max(60),
  description: z.string().min(1).max(300),
  shareMessage: z.string().min(1).max(140),
  rationale: z.string().min(1).max(300),
});

export const copyResponseSchema = z.object({
  proposals: z.array(copyProposalSchema).min(1).max(3),
});

export type CopyProposal = z.infer<typeof copyProposalSchema>;
export type CopyResponse = z.infer<typeof copyResponseSchema>;

export type ParsedCopyResponse =
  | {
      ok: true;
      value: CopyResponse;
      /**
       * The JSON as the model sent it, **before** the schema stripped unknown
       * keys. Needed because the stripping is what makes `forbiddenKeysIn` on
       * `value` always empty — the evidence is only in the original.
       */
      raw: unknown;
    }
  | { ok: false; reason: 'no_json' | 'invalid_shape'; detail: string };

/**
 * Pulls the first JSON object out of a model's reply.
 *
 * Models wrap JSON in prose and in fenced code blocks even when told not to.
 * Rather than retrying on that (a second call costs latency for a formatting
 * habit), the first balanced `{…}` is extracted. A reply with no braces at all is
 * a genuine failure and reported as `no_json`.
 *
 * Braces inside string literals are counted, because `{"title": "Beef {bowl}"}`
 * is valid JSON and a naive brace counter would truncate it.
 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Parses and validates a model reply.
 *
 * Never throws: the caller needs to fall back, not to catch. A Zod failure is
 * reported with its first issue so the log line names the field rather than
 * saying "invalid".
 */
export function parseCopyResponse(text: string): ParsedCopyResponse {
  const raw = extractJsonObject(text);
  if (raw === null) {
    return { ok: false, reason: 'no_json', detail: 'no JSON object in the reply' };
  }

  const parsed = copyResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: 'invalid_shape',
      detail: first ? `${first.path.join('.')}: ${first.message}` : 'invalid shape',
    };
  }

  return { ok: true, value: parsed.data, raw };
}

/**
 * Keys a model must not be setting. Used only to *notice* — the schema has
 * already dropped them by the time this runs.
 *
 * `dealPriceCents` first because that is the one the PRD's contract invites.
 */
const MONEY_KEYS = [
  'dealPriceCents',
  'price',
  'priceCents',
  'minQty',
  'maxQty',
  'discount',
  'discountPct',
  'windowStart',
  'windowEnd',
  'cutoffAt',
] as const;

/**
 * Returns the forbidden keys present anywhere in a raw model reply.
 *
 * Deliberately tolerant of shape: it walks the parsed object rather than a typed
 * one, because the point is to catch what the *model* sent, not what the schema
 * allowed through.
 */
export function forbiddenKeysIn(raw: unknown): string[] {
  const found = new Set<string>();

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if ((MONEY_KEYS as readonly string[]).includes(key)) {
        found.add(key);
      }
      walk(entry);
    }
  };

  walk(raw);
  return [...found].sort();
}
