import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_SAMPLE,
  HISTORY_WINDOW_DAYS,
  WEIGHTS,
  deadlineProximity,
  fillRate,
  likelyFill,
  rankByLikelyFill,
  reasonSentence,
  thresholdReachability,
  type RankFacts,
} from '../likely-fill';

/**
 * FR-801's `likelyFill` — §9.3's four inputs, as arithmetic.
 *
 * No database and no clock: every case passes its own `now`, which is the only reason
 * a ranking can be tested at all. A score that read the clock would be untestable
 * within a day of being written, and the failure would look like flakiness.
 *
 * The cases below are chosen so that each one fails for a *specific* wrong formula,
 * not just for garbage. `1` and `2` for the threshold term are the pair that caught the
 * first implementation of `thresholdReachability`, which scored them identically while
 * its own comment claimed they differed.
 */

const NOW = new Date('2026-11-03T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function facts(overrides: Partial<RankFacts> = {}): RankFacts {
  return {
    minQty: 5,
    cutoffAt: new Date(NOW.getTime() + 2 * DAY),
    category: 'Bowls',
    merchantHistory: null,
    organiserCuisineHistory: [],
    ...overrides,
  };
}

describe('the weights', () => {
  it('sum to 1, so a score is comparable across drops', () => {
    // Not cosmetic: if they summed to 1.2, a drop with history on every axis could
    // score 1.2 while a structural-only drop capped at 0.7, and the two numbers would
    // stop being on the same scale. The sort would still work; the "is this a good
    // drop" reading would not.
    const total = WEIGHTS.cuisine + WEIGHTS.merchantItem + WEIGHTS.deadline + WEIGHTS.threshold;
    expect(total).toBeCloseTo(1, 10);
  });

  it('ranks the organiser\'s own record above every structural term', () => {
    // §9.3 calls this "the organiser's past success with this cuisine" — the only input
    // that is evidence about *them* rather than about the drop.
    expect(WEIGHTS.cuisine).toBeGreaterThan(WEIGHTS.merchantItem);
    expect(WEIGHTS.merchantItem).toBeGreaterThan(WEIGHTS.deadline);
    expect(WEIGHTS.deadline).toBeGreaterThan(WEIGHTS.threshold);
  });
});

describe('fillRate', () => {
  it('returns null rather than 0 when nothing has been decided', () => {
    // The distinction the whole cold-start arm rests on. A `0` here would mean "this
    // never fills", which is the opposite of "we do not know".
    expect(fillRate([])).toBeNull();
  });

  it('counts a rate and its denominator together', () => {
    expect(fillRate(['filled', 'missed', 'missed', 'filled'])).toEqual({ rate: 0.5, decided: 4 });
  });
});

describe('deadlineProximity', () => {
  it('is 1 at the cutoff and 0 at §8.3\'s five-day maximum', () => {
    expect(deadlineProximity(new Date(NOW.getTime()), NOW)).toBe(1);
    expect(deadlineProximity(new Date(NOW.getTime() + 5 * DAY), NOW)).toBe(0);
  });

  it('never goes negative for a cutoff beyond the five-day cap', () => {
    // Probe D found this: deleting the `Math.max(0, …)` clamp changed nothing, because
    // no test ever looked past five days. §8.3 caps `cutoffAt − publishedAt` at five
    // days, so this case *should* be unreachable — but "should be unreachable" is what
    // the clamp defends against, and a negative deadline term would pull a distant drop
    // below every structural baseline. Pinned so the clamp is load-bearing rather than
    // decorative.
    for (const days of [6, 9, 30]) {
      expect(deadlineProximity(new Date(NOW.getTime() + days * DAY), NOW)).toBe(0);
    }
  });

  it('is halfway at half the window', () => {
    expect(deadlineProximity(new Date(NOW.getTime() + 2.5 * DAY), NOW)).toBeCloseTo(0.5, 10);
  });

  it('treats a cutoff already in the past as maximally urgent, not as negative', () => {
    // `listShareableDrops` filters these out, so this is a guard: without the clamp a
    // past cutoff would score below zero and a stale tab would sort the closed drop last.
    expect(deadlineProximity(new Date(NOW.getTime() - 3 * DAY), NOW)).toBe(1);
  });
});

