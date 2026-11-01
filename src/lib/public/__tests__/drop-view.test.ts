import { describe, expect, it } from 'vitest';

import { headlineFor, resolveDropView, type DropViewInput } from '../drop-view';

/**
 * The public page's state machine.
 *
 * Each case below is a screen a real diner can be looking at, and the assertions
 * are about what that screen is allowed to say. The three that carry money or
 * trust weight:
 *
 *   - a drop that failed must say **nobody was charged**, and must never be
 *     reachable as "open" again;
 *   - scarcity must come from `maxQty − joinedQty` or not appear at all;
 *   - a confirmed drop must stop taking joins, per FR-305.
 */

const NOW = new Date('2026-11-01T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function input(overrides: Partial<DropViewInput> = {}): DropViewInput {
  return {
    status: 'PUBLISHED',
    minQty: 20,
    maxQty: 30,
    cutoffAt: new Date(NOW.getTime() + 24 * HOUR),
    windowStart: new Date(NOW.getTime() + 26 * HOUR),
    windowEnd: new Date(NOW.getTime() + 28 * HOUR),
    joinedQty: 0,
    now: NOW,
    ...overrides,
  };
}

describe('offer phase', () => {
  it('is open while the cutoff is ahead and the threshold is not met', () => {
    const view = resolveDropView(input({ joinedQty: 7 }));

    expect(view.offerPhase).toBe('OPEN');
    expect(view.canJoin).toBe(true);
    expect(view.joinBlockedReason).toBeNull();
    expect(view.progress).toBeCloseTo(7 / 20, 10);
  });

  it('confirms at the threshold and stops taking joins (FR-305)', () => {
    const view = resolveDropView(input({ joinedQty: 20 }));

    expect(view.offerPhase).toBe('CONFIRMED');
    expect(view.thresholdMet).toBe(true);
    expect(view.canJoin).toBe(false);
    expect(view.joinBlockedReason).toBe('THRESHOLD_MET');
  });

  it('fails a drop whose cutoff passed below the minimum', () => {
    const view = resolveDropView(
      input({ joinedQty: 5, cutoffAt: new Date(NOW.getTime() - HOUR) }),
    );

    expect(view.offerPhase).toBe('FAILED');
    expect(view.canJoin).toBe(false);
    expect(view.joinBlockedReason).toBe('FAILED');
  });

  it('fails a drop the cutoff job has already marked FAILED, whatever the count says', () => {
    // The count can only go down after a void, never up. Trusting it would let a
    // failed drop reopen.
    const view = resolveDropView(input({ status: 'FAILED', joinedQty: 21 }));

    expect(view.offerPhase).toBe('FAILED');
    expect(view.canJoin).toBe(false);
  });

  it('settles rather than reopening when the threshold is met at the cutoff', () => {
    const view = resolveDropView(
      input({ joinedQty: 22, cutoffAt: new Date(NOW.getTime() - HOUR) }),
    );

    expect(view.offerPhase).toBe('CONFIRMED');
    // The job has not finished, so the page must not imply the money has moved.
    expect(view.settling).toBe(true);
    expect(headlineFor(view, 20)).toContain("charging cards now");
  });

  it('stops settling once the job has locked the drop', () => {
    const view = resolveDropView(
      input({ status: 'LOCKED', joinedQty: 22, cutoffAt: new Date(NOW.getTime() - HOUR) }),
    );

    expect(view.offerPhase).toBe('CONFIRMED');
    expect(view.settling).toBe(false);
    expect(headlineFor(view, 20)).toBe('Confirmed — 22 orders.');
  });

  it('keeps a confirmed drop confirmed when the count drops after a failed capture', () => {
    // PRD-v1 §8.5: a partial capture can leave fewer captured units than joined.
    // Flipping the page back to "open" would invite joins for food already made.
    const view = resolveDropView(input({ status: 'CAPTURED', joinedQty: 15 }));

    expect(view.offerPhase).toBe('CONFIRMED');
    expect(view.canJoin).toBe(false);
  });
});

describe('scarcity (FR-304)', () => {
  it('shows only when fewer than 20% of the batch is left', () => {
    // 18 of 22: 4 left, and 20% of 22 is 4.4.
    const view = resolveDropView(input({ minQty: 20, maxQty: 22, joinedQty: 18 }));
    expect(view.remainingQty).toBe(4);
    expect(view.showScarcity).toBe(true);
  });

  it('stays silent when the batch is far from full', () => {
    const view = resolveDropView(input({ minQty: 20, maxQty: 30, joinedQty: 18 }));
    expect(view.remainingQty).toBe(12);
    expect(view.showScarcity).toBe(false);
  });

  it('is silent at exactly 20% left', () => {
    // 24 of 30 leaves 6, which is exactly 20% — not "fewer than".
    const view = resolveDropView(input({ minQty: 20, maxQty: 30, joinedQty: 24 }));
    expect(view.remainingQty).toBe(6);
    expect(view.showScarcity).toBe(false);
  });

  it('never reports a negative remainder', () => {
    const view = resolveDropView(input({ maxQty: 20, minQty: 20, joinedQty: 25 }));
    expect(view.remainingQty).toBe(0);
    expect(view.soldOut).toBe(true);
  });
});

describe('pickup phase', () => {
  it('runs upcoming → open → ended', () => {
    expect(resolveDropView(input()).pickupPhase).toBe('UPCOMING');
    expect(
      resolveDropView(input({ now: new Date(NOW.getTime() + 27 * HOUR) })).pickupPhase,
    ).toBe('OPEN');
    expect(
      resolveDropView(input({ now: new Date(NOW.getTime() + 40 * HOUR) })).pickupPhase,
    ).toBe('ENDED');
  });

  it('is independent of the offer phase', () => {
    // Pickup open, offer already confirmed: the two facts are separate, which is
    // why they are two fields rather than one status.
    const view = resolveDropView(input({ status: 'PICKUP_OPEN', joinedQty: 22, now: new Date(NOW.getTime() + 27 * HOUR) }));
    expect(view.offerPhase).toBe('CONFIRMED');
    expect(view.pickupPhase).toBe('OPEN');
  });
});

describe('headlineFor', () => {
  it('names the number in the threshold it missed', () => {
    const view = resolveDropView(
      input({ minQty: 20, joinedQty: 5, cutoffAt: new Date(NOW.getTime() - HOUR) }),
    );
    // FR-306 requires the "nobody was charged" sentence to be explicit.
    expect(headlineFor(view, 20)).toBe("This drop didn't reach 20 — nobody was charged.");
  });

  it('counts up while the drop is open', () => {
    const view = resolveDropView(input({ joinedQty: 12 }));
    expect(headlineFor(view, 20)).toBe('12 of 20 orders in.');
  });
});
