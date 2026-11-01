import { describe, expect, it } from 'vitest';

import {
  MAX_AUTH_WINDOW_DAYS,
  isOpenForJoining,
  latestCutoffFor,
  validateDropQuantities,
  validateDropTiming,
} from '@/lib/drops/rules';

/**
 * The rules that protect money: the authorisation window (§8.3) and the quantity
 * relationship (§4.1). Pure functions, so the tests are cheap and there is no
 * excuse for leaving a branch uncovered.
 *
 * Every case passes `now` explicitly — the module never reads a clock, which is
 * what makes "five days from publish" testable without freezing time.
 */

const BASE = new Date('2026-11-05T12:00:00-07:00');

function at(offsetDays: number, base: Date = BASE): Date {
  return new Date(base.getTime() + offsetDays * 24 * 60 * 60 * 1000);
}

/** A window that satisfies every rule, so each test can vary one thing. */
function validTiming(): { windowStart: Date; windowEnd: Date; cutoffAt: Date } {
  return {
    windowStart: at(4),
    windowEnd: at(4, new Date(BASE.getTime() + 2 * 60 * 60 * 1000)),
    cutoffAt: at(3),
  };
}

describe('validateDropTiming · the happy path', () => {
  it('accepts a window inside every limit', () => {
    expect(validateDropTiming(validTiming(), BASE)).toEqual([]);
  });

  it('accepts a cutoff exactly at the five-day limit', () => {
    const timing = {
      ...validTiming(),
      // Exactly MAX_AUTH_WINDOW_DAYS out. The rule is "no more than", so this is
      // allowed — an off-by-one here would reject a legitimate drop.
      cutoffAt: latestCutoffFor(BASE),
      windowStart: at(6),
      windowEnd: at(6, new Date(BASE.getTime() + 60 * 60 * 1000)),
    };
    expect(validateDropTiming(timing, BASE)).toEqual([]);
  });
});

describe('validateDropTiming · the authorisation window (§8.3)', () => {
  it('rejects a cutoff more than five days after publish', () => {
    const timing = {
      ...validTiming(),
      cutoffAt: at(MAX_AUTH_WINDOW_DAYS + 0.01),
      windowStart: at(7),
      windowEnd: at(7, new Date(BASE.getTime() + 60 * 60 * 1000)),
    };

    const issues = validateDropTiming(timing, BASE);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('cutoffAt');
    // The message must explain *why*, because the merchant will otherwise try to
    // work around a rule that appears arbitrary.
    expect(issues[0]?.message).toMatch(/seven days/);
  });

  it('rejects a six-day drop but not a five-day one — the boundary is exact', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const make = (days: number) => ({
      cutoffAt: new Date(BASE.getTime() + days * dayMs),
      windowStart: new Date(BASE.getTime() + (days + 1) * dayMs),
      windowEnd: new Date(BASE.getTime() + (days + 1) * dayMs + 3600_000),
    });

    expect(validateDropTiming(make(5), BASE)).toEqual([]);
    expect(validateDropTiming(make(5.5), BASE)).toHaveLength(1);
  });
});

describe('validateDropTiming · window sanity', () => {
  it('rejects a window that ends before it starts', () => {
    const timing = { ...validTiming(), windowEnd: at(3.5) };
    const issues = validateDropTiming(timing, BASE);

    expect(issues.map((issue) => issue.field)).toContain('windowEnd');
  });

  it('rejects a zero-length window', () => {
    const timing = { ...validTiming() };
    timing.windowEnd = new Date(timing.windowStart.getTime());

    // "Ends at the same moment it starts" is not a pickup window a diner can use.
    expect(validateDropTiming(timing, BASE).map((issue) => issue.field)).toContain('windowEnd');
  });

  it('rejects a cutoff at or after the window opens', () => {
    const timing = { ...validTiming(), cutoffAt: new Date(validTiming().windowStart.getTime()) };
    const issues = validateDropTiming(timing, BASE);

    expect(issues.map((issue) => issue.field)).toContain('cutoffAt');
    expect(issues[0]?.message).toMatch(/before pickup starts/);
  });

  it('rejects a cutoff after the window has already closed', () => {
    const timing = { ...validTiming(), cutoffAt: at(4.5) };
    expect(validateDropTiming(timing, BASE).map((issue) => issue.field)).toContain('cutoffAt');
  });
});

