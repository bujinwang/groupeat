'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * FR-303 — the join count updates within 30 seconds, without a reload.
 *
 * ## Why a client island instead of a server stream
 *
 * The core of the page (price, window, address, state) is server-rendered and
 * works with JavaScript disabled (FR-301). Only the counter needs to move, so only
 * the counter is a client component. A streaming RSC response would keep a
 * connection open per viewer for a number that changes a handful of times an hour;
 * a 15-second poll is cheaper and survives a flaky mobile network by simply
 * trying again.
 *
 * ## Why a phase change triggers a refresh rather than a local update
 *
 * The counter can change from "12 of 20" to "Confirmed" while somebody is looking
 * at it, and at that moment the join button must stop working. Re-rendering that
 * locally would duplicate the state machine in the browser — the exact drift the
 * server-side `resolveDropView()` exists to prevent. So the poller updates its own
 * numbers while the phase is unchanged, and asks the server to re-render when it
 * is not.
 */

export type CountSnapshot = {
  headline: string;
  joinedQty: number;
  minQty: number;
  maxQty: number;
  remainingQty: number;
  progress: number;
  showScarcity: boolean;
  offerPhase: 'OPEN' | 'CONFIRMED' | 'FAILED';
};

const POLL_INTERVAL_MS = 15_000;

export function CountPoller({
  publicCode,
  initial,
}: {
  publicCode: string;
  initial: CountSnapshot;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<CountSnapshot>(initial);

  useEffect(() => {
    // A tab in the background does not need to poll: it is not being read, and
    // when it comes back the first tick catches up.
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch(`/api/public/drops/${publicCode}/count`, {
          cache: 'no-store',
        });
        if (!response.ok) return;

        const body = (await response.json()) as {
          view?: CountSnapshot;
        };
        if (!body.view || cancelled) return;

        if (body.view.offerPhase !== snapshot.offerPhase) {
          // The offer changed under us — confirmed, or failed at the cutoff.
          // Only the server may decide what that looks like.
          router.refresh();
          return;
        }

        setSnapshot(body.view);
      } catch {
        // A failed poll is not an error state. The last known count stays on
        // screen and the next tick tries again.
      }
    };

    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [publicCode, router, snapshot.offerPhase]);

  return (
    <div>
      <p className="text-base font-semibold text-ink" aria-live="polite">
        {snapshot.headline}
      </p>

      {snapshot.offerPhase === 'OPEN' ? (
        <>
          <div
            className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-valuenow={snapshot.joinedQty}
            aria-valuemin={0}
            aria-valuemax={snapshot.minQty}
            aria-label={`${snapshot.joinedQty} of ${snapshot.minQty} orders in`}
          >
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-500"
              style={{ width: `${Math.round(snapshot.progress * 100)}%` }}
            />
          </div>

          {snapshot.showScarcity ? (
            // FR-304: this number is `maxQty − joinedQty`, computed from the same
            // counter the progress bar uses. There is no other source for it.
            <p className="mt-2 text-sm font-medium text-thin">
              Only {snapshot.remainingQty} left at this price.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
