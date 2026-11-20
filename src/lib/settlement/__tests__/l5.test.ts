import { describe, expect, it } from 'vitest';

import { reconcileL5 } from '../l5';

/**
 * L5's two identities, over ADR-004's own worked example.
 *
 * Vector A: three plates at $11.12, platform fee $0.89 per plate, Stripe card fee
 * $1.27. Connected delta +$29.42; platform delta +$2.67. The point of the split is that
 * neither figure is a sum of our ledger alone — the card fee is a third party's cut,
 * and the platform fee moves on the other account.
 */

const ENTRIES = [
  { type: 'CHARGE' as const, amountCents: 3336 },
  { type: 'PLATFORM_FEE' as const, amountCents: 267 },
];
const CONNECTED = [
  { id: 'txn_charge', kind: 'charge' as const, amountCents: 3336, feeCents: -127 },
];
const PLATFORM = [
  { id: 'txn_fee', kind: 'application_fee' as const, amountCents: 267 },
];

describe('reconcileL5', () => {
  it('reconciles vector A on both accounts', () => {
    const result = reconcileL5({ entries: ENTRIES, connected: CONNECTED, platform: PLATFORM });

    expect(result.ok).toBe(true);
    expect(result.ledgerConnectedCents).toBe(3336);
    expect(result.stripeFeeCents).toBe(-127);
    expect(result.ledgerPlatformCents).toBe(267);
    expect(result.checks).toEqual([
      {
        name: 'CONNECTED_BALANCE',
        ok: true,
        expectedCents: 3209,
        actualCents: 3209,
        differenceCents: 0,
      },
      {
        name: 'PLATFORM_APPLICATION_FEES',
        ok: true,
        expectedCents: 267,
        actualCents: 267,
        differenceCents: 0,
      },
    ]);
  });

  it('fails when the ledger charge differs from the balance transaction', () => {
    // The fee is Stripe's and cancels on both sides when it is used consistently, so
    // the discriminating error is an amount: a charge row of 3300 against Stripe's
    // 3336 is exactly the silent wrong-cent bug L5 exists to catch.
    const result = reconcileL5({
      entries: [
        { type: 'CHARGE', amountCents: 3300 },
        { type: 'PLATFORM_FEE', amountCents: 267 },
      ],
      connected: CONNECTED,
      platform: PLATFORM,
    });

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: 'CONNECTED_BALANCE',
      ok: false,
      expectedCents: 3173,
      actualCents: 3209,
      differenceCents: -36,
    });
  });

  it('fails the platform identity when an application fee is missing or wrong', () => {
    const result = reconcileL5({
      entries: ENTRIES,
      connected: CONNECTED,
      platform: [{ id: 'txn_fee', kind: 'application_fee', amountCents: 200 }],
    });

    expect(result.ok).toBe(false);
    expect(result.checks[1]).toMatchObject({
      name: 'PLATFORM_APPLICATION_FEES',
      expectedCents: 267,
      actualCents: 200,
      differenceCents: 67,
    });
  });

  it('accounts for a partial refund on both sides', () => {
    const result = reconcileL5({
      entries: [
        { type: 'CHARGE', amountCents: 3336 },
        { type: 'REFUND', amountCents: -1112 },
        { type: 'PLATFORM_FEE', amountCents: 267 },
        { type: 'ADJUSTMENT', amountCents: -89 },
      ],
      connected: [
        { id: 'txn_charge', kind: 'charge', amountCents: 3336, feeCents: -127 },
        { id: 'txn_refund', kind: 'refund', amountCents: -1112, feeCents: 0 },
      ],
      platform: [{ id: 'txn_fee', kind: 'application_fee', amountCents: 178 }],
    });

    expect(result.ok).toBe(true);
    expect(result.checks[0]?.expectedCents).toBe(3336 - 1112 - 127);
    expect(result.checks[1]?.expectedCents).toBe(267 - 89);
  });

  it('does not count an organiser commission against either L5 identity', () => {
    // Commission is a payout statement, not a capture-time movement (ADR-004 §5).
    const result = reconcileL5({
      entries: [...ENTRIES, { type: 'ORGANISER_COMMISSION', amountCents: -100 }],
      connected: CONNECTED,
      platform: PLATFORM,
    });

    expect(result.ok).toBe(true);
    expect(result.ledgerPlatformCents).toBe(267);
  });
});
