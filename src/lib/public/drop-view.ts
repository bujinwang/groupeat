/**
 * The public deal page's state machine — PRD-v1 §6.3, FR-301…FR-307.
 *
 * Pure, no I/O, no clock: `now` is passed in. The page, the count endpoint and
 * the tests all call this one function, so the badge on the page and the reason
 * the join button is disabled cannot disagree.
 *
 * ## Two phases, not one status
 *
 * A drop has an **offer** phase (can I still join, and is it confirmed?) and a
 * **pickup** phase (when can I collect?). They are independent: a confirmed drop
 * whose pickup window has ended is `CONFIRMED` + `ENDED`, and flattening those
 * into one enum is how a page ends up telling a diner "this drop is over" when
 * the truth is "your food is still in the warmer".
 *
 * ## The three things this function refuses to do
 *
 *   1. **Fake scarcity.** FR-304 is explicit — "only N left" is derived from
 *      `maxQty − joinedQty` or it is not shown. There is no randomisation, no
 *      rounding up, no "hurry!" that is not a number.
 *   2. **Lie about a failure.** A drop whose cutoff passed below its minimum has
 *      failed, whether or not the job has run yet. Capture only ever happens at
 *      the cutoff, so "nobody was charged" is true the moment the cutoff passes —
 *      and it is the sentence a diner most needs to read.
 *   3. **Hide a failed drop.** `FAILED` is a *visible* state. A diner who joined
 *      a drop that did not run taps the same link they used to join; a 404 there
 *      means "you may have been charged and we will not tell you".
 */

/** The statuses a published drop can be in once the cutoff has passed. */
const SETTLED_STATUSES: readonly string[] = [
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
];

export type OfferPhase =
  /** Accepting joins, threshold not yet met. */
  | 'OPEN'
  /** Threshold met. The drop runs; joins continue to `maxQty` (ADR-003). */
  | 'CONFIRMED'
  /** Threshold not met by the cutoff. Nobody was charged. FR-306. */
  | 'FAILED'
  /**
   * The merchant or an admin called it off — FR-208, FR-902.
   *
   * Its own phase rather than a shade of `FAILED`, and the distinction is the whole
   * reason it exists. `FAILED` means "we did not get enough orders", which is a
   * statement about demand; `CANCELLED` means "somebody decided this will not
   * happen", which is a statement about a decision and says nothing about demand. A
   * diner reading "this drop didn't reach 8" about a drop that had 30 orders and was
   * called off by the restaurant would reasonably conclude the page was broken.
   *
   * **Before this member existed the status fell through to `CONFIRMED`.** It was not
   * in `SETTLED_STATUSES` and it is not `FAILED`, so `CANCELLED` took the
   * `thresholdMet` branch — or the `else` branch when it was below — and a cancelled
   * drop either told diners it was running or told them it was still open. Nothing
   * caught it because `CANCELLED` was written by nothing when this module was
   * written; FR-902 is what writes it, which is exactly why the branch had to be
   * added in the same slice as the writer.
   *
   * Two paths write it now — `forceFailDrop` (an admin override on a drop that may
   * have charged) and `cancelDrop` (a merchant calling off a drop that has not) — and
   * the copy below distinguishes them by `hadCaptures`, not by which path ran.
   */
  | 'CANCELLED';

export type PickupPhase = 'UPCOMING' | 'OPEN' | 'ENDED';

/**
 * Why the join button is disabled. `null` means it is not.
 *
 * There is no `THRESHOLD_MET` member any more, and its absence is the point of
 * ADR-003: a drop that has reached its minimum keeps taking joins until the batch
 * is full. "Confirmed" is a *status*, not a closed door.
 */
export type JoinBlockedReason = 'SOLD_OUT' | 'CLOSED' | 'FAILED' | 'CANCELLED';

