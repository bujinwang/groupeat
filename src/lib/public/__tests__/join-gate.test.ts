import { describe, expect, it } from 'vitest';

import { resolveJoinGate, type JoinGateInput } from '../join-gate';

/**
 * The deal page's Join gate.
 *
 * The property worth testing is not "it returns false" — it is that **neither gate
 * alone can open the button**. A single boolean had that failure mode built in: a
 * keyed deployment would look ready even though no card had ever been held, which is
 * exactly the state this repo is in, so the failure would have been invisible until a
 * diner tapped a button that led to a form with no card field.
 */

function input(overrides: Partial<JoinGateInput> = {}): JoinGateInput {
  return {
    canJoin: true,
    stripeConfigured: true,
    provenLive: true,
    ...overrides,
  };
}

describe('resolveJoinGate', () => {
  it('offers the link only when the drop is open, a key exists and a live run happened', () => {
    expect(resolveJoinGate(input())).toEqual({ offerJoin: true, blockedBy: null });
  });

  it('refuses on a deployment with no publishable key, and says so', () => {
    // Capability. This is the state the slice actually ships in.
    expect(resolveJoinGate(input({ stripeConfigured: false }))).toEqual({
      offerJoin: false,
      blockedBy: 'PAYMENTS',
    });
  });

  it('refuses when payments exist but have never been proven against Stripe', () => {
    // The subtle one, and the reason this is a function. A key is present, so the
    // old single boolean would have said "ready" — but no card has ever been held.
    expect(resolveJoinGate(input({ provenLive: false }))).toEqual({
      offerJoin: false,
      blockedBy: 'UNPROVEN',
    });
  });

  it('blames the drop, not the build, when the drop cannot be joined', () => {
    // `blockedBy: null` is load-bearing: the deal page renders its own copy for
    // SOLD_OUT / FAILED / closed, and a build-level message here would replace it
    // with something less specific and less true.
    expect(resolveJoinGate(input({ canJoin: false }))).toEqual({
      offerJoin: false,
      blockedBy: null,
    });
  });

  it('never opens the button when every gate is shut', () => {
    const gate = resolveJoinGate({ canJoin: false, stripeConfigured: false, provenLive: false });
    expect(gate.offerJoin).toBe(false);
  });

  it('reports capability ahead of evidence, because it is the verifiable reason', () => {
    // Both shut. A diner can check "this site cannot take a card"; they cannot check
    // "this build was never tested against Stripe". Prefer the one that is useful.
    expect(resolveJoinGate(input({ stripeConfigured: false, provenLive: false })).blockedBy).toBe(
      'PAYMENTS',
    );
  });
});

describe('the gate cannot be opened by configuration alone', () => {
  /**
   * The regression this guards, stated as a property: with a key present and the
   * drop open, the evidence gate is still the only thing standing between a diner
   * and a card form. If someone ever collapses the two flags again, this fails.
   */
  it('keeps the button shut on keys alone', () => {
    const looksReady = input({ provenLive: false });
    expect(looksReady.stripeConfigured).toBe(true);
    expect(resolveJoinGate(looksReady).offerJoin).toBe(false);
  });
});
