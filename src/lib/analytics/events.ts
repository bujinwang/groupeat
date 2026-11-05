import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { logger } from '../logging/logger';

/**
 * Append-only analytics sink: one JSON object per line (S1-017).
 *
 * A local file rather than a vendor SDK, so no schema delta and no dependency
 * was needed. The weekly report (M7) reads this file; nothing in Sprint 1 parses
 * it back.
 *
 * Two rules:
 *   - **Ids and cents only.** No email, no phone, no dish name, no token.
 *   - **Never throws.** Analytics must not be able to fail a merchant's save. A
 *     write failure is logged and swallowed.
 *
 * The path is read from `ANALYTICS_LOG_PATH` (default `var/analytics/events.jsonl`,
 * git-ignored) here rather than from `src/lib/config.ts`, so that seeds and
 * one-off scripts can append an event without a full server environment.
 */

export type AnalyticsEventName =
  | 'guardrail_evaluated'
  | 'guardrail_violation'
  | 'food_cost_implausible'
  | 'floor_changed'
  /**
   * FR-906. An organiser account was created by ops, or repaired into having the
   * profile it should have had at creation.
   *
   * Ids only, per the rule above. Worth an event at all because organisers are
   * onboarded by hand ("no self-serve, 5–15 of them in beta" — PRD-v1 §3.3), so their
   * creation rate is a thing a human is doing rather than a thing the product does.
   */
  | 'organiser_created'
  /**
   * S1-025 / S1-017. Emitted on every `containsAlcohol` transition, with
   * `{ itemId, merchantId, actorUserId, from, to, changedAt }`. The liquor
   * licence liability sits with the merchant, so an AGLC question ("who cleared
   * this flag, and when?") has to be answerable from the append-only stream.
   */
  | 'item_alcohol_flag_changed'
  // -------------------------------------------------------------------------
  // PRD-v1 §10.1 — the diner funnel. Built in this order on purpose: §10.2 says
  // the north-star dashboard comes before feature polish, and its "join
  // conversion = authorised ÷ deal page views" could not be computed at all while
  // neither side of that ratio was emitted.
  //
  // The payload builders live in `./funnel.ts`, which is pure and has no `emit`
  // in it, so the arithmetic is testable without a filesystem.
  // -------------------------------------------------------------------------
  /**
   * A person looked at a deal page. The denominator of join conversion.
   *
   * `source` is the attribution from `?src=`: `organiser_link`, `direct`, or
   * `preview`. Link-preview fetchers are **not** counted — see `isHumanView`,
   * which explains why counting them would make a well-shared drop look worse
   * than a badly-shared one.
   */
  | 'deal_page_viewed'
  /** A diner submitted a join request that got past validation. */
  | 'join_started'
  /** A card was held. The numerator of join conversion. */
  | 'join_authorised'
  /** A join was refused; `reason` is the bounded vocabulary from `join/rules.ts`. */
  | 'join_failed'
  /**
   * A drop crossed `minQty` for the first time. Emitted once per crossing, from
   * the totals before and after the write, so the north-star "threshold hit rate"
   * is a count and not an estimate.
   */
  | 'threshold_reached'
  /** A drop went live. The denominator of the threshold hit rate. */
  | 'drop_published'
  /** The cutoff passed with enough people; cards are being charged (FR-501…). */
  | 'drop_locked'
  /** The cutoff passed short of `minQty`; nobody was charged (FR-306). */
  | 'drop_failed'
  // -------------------------------------------------------------------------
  // The rest of PRD-v1 §10.1. These eight were absent from the union entirely
  // until the north-star board landed: §10.2 reads this sink, so an event that
  // is never named here cannot be measured by anything downstream. §10.1 is a
  // list of sixteen, and this completes it.
  //
  // All of them go through the pure builders in `./funnel.ts`, so the PII guard
  // and the "ids and cents only" rule apply to the whole §10.1 list rather than
  // only to the diner funnel it started as.
  // -------------------------------------------------------------------------
  /** A DRAFT row was written. Fires once, after the `publicCode` retry wins. */
  | 'drop_created'
  /** A PUBLISHED drop was called off (FR-208). Fires after the CAS commit. */
  | 'drop_cancelled'
  /** A participant's card was captured and the Order/ledger write committed. */
  | 'capture_succeeded'
  /** A participant's capture was declined by the provider. Not a retry. */
  | 'capture_failed'
  /** A code was submitted to the scanner. One event per submitted code. */
  | 'redemption_scanned'
  /** Units were actually claimed under the row lock. Not a double scan. */
  | 'redemption_completed'
  /** A merchant opened the reports page and the query completed. */
  | 'report_viewed'
  /** The deal builder produced proposals and wrote its `AiDraft` audit row. */
  | 'ai_draft_generated';

/**
 * The sixteen events PRD-v1 §10.1 requires, as a runtime list.
 *
 * A TypeScript union cannot be enumerated, so before this existed the only way to
 * check §10.1 was to grep `src/` by hand — which is exactly how eight event names
 * went missing while the definition of done claimed they were emitted. `satisfies`
 * makes TypeScript reject any name not in `AnalyticsEventName`, and the test in
 * `__tests__/lifecycle.test.ts` asserts the list is complete and has no duplicate.
 * Adding a seventeenth event is a PRD change, not a one-line addition here.
 *
 * Nothing in production reads this list — it is a runtime value so the guard
 * test can enumerate the requirement, not a router or an emit allowlist.
 *
 * This is deliberately a list of **required** events, not of every event in the
 * union: the guardrail and admin events above are ours, and §10.1 says nothing
 * about them.
 */
export const PRD_10_1_EVENTS = [
  'drop_created',
  'drop_published',
  'drop_cancelled',
  'deal_page_viewed',
  'join_started',
  'join_authorised',
  'join_failed',
  'threshold_reached',
  'drop_locked',
  'drop_failed',
  'capture_succeeded',
  'capture_failed',
  'redemption_scanned',
  'redemption_completed',
  'report_viewed',
  'ai_draft_generated',
] as const satisfies readonly AnalyticsEventName[];

export type AnalyticsPayload = Record<string, string | number | boolean | null>;

export const DEFAULT_ANALYTICS_LOG_PATH = 'var/analytics/events.jsonl';

export type EmitOptions = {
  /** Absolute or cwd-relative path. Tests use a temporary file. */
  path?: string;
};

/** Resolves the log path, honouring `ANALYTICS_LOG_PATH` and any override. */
export function resolveAnalyticsPath(override?: string): string {
  const configured = override ?? process.env.ANALYTICS_LOG_PATH ?? DEFAULT_ANALYTICS_LOG_PATH;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/**
 * Appends one event line. Returns `true` when the line was written.
 *
 * The timestamp is generated here — this module is not pure and is not part of
 * the guardrail folder.
 */
export function emit(
  event: AnalyticsEventName,
  payload: AnalyticsPayload,
  options: EmitOptions = {},
): boolean {
  const record = {
    ts: new Date().toISOString(),
    event,
    ...payload,
  };

  try {
    const path = resolveAnalyticsPath(options.path);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch (error) {
    logger.warn('analytics.write_failed', {
      event,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}