export type DropViewInput = {
  /** `DropStatus` as a string, so this module stays free of Prisma. */
  status: string;
  minQty: number;
  maxQty: number;
  cutoffAt: Date;
  windowStart: Date;
  windowEnd: Date;
  /** Units from participants whose authorisation is live. */
  joinedQty: number;
  now: Date;
  /**
   * True when at least one `Order` row exists for this drop — money actually moved.
   *
   * Optional and defaulting to `false` on purpose: every existing call site and
   * every existing test compiles and passes unchanged, and the default is the
   * honest answer for a drop that never got as far as capture. `public-drops.ts`
   * supplies the real value from the `Order` table.
   *
   * It exists because §8.5's partial capture makes one shipped sentence false: a
   * drop can reach `minQty`, charge cards, and then fail below the 90 % tolerance
   * and refund everyone. "Nobody was charged" is then the opposite of the truth,
   * and FR-306 requires the page to be explicit about whether money moved.
   */
  hadCaptures?: boolean;
};

export type DropView = {
  offerPhase: OfferPhase;
  pickupPhase: PickupPhase;
  joinedQty: number;
  minQty: number;
  maxQty: number;
  /** `maxQty − joinedQty`, never negative. */
  remainingQty: number;
  /** `joinedQty / minQty`, clamped to 0…1. Drives the progress bar. */
  progress: number;
  /**
   * True when fewer than 20% of the batch is left. The page shows "only N left"
   * only when this is true, and N is `remainingQty`.
   */
  showScarcity: boolean;
  /** The threshold is met and the drop is running. */
  thresholdMet: boolean;
  /** The batch is fully claimed. */
  soldOut: boolean;
  canJoin: boolean;
  joinBlockedReason: JoinBlockedReason | null;
  /**
   * Threshold met but the cutoff job has not finished. The page says "we are
   * charging cards now" rather than pretending the money has moved.
   */
  settling: boolean;
  /** At least one `Order` row exists. See `DropViewInput.hadCaptures`. */
  hadCaptures: boolean;
};

/** FR-304's threshold: show scarcity below 20% of the batch. */
export const SCARCITY_THRESHOLD = 0.2;

export function resolveDropView(input: DropViewInput): DropView {
  const { status, minQty, maxQty, joinedQty, now } = input;

  const thresholdMet = joinedQty >= minQty;
  const cutoffPassed = now.getTime() >= input.cutoffAt.getTime();
  const remainingQty = Math.max(0, maxQty - joinedQty);
  const soldOut = remainingQty === 0;

  let offerPhase: OfferPhase;
  if (status === 'CANCELLED') {
    // First, and deliberately ahead of the `SETTLED_STATUSES` check below: a
    // cancelled drop must never be reported as confirmed, however many orders it
    // collected before it was called off.
    offerPhase = 'CANCELLED';
  } else if (status === 'FAILED') {
    offerPhase = 'FAILED';
  } else if (SETTLED_STATUSES.includes(status)) {
    // Past the cutoff with the threshold met — the drop ran. `joinedQty` is not
    // consulted here on purpose: a capture that later failed must not flip a
    // confirmed drop back to "open", which would invite joins for food that has
    // already been made.
    offerPhase = 'CONFIRMED';
  } else if (thresholdMet) {
    offerPhase = 'CONFIRMED';
  } else if (cutoffPassed) {
    offerPhase = 'FAILED';
  } else {
    offerPhase = 'OPEN';
  }

  const pickupPhase: PickupPhase =
    now.getTime() < input.windowStart.getTime()
      ? 'UPCOMING'
      : now.getTime() <= input.windowEnd.getTime()
        ? 'OPEN'
        : 'ENDED';

  // Whether a card can be taken right now. Three conditions, all of them facts
  // about the drop rather than about the threshold (ADR-003):
  //
  //   - the drop is live (`PUBLISHED`), so a settled or failed drop never reopens;
  //   - the cutoff has not passed, because capture happens at the cutoff;
  //   - there is something left in the batch.
  //
  // Meeting the minimum is deliberately **not** one of them. `maxQty` is the
  // merchant's own statement of what the kitchen can make, so refusing joins
  // between `minQty` and `maxQty` throws away plates they already agreed to cook.
  const joinBlockedReason: JoinBlockedReason | null =
    offerPhase === 'FAILED'
      ? 'FAILED'
      : offerPhase === 'CANCELLED'
        ? 'CANCELLED'
        : status !== 'PUBLISHED' || cutoffPassed
          ? 'CLOSED'
          : soldOut
            ? 'SOLD_OUT'
            : null;

  return {
    offerPhase,
    pickupPhase,
    joinedQty,
    minQty,
    maxQty,
    remainingQty,
    progress: minQty > 0 ? Math.min(1, Math.max(0, joinedQty / minQty)) : 0,
    showScarcity: remainingQty > 0 && remainingQty < maxQty * SCARCITY_THRESHOLD,
    thresholdMet,
    soldOut,
    canJoin: joinBlockedReason === null,
    joinBlockedReason,
    settling: offerPhase === 'CONFIRMED' && cutoffPassed && status === 'PUBLISHED',
    hadCaptures: input.hadCaptures === true,
  };
}

