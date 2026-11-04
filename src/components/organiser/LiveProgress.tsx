'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/Badge';

/**
 * FR-803 — "joined / needed" updates within 30 seconds, without a reload.
 *
 * > `FR-803 | Live progress: joined / needed | Updates ≤30s` — PRD-v1.md:538
 *
 * ## Why one poller and a context, not one poller per card
 *
 * A page with six open drops would otherwise make six requests every fifteen seconds
 * for one query that already returns every drop. The API is
 * `GET /api/organiser/drops`; one call produces every count on the screen, so one
 * component owns the interval and the cards read through a context.
 *
 * ## Why it does not refresh the page when the set of drops changes
 *
 * `CountPoller` on the public page refreshes on a phase change because the join button
 * must stop working, and only the server may decide that. Here the only thing that
 * moves is a count. A drop that closes or appears is a reason to reload, but reloading
 * from a polling island is a worse experience than a stale card: the organiser may be
 * halfway through copying a message, and a `router.refresh()` would replace the form
 * under their thumb. The page is `force-dynamic`, so the next visit is correct, and the
 * counts for the drops that are still open are always current. That limitation is
 * stated rather than hidden.
 *
 * ## What it does not read
 *
 * The payload is `{ id, joinedQty, minQty }` and nothing else. FR-805's privacy rule is
 * structural in `shareableDropJson`, and this component narrows further: a name or a
 * phone could appear in the JSON tomorrow and this file would still not look at it.
 */

export type LiveDropCount = {
  readonly joinedQty: number;
  readonly minQty: number;
};

type LiveCounts = Readonly<Record<string, LiveDropCount>>;

const LiveProgressContext = createContext<LiveCounts | null>(null);

/** FR-803's interval. Fifteen seconds is half the requirement's budget. */
export const LIVE_PROGRESS_POLL_MS = 15_000;

/**
 * Merges a poll response into the known counts.
 *
 * Exported for a unit test, because the two behaviours that matter here are data
 * questions rather than rendering questions: an unknown drop must be ignored (this
 * component does not own the list), and a malformed row must not turn a count into
 * `NaN` or `undefined` on screen. A pure function is the only place those can be
 * asserted without a DOM runner.
 */
export function mergeLiveCounts(
  previous: LiveCounts,
  rows: readonly { readonly id: string; readonly joinedQty: number; readonly minQty: number }[],
): LiveCounts {
  const next: Record<string, LiveDropCount> = { ...previous };
  for (const row of rows) {
    // Only drops already on the page. A new drop needs a server render to produce its
    // card, and inventing one here would render a card with no title, price or link.
    if (!(row.id in next)) continue;
    if (!Number.isInteger(row.joinedQty) || row.joinedQty < 0) continue;
    if (!Number.isInteger(row.minQty) || row.minQty < 0) continue;
    next[row.id] = { joinedQty: row.joinedQty, minQty: row.minQty };
  }
  return next;
}

/**
 * The provider. Wrap the list once; every card reads through `useLiveCount`.
 *
 * `initial` is the server render's answer, so the first paint is correct without
 * JavaScript and hydration does not change a number. The first poll happens one interval
 * later, not on mount: the server just rendered this data, and an immediate second read
 * would be a wasted round trip on every page view.
 */
export function LiveProgress({
  initial,
  children,
}: {
  initial: readonly (LiveDropCount & { readonly id: string })[];
  children: ReactNode;
}) {
  const [counts, setCounts] = useState<LiveCounts>(() =>
    Object.fromEntries(
      initial.map((row) => [row.id, { joinedQty: row.joinedQty, minQty: row.minQty }]),
    ),
  );

  useEffect(() => {
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/api/organiser/drops', { cache: 'no-store' });
        if (!response.ok) return;

        const body = (await response.json()) as {
          drops?: { id?: unknown; joinedQty?: unknown; minQty?: unknown }[];
        };
        if (!Array.isArray(body.drops) || cancelled) return;

        const rows = body.drops.flatMap((row) => {
          if (typeof row.id !== 'string') return [];
          if (typeof row.joinedQty !== 'number' || typeof row.minQty !== 'number') return [];
          return [{ id: row.id, joinedQty: row.joinedQty, minQty: row.minQty }];
        });

        setCounts((previous) => mergeLiveCounts(previous, rows));
      } catch {
        // A failed poll is not an error state. The last known count stays on screen,
        // and the next tick tries again — the same rule CountPoller states.
      }
    };

    const timer = setInterval(() => void tick(), LIVE_PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return <LiveProgressContext.Provider value={counts}>{children}</LiveProgressContext.Provider>;
}

/** The current count for one drop, or `null` when not inside the provider. */
export function useLiveCount(dropId: string): LiveDropCount | null {
  const counts = useContext(LiveProgressContext);
  return counts?.[dropId] ?? null;
}

/**
 * The badge, kept as a component so the threshold comparison exists once.
 *
 * `>=` and not `>`: a drop that has reached exactly its minimum is met, and that
 * boundary is the difference between "Threshold met" and "5 of 5" — which looks like a
 * rounding bug to the organiser who recruited all five.
 */
export function LiveThresholdBadge({
  dropId,
  initialJoinedQty,
  initialMinQty,
}: {
  dropId: string;
  initialJoinedQty: number;
  initialMinQty: number;
}) {
  const live = useLiveCount(dropId);
  const joinedQty = live?.joinedQty ?? initialJoinedQty;
  const minQty = live?.minQty ?? initialMinQty;
  const met = joinedQty >= minQty;

  return (
    <span aria-live="polite">
      <Badge tone={met ? 'ok' : 'neutral'}>
        {met ? 'Threshold met' : `${joinedQty} of ${minQty}`}
      </Badge>
    </span>
  );
}
