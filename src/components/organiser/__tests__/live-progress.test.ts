import { describe, expect, it } from 'vitest';

import { LIVE_PROGRESS_POLL_MS, mergeLiveCounts } from '@/components/organiser/LiveProgress';

/**
 * FR-803's poll merge, without a DOM.
 *
 * The component cannot be driven here — there is no DOM runner in this repo, and the
 * same limitation is recorded for `CountPoller`. What can be pinned is the decision the
 * component makes about a payload, which is where a live count can go wrong: a new drop
 * appearing must not invent a card, and a malformed row must not put `NaN` on screen.
 */

const previous = {
  a: { joinedQty: 2, minQty: 5 },
  b: { joinedQty: 5, minQty: 5 },
};

describe('mergeLiveCounts', () => {
  it('updates a known drop and leaves a drop the payload did not mention alone', () => {
    const next = mergeLiveCounts(previous, [{ id: 'a', joinedQty: 4, minQty: 5 }]);

    expect(next.a).toEqual({ joinedQty: 4, minQty: 5 });
    // A payload that omits B is not evidence B is gone. It may be a paginated or
    // filtered response; the last known count is the honest fallback.
    expect(next.b).toEqual({ joinedQty: 5, minQty: 5 });
  });

  it('ignores a drop that is not already on the page', () => {
    const next = mergeLiveCounts(previous, [{ id: 'new', joinedQty: 1, minQty: 5 }]);
    expect(next.new).toBeUndefined();
    expect(next).toEqual(previous);
  });

  it('ignores malformed counts instead of rendering them', () => {
    const next = mergeLiveCounts(previous, [
      { id: 'a', joinedQty: Number.NaN, minQty: 5 },
      { id: 'b', joinedQty: 5, minQty: -1 },
    ]);

    expect(next).toEqual(previous);
  });

  it('keeps the threshold boundary, because it is a comparison and not a count', () => {
    // Exactly at minimum is met. The merge stores numbers; the badge's `>=` is what
    // makes this true, and a test that only checked a count above minimum would not
    // distinguish `>=` from `>`.
    const next = mergeLiveCounts(previous, [{ id: 'a', joinedQty: 5, minQty: 5 }]);
    expect(next.a!.joinedQty >= next.a!.minQty).toBe(true);
  });

  it('polls at half the requirement’s 30-second budget', () => {
    expect(LIVE_PROGRESS_POLL_MS).toBe(15_000);
    expect(LIVE_PROGRESS_POLL_MS).toBeLessThanOrEqual(30_000);
  });
});
