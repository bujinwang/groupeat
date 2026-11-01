/**
 * Stripe Connect onboarding as a state machine, with no Stripe dependency.
 *
 * ## Why the decision logic is separated from the API call
 *
 * FR-102 says `onboardingComplete = true` only after Stripe reports
 * `charges_enabled && payouts_enabled`. That is a rule about **our** state, not
 * about Stripe's API, and getting it wrong is expensive in a specific way: a
 * merchant who appears ready to take money but whose account is disabled will
 * have every drop fail at capture, after diners have already been authorised and
 * been told they were in.
 *
 * So the rule lives here as a pure function over the fields Stripe returns. That
 * makes it testable against every combination of `charges_enabled`,
 * `payouts_enabled`, `details_submitted` and `requirements.currently_due` without
 * a network, a key, or an account — including the combinations that are hard to
 * produce on demand and therefore never get tested against the live API.
 *
 * `src/lib/payments/account.ts` is the thin adapter that fetches the account and
 * calls this.
 */

/** The subset of a Stripe `Account` object this logic reads. */
export type StripeAccountSnapshot = {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  /** Stripe's machine-readable reason the account cannot transact, if any. */
  disabled_reason?: string | null;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
};

/**
 * What the merchant can do, from GroupEat's point of view.
 *
 * - `NOT_STARTED` — no connected account yet.
 * - `INCOMPLETE` — account exists, Stripe still wants information.
 * - `ACTION_REQUIRED` — Stripe has disabled something; the merchant must act.
 * - `READY` — can take money. The only state in which a drop may be published.
 * - `RESTRICTED` — was ready, is no longer. Treated as unsafe for new drops.
 */
export type OnboardingState =
  | 'NOT_STARTED'
  | 'INCOMPLETE'
  | 'ACTION_REQUIRED'
  | 'READY'
  | 'RESTRICTED';

export type OnboardingAssessment = {
  state: OnboardingState;
  /** Maps to `Merchant.onboardingComplete`. True only in `READY`. */
  onboardingComplete: boolean;
  /** Maps to `Merchant.status`. */
  merchantStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  /** True when a published drop could actually be captured. */
  canAcceptPayments: boolean;
  /**
   * Fields Stripe is waiting on, for the onboarding UI. Empty when `READY`.
   * Names only — never values, and never rendered to a diner.
   */
  outstandingRequirements: string[];
  /** Stripe's own reason, surfaced to ops so they can act without opening Stripe. */
  disabledReason: string | null;
};

/** Requirements Stripe reports across both the account and its `requirements` block. */
function collectOutstanding(account: StripeAccountSnapshot): string[] {
  const requirements = account.requirements ?? {};
  const due = requirements.currently_due ?? [];
  const past = requirements.past_due ?? [];
  // De-duplicated and sorted so the UI does not reshuffle between polls.
  return [...new Set([...due, ...past])].sort();
}

/**
 * The rule (FR-102), stated once.
 *
 * `READY` requires **all** of:
 *   - `charges_enabled` — Stripe will accept a charge;
 *   - `payouts_enabled` — the merchant can actually receive the money;
 *   - `details_submitted` — the merchant finished the form (so a half-finished
 *     signup that Stripe pre-approves is not treated as done);
 *   - no `disabled_reason`.
 *
 * `payouts_enabled` is not redundant with `charges_enabled`. Stripe can hold one
 * without the other, and a merchant who can be charged but not paid out is
 * exactly the merchant whose drop silently strands money. FR-102 names both for
 * that reason.
 */
export function assessOnboarding(account: StripeAccountSnapshot | null): OnboardingAssessment {
  if (account === null) {
    return {
      state: 'NOT_STARTED',
      onboardingComplete: false,
      merchantStatus: 'PENDING',
      canAcceptPayments: false,
      outstandingRequirements: [],
      disabledReason: null,
    };
  }

  const outstanding = collectOutstanding(account);
  const disabledReason =
    account.disabled_reason ?? account.requirements?.disabled_reason ?? null;

  const fullyEnabled =
    account.charges_enabled &&
    account.payouts_enabled &&
    account.details_submitted &&
    disabledReason === null;

  if (fullyEnabled) {
    return {
      state: 'READY',
      onboardingComplete: true,
      merchantStatus: 'ACTIVE',
      canAcceptPayments: true,
      outstandingRequirements: [],
      disabledReason: null,
    };
  }

  // A reason set by Stripe means something is wrong beyond "not finished yet":
  // a rejected document, a prohibited business, a closed account. The merchant
  // cannot fix that by continuing the same form, so it is a different state.
  if (disabledReason !== null) {
    return {
      state: account.charges_enabled || account.payouts_enabled ? 'RESTRICTED' : 'ACTION_REQUIRED',
      onboardingComplete: false,
      merchantStatus: 'PENDING',
      canAcceptPayments: false,
      outstandingRequirements: outstanding,
      disabledReason,
    };
  }

  return {
    state: 'INCOMPLETE',
    onboardingComplete: false,
    merchantStatus: 'PENDING',
    canAcceptPayments: false,
    outstandingRequirements: outstanding,
    disabledReason: null,
  };
}

/**
 * Merchant-facing explanation, one sentence, no Stripe vocabulary.
 *
 * Deliberately not generated per-requirement: a merchant reading
 * "individual.verification.document" learns nothing, and a translation table for
 * Stripe's requirement strings would be stale within a quarter. The requirement
 * names go to **ops** (`outstandingRequirements`); the merchant gets the one
 * sentence that tells them what to do.
 */
export function onboardingMessage(assessment: OnboardingAssessment): string {
  switch (assessment.state) {
    case 'NOT_STARTED':
      return 'Set up payouts before you run a deal. It takes about five minutes.';
    case 'INCOMPLETE':
      return 'Payout setup is not finished yet. Stripe is still waiting on some details.';
    case 'ACTION_REQUIRED':
      return 'Stripe needs something from you before you can be paid. Open the payout setup to see what.';
    case 'RESTRICTED':
      return 'Payouts are paused on your account. Nothing can be charged until this is resolved.';
    case 'READY':
      return 'Payouts are set up. You can run a deal.';
  }
}

/**
 * Whether a drop may be published.
 *
 * Separate from `assessOnboarding` because it is a **precondition check at a
 * write boundary**, and M3 needs to call it from the publish action rather than
 * re-deriving `state === 'READY'` in a page component. A drop published against a
 * non-ready account is the failure mode this exists to prevent.
 */
export function canPublishDrop(assessment: OnboardingAssessment): boolean {
  return assessment.state === 'READY' && assessment.canAcceptPayments;
}
