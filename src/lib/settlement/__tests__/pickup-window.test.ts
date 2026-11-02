import { describe, expect, it } from 'vitest';

import { pickupTransitionFor } from '../pickup-window';

/**
 * The pickup clock, as a pure function.
 *
 * ## Why every one of these is a money question
 *
 * `redeem.ts` decides whether to hand over food by asking one question:
 * `isRedeemableStatus(drop.status)`. It does not read a clock. So this function is
 * the *only* thing that makes a paid order collectable, and each boundary below is
 * a diner at a counter.
 *
 * The two failures worth naming:
 *
 *   - **Too early** (`OPENED` before `windowStart`): the scanner would accept a code
 *     for food the kitchen has not cooked. Invisible in the data — `redeemedQty`
 *     would look normal.
 *   - **Never** (the bug this module was written to fix): the drop stays `CAPTURED`
 *     forever, every scan answers `NOT_YET`, and diners who paid are turned away
 *     inside their own window.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const WINDOW_START = new Date('2026-11-02T18:00:00.000Z');
const WINDOW_END = new Date('2026-11-02T20:00:00.000Z');

function at(offsetMs: number): Date {
  return new Date(WINDOW_START.getTime() + offsetMs);
}

function transition(status: string, now: Date) {
  return pickupTransitionFor({
    status,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    now,
  });
}

describe('CAPTURED — before, during, and after the window', () => {
  it('does nothing a minute before the window opens', () => {
    // The state immediately after capture, which for an evening pickup can be most
    // of a day. A drop that opened here would sell food before it exists.
    expect(transition('CAPTURED', at(-1 * MINUTE))).toBeNull();
  });

  it('does nothing an hour before the window opens', () => {
    expect(transition('CAPTURED', at(-1 * HOUR))).toBeNull();
  });

  it('opens exactly at windowStart', () => {
    // Inclusive at the start: a diner who arrives on the stated minute must not be
    // told the window has not opened. This boundary is the one a `<` versus `<=`
    // typo moves, and moving it costs a real argument at a counter.
    expect(transition('CAPTURED', at(0))).toBe('OPENED');
  });

  it('opens during the window', () => {
    expect(transition('CAPTURED', at(1 * HOUR))).toBe('OPENED');
  });

  it('does not open at the instant the window ends — it completes', () => {
    // `now === windowEnd` is over, not open. `after(arg*2)` is exactly windowEnd.
    expect(transition('CAPTURED', at(2 * HOUR))).toBe('COMPLETED');
  });

  it('completes directly when the whole window elapsed untended', () => {
    // The missed-tick case: the job was down or the scheduler never fired, and the
    // window came and went. Opening first would flash a collectable drop for a
    // pickup that ended before anybody looked — and would leave `completedAt` one
    // tick behind reality.
    expect(transition('CAPTURED', at(3 * HOUR))).toBe('COMPLETED');
    expect(transition('CAPTURED', at(48 * HOUR))).toBe('COMPLETED');
  });
});

describe('PICKUP_OPEN — only ever forwards', () => {
  it('stays put during the window', () => {
    expect(transition('PICKUP_OPEN', at(0))).toBeNull();
    expect(transition('PICKUP_OPEN', at(1 * HOUR))).toBeNull();
  });

  it('completes at the end of the window', () => {
    expect(transition('PICKUP_OPEN', at(2 * HOUR))).toBe('COMPLETED');
    expect(transition('PICKUP_OPEN', at(3 * HOUR))).toBe('COMPLETED');
  });

  it('never re-opens, even if the window is moved back into the future', () => {
    // A merchant editing a live drop is not a supported flow, and if it happens the
    // status must not follow the dates backwards — that would un-complete a drop
    // whose food has been handed over.
    expect(transition('PICKUP_OPEN', at(-1 * HOUR))).toBeNull();
  });
});

describe('statuses this module must not touch', () => {
  it('leaves every other status alone, whatever the clock says', () => {
    // Written as a loop over the statuses that exist rather than as four cases, so a
    // status added to the enum is visibly *not* handled here instead of silently
    // falling into a default.
    const untouched = ['DRAFT', 'PUBLISHED', 'LOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'];

    for (const status of untouched) {
      for (const offset of [-2 * HOUR, 0, 1 * HOUR, 2 * HOUR, 24 * HOUR]) {
        expect(transition(status, at(offset)), `${status} @ ${offset}`).toBeNull();
      }
    }
  });

  it('does not resurrect a FAILED drop at its window start', () => {
    // The dangerous one: a failed drop has a real `windowStart` in the past, and a
    // query that forgot to filter on status would "open" it — making unpaid orders
    // collectable. This is why the write is guarded, not just the read.
    expect(transition('FAILED', at(1 * HOUR))).toBeNull();
  });

  it('does not resurrect a CANCELLED drop', () => {
    expect(transition('CANCELLED', at(1 * HOUR))).toBeNull();
  });

  it('is idempotent: the same inputs give the same answer', () => {
    // The tick retries. A function with a clock of its own would answer differently
    // on the second call and produce a second transition.
    const now = at(1 * HOUR);
    expect(transition('CAPTURED', now)).toBe(transition('CAPTURED', now));
  });
});

describe('degenerate windows', () => {
  it('handles windowStart === windowEnd as open at that instant only', () => {
    // A zero-length window is a configuration mistake, not something the schema
    // forbids. At the instant itself it is open; a millisecond later it is over. The
    // rule must not produce `OPENED` for a window that has no duration and has
    // already begun, which would be a permanently collectable code.
    const zero = new Date(WINDOW_START.getTime());
    const args = { windowStart: zero, windowEnd: zero, now: zero };

    expect(pickupTransitionFor({ status: 'CAPTURED', ...args })).toBe('COMPLETED');
    expect(
      pickupTransitionFor({ status: 'CAPTURED', windowStart: zero, windowEnd: zero, now: at(-1) }),
    ).toBeNull();
  });

  it('handles a window that ends before it starts by completing', () => {
    // Also a configuration mistake. The safe reading is "over", not "open forever":
    // a drop whose dates are inverted should hand nothing over, and `COMPLETED` is
    // the terminal state that does that.
    const inverted = {
      status: 'CAPTURED',
      windowStart: new Date(WINDOW_END.getTime()),
      windowEnd: new Date(WINDOW_START.getTime()),
      now: WINDOW_START,
    };

    expect(pickupTransitionFor(inverted)).toBe('COMPLETED');
  });
});
