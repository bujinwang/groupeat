import { describe, expect, it } from 'vitest';

import { fakeJoinPaymentPort } from '../fake-payment-port';
import { joinKey } from '../payment-port';

/**
 * The fake's own behaviour.
 *
 * A fake that is wrong is worse than no fake: every test written against it
 * inherits the mistake and reports it as a pass. These assertions pin the two
 * properties the join tests rely on — idempotent replay, and a decline that is an
 * outcome rather than an exception.
 */

function request(overrides: Partial<Parameters<ReturnType<typeof fakeJoinPaymentPort>['createJoinAuthorisation']>[0]> = {}) {
  return {
    dropId: 'drop-1',
    participantId: 'participant-1',
    stripeAccountId: 'acct_test',
    amountCents: 3336,
    platformFeeCents: 267,
    currency: 'cad',
    idempotencyKey: joinKey('participant-1'),
    ...overrides,
  };
}

describe('fakeJoinPaymentPort', () => {
  it('returns requires_capture and holds the money without charging it', async () => {
    const port = fakeJoinPaymentPort();

    const outcome = await port.createJoinAuthorisation(request());

    expect(outcome.status).toBe('AUTHORIZED');
    if (outcome.status !== 'AUTHORIZED') return;
    expect(outcome.providerStatus).toBe('requires_capture');
    expect(outcome.paymentIntentId).toBe('pi_fake_join_1');
    // Held, not captured: the fake has no capture method at all, which is FR-404
    // expressed as a type.
    expect(port.authorisedTotalCents()).toBe(3336);
  });

  /**
   * The property the retry tests rest on. Without it, "the retry produced one hold"
   * would be asserting something the fake cannot do wrong.
   */
  it('replays the original outcome for a repeated idempotency key', async () => {
    const port = fakeJoinPaymentPort();

    const first = await port.createJoinAuthorisation(request());
    const second = await port.createJoinAuthorisation(request());

    expect(port.calls).toHaveLength(2);
    expect(first.status).toBe('AUTHORIZED');
    expect(second.status).toBe('AUTHORIZED');
    if (first.status !== 'AUTHORIZED' || second.status !== 'AUTHORIZED') return;

    // Same intent, and the card is held once.
    expect(second.paymentIntentId).toBe(first.paymentIntentId);
    expect(port.authorisedCount()).toBe(1);
    expect(port.authorisedTotalCents()).toBe(3336);
  });

  it('creates a second hold for a different idempotency key', async () => {
    // The negative of the test above: the key, not the participant, is what dedupes.
    const port = fakeJoinPaymentPort();

    await port.createJoinAuthorisation(request());
    await port.createJoinAuthorisation(
      request({ idempotencyKey: 'join:something-else', participantId: 'participant-2' }),
    );

    expect(port.authorisedCount()).toBe(2);
    expect(port.authorisedTotalCents()).toBe(6672);
  });

  it('reports a decline as an outcome, not an exception', async () => {
    const port = fakeJoinPaymentPort({ declineParticipantIds: ['participant-1'] });

    const outcome = await port.createJoinAuthorisation(request());

    expect(outcome.status).toBe('DECLINED');
    if (outcome.status !== 'DECLINED') return;
    expect(outcome.declineCode).toBe('card_declined');
    // Nothing is held for a declined card.
    expect(port.authorisedCount()).toBe(0);
  });

  it('replays a decline rather than retrying the card', async () => {
    // A declined card must not get a second attempt at the network on retry.
    const port = fakeJoinPaymentPort({ declineParticipantIds: ['participant-1'] });

    await port.createJoinAuthorisation(request());
    const second = await port.createJoinAuthorisation(request());

    expect(second.status).toBe('DECLINED');
    expect(port.calls).toHaveLength(2);
    expect(port.authorisedCount()).toBe(0);
  });

  it('throws a retryable error once for an unavailable participant', async () => {
    const port = fakeJoinPaymentPort({ unavailableOnceFor: ['participant-1'] });

    await expect(port.createJoinAuthorisation(request())).rejects.toThrow(/timed out/);

    // The second attempt — with the same key — succeeds.
    const retry = await port.createJoinAuthorisation(request());
    expect(retry.status).toBe('AUTHORIZED');
    expect(port.authorisedCount()).toBe(1);
    // Two calls, one hold: the unknown state resolved to one authorisation.
    expect(port.calls).toHaveLength(2);
  });

  it('keeps throwing for a participant whose provider is down', async () => {
    const port = fakeJoinPaymentPort({ unavailableAlwaysFor: ['participant-1'] });

    await expect(port.createJoinAuthorisation(request())).rejects.toThrow(/unavailable/);
    await expect(port.createJoinAuthorisation(request())).rejects.toThrow(/unavailable/);

    expect(port.authorisedCount()).toBe(0);
  });
});
