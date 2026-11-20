import { describe, expect, it } from 'vitest';

import { computeNorthStar, type NorthStarFacts } from '../north-star';

/**
 * §10.2's eight definitions, with the denominators that make them checkable.
 *
 * Each fixture is chosen so the wrong definition produces a different number:
 * a voided authorisation in a failed drop (fill), a second order for one customer
 * (repeat), and a first-capture order that is not the earliest row (new share).
 */

const T0 = new Date('2026-11-01T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const FACTS: NorthStarFacts = {
  decidedDrops: [
    {
      status: 'COMPLETED',
      minQty: 10,
      participants: [
        { qty: 6, authStatus: 'AUTHORIZED' },
        { qty: 4, authStatus: 'AUTHORIZED' },
      ],
    },
    {
      status: 'CAPTURED',
      minQty: 10,
      participants: [
        { qty: 8, authStatus: 'AUTHORIZED' },
        { qty: 4, authStatus: 'AUTHORIZED' }, // 12/10, over-filled
      ],
    },
    {
      status: 'FAILED',
      minQty: 20,
      participants: [
        { qty: 8, authStatus: 'VOIDED' }, // joined, then released
        { qty: 5, authStatus: 'FAILED' }, // declined; not demand
      ],
    },
  ],
  merchants: [
    { createdAt: T0, firstPublishedAt: new Date(T0.getTime() + 2 * HOUR) },
    { createdAt: T0, firstPublishedAt: new Date(T0.getTime() + 6 * HOUR) },
    { createdAt: T0, firstPublishedAt: null },
  ],
  sharedDropIds: ['d1', 'd1', 'd2'],
  publishedDropIds: ['d1', 'd2', 'd3'],
  orders: [
    { customerId: 'a', createdAt: new Date(T0.getTime() + 1 * HOUR) },
    { customerId: 'b', createdAt: new Date(T0.getTime() + 2 * HOUR) },
    { customerId: 'a', createdAt: new Date(T0.getTime() + 3 * HOUR) },
  ],
  redemption: [
    { qty: 10, redeemedQty: 8 },
    { qty: 10, redeemedQty: 7 },
  ],
  analytics: { dealPageViewed: 100, joinAuthorised: 10 },
};

describe('computeNorthStar', () => {
  it('computes all eight with explicit numerators and denominators', () => {
    const metrics = computeNorthStar(FACTS);

    // 2 hits (COMPLETED, CAPTURED) of 3 decided (FAILED is a decision).
    expect(metrics.thresholdHitRate).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
    // Fill rates: 10/10 = 1, 12/10 = 1.2, 8/20 = 0.4; median 1.
    expect(metrics.medianFillRate).toBe(1);
    // 2h and 6h; median 4h.
    expect(metrics.medianHoursToFirstPublish).toBe(4);
    expect(metrics.joinConversion).toEqual({ numerator: 10, denominator: 100, value: 0.1 });
    // Two distinct shared drops of three published.
    expect(metrics.organiserShareRate).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(metrics.redemptionRate).toEqual({ numerator: 15, denominator: 20, value: 0.75 });
    expect(metrics.repeatParticipantRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    // First captures: a's first order, b's only order. a's second is not new.
    expect(metrics.newCustomerShare).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
  });

  it('returns null, never zero, when the denominator is empty', () => {
    const metrics = computeNorthStar({
      decidedDrops: [],
      merchants: [],
      sharedDropIds: [],
      publishedDropIds: [],
      orders: [],
      redemption: [],
      analytics: { dealPageViewed: 0, joinAuthorised: 0 },
    });

    expect(metrics.thresholdHitRate.value).toBeNull();
    expect(metrics.medianFillRate).toBeNull();
    expect(metrics.medianHoursToFirstPublish).toBeNull();
    expect(metrics.joinConversion.value).toBeNull();
    expect(metrics.organiserShareRate.value).toBeNull();
    expect(metrics.redemptionRate.value).toBeNull();
    expect(metrics.repeatParticipantRate.value).toBeNull();
    expect(metrics.newCustomerShare.value).toBeNull();
  });

  it('excludes declined cards from fill but includes voided joins', () => {
    const metrics = computeNorthStar({
      ...FACTS,
      decidedDrops: [FACTS.decidedDrops[2]!],
      merchants: [],
      sharedDropIds: [],
      publishedDropIds: [],
      orders: [],
      redemption: [],
    });

    // 8 voided / 20 = 0.4. A version that summed every participant would say 13/20.
    expect(metrics.medianFillRate).toBe(0.4);
  });
});
