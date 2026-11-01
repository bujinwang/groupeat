/**
 * Drop window and quantity rules — PRD-v1 §4.1 "Blocking rules" and §8.3.
 *
 * Pure: no database, no clock. Every function takes `now` explicitly, because a
 * rule about "cutoff no more than five days out" is untestable and unauditable if
 * it reads the clock itself, and because a publish path needs to evaluate the
 * rules against a single consistent instant rather than several drifting ones.
 *
 * These are the rules that protect money:
 *
 *   - **The authorisation window.** A card authorisation lives ~7 days. A drop
 *     published now and cut off in 10 days would hold diners' authorisations
 *     past expiry, and the capture at cutoff would fail for people who did
 *     nothing wrong. §8.3 caps `cutoffAt − publishedAt` at 5 days, leaving ~2
 *     days of slack for somebody joining on the last day.
 *   - **Batch yield.** You cannot promise 40 of a dish the merchant can make 30
 *     of. `maxQty <= batchYield` is not a preference.
 *   - **Window sanity.** Pickup must end after it starts, and the cutoff must
 *     fall before the window opens — otherwise a diner joins a drop whose pickup
 *     has already begun.
 */

/**
 * Maximum days between publish and cutoff (PRD-v1 §8.3).
 *
 * Five, not seven: the authorisation expires at ~7 days from the *join*, and
 * somebody joining on day 5 needs ~2 remaining. Encoding the margin in the cap
 * means the rule is one number rather than a comment nobody re-derives.
 */
export const MAX_AUTH_WINDOW_DAYS = 5;

/** PRD-v1 §4.1: a participant takes 1–4 units (also `Drop.maxPerCustomer`). */
export const MIN_PER_CUSTOMER = 1;
export const MAX_PER_CUSTOMER = 4;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A field-keyed problem, in the same shape the forms already consume. */
export type DropIssue =
  | { field: 'dealPriceCents' | 'minQty' | 'maxQty' | 'windowStart' | 'windowEnd' | 'cutoffAt' | 'title' | 'description'; message: string };

export type DropTiming = {
  windowStart: Date;
  windowEnd: Date;
  cutoffAt: Date;
};

export type DropQuantities = {
  minQty: number;
  maxQty: number;
  batchYield: number;
};

/**
 * Validates the pickup window and the join deadline.
 *
 * @param publishedAt The instant the drop went live. For a draft preview, pass
 *   the moment you would publish; the rule is about the window the *published*
 *   drop would have.
 */
export function validateDropTiming(
  timing: DropTiming,
  publishedAt: Date,
): DropIssue[] {
  const issues: DropIssue[] = [];

  if (Number.isNaN(timing.windowStart.getTime())) {
    issues.push({ field: 'windowStart', message: 'Choose when pickup starts.' });
  }
  if (Number.isNaN(timing.windowEnd.getTime())) {
    issues.push({ field: 'windowEnd', message: 'Choose when pickup ends.' });
  }
  if (Number.isNaN(timing.cutoffAt.getTime())) {
    issues.push({ field: 'cutoffAt', message: 'Choose when joining closes.' });
  }
  if (issues.length > 0) {
    // Comparing invalid dates produces NaN comparisons that are all false, which
    // would let a malformed window through as "valid". Stop here.
    return issues;
  }

  if (timing.windowEnd.getTime() <= timing.windowStart.getTime()) {
    issues.push({
      field: 'windowEnd',
      message: 'Pickup has to end after it starts.',
    });
  }

  // Cutoff before the window opens, not merely before it closes: once pickup has
  // begun, the merchant needs to know the count in order to cook it.
  if (timing.cutoffAt.getTime() >= timing.windowStart.getTime()) {
    issues.push({
      field: 'cutoffAt',
      message: 'Joining has to close before pickup starts, so you know how much to make.',
    });
  }

  // §8.3: authorisations must survive until capture.
  const authWindowMs = timing.cutoffAt.getTime() - publishedAt.getTime();
  if (authWindowMs > MAX_AUTH_WINDOW_DAYS * MS_PER_DAY) {
    issues.push({
      field: 'cutoffAt',
      message: `Joining has to close within ${MAX_AUTH_WINDOW_DAYS} days of publishing. Banks only hold a card authorisation for about seven days, so a longer drop would fail to charge people who did nothing wrong.`,
    });
  }

  return issues;
}

/**
 * Validates `minQty` / `maxQty` against each other and the dish's `batchYield`.
 *
 * `batchYield` is passed in rather than looked up, so this stays pure and so the
 * caller cannot accidentally validate against a value it did not read from the
 * database.
 */
export function validateDropQuantities(quantities: DropQuantities): DropIssue[] {
  const issues: DropIssue[] = [];
  const { minQty, maxQty, batchYield } = quantities;

  if (!Number.isInteger(minQty) || minQty < 1) {
    issues.push({ field: 'minQty', message: 'Set how many people you need for the drop to run.' });
  }
  if (!Number.isInteger(maxQty) || maxQty < 1) {
    issues.push({ field: 'maxQty', message: 'Set the most you will make.' });
  }

  // Only compare once both are known-good integers; otherwise the message below
  // fires on a value that already has a better message.
  if (issues.length === 0) {
    if (minQty > maxQty) {
      issues.push({
        field: 'minQty',
        message: "The minimum can't be higher than the maximum.",
      });
    }
    if (maxQty > batchYield) {
      issues.push({
        field: 'maxQty',
        // Named, not "too high": the merchant needs to know it is a capacity
        // statement they made about their own kitchen.
        message: `You can make ${batchYield} of this dish in one batch, so the maximum can't be higher than that.`,
      });
    }
  }

  return issues;
}

/**
 * True when the drop is still joinable at `now`.
 *
 * Used by the deal page and the join route; both must agree, so there is one
 * function rather than two comparisons.
 */
export function isOpenForJoining(
  args: { status: string; cutoffAt: Date },
  now: Date,
): boolean {
  return args.status === 'PUBLISHED' && args.cutoffAt.getTime() > now.getTime();
}

/**
 * The latest cutoff a drop published at `publishedAt` may have (PRD-v1 §8.3).
 *
 * Exposed so a form can set the date input's `max` from the same constant the
 * server validates against — a client limit that disagrees with the server rule
 * produces a rejected save the merchant cannot understand.
 */
export function latestCutoffFor(publishedAt: Date): Date {
  return new Date(publishedAt.getTime() + MAX_AUTH_WINDOW_DAYS * MS_PER_DAY);
}
