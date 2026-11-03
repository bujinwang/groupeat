import { MAX_AUTH_WINDOW_DAYS } from '@/lib/drops/rules';

/**
 * FR-801's `likelyFill` — PRD-v1.md:536, defined at §9.3.
 *
 * > `FR-801 | Organiser sees available drops from their merchants | Ranked by
 * > likelyFill (§9.4)` — PRD-v1.md:536
 * >
 * > `likelyFill(drop) = f(historical fill rate for this merchant+item, group size vs
 * > minQty, days until cutoff, organiser's past success with this cuisine)`
 * > `Start with a simple logistic or even a weighted heuristic. Do not build an ML
 * > model in V1.` — PRD-v1.md:793
 *
 * ## Why this is a weighted heuristic and not a logistic
 *
 * §9.3 permits either. A logistic needs coefficients fitted to outcomes, and the
 * database this would ship against has **55 failed drops and zero successful ones** —
 * there is no positive class to fit. A fitted model on that data would learn "nothing
 * fills" and rank accordingly, which is a worse product than a hand-set prior and a
 * much worse thing to defend in a review.
 *
 * So the weights below are a stated prior, not a finding. They are also all in one
 * place, in one table, so the argument about whether "deadline proximity" deserves
 * 0.3 or 0.25 happens over four numbers rather than over the shape of a formula.
 *
 * ## The four inputs, and what each one can and cannot see
 *
 * §9.3 names four. Every one of them exists in the schema — this is worth stating
 * because `docs/PROGRESS.md` carried gap 16 as blocked on history "that does not
 * exist" for several slices, and it was measurably not blocked:
 *
 * | §9.3 input | Where it comes from | What it cannot tell you |
 * |---|---|---|
 * | historical fill rate for merchant+item | `Drop.status` over that pair's past drops | nothing about *why* a drop failed — a bad price and a bad week look identical |
 * | group size vs `minQty` | `MarketFillInput.minQty` alone | the organiser's actual group size; §9.3 says "self-reported or inferred", and this app has neither, so the drop's threshold is the only available proxy |
 * | days until cutoff | `Drop.cutoffAt` | — |
 * | organiser's past success with this cuisine | `Drop.status` for this organiser's `ShareLink`s, joined to `MenuItem.category` | whether the diner came from the link or walked in; `shareLinkId` says attributed, not persuaded |
 *
 * The third row is the one that is a substitution rather than a measurement, and it is
 * named as such: a small `minQty` is evidence that somebody chose a reachable target,
 * not evidence about this organiser's reach. It is in the score because the PRD asks
 * for it, and doing nothing would be the same as assuming every threshold is equally
 * reachable — which the published `minQty` values contradict.
 *
 * ## Cold start is the normal case, not the edge case
 *
 * Both histories ship empty: no organiser has attributed a successful drop, because no
 * drop has succeeded. `fillRateFor` returns `null` and the score stops depending on
 * history at all — it becomes the two structural terms (deadline, threshold). That is
 * the behaviour the tests pin, and it is why `CONFIDENCE` exists rather than a plain
 * sample-size blend: a merchant with one failed drop in a rainy week should not be
 * ranked far below a merchant with none, because one drop is not a rate.
 *
 * ## What this module deliberately does not do
 *
 * No database, no clock, no `prisma` import — the caller assembles `RankFacts` and
 * passes `now`. That is the same stance as `drops/rules.ts`, and it is what lets the
 * tie-break rules be tested without a Postgres.
 */

/**
 * How many past drops a rate is trusted to describe.
 *
 * A prior: at four decided drops, a 25% fill rate and a 100% one start to mean
 * different things. Below it, history is blended toward the neutral prior in
 * proportion to its sample size, so one failed drop pulls the score by a quarter of
 * its distance from neutral rather than by all of it.
 */
export const CONFIDENCE_SAMPLE = 4;

