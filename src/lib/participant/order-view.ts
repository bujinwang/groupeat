/**
 * What a diner's own order page may say — FR-408's link, FR-306, FR-407.
 *
 * Pure: no I/O, no clock of its own, no Prisma. Every sentence this page shows is
 * decided here and tested here, because this is the one screen in the product that
 * tells a stranger what happened to their money.
 *
 * ## The three states, and why they are three
 *
 * | State | The truth | The page's job |
 * |---|---|---|
 * | `WAITING` | the drop has not been decided; the card is held, not charged | say nothing has been charged, and when it will be decided |
 * | `CHARGED` | the money moved; there is food to collect | show the code, the quantity and where to go |
 * | `NOT_CHARGED` | the drop failed or was cancelled; the hold was released | say clearly that nothing was charged |
 *
 * These are file-separated on purpose. The failure this page must never have is a
 * diner reading "you're in" on the day their drop failed, or reading "nothing was
 * charged" while a charge sits on their card. Each state is reachable from exactly
 * one set of database facts, and `resolveOrderView` is total over them.
 *
 * ## Why the code is gated on more than "does a code exist"
 *
 * `redemptionCode` is written at capture and is **not** cleared if a drop is later
 * refunded. The code is also a bearer token: whoever reads it can collect the food.
 * So the page shows it only when all of these hold:
 *
 *   - the drop is in a status where the **scanner** would accept the code — see
 *     `COLLECTABLE_DROP_STATUSES` below, which is imported from the scanner rather
 *     than restated. `CAPTURED` is not one of them: capture happens at the cutoff,
 *     which can be the day before anyone cooks;
 *   - the participant's charge is `CAPTURED` (not refunded, not failed);
 *   - the pickup window has not closed;
 *   - there is at least one plate still uncollected.
 *
 * A code shown after pickup ends is a code that cannot be honoured, and showing it
 * teaches a diner that the page is unreliable. Showing nothing, with "pickup has
 * ended", is the true thing. A code shown before the window opens is the same
 * mistake one day early.
 */

/**
 * Whether this drop can be collected from — imported, not restated.
 *
 * The first draft of this file had its own `['CAPTURED', 'PICKUP_OPEN']`, and it
 * was wrong in the direction that matters: the scanner refuses a code while the drop
 * is `CAPTURED` (`REDEEMABLE_STATUSES` is `PICKUP_OPEN` and `COMPLETED` only, because
 * capture happens at the cutoff, which can be the day before the kitchen cooks). So
 * that draft would have shown a diner a code on the one screen in the product whose
 * whole job is to be true about money, and the counter would have refused it.
 *
 * Importing the scanner's constant is the fix, and it is deliberately the same value
 * rather than a matching copy: there is now one answer in the codebase to "may food
 * change hands", and this page cannot drift from the till. `redemption/rules.ts` is
 * pure and imports nothing, so this costs no Prisma and no `server-only`.
 *
 * Imported *and* re-exported under this module's own name: the page's vocabulary is
 * about collecting, the scanner's is about redeeming, and a reader of either file
 * should not have to translate.
 */
import { REDEEMABLE_STATUSES } from '@/lib/redemption/rules';

export const COLLECTABLE_DROP_STATUSES = REDEEMABLE_STATUSES;

export type OrderPhase = 'WAITING' | 'CHARGED' | 'NOT_CHARGED';

export type OrderViewInput = {
  readonly dropStatus: string;
  readonly chargeStatus: string;
  readonly authStatus: string;
  readonly qty: number;
  readonly redeemedQty: number;
  /** Null until capture mints it. */
  readonly redemptionCode: string | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly now: Date;
  readonly minQty: number;
  readonly joinedQty: number;
};

export type OrderView = {
  readonly phase: OrderPhase;
  /**
   * The code to show, or null. Non-null only when handing over food is still
   * legitimate — see the module note. Never derive this from `redemptionCode`
   * being present.
   */
  readonly code: string | null;
  /** Plates still owed. `qty − redeemedQty`, floored at zero. */
  readonly outstandingQty: number;
  /** The pickup window has closed, whatever else is true. */
  readonly pickupEnded: boolean;
  /** True when the drop is decided and this diner's card was not charged. */
  readonly nothingCharged: boolean;
};

export function resolveOrderView(input: OrderViewInput): OrderView {
  const now = input.now;
  const pickupEnded = now.getTime() > input.windowEnd.getTime();
  const outstandingQty = Math.max(input.qty - input.redeemedQty, 0);

  // Decided, and this diner's money moved. `chargeStatus` is the authority, not the
  // drop status: a drop can be `CAPTURED` while one participant's card declined, and
  // that participant must not be told they have food coming.
  if (input.chargeStatus === 'CAPTURED') {
    const collectable = (COLLECTABLE_DROP_STATUSES as readonly string[]).includes(
      input.dropStatus,
    );
    const code = collectable && !pickupEnded && outstandingQty > 0 ? input.redemptionCode : null;

    return {
      phase: 'CHARGED',
      code,
      outstandingQty,
      pickupEnded,
      nothingCharged: false,
    };
  }

  // Decided, and this diner's money did not move. `REFUNDED` and
  // `PARTIALLY_REFUNDED` both mean the food is not theirs to collect, and
  // `FAILED` means the capture never landed.
  if (
    input.chargeStatus === 'REFUNDED' ||
    input.chargeStatus === 'PARTIALLY_REFUNDED' ||
    input.chargeStatus === 'FAILED' ||
    input.dropStatus === 'FAILED' ||
    input.dropStatus === 'CANCELLED'
  ) {
    return {
      phase: 'NOT_CHARGED',
      code: null,
      outstandingQty,
      pickupEnded,
      nothingCharged: true,
    };
  }

  // Not decided yet. A hold exists at most; nothing has been charged. This is the
  // state the whole product is built around (FR-404), so the copy for it is the most
  // important sentence on the page.
  return {
    phase: 'WAITING',
    code: null,
    outstandingQty,
    pickupEnded,
    nothingCharged: true,
  };
}

/**
 * The cutoff sentence for `WAITING`, or null.
 *
 * `null` rather than an empty string so a caller cannot accidentally render a blank
 * line and have it look like a layout bug. Separated from the view so the `Date`
 * formatting stays on the server, next to the drop's time zone, rather than being
 * re-derived by a component.
 */
export function waitingHeadline(view: OrderView, minQty: number): string | null {
  if (view.phase !== 'WAITING') {
    return null;
  }
  return minQty === 1
    ? 'Your card is held, not charged. This offer needs one more person to go ahead.'
    : `Your card is held, not charged. This offer needs at least ${minQty} people to go ahead.`;
}
