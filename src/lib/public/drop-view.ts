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
  /** Threshold met. FR-305: no more joins. */
  | 'CONFIRMED'
  /** Threshold not met by the cutoff. Nobody was charged. FR-306. */
  | 'FAILED';

export type PickupPhase = 'UPCOMING' | 'OPEN' | 'ENDED';

/**
 * Why the join button is disabled. `null` means it is not.
 *
 * There is no `SOLD_OUT` member, and its absence is deliberate: `minQty <= maxQty`
 * is enforced at save and at publish, so `joinedQty >= maxQty` implies
 * `joinedQty >= minQty`, which means a full batch is always already
 * `THRESHOLD_MET`. A separate reason for it would be a branch that can never be
 * taken — and an untested branch in the code that decides whether money is taken
 * is worse than no branch. `soldOut` survives as a *display* fact ("all 30 plates
 * claimed"), not as a decision.
 */
export type JoinBlockedReason = 'THRESHOLD_MET' | 'CLOSED' | 'FAILED';

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
  if (status === 'FAILED') {
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

  // Derived from the phase rather than from the count, so `canJoin` is exactly
  // "the offer is open" — one fact, not two that can disagree. A settled drop
  // whose count later fell below the minimum (a failed capture, PRD-v1 §8.5) is
  // still CONFIRMED here, and must still refuse joins.
  const joinBlockedReason: JoinBlockedReason | null =
    offerPhase === 'FAILED'
      ? 'FAILED'
      : offerPhase === 'CONFIRMED'
        ? 'THRESHOLD_MET'
        : cutoffPassed
          ? 'CLOSED'
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
    canJoin: offerPhase === 'OPEN',
    joinBlockedReason,
    settling: offerPhase === 'CONFIRMED' && cutoffPassed && status === 'PUBLISHED',
  };
}

/**
 * The one sentence a diner reads at the top of the page.
 *
 * Separated from the page so the copy is testable and so the FAILED sentence —
 * the one that has to say "nobody was charged" — cannot be softened by a UI
 * edit. PRD-v1 FR-306 requires that sentence to be explicit.
 */
export function headlineFor(view: DropView, minQty: number): string {
  switch (view.offerPhase) {
    case 'FAILED':
      return `This drop didn't reach ${minQty} — nobody was charged.`;
    case 'CONFIRMED':
      if (view.settling) {
        return `Confirmed — ${view.joinedQty} orders. We're charging cards now.`;
      }
      return `Confirmed — ${view.joinedQty} orders.`;
    case 'OPEN':
      return `${view.joinedQty} of ${minQty} orders in.`;
  }
}
