import type { GuidanceBucket } from '@/lib/guardrail';

/**
 * PRD-sprint1 §5.3, line 7 — the guidance sentence.
 *
 * In Sprint 1 there is no AI: the sentence is a lookup on the break-even bucket,
 * and the bucket is a function of the number produced by the guardrail. When M3
 * adds the AI, it may reword the sentence but may not change the bucket.
 *
 * These strings are frozen. A change must show up as a snapshot diff in a pull request.
 */
export const GUIDANCE_LINES: Readonly<Record<GuidanceBucket, string>> = {
  CHEAP:
    "→ So run this drop in a slot you're normally empty in. This one is cheap to run — you have some room.",
  MODERATE:
    "→ So run this drop in a slot you're normally empty in, and start with 20 units.",
  TIGHT:
    "→ So run this drop in a slot you're normally empty in. If it fills a busy hour, you lose money.",
  SEVERE:
    "→ Most of these plates must be people who would not have come. Only run this at a time you're normally empty — and consider a cheaper dish instead.",
};

/** The frozen sentence for a break-even bucket. */
export function guidanceLine(bucket: GuidanceBucket): string {
  return GUIDANCE_LINES[bucket];
}