/** How far back history is read. Older drops describe a different corridor. */
export const HISTORY_WINDOW_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The weights, summing to 1.
 *
 * Ordered by how much each term is *evidence* rather than assumption: an organiser's
 * own record with a cuisine is the strongest signal the app can hold, a merchant's
 * record is next, and the structural terms are priors that would be there with no data
 * at all. Deadline is last of the four because urgency is an argument about attention,
 * not about whether the drop can fill.
 */
export const WEIGHTS = {
  cuisine: 0.35,
  merchantItem: 0.3,
  deadline: 0.2,
  threshold: 0.15,
} as const;

/** What a decided drop did. Only the two outcomes that mean "the cutoff passed". */
export type DecidedOutcome = 'filled' | 'missed';

/**
 * A merchant+item pair's record over the history window.
 *
 * `outcomes` rather than a rate, because the caller can count rows it already has and
 * a rate passed across a boundary has to carry its own denominator anyway. Counting
 * here means one place decides what "filled" means.
 */
export type PairHistory = {
  readonly merchantId: string;
  readonly menuItemId: string;
  readonly outcomes: readonly DecidedOutcome[];
};

/** One organiser's attributed record for a cuisine. */
export type CuisineHistory = {
  /** `MenuItem.category`, or `null` for items created before D-3 populated it. */
  readonly category: string | null;
  readonly outcomes: readonly DecidedOutcome[];
};

/** Everything the score reads, assembled by the caller. No queries in here. */
export type RankFacts = {
  readonly minQty: number;
  readonly cutoffAt: Date;
  readonly category: string | null;
  readonly merchantHistory: PairHistory | null;
  readonly organiserCuisineHistory: readonly CuisineHistory[];
};

/** Why a drop sits where it does — shown as the card's one-line reason (§9.3). */
export type RankReason =
  | { readonly kind: 'organiser-record'; readonly category: string; readonly rate: number; readonly decided: number }
  | { readonly kind: 'merchant-record'; readonly rate: number; readonly decided: number }
  | { readonly kind: 'closing-soon' }
  | { readonly kind: 'threshold' }
  | { readonly kind: 'no-history' };

export type Ranked = {
  readonly score: number;
  readonly reason: RankReason;
};

/**
 * A fill rate with its sample size, or `null` when nothing has been decided.
 *
 * "Decided" is `filled | missed` only: a drop still `PUBLISHED`, or `DRAFT`, or
 * `CANCELLED` by a merchant, says nothing about whether it would have filled. Counting
 * a cancellation as a miss would punish a merchant for a kitchen closure.
 */
export function fillRate(outcomes: readonly DecidedOutcome[]): {
  readonly rate: number;
  readonly decided: number;
} | null {
  if (outcomes.length === 0) {
    return null;
  }
  const filled = outcomes.filter((outcome) => outcome === 'filled').length;
  return { rate: filled / outcomes.length, decided: outcomes.length };
}

/**
 * Blends a measured rate toward the prior in proportion to its sample size.
 *
 * This is the only place the confidence idea appears, so a change to how much history
 * is trusted is one constant and not a search.
 */
function blended(rate: number, decided: number): number {
  const trust = decided / (decided + CONFIDENCE_SAMPLE);
  // 0.5 is the neutral prior: "no reason to expect this to fill or not".
  return 0.5 + (rate - 0.5) * trust;
}

/**
 * How soon the drop closes, as `1` for "now" and `0` for "the furthest away it can be".
 *
 * The denominator is §8.3's five-day cap on `cutoffAt − publishedAt`, which is also
 * the window a *published* drop can be in at all. Using it here means the term is
 * scaled to the range the data can occupy rather than to an arbitrary constant.
 *
 * A cutoff already in the past scores `1`: it is the most urgent thing on the page,
 * though `listShareableDrops` filters those out, so this is a guard rather than a case.
 */
