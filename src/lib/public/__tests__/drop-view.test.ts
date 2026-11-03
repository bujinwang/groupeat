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
 *   - a confirmed drop keeps taking joins until the batch is full (ADR-003),
 *     and only a full, closed or failed drop refuses a card.
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

  it('confirms at the threshold and keeps taking joins (ADR-003)', () => {
    const view = resolveDropView(input({ joinedQty: 20 }));

    expect(view.offerPhase).toBe('CONFIRMED');
    expect(view.thresholdMet).toBe(true);
    // The batch is not full, and `maxQty` is the merchant's own statement of what
    // the kitchen can make. Refusing joins here throws away plates they already
    // agreed to cook — which is what FR-305 said to do and ADR-003 overrules.
    expect(view.canJoin).toBe(true);
    expect(view.joinBlockedReason).toBeNull();
    expect(view.remainingQty).toBe(10);
  });

  it('still accepts joins right up to the last plate', () => {
    const view = resolveDropView(input({ joinedQty: 29 }));
    expect(view.offerPhase).toBe('CONFIRMED');
    expect(view.remainingQty).toBe(1);
    expect(view.canJoin).toBe(true);
  });

  it('stops at maxQty', () => {
    const view = resolveDropView(input({ joinedQty: 30 }));

    expect(view.offerPhase).toBe('CONFIRMED');
    expect(view.soldOut).toBe(true);
    expect(view.canJoin).toBe(false);
    expect(view.joinBlockedReason).toBe('SOLD_OUT');
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
    // A locked drop is closed to joins even though it is nowhere near `maxQty`.
    expect(view.canJoin).toBe(false);
    expect(view.joinBlockedReason).toBe('CLOSED');
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

/**
 * `CANCELLED` — FR-902's phase, added in the same slice as the writer that produces
 * it. Before the member existed the status fell through every branch below it, and
 * the two tests at the top of this block are the ones that would have caught that:
 * a cancelled drop reported as `CONFIRMED` tells diners the kitchen is cooking, and
 * a cancelled drop reported as `OPEN` offers a join button that the API refuses.
 */
describe('cancelled (FR-902)', () => {
  it('is CANCELLED, not CONFIRMED, even with the threshold met and past the cutoff', () => {
    // The failure this pins: `CANCELLED` is not in `SETTLED_STATUSES` and it is not
    // `FAILED`, so without its own branch the `thresholdMet` arm claimed it. Thirty
    // orders on a called-off drop read as "Confirmed — 30 orders. We're charging
    // cards now." — the single worst sentence in this file.
    const view = resolveDropView(
      input({
        status: 'CANCELLED',
        joinedQty: 30,
        cutoffAt: new Date(NOW.getTime() - HOUR),
        hadCaptures: true,
      }),
    );

    expect(view.offerPhase).toBe('CANCELLED');
    expect(view.canJoin).toBe(false);
    expect(view.joinBlockedReason).toBe('CANCELLED');
    // Settling is a claim that money is moving right now. A cancelled drop is the
    // one state where that is certainly false.
    expect(view.settling).toBe(false);
  });

  it('is CANCELLED, not OPEN, when cancelled before the cutoff on a short count', () => {
    // Cancelled before the cutoff with nothing collected: `cutoffPassed` is false and
    // the threshold is unmet, so the `else` arm would have returned `OPEN` and put a
    // live join button on a dead drop.
    const view = resolveDropView(input({ status: 'CANCELLED', joinedQty: 2 }));

    expect(view.offerPhase).toBe('CANCELLED');
    expect(view.canJoin).toBe(false);
    expect(view.joinBlockedReason).toBe('CANCELLED');
  });

  it('says the restaurant refunded everyone when money had moved', () => {
    const view = resolveDropView(
      input({ status: 'CANCELLED', joinedQty: 24, hadCaptures: true }),
    );

    expect(headlineFor(view, 20)).toBe(
      'This drop was cancelled by the restaurant. Everyone who paid has been refunded in full.',
    );
  });

  it('says nobody was charged when nothing was ever captured', () => {
    // Same phase, opposite monetary claim, and `hadCaptures` is the discriminator —
    // the same one `FAILED` uses, because it is a fact about the `Order` table rather
    // than an inference from a status.
    const view = resolveDropView(input({ status: 'CANCELLED', joinedQty: 0 }));

    expect(headlineFor(view, 20)).toBe(
      'This drop was cancelled by the restaurant. Nobody was charged, and any hold on your card is released.',
    );
  });

  it('never mentions the minimum, because the minimum is not why it stopped', () => {
    // A diner who saw 30 orders on a drop that was then called off must not read
    // "this drop didn't reach 20" — that would be a false statement about demand, and
    // the sort of false statement that makes somebody distrust the refund sentence
    // printed next to it.
    const view = resolveDropView(
      input({ status: 'CANCELLED', joinedQty: 30, hadCaptures: true }),
    );

    expect(headlineFor(view, 20)).not.toContain('reach');
    expect(headlineFor(view, 20)).not.toContain('20');
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

  it('says "so far" while a confirmed drop is still filling', () => {
    // The count is still moving, so the headline must not read as final — the
    // merchant sees this page too, and reads it as the number to cook.
    const view = resolveDropView(input({ joinedQty: 22 }));
    expect(headlineFor(view, 20)).toBe('Confirmed — 22 orders so far.');
  });

  it('drops "so far" once nothing more can join', () => {
    const view = resolveDropView(input({ joinedQty: 30 }));
    expect(headlineFor(view, 20)).toBe('Confirmed — 30 orders.');
  });

  it('says everyone was refunded when the drop charged cards and then failed', () => {
    // PRD-v1 §8.5: a drop can reach its minimum, charge cards, and then fall below
    // the 90 % capture tolerance. Saying "nobody was charged" then is the opposite
    // of the truth, and FR-306 requires the page to be explicit about money.
    const view = resolveDropView(
      input({ status: 'FAILED', joinedQty: 22, hadCaptures: true }),
    );

    const headline = headlineFor(view, 20);
    expect(headline).toContain('refunded');
    expect(headline).not.toContain('nobody was charged');
  });

  it('still says nobody was charged when no capture ever happened', () => {
    const view = resolveDropView(
      input({ status: 'FAILED', joinedQty: 5, hadCaptures: false }),
    );

    expect(headlineFor(view, 20)).toBe("This drop didn't reach 20 — nobody was charged.");
  });

  it('defaults hadCaptures to false, so every existing call site keeps the old sentence', () => {
    // The field is optional precisely so the 368 tests that predate it compile and
    // pass unchanged; the default is also the honest answer for a drop that never
    // reached capture.
    const view = resolveDropView(input({ status: 'FAILED', joinedQty: 5 }));

    expect(view.hadCaptures).toBe(false);
    expect(headlineFor(view, 20)).toContain('nobody was charged');
  });
});
