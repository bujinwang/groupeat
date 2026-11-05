import { readFile } from 'node:fs/promises';

import { resolveAnalyticsPath, type AnalyticsEventName } from './events';

/**
 * Reads the append-only analytics sink, counts a bounded set of events.
 *
 * ## Why this is separate from `events.ts`
 *
 * `events.ts` writes one JSON line and must never throw into a request. Reading is a
 * different caller — an admin dashboard — and a missing file is the normal cold-start
 * state, not a reason to fail the page. Counts are returned as zeros; the dashboard
 * says "not measured yet" when the denominator is zero, so a missing sink is visible
 * rather than silently reported as 0% conversion.
 *
 * ## Why a full scan is acceptable
 *
 * The sink is a local JSONL file and the beta has a handful of drops. A streaming
 * parser or an index would add a subsystem before there is a reason; the function is
 * bounded by `names` and ignores every other line without parsing its payload.
 *
 * It never throws: an unreadable or malformed file is a zero count, not a 500 on the
 * admin page.
 */
export async function countAnalyticsEvents(
  names: readonly AnalyticsEventName[],
  path?: string,
): Promise<Partial<Record<AnalyticsEventName, number>>> {
  const counts: Partial<Record<AnalyticsEventName, number>> = {};
  for (const name of names) counts[name] = 0;

  let text: string;
  try {
    text = await readFile(resolveAnalyticsPath(path), 'utf8');
  } catch {
    return counts;
  }

  const wanted = new Set<string>(names);
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const event = (record as { event?: unknown }).event;
    if (typeof event !== 'string' || !wanted.has(event)) continue;
    counts[event as AnalyticsEventName] = (counts[event as AnalyticsEventName] ?? 0) + 1;
  }

  return counts;
}