describe('thresholdReachability', () => {
  it('distinguishes a threshold of 1 from a threshold of 2', () => {
    // The pair that killed the first implementation. It returned `1` for both, so a
    // one-plate minimum and a two-plate minimum ranked identically — which is the
    // discrimination the function exists to provide.
    expect(thresholdReachability(1)).toBe(1);
    expect(thresholdReachability(2)).toBeLessThan(1);
  });

  it('falls steeply at the low end and flattens above it', () => {
    // Probe E was the bad-assertion case: the ratio test below (`low > high * 3`) is
    // satisfied by a *linear* formula too, so swapping the shape for `1 - minQty/20`
    // left the suite green. The property that actually distinguishes them is the ratio
    // itself — a saturating curve loses a much larger *fraction* of its height over
    // 2→5 than over 20→23, because it is approaching an asymptote rather than a floor.
    const at2 = thresholdReachability(2);
    const at5 = thresholdReachability(5);
    const at20 = thresholdReachability(20);
    const at23 = thresholdReachability(23);

    const lowFraction = (at2 - at5) / at2;
    const highFraction = (at20 - at23) / at20;

    // Saturating: 0.90 → 0.71 is a 21% drop; 0.34 → 0.31 is an 8% drop, so ~2.6×.
    // Linear: 0.90 → 0.75 is 17%; 0 → negative-or-zero is unbounded, and the clamped
    // version is 0. Either way it cannot reach 3×.
    expect(lowFraction).toBeGreaterThan(highFraction * 2);

    // And the absolute check, kept because it states the intent in one line.
    expect(at2 - at5).toBeGreaterThan(at20 - at23);
  });

  it('never returns more than 1 or less than 0', () => {
    for (const minQty of [0, -5, 1, 2, 10, 1000]) {
      const value = thresholdReachability(minQty);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('cold start — the case the shipped database is actually in', () => {
  it('scores on structure alone when no history exists', () => {
    // Both histories are empty in production: no drop has ever succeeded, so no
    // organiser has an attributed success. This is not an edge case to be handled
    // gracefully; it is the only case that runs today.
    const soon = likelyFill(facts({ cutoffAt: new Date(NOW.getTime() + DAY), minQty: 2 }), NOW);
    const later = likelyFill(
      facts({ cutoffAt: new Date(NOW.getTime() + 4 * DAY), minQty: 8 }),
      NOW,
    );

    expect(soon.score).toBeGreaterThan(later.score);
  });

  it('does not renormalise the weights when history is missing', () => {
    // Renormalising would push a no-history drop up toward 1, letting an unknown
    // merchant outrank a known-bad one purely by having less evidence against it.
    // The ceiling for a structural-only drop is therefore well below 1.
    const best = likelyFill(
      facts({ cutoffAt: new Date(NOW.getTime()), minQty: 1 }),
      NOW,
    );
    expect(best.score).toBeLessThan(0.7);
    expect(best.score).toBeGreaterThan(0.5);
  });

  it('says `no-history` only when nothing else is true', () => {
    const distant = likelyFill(
      facts({
        cutoffAt: new Date(NOW.getTime() + 4.9 * DAY),
        minQty: 20,
        category: null,
      }),
      NOW,
    );
    expect(distant.reason.kind).toBe('no-history');
  });
});

describe('history moves the score, and by how much', () => {
  it('ranks a good organiser record above an unknown one', () => {
    const withRecord = likelyFill(
      facts({
        organiserCuisineHistory: [{ category: 'Bowls', outcomes: ['filled', 'filled', 'filled', 'filled'] }],
      }),
      NOW,
    );
    const without = likelyFill(facts(), NOW);

    expect(withRecord.score).toBeGreaterThan(without.score);
    expect(withRecord.reason).toEqual({
      kind: 'organiser-record',
      category: 'Bowls',
      rate: expect.closeTo(0.75, 10),
      decided: 4,
    });
  });

  it('pulls a single failed drop only a quarter of the way toward "never fills"', () => {
    // `CONFIDENCE_SAMPLE` is the point of `blended`. One failure is not a rate; four
    // are starting to be. With a prior of 4, one outcome moves the estimate 1/5 of the
    // distance, and four move it half.
    const one = likelyFill(
      facts({ organiserCuisineHistory: [{ category: 'Bowls', outcomes: ['missed'] }] }),
      NOW,
    );
    const four = likelyFill(
      facts({
        organiserCuisineHistory: [
          { category: 'Bowls', outcomes: ['missed', 'missed', 'missed', 'missed'] },
        ],
      }),
      NOW,
    );

    // 0.5 + (0 - 0.5) * (1/5) = 0.4; 0.5 + (0 - 0.5) * (4/8) = 0.25.
    expect(one.reason.kind).toBe('organiser-record');
    if (one.reason.kind !== 'organiser-record') throw new Error('unreachable');
    expect(one.reason.rate).toBeCloseTo(0.4, 10);

    if (four.reason.kind !== 'organiser-record') throw new Error('unreachable');
    expect(four.reason.rate).toBeCloseTo(0.25, 10);
    expect(four.score).toBeLessThan(one.score);
  });

  it('exposes the prior as one constant rather than a scattered fudge', () => {
    // So a future argument about how much history to trust happens over one number.
    expect(CONFIDENCE_SAMPLE).toBeGreaterThan(0);
    expect(HISTORY_WINDOW_DAYS).toBeGreaterThan(CONFIDENCE_SAMPLE);
  });

  it('ignores categories that do not match, and `null` categories entirely', () => {
    // Five uncategorised failures must not read as a cuisine the organiser is bad at.
    const otherCuisine = likelyFill(
      facts({
        organiserCuisineHistory: [
          { category: 'Coffee', outcomes: ['missed', 'missed', 'missed', 'missed'] },
        ],
      }),
      NOW,
    );
    expect(otherCuisine.reason.kind).not.toBe('organiser-record');

    // Probe P deleted the `category === null` guard and this test stayed green, because
    // `not.toBe('organiser-record')` is satisfied by the *score difference* too: the
    // null-category history still fed `cuisineRate` and dragged the score down while the
    // reason fell through. So the assertion is on the score now, against a control that
    // differs only in having no history at all.
    const nullCategory = likelyFill(
      facts({
        category: null,
        organiserCuisineHistory: [
          { category: null, outcomes: ['missed', 'missed', 'missed', 'missed'] },
        ],
      }),
      NOW,
    );
    expect(nullCategory.reason.kind).not.toBe('organiser-record');

    const noHistory = likelyFill(facts({ category: null }), NOW);
    // Identical: a null category contributes nothing, exactly as an empty history does.
    expect(nullCategory.score).toBe(noHistory.score);
  });

  it('falls back to the merchant record when the cuisine is unknown', () => {
    const merchantOnly = likelyFill(
      facts({
        merchantHistory: {
          merchantId: 'm1',
          menuItemId: 'i1',
          outcomes: ['filled', 'filled'],
        },
      }),
      NOW,
    );
    expect(merchantOnly.reason.kind).toBe('merchant-record');
  });
});

describe('the one-line reason', () => {
  it('prefers the organiser record over the merchant record', () => {
    // The reason is what an organiser repeats to their group, so it names the strongest
    // evidence rather than the largest number in the weight table.
    const both = likelyFill(
      facts({
        organiserCuisineHistory: [{ category: 'Bowls', outcomes: ['filled', 'missed'] }],
        merchantHistory: {
          merchantId: 'm1',
          menuItemId: 'i1',
          outcomes: ['filled', 'filled', 'filled'],
        },
      }),
      NOW,
    );
    expect(both.reason.kind).toBe('organiser-record');
  });

  it('says `closing-soon` for a drop inside half its window with no history', () => {
    const soon = likelyFill(
      facts({ cutoffAt: new Date(NOW.getTime() + 2 * DAY) }),
      NOW,
    );
    // 2 of 5 days left → proximity 0.6 → at or past the 0.5 threshold.
    expect(soon.reason.kind).toBe('closing-soon');
  });

  it('says `threshold` for a distant drop with a small minimum', () => {
    const far = likelyFill(
      facts({ cutoffAt: new Date(NOW.getTime() + 4.5 * DAY), minQty: 3 }),
      NOW,
    );
    expect(far.reason.kind).toBe('threshold');
  });
});

describe('the one-line reason, as a sentence', () => {
  it('states the percentage and the denominator, because both are claims', () => {
    // "100% filled" after one drop and after eight are different claims, and the
    // sentence says which. Math.round because a person repeats this number.
    const sentence = reasonSentence({
      kind: 'organiser-record',
      category: 'Bowls',
      rate: 0.6667,
      decided: 6,
    });
    expect(sentence).toContain('67%');
    expect(sentence).toContain('Bowls');
    expect(sentence).toContain('6 decided');
  });

  it('names the restaurant for a merchant record', () => {
    const sentence = reasonSentence({ kind: 'merchant-record', rate: 0.8, decided: 5 });
    expect(sentence).toContain('80%');
    expect(sentence).toContain('5 decided');
  });

  it('says nothing for the three structural reasons', () => {
    // The card already shows the deadline and the count. A sentence that repeats
    // visible information trains the reader to skip the one that does not.
    expect(reasonSentence({ kind: 'closing-soon' })).toBeNull();
    expect(reasonSentence({ kind: 'threshold' })).toBeNull();
    expect(reasonSentence({ kind: 'no-history' })).toBeNull();
  });
});

describe('rankByLikelyFill', () => {
  const row = (id: string, cutoffInDays: number, score: number) => ({
    id,
    cutoffAt: new Date(NOW.getTime() + cutoffInDays * DAY),
    likelyFill: { score, reason: { kind: 'no-history' as const } },
  });

  it('orders by score descending', () => {
    const ranked = rankByLikelyFill([row('a', 1, 0.4), row('b', 2, 0.9), row('c', 3, 0.6)]);
    expect(ranked.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties on the cutoff, then on id — a total order, not the sort\'s stability', () => {
    // `Array.prototype.sort` is stable, so equal scores would keep insertion order and
    // the result would be a property of the caller's array. Two runs over the same rows
    // in a different order have to agree, so the tie-break is written down.
    const first = rankByLikelyFill([row('z', 2, 0.5), row('a', 2, 0.5), row('m', 1, 0.5)]);
    const reversed = rankByLikelyFill([row('m', 1, 0.5), row('a', 2, 0.5), row('z', 2, 0.5)]);

    expect(first.map((entry) => entry.id)).toEqual(['m', 'a', 'z']);
    expect(reversed.map((entry) => entry.id)).toEqual(['m', 'a', 'z']);
  });

  it('does not mutate its input', () => {
    const input = [row('a', 1, 0.4), row('b', 2, 0.9)];
    rankByLikelyFill(input);
    expect(input.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