/**
 * The one sentence a diner reads at the top of the page.
 *
 * Separated from the page so the copy is testable and so the FAILED sentence —
 * the one that has to say "nobody was charged" — cannot be softened by a UI
 * edit. PRD-v1 FR-306 requires that sentence to be explicit.
 *
 * ## Why "so far" is in the confirmed sentence
 *
 * Under ADR-003 a confirmed drop keeps taking joins up to `maxQty`. So
 * "Confirmed — 22 orders." would be a claim about a number that is still moving,
 * and the merchant reading the same page would take it as the number to cook.
 * "So far" costs two words and removes that ambiguity.
 */
export function headlineFor(view: DropView, minQty: number): string {
  switch (view.offerPhase) {
    case 'CANCELLED':
      // Two truths again, and `hadCaptures` is again the discriminator — but the
      // sentences are different from `FAILED`'s, because the cause is different and
      // a diner who had 30 orders should not be told the drop "didn't reach"
      // anything. This one names the decision rather than the shortfall.
      //
      // The refunded sentence makes a monetary claim ("refunded in full"), which is
      // only true for the two paths that can produce `CANCELLED`, and both satisfy it
      // by ordering: `forceFailDrop` (FR-902) refunds every captured order before it
      // writes the status, and `cancelDrop` (FR-208) refuses every drop that is not
      // `PUBLISHED` — so a merchant cancellation cannot have taken anyone's money, and
      // lands in the no-charge arm by construction.
      //
      // The consequence worth naming: `hadCaptures` is what selects this sentence, and
      // it is a fact about the `Order` table rather than an inference from the status,
      // so a future third path that wrote `CANCELLED` after capturing would be caught
      // by the sentence rather than silently lying.
      return view.hadCaptures
        ? 'This drop was cancelled by the restaurant. Everyone who paid has been refunded in full.'
        : 'This drop was cancelled by the restaurant. Nobody was charged, and any hold on your card is released.';
    case 'FAILED':
      // Two different failures, two different truths. `hadCaptures` is the
      // discriminator because it is a fact about the `Order` table rather than an
      // inference from a status: money either moved or it did not.
      //
      // The refunded sentence contains a monetary claim ("refunded in full") and is
      // therefore a type signature under CONTRIBUTING.md. It can only stay true
      // because settlement writes `FAILED` after every refund has returned
      // (design §4.5), not before.
      return view.hadCaptures
        ? "This drop didn't run — we couldn't charge enough cards, so everyone who paid has been refunded in full."
        : `This drop didn't reach ${minQty} — nobody was charged.`;
    case 'CONFIRMED':
      if (view.settling) {
        return `Confirmed — ${view.joinedQty} orders. We're charging cards now.`;
      }
      return view.canJoin
        ? `Confirmed — ${view.joinedQty} orders so far.`
        : `Confirmed — ${view.joinedQty} orders.`;
    case 'OPEN':
      return `${view.joinedQty} of ${minQty} orders in.`;
  }
}
