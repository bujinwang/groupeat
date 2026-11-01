import { describe, expect, it } from 'vitest';

import {
  assessOnboarding,
  canPublishDrop,
  onboardingMessage,
  type StripeAccountSnapshot,
} from '../onboarding';

/**
 * FR-102 — `onboardingComplete` is true only when Stripe says
 * `charges_enabled && payouts_enabled`.
 *
 * The cases below are the ones that are hard to produce against the live API on
 * demand (a restricted account, a charge-enabled/payout-disabled split, an
 * account with a past-due requirement) and therefore the ones that would
 * otherwise never be tested at all.
 */

function account(overrides: Partial<StripeAccountSnapshot> = {}): StripeAccountSnapshot {
  return {
    id: 'acct_test_123',
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    disabled_reason: null,
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
    ...overrides,
  };
}

describe('assessOnboarding — FR-102', () => {
  it('is NOT_STARTED with no account, and cannot accept payments', () => {
    const result = assessOnboarding(null);
    expect(result.state).toBe('NOT_STARTED');
    expect(result.onboardingComplete).toBe(false);
    expect(result.canAcceptPayments).toBe(false);
    expect(result.merchantStatus).toBe('PENDING');
  });

  it('is READY only when charges, payouts and details are all complete', () => {
    const result = assessOnboarding(account());
    expect(result.state).toBe('READY');
    expect(result.onboardingComplete).toBe(true);
    expect(result.canAcceptPayments).toBe(true);
    expect(result.merchantStatus).toBe('ACTIVE');
  });

  it('is INCOMPLETE when charges are enabled but payouts are not', () => {
    // The dangerous half-configured case: Stripe will take the diner's money and
    // the merchant cannot be paid. FR-102 names both flags for this reason.
    const result = assessOnboarding(account({ payouts_enabled: false }));
    expect(result.state).toBe('INCOMPLETE');
    expect(result.onboardingComplete).toBe(false);
    expect(result.canAcceptPayments).toBe(false);
  });

  it('is INCOMPLETE when payouts are enabled but charges are not', () => {
    const result = assessOnboarding(account({ charges_enabled: false }));
    expect(result.onboardingComplete).toBe(false);
    expect(result.canAcceptPayments).toBe(false);
  });

  it('refuses READY when details were never submitted, even if Stripe pre-enabled both flags', () => {
    // Stripe can report both capabilities on an account whose owner never
    // finished the form. Treating that as done is how a merchant gets a "you're
    // ready" email and a failed drop.
    const result = assessOnboarding(account({ details_submitted: false }));
    expect(result.state).toBe('INCOMPLETE');
    expect(result.onboardingComplete).toBe(false);
  });

  it('is ACTION_REQUIRED when Stripe sets a disabled_reason and nothing works yet', () => {
    const result = assessOnboarding(
      account({
        charges_enabled: false,
        payouts_enabled: false,
        disabled_reason: 'requirements.past_due',
        requirements: { currently_due: ['individual.id_number'], past_due: ['individual.id_number'] },
      }),
    );
    expect(result.state).toBe('ACTION_REQUIRED');
    expect(result.disabledReason).toBe('requirements.past_due');
    expect(result.canAcceptPayments).toBe(false);
  });

  it('is RESTRICTED when a previously-ready account is disabled', () => {
    // Capabilities still on, but Stripe has flagged the account. Must not be
    // allowed to publish: the flag means Stripe intends to stop paying out.
    const result = assessOnboarding(
      account({ disabled_reason: 'rejected.fraud', requirements: { currently_due: [] } }),
    );
    expect(result.state).toBe('RESTRICTED');
    expect(result.onboardingComplete).toBe(false);
    expect(result.canAcceptPayments).toBe(false);
  });

  it('reads disabled_reason from requirements when the top level is clean', () => {
    const result = assessOnboarding(
      account({
        charges_enabled: false,
        payouts_enabled: false,
        disabled_reason: null,
        requirements: { currently_due: [], disabled_reason: 'under_review' },
      }),
    );
    expect(result.disabledReason).toBe('under_review');
    expect(result.state).toBe('ACTION_REQUIRED');
  });

  it('collects, de-duplicates and sorts outstanding requirements', () => {
    const result = assessOnboarding(
      account({
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        requirements: {
          currently_due: ['individual.dob.day', 'external_account'],
          past_due: ['individual.dob.day', 'business_profile.url'],
        },
      }),
    );
    // Sorted so the UI does not reshuffle between polls; deduped so a field that
    // is both currently and past due appears once.
    expect(result.outstandingRequirements).toEqual([
      'business_profile.url',
      'external_account',
      'individual.dob.day',
    ]);
  });

  it('reports no outstanding requirements once READY', () => {
    expect(assessOnboarding(account()).outstandingRequirements).toEqual([]);
  });

  it('never marks a merchant ACTIVE on anything but READY', () => {
    const nonReady = [
      null,
      account({ charges_enabled: false }),
      account({ payouts_enabled: false }),
      account({ details_submitted: false }),
      account({ disabled_reason: 'rejected.other' }),
    ];
    for (const snapshot of nonReady) {
      expect(assessOnboarding(snapshot).merchantStatus).not.toBe('ACTIVE');
    }
  });
});

describe('canPublishDrop', () => {
  it('allows publishing only from READY', () => {
    expect(canPublishDrop(assessOnboarding(account()))).toBe(true);
  });

  it('blocks every non-READY state', () => {
    const blocked = [
      null,
      account({ charges_enabled: false }),
      account({ payouts_enabled: false }),
      account({ details_submitted: false }),
      account({ disabled_reason: 'rejected.fraud' }),
    ];
    for (const snapshot of blocked) {
      expect(canPublishDrop(assessOnboarding(snapshot))).toBe(false);
    }
  });
});

describe('onboardingMessage', () => {
  it('gives every state a sentence and never leaks Stripe vocabulary', () => {
    const states = [
      null,
      account({ charges_enabled: false }),
      account({ disabled_reason: 'requirements.past_due' }),
      account({ disabled_reason: 'rejected.fraud' }),
      account(),
    ];
    for (const snapshot of states) {
      const message = onboardingMessage(assessOnboarding(snapshot));
      expect(message.length).toBeGreaterThan(10);
      // A merchant reading "individual.verification.document" learns nothing.
      expect(message).not.toMatch(/currently_due|past_due|individual\.|acct_/);
    }
  });
});