export function deadlineProximity(cutoffAt: Date, now: Date): number {
  const daysLeft = (cutoffAt.getTime() - now.getTime()) / MS_PER_DAY;
  if (daysLeft <= 0) {
    return 1;
  }
  return Math.max(0, 1 - daysLeft / MAX_AUTH_WINDOW_DAYS);
}

/**
 * How reachable the drop's threshold looks, from its `minQty` alone.
 *
 * `10 / (9 + minQty)` — one at a threshold of 1, half at 11, falling toward zero. The
 * shape matters more than the constants: the difference between a threshold of 2 and
 * one of 5 is a real difference to a group chat, while the difference between 20 and 23
 * is not, so the term has to fall steeply at the low end and flatten above it.
 *
 * The first version of this was `log1p(1)/log1p(minQty) + 0.5`, which saturates to `1`
 * for every `minQty <= 2` — so it scored a threshold of 1 and a threshold of 2
 * identically, which is precisely the discrimination the sentence above claims. Caught
 * by writing the two cases into the tests and watching them produce the same number.
 */
export function thresholdReachability(minQty: number): number {
  // Not "infinitely reachable": a one-plate minimum is a drop that will run, so it
  // scores as high as the term allows. The `<= 1` guard also keeps a malformed row
  // (zero or negative) from producing `Infinity` or `NaN` and poisoning the sort.
  if (minQty <= 1) {
    return 1;
  }
  return 10 / (9 + minQty);
}

/**
 * The organiser's blended record for a cuisine, or `null` when there is none.
 *
 * `category: null` never matches. A row with no category is not a cuisine, and
 * grouping all of them together would let five uncategorised failures read as a
 * cuisine the organiser is bad at.
 */
function cuisineRate(
  history: readonly CuisineHistory[],
  category: string | null,
): { rate: number; decided: number } | null {
  if (category === null) {
    return null;
  }
  const outcomes = history
    .filter((entry) => entry.category === category)
    .flatMap((entry) => entry.outcomes);
  const measured = fillRate(outcomes);
  if (measured === null) {
    return null;
  }
  return { rate: blended(measured.rate, measured.decided), decided: measured.decided };
}

/** The merchant+item record, blended the same way. */
function merchantRate(history: PairHistory | null): { rate: number; decided: number } | null {
  if (history === null) {
    return null;
  }
  const measured = fillRate(history.outcomes);
  if (measured === null) {
    return null;
  }
  return { rate: blended(measured.rate, measured.decided), decided: measured.decided };
}

/**
 * FR-801's ranking, for one drop.
 *
 * The two history terms fall back to the neutral 0.5 when absent, so a drop with no
 * history scores on its structure alone and a drop with history is compared against
 * the same floor. The weights do not renormalise, because renormalising would make an
 * unknown merchant outrank a known-bad one purely by having less evidence against it.
 *
 * ## Why the reason names the *strongest* term rather than the highest score
 *
 * §9.3 asks for "a one-line reason". The reason is what an organiser would repeat to
 * their group, so it should be the thing that actually moved this drop to the top —
 * hence `organiser-record` outranks `merchant-record` outranks `closing-soon`. Reading
 * it off the weight table instead would produce "closing soon" for a drop whose
 * merchant has an 80% record, which is true and unhelpful.
 */
export function likelyFill(facts: RankFacts, now: Date): Ranked {
  const cuisine = cuisineRate(facts.organiserCuisineHistory, facts.category);
  const merchant = merchantRate(facts.merchantHistory);

  const score =
    WEIGHTS.cuisine * (cuisine?.rate ?? 0.5) +
    WEIGHTS.merchantItem * (merchant?.rate ?? 0.5) +
    WEIGHTS.deadline * deadlineProximity(facts.cutoffAt, now) +
    WEIGHTS.threshold * thresholdReachability(facts.minQty);

  return { score, reason: reasonFor({ cuisine, merchant, facts, now }) };
}

