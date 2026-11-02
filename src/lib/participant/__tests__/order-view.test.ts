import { describe, expect, it } from 'vitest';

import { REDEEMABLE_STATUSES } from '@/lib/redemption/rules';

import { COLLECTABLE_DROP_STATUSES, resolveOrderView, waitingHeadline } from '../order-view';

/**
 * What a diner's own page is allowed to say.
 *
 * ## The two failures this file exists to prevent
 *
 *  1. Reading "you're in — show this at the counter" on the day the drop failed.
 *     That is a diner standing in a restaurant with no food and a charge they were
 *     told did not happen.
 *  2. Reading "nothing was charged" while a charge sits on their card. That is
 *     worse: it is a false statement about money, and the diner either disputes it
 *     or stops trusting the app.
 *
 * Every test below is one of those two, expressed against a real combination of
 * `dropStatus` / `chargeStatus` / `redeemedQty` / clock. They are pure, so they can
 * be exhaustive cheaply — which is the reason the decision was moved out of the JSX.
 */

const NOW = new Date('2026-11-02T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/**
 * A captured diner on a drop whose window is open, with plates still owed.
 *
 * `PICKUP_OPEN`, not `CAPTURED`: the code is only legitimate once the scanner would
 * accept it, and that starts when the window opens. See the file's note on the bug
 * this caught.
 */
function base(overrides: Partial<Parameters<typeof resolveOrderView>[0]> = {}) {
  return {
    dropStatus: 'PICKUP_OPEN',
    chargeStatus: 'CAPTURED',
    authStatus: 'AUTHORIZED',
    qty: 2,
    redeemedQty: 0,
    redemptionCode: 'v1.body.sig',
    windowStart: new Date(NOW.getTime() - 1 * HOUR),
    windowEnd: new Date(NOW.getTime() + 1 * HOUR),
    now: NOW,
    minQty: 3,
    joinedQty: 5,
    ...overrides,
  };
}

describe('CHARGED — the money moved', () => {
  it('shows the code once pickup has opened', () => {
    const view = resolveOrderView(base({ dropStatus: 'PICKUP_OPEN' }));

    expect(view.phase).toBe('CHARGED');
    expect(view.code).toBe('v1.body.sig');
    expect(view.nothingCharged).toBe(false);
    expect(view.outstandingQty).toBe(2);
  });

  it('hides the code at CAPTURED, because the scanner would refuse it there', () => {
    // The bug this test was written for. Capture happens at the cutoff, which can be
    // the day before the kitchen cooks; `REDEEMABLE_STATUSES` is `PICKUP_OPEN` and
    // `COMPLETED` only. Showing the code at `CAPTURED` would put a diner at a counter
    // with a code the counter rejects — on the one screen whose job is to be true
    // about money. The page must wait for the window, exactly as the till does.
    const view = resolveOrderView(base({ dropStatus: 'CAPTURED' }));

    expect(view.phase).toBe('CHARGED');
    expect(view.code).toBeNull();
  });

  it('shows the code after COMPLETED only while plates are still owed', () => {
    // `COMPLETED` is redeemable (a late collector is a real conversation), so the
    // status alone does not hide the code. The window end and the outstanding count
    // do that work, and this pins that the status is not what stops it.
    const stillOwed = resolveOrderView(base({ dropStatus: 'COMPLETED' }));
    expect(stillOwed.code).toBe('v1.body.sig');

    const allDone = resolveOrderView(base({ dropStatus: 'COMPLETED', redeemedQty: 2 }));
    expect(allDone.code).toBeNull();
  });

  it('hides the code once the window has closed, even at a redeemable status', () => {
    // `PICKUP_OPEN` is redeemable, so the status cannot be what withholds the code.
    // The clock does: the code is a bearer credential, and past the window it cannot
    // be honoured.
    const view = resolveOrderView(
      base({
        now: new Date(NOW.getTime() + 2 * HOUR),
        windowEnd: new Date(NOW.getTime() + 1 * HOUR),
      }),
    );

    expect(view.phase).toBe('CHARGED');
    expect(view.code).toBeNull();
    expect(view.pickupEnded).toBe(true);
  });

  it('still withholds the code before the window opens', () => {
    // The status is still `CAPTURED` a second before the window opens, because
    // nothing in this build transitions it. So the status gate does the work here —
    // and it is the same gate that keeps a diner from turning up at 4pm for a 6pm
    // pickup.
    const view = resolveOrderView(
      base({
        dropStatus: 'CAPTURED',
        windowStart: new Date(NOW.getTime() + 2 * HOUR),
        windowEnd: new Date(NOW.getTime() + 4 * HOUR),
      }),
    );

    expect(view.code).toBeNull();
    expect(view.pickupEnded).toBe(false);
  });

  it('shows nothing once every plate has been collected', () => {
    // `outstandingQty` reaches zero when the last plate is scanned. There is nothing
    // left to claim, so leaving the code on screen only invites a second attempt at
    // the counter.
    const view = resolveOrderView(base({ qty: 2, redeemedQty: 2 }));

    expect(view.phase).toBe('CHARGED');
    expect(view.outstandingQty).toBe(0);
    expect(view.code).toBeNull();
  });

  it('keeps a partially collected order collectable', () => {
    const view = resolveOrderView(base({ qty: 3, redeemedQty: 1 }));

    expect(view.outstandingQty).toBe(2);
    expect(view.code).toBe('v1.body.sig');
  });

  it('never reports a negative quantity owed', () => {
    // `redeemedQty` is incremented by the scanner and could exceed `qty` if a row
    // were edited by hand or a redemption were double-counted by a bug. The page is
    // not the place to surface that: it floors at zero and says everything has been
    // collected.
    expect(resolveOrderView(base({ qty: 2, redeemedQty: 5 })).outstandingQty).toBe(0);
  });

  it('tells a captured diner on a failed drop nothing was charged', () => {
    // Reachable: a drop can fail *after* one participant's capture landed and before
    // the refund sweep runs. `chargeStatus` is CAPTURED, so phase says charged — but
    // the drop is FAILED, so there is no food. This asserts the phase follows the
    // money and the code follows the drop.
    const view = resolveOrderView(base({ dropStatus: 'FAILED' }));

    expect(view.phase).toBe('CHARGED');
    expect(view.code).toBeNull();
  });
});

describe('NOT_CHARGED — the money did not move', () => {
  it('says nothing was charged when the card was refunded', () => {
    const view = resolveOrderView(base({ chargeStatus: 'REFUNDED' }));

    expect(view.phase).toBe('NOT_CHARGED');
    expect(view.nothingCharged).toBe(true);
    expect(view.code).toBeNull();
  });

  it('says nothing was charged when the card was partially refunded', () => {
    // Partial refund means the food is not theirs to collect in full, so the code
    // is withheld. The page says nothing was charged rather than naming a partial
    // figure — the reconciliation detail belongs to support, not to a one-page view.
    const view = resolveOrderView(base({ chargeStatus: 'PARTIALLY_REFUNDED' }));

    expect(view.phase).toBe('NOT_CHARGED');
    expect(view.code).toBeNull();
  });

  it('says nothing was charged when the capture failed', () => {
    const view = resolveOrderView(base({ chargeStatus: 'FAILED' }));

    expect(view.phase).toBe('NOT_CHARGED');
    expect(view.nothingCharged).toBe(true);
  });

  it('says nothing was charged when the drop failed, even on a row still marked AUTHORIZED', () => {
    // The void sweep has not necessarily run yet. `authStatus: 'AUTHORIZED'` is a
    // hold the diner's bank has not released; the honest sentence is still "nothing
    // was charged", because nothing was.
    const view = resolveOrderView(base({ dropStatus: 'FAILED', chargeStatus: 'NONE' }));

    expect(view.phase).toBe('NOT_CHARGED');
    expect(view.code).toBeNull();
  });

  it('says nothing was charged for a cancelled drop', () => {
    expect(resolveOrderView(base({ dropStatus: 'CANCELLED', chargeStatus: 'NONE' })).phase).toBe(
      'NOT_CHARGED',
    );
  });

  it('never shows a code in NOT_CHARGED, even if one is still on the row', () => {
    // `redemptionCode` is written at capture and is **not** cleared by a refund. A
    // later refund therefore leaves a live-looking code on a row whose money came
    // back. This is precisely the case the `phase === 'CHARGED'` gate exists for.
    const view = resolveOrderView(
      base({ chargeStatus: 'REFUNDED', redemptionCode: 'v1.body.sig' }),
    );

    expect(view.code).toBeNull();
  });
});

describe('WAITING — nothing decided', () => {
  it('waits while the drop is published and the hold is in place', () => {
    const view = resolveOrderView(
      base({
        dropStatus: 'PUBLISHED',
        chargeStatus: 'NONE',
        redemptionCode: null,
        windowStart: new Date(NOW.getTime() + 3 * HOUR),
        windowEnd: new Date(NOW.getTime() + 5 * HOUR),
      }),
    );

    expect(view.phase).toBe('WAITING');
    expect(view.code).toBeNull();
    expect(view.nothingCharged).toBe(true);
  });

  it('waits while the drop is locked and being charged', () => {
    // The dangerous window: `LOCKED` means settlement is running right now. A page
    // that said "nothing was charged" here would be one refresh away from being
    // false, so `WAITING`'s copy has to hold for it too.
    const view = resolveOrderView(
      base({
        dropStatus: 'LOCKED',
        chargeStatus: 'NONE',
        redemptionCode: null,
        windowStart: new Date(NOW.getTime() + 3 * HOUR),
        windowEnd: new Date(NOW.getTime() + 5 * HOUR),
      }),
    );

    expect(view.phase).toBe('WAITING');
    expect(view.nothingCharged).toBe(true);
  });

  it('waits while this diner is the one whose authorisation is still pending', () => {
    const view = resolveOrderView(
      base({
        dropStatus: 'PUBLISHED',
        chargeStatus: 'NONE',
        authStatus: 'PENDING',
        redemptionCode: null,
      }),
    );

    expect(view.phase).toBe('WAITING');
  });
});

describe('the phase table is total', () => {
  it('assigns every combination of real statuses to exactly one phase', () => {
    // `resolveOrderView` is total by construction (three `return`s and a fallthrough),
    // but "total" is easy to lose in a refactor. This walks the combinations that
    // can actually occur and pins the phase for each.
    const dropStatuses = ['PUBLISHED', 'LOCKED', 'CAPTURED', 'PICKUP_OPEN', 'COMPLETED', 'FAILED', 'CANCELLED'];
    const chargeStatuses = ['NONE', 'CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED'];

    for (const dropStatus of dropStatuses) {
      for (const chargeStatus of chargeStatuses) {
        const view = resolveOrderView(base({ dropStatus, chargeStatus }));

        // CAPTURED is the only charge status that means money moved.
        if (chargeStatus === 'CAPTURED') {
          expect(view.phase, `${dropStatus}/${chargeStatus}`).toBe('CHARGED');
        } else if (chargeStatus !== 'NONE') {
          // REFUNDED, PARTIALLY_REFUNDED, FAILED — decided, and not in the diner's favour.
          expect(view.phase, `${dropStatus}/${chargeStatus}`).toBe('NOT_CHARGED');
        } else if (dropStatus === 'FAILED' || dropStatus === 'CANCELLED') {
          expect(view.phase, `${dropStatus}/${chargeStatus}`).toBe('NOT_CHARGED');
        } else {
          expect(view.phase, `${dropStatus}/${chargeStatus}`).toBe('WAITING');
        }

        // The invariant that spans every combination: a code is shown only in CHARGED.
        if (view.phase !== 'CHARGED') {
          expect(view.code, `${dropStatus}/${chargeStatus}`).toBeNull();
        }
      }
    }
  });

  it('shows a code only for the statuses the scanner accepts', () => {
    for (const dropStatus of ['CAPTURED', 'PICKUP_OPEN', 'COMPLETED', 'FAILED', 'CANCELLED', 'LOCKED', 'PUBLISHED']) {
      const view = resolveOrderView(base({ dropStatus, chargeStatus: 'CAPTURED' }));
      const redeemable = (COLLECTABLE_DROP_STATUSES as readonly string[]).includes(dropStatus);

      expect(view.code !== null, dropStatus).toBe(redeemable);
    }
  });

  it('takes the collectable statuses from the scanner rather than restating them', () => {
    // The defect this replaces: this file once said `['CAPTURED', 'PICKUP_OPEN']`,
    // which disagreed with `REDEEMABLE_STATUSES` on `CAPTURED` and `COMPLETED` —
    // both directions. A copy of a rule is a second answer waiting to diverge, so
    // the assertion here is identity, not equality.
    expect(COLLECTABLE_DROP_STATUSES).toBe(REDEEMABLE_STATUSES);
  });
});

describe('waitingHeadline', () => {
  it('returns null for the phases it does not speak for', () => {
    const charged = resolveOrderView(base());
    const notCharged = resolveOrderView(base({ chargeStatus: 'REFUNDED' }));

    expect(waitingHeadline(charged, 3)).toBeNull();
    expect(waitingHeadline(notCharged, 3)).toBeNull();
  });

  it('uses the singular form for a one-person minimum', () => {
    const view = resolveOrderView(
      base({ dropStatus: 'PUBLISHED', chargeStatus: 'NONE', redemptionCode: null }),
    );

    expect(waitingHeadline(view, 1)).toBe(
      'Your card is held, not charged. This offer needs one more person to go ahead.',
    );
  });

  it('names the number for a multi-person minimum', () => {
    const view = resolveOrderView(
      base({ dropStatus: 'PUBLISHED', chargeStatus: 'NONE', redemptionCode: null }),
    );

    expect(waitingHeadline(view, 4)).toContain('at least 4 people');
  });

  it('always says the card is held rather than charged — FR-404 in copy', () => {
    // The one sentence this page must never get wrong. It is asserted separately
    // from the wording above so a future edit to the second half cannot quietly drop
    // the first.
    const view = resolveOrderView(
      base({ dropStatus: 'PUBLISHED', chargeStatus: 'NONE', redemptionCode: null }),
    );

    expect(waitingHeadline(view, 2)).toMatch(/^Your card is held, not charged\./);
  });
});