describe('validateDropTiming · invalid dates', () => {
  it('reports invalid dates and stops, rather than comparing NaN', () => {
    const timing = {
      windowStart: new Date('not a date'),
      windowEnd: new Date('also not a date'),
      cutoffAt: new Date('nope'),
    };

    const issues = validateDropTiming(timing, BASE);
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      'cutoffAt',
      'windowEnd',
      'windowStart',
    ]);
    // The important part: no *ordering* complaints. Every comparison against an
    // invalid date is false, so a naive implementation returns zero issues here
    // and lets a malformed window through as valid.
    expect(issues.some((issue) => /after it starts|before pickup starts/.test(issue.message))).toBe(
      false,
    );
  });
});

describe('validateDropQuantities', () => {
  const batchYield = 30;

  it('accepts a sound relationship', () => {
    expect(validateDropQuantities({ minQty: 20, maxQty: 30, batchYield })).toEqual([]);
  });

  it('accepts minQty equal to maxQty — an all-or-nothing drop', () => {
    expect(validateDropQuantities({ minQty: 25, maxQty: 25, batchYield })).toEqual([]);
  });

  it('rejects a minimum above the maximum', () => {
    const issues = validateDropQuantities({ minQty: 30, maxQty: 20, batchYield });
    expect(issues.map((issue) => issue.field)).toContain('minQty');
  });

  it('rejects a maximum above the batch yield, naming the real ceiling', () => {
    const issues = validateDropQuantities({ minQty: 20, maxQty: 40, batchYield });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('maxQty');
    // The merchant must be told their own number back: "too high" is not
    // actionable, "you said you can make 30" is.
    expect(issues[0]?.message).toContain('30');
  });

  it('rejects zero, negative and fractional quantities', () => {
    expect(validateDropQuantities({ minQty: 0, maxQty: 30, batchYield })).toHaveLength(1);
    expect(validateDropQuantities({ minQty: -5, maxQty: 30, batchYield })).toHaveLength(1);
    expect(validateDropQuantities({ minQty: 20, maxQty: 30.5, batchYield })).toHaveLength(1);
    expect(validateDropQuantities({ minQty: 20.5, maxQty: 30, batchYield })).toHaveLength(1);
  });

  it('reports only the format problem, not a comparison, when a value is invalid', () => {
    // minQty 0 is invalid; reporting "minimum is above maximum" as well would be
    // two messages for one mistake.
    const issues = validateDropQuantities({ minQty: 0, maxQty: 30, batchYield });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('minQty');
  });

  it('does not silently accept a yield of zero', () => {
    // A dish with batchYield 0 is a data problem, but this function's contract is
    // the relationship; it still refuses a positive maxQty against a zero yield.
    const issues = validateDropQuantities({ minQty: 1, maxQty: 1, batchYield: 0 });
    expect(issues.map((issue) => issue.field)).toContain('maxQty');
  });
});

describe('isOpenForJoining', () => {
  it('is true only for a PUBLISHED drop before its cutoff', () => {
    expect(isOpenForJoining({ status: 'PUBLISHED', cutoffAt: at(1) }, BASE)).toBe(true);
    expect(isOpenForJoining({ status: 'PUBLISHED', cutoffAt: at(-1) }, BASE)).toBe(false);
    expect(isOpenForJoining({ status: 'DRAFT', cutoffAt: at(1) }, BASE)).toBe(false);
    expect(isOpenForJoining({ status: 'LOCKED', cutoffAt: at(1) }, BASE)).toBe(false);
    expect(isOpenForJoining({ status: 'FAILED', cutoffAt: at(1) }, BASE)).toBe(false);
  });

  it('is false exactly at the cutoff instant', () => {
    // At the boundary the job may already be capturing. Treating the boundary as
    // open would let a join arrive after the count was taken.
    expect(isOpenForJoining({ status: 'PUBLISHED', cutoffAt: new Date(BASE) }, BASE)).toBe(false);
  });
});

describe('latestCutoffFor', () => {
  it('is exactly five days out', () => {
    const latest = latestCutoffFor(BASE);
    expect(latest.getTime() - BASE.getTime()).toBe(MAX_AUTH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });

  it('agrees with the validator — the boundary it produces is accepted', () => {
    // The form sets an input `max` from this function and the server validates
    // with `validateDropTiming`. If the two disagreed, a form would offer a date
    // the server rejects.
    const latest = latestCutoffFor(BASE);
    const timing = {
      cutoffAt: latest,
      windowStart: new Date(latest.getTime() + 60 * 60 * 1000),
      windowEnd: new Date(latest.getTime() + 2 * 60 * 60 * 1000),
    };
    expect(validateDropTiming(timing, BASE)).toEqual([]);
  });
});