function reasonFor(args: {
  cuisine: { rate: number; decided: number } | null;
  merchant: { rate: number; decided: number } | null;
  facts: RankFacts;
  now: Date;
}): RankReason {
  const { cuisine, merchant, facts, now } = args;

  if (cuisine !== null && facts.category !== null) {
    return {
      kind: 'organiser-record',
      category: facts.category,
      rate: cuisine.rate,
      decided: cuisine.decided,
    };
  }
  if (merchant !== null) {
    return { kind: 'merchant-record', rate: merchant.rate, decided: merchant.decided };
  }
  if (deadlineProximity(facts.cutoffAt, now) >= 0.5) {
    return { kind: 'closing-soon' };
  }
  if (facts.minQty <= 5) {
    return { kind: 'threshold' };
  }
  return { kind: 'no-history' };
}

/**
 * The one-line reason as a sentence, or `null` when there is nothing worth saying.
 *
 * ## Why this lives beside the rank and not in the page
 *
 * §9.3's output is "top 3 recommended drops with a one-line reason". The reason is
 * part of the requirement, so the words belong with the arithmetic that produced it —
 * the page renders the sentence, it does not author it. That is the same split as
 * `shareMessageFor`: the server owns the words, and a second client composing its own
 * is how one of them ends up describing a different ranking.
 *
 * ## Why some reasons produce `null`
 *
 * `closing-soon`, `threshold` and `no-history` are *structural*: the card already
 * shows the deadline and the count. Repeating "closes soon" above a line that says
 * when it closes is noise, and a page that adds a sentence to every card trains the
 * reader to skip all of them. Only the two history reasons say something the card
 * cannot: a percentage the organiser cannot see anywhere else.
 *
 * ## Why the percentage is rounded and hedged
 *
 * `Math.round` because "67% filled" is a claim a person repeats and `0.6666` is not.
 * The hedge — "of N" — is not decoration: a rate over one drop and a rate over eight
 * are different claims, and stating the denominator is what keeps the sentence honest
 * when the sample is tiny. It is also what stops "based on your 100% record" from
 * appearing after a single lucky drop.
 */
export function reasonSentence(reason: RankReason): string | null {
  switch (reason.kind) {
    case 'organiser-record': {
      const pct = Math.round(reason.rate * 100);
      return `Your ${reason.category} drops have filled ${pct}% of the time (${reason.decided} decided) — this is one of them.`;
    }
    case 'merchant-record': {
      const pct = Math.round(reason.rate * 100);
      return `This restaurant's drops have filled ${pct}% of the time (${reason.decided} decided).`;
    }
    default:
      return null;
  }
}

/**
 * Sorts ranked drops and settles ties deterministically.
 *
 * ## Why this takes the whole row rather than `(a, b) => number`
 *
 * A comparator would let each caller write its own — and the page and the API route
 * are two callers. The tie-break below is the part people leave out when they write a
 * one-line comparator, and leaving it out is invisible until the data has a tie in it.
 * So the rule lives here and the callers pass rows.
 *
 * ## Why the tie-break is explicit and total
 *
 * `Array.prototype.sort` is stable, so equal scores already keep insertion order —
 * which is `cutoffAt` ascending from the query. Relying on that would make the order a
 * property of the *query* rather than of this module, and the first caller that built
 * its own array would get a different answer for the same data. Ties are broken on
 * `cutoffAt`, then `id`, so the output is a pure function of the input set and two
 * runs over the same rows cannot disagree.
 *
 * The alternative — comparing floats with an epsilon — was rejected: `epsilon` is a
 * number nobody can defend, and two drops whose scores differ in the twelfth decimal
 * are not "tied" in any sense an organiser cares about.
 */
export function rankByLikelyFill<
  T extends { readonly id: string; readonly cutoffAt: Date; readonly likelyFill: Ranked },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (b.likelyFill.score !== a.likelyFill.score) {
      return b.likelyFill.score - a.likelyFill.score;
    }
    const byCutoff = a.cutoffAt.getTime() - b.cutoffAt.getTime();
    if (byCutoff !== 0) {
      return byCutoff;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
