import { describe, expect, it } from 'vitest';

import {
  type CaptureRequest,
  captureKey,
  isPaymentProviderUnavailable,
  PaymentProviderUnavailableError,
  type RefundRequest,
  refundKey,
  type VoidRequest,
  voidKey,
} from '../charge-port';
import { fakeChargePort } from '../fake-charge-port';

/**
 * The fake is a test double, so it is itself under test.
 *
 * Every assertion here is a property `settle.test.ts` silently assumes. If the
 * fake stopped deduping by idempotency key, the retry tests would still pass —
 * they would just stop proving anything. This file is what makes those tests
 * meaningful.
 */

function captureRequest(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    participantId: 'p1',
    dropId: 'd1',
    stripeAccountId: 'acct_test_1',
    paymentIntentId: 'pi_1',
    amountCents: 2224,
    platformFeeCents: 178,
    idempotencyKey: captureKey('p1'),
    ...overrides,
  };
}

describe('capture', () => {
  it('replays the same charge for the same idempotency key, and still records both calls', async () => {
    const fake = fakeChargePort();

    const first = await fake.capture(captureRequest());
    const second = await fake.capture(captureRequest());

    expect(first.status).toBe('CAPTURED');
    expect(second.status).toBe('CAPTURED');
    if (first.status !== 'CAPTURED' || second.status !== 'CAPTURED') {
      throw new Error('unreachable');
    }
    // One charge, two calls: this is what makes the retry tests in settle.test.ts
    // prove "no second charge" rather than "the fake cannot make two".
    expect(second.chargeId).toBe(first.chargeId);
    expect(fake.calls).toHaveLength(2);
  });

  it('makes a second charge for a second participant', async () => {
    const fake = fakeChargePort();

    const a = await fake.capture(captureRequest({ participantId: 'p1' }));
    const b = await fake.capture(
      captureRequest({ participantId: 'p2', idempotencyKey: captureKey('p2') }),
    );

    if (a.status !== 'CAPTURED' || b.status !== 'CAPTURED') {
      throw new Error('expected two captures');
    }
    expect(b.chargeId).not.toBe(a.chargeId);
  });

  it('reports a decline as data, not as an exception', async () => {
    const fake = fakeChargePort({ declineParticipantIds: ['p2'] });

    const outcome = await fake.capture(
      captureRequest({ participantId: 'p2', idempotencyKey: captureKey('p2') }),
    );

    // §8.5 expects 2–5 % of captures to decline. If this threw, every settlement
    // test would have to wrap a normal business outcome in try/catch.
    expect(outcome).toEqual({ status: 'DECLINED', declineCode: 'card_declined' });
  });

  it('replays a decline for a retried key, as Stripe does', async () => {
    const fake = fakeChargePort({ declineParticipantIds: ['p1'], declineCode: 'insufficient_funds' });

    await fake.capture(captureRequest());
    const second = await fake.capture(captureRequest());

    expect(second).toEqual({ status: 'DECLINED', declineCode: 'insufficient_funds' });
  });

  it('throws once for an unavailable participant and then succeeds', async () => {
    const fake = fakeChargePort({ unavailableOnceFor: ['p1'] });

    let caught: unknown;
    try {
      await fake.capture(captureRequest());
    } catch (error) {
      caught = error;
    }

    expect(isPaymentProviderUnavailable(caught)).toBe(true);
    expect((caught as PaymentProviderUnavailableError).reason).toBe('timeout');

    // The retry must succeed: a fake that always fails would make the
    // "resume on the next tick" tests unprovable.
    const retry = await fake.capture(captureRequest());
    expect(retry.status).toBe('CAPTURED');
    expect(fake.calls).toHaveLength(2);
  });
});

describe('voidAuthorization', () => {
  it('voids, then reports the same void for a retried key', async () => {
    const fake = fakeChargePort();
    const request: VoidRequest = {
      participantId: 'p1',
      stripeAccountId: 'acct_test_1',
      paymentIntentId: 'pi_1',
      idempotencyKey: voidKey('p1'),
    };

    expect(await fake.voidAuthorization(request)).toEqual({ status: 'VOIDED' });
    expect(await fake.voidAuthorization(request)).toEqual({ status: 'VOIDED' });
  });

  it('reports an already-lapsed authorisation without throwing', async () => {
    // Stripe answers "this PaymentIntent is not capturable" for a lapsed auth.
    // That is terminal and not a failure: the diner's hold is gone either way.
    const fake = fakeChargePort({ expiredPaymentIntentIds: ['pi_gone'] });

    const outcome = await fake.voidAuthorization({
      participantId: 'p9',
      stripeAccountId: 'acct_test_1',
      paymentIntentId: 'pi_gone',
      idempotencyKey: voidKey('p9'),
    });

    expect(outcome).toEqual({ status: 'ALREADY_EXPIRED' });
  });
});

describe('refund', () => {
  const request: RefundRequest = {
    participantId: 'p1',
    stripeAccountId: 'acct_test_1',
    chargeId: 'ch_fake_1',
    amountCents: 2224,
    platformFeeCents: 178,
    reverseApplicationFee: true,
    idempotencyKey: refundKey('p1'),
  };

  it('refunds once and reports ALREADY_REFUNDED for a second, differently-keyed attempt', async () => {
    const fake = fakeChargePort();
    // The fake only knows a charge's amount and fee if it captured it, so this
    // refunds a charge the fake created — which is also the real sequence.
    const captured = await fake.capture({
      participantId: 'p1',
      dropId: 'drop-1',
      stripeAccountId: 'acct_test_1',
      paymentIntentId: 'pi_1',
      amountCents: 2224,
      platformFeeCents: 178,
      idempotencyKey: captureKey('p1'),
    });
    expect(captured.status).toBe('CAPTURED');
    const chargeId = captured.status === 'CAPTURED' ? captured.chargeId : '';

    const first = await fake.refund({ ...request, chargeId });
    // A different key for the same charge: our own retry is keyed, but a second
    // worker with a stale view could still ask twice. Stripe answers
    // ALREADY_REFUNDED, and settle() must treat that as success.
    const second = await fake.refund({ ...request, chargeId, idempotencyKey: 'refund:p1:again' });

    expect(first.status).toBe('REFUNDED');
    // A full refund reverses the whole fee, and the second call reports the same
    // reversal rather than a fresh zero — the ledger writes it from this number.
    expect(first).toEqual({ status: 'REFUNDED', refundId: expect.any(String), applicationFeeRefundCents: 178 });
    expect(second).toEqual({ status: 'ALREADY_REFUNDED', applicationFeeRefundCents: 178 });
  });

  it('reverses a proportional slice of the fee on a partial refund', async () => {
    const fake = fakeChargePort();
    const captured = await fake.capture({
      participantId: 'p1',
      dropId: 'drop-1',
      stripeAccountId: 'acct_test_1',
      paymentIntentId: 'pi_1',
      amountCents: 1112,
      platformFeeCents: 89,
      idempotencyKey: captureKey('p1'),
    });
    const chargeId = captured.status === 'CAPTURED' ? captured.chargeId : '';

    const half = await fake.refund({ ...request, chargeId, amountCents: 556 });

    // 89 × 556 / 1112 = 44.5 → 45 under round-half-up. NOT 89: a partial refund
    // that reversed the whole fee would overstate what we returned by 44 cents.
    expect(half.applicationFeeRefundCents).toBe(45);
  });

  it('models a reversal that cannot be read back, so the retry path is testable', async () => {
    const fake = fakeChargePort({ unreadableReversalForChargeIds: ['ch_known'] });

    await expect(
      fake.refund({ ...request, chargeId: 'ch_known' }),
    ).rejects.toThrow(PaymentProviderUnavailableError);
  });

  it('can be made to fail once, so the "refund failed, stay LOCKED" path is testable', async () => {
    const fake = fakeChargePort({ refundUnavailableOnceFor: ['p1'] });

    await expect(fake.refund(request)).rejects.toThrow(PaymentProviderUnavailableError);
    expect((await fake.refund(request)).status).toBe('REFUNDED');
  });

  it('refuses at compile time a refund that would keep our application fee', () => {
    // ADR-001 §3.2: under a direct charge the application fee is not reversed
    // automatically. A `boolean` field would let a caller pass `false` and
    // quietly keep our fee on a drop that never ran, so the field is the literal
    // `true` and the type refuses.
    const request: RefundRequest = {
      participantId: 'p1',
      stripeAccountId: 'acct_test_1',
      chargeId: 'ch_fake_1',
      amountCents: 2224,
      platformFeeCents: 178,
      // @ts-expect-error `reverseApplicationFee` is the literal `true`; `false` must not compile.
      reverseApplicationFee: false,
      idempotencyKey: refundKey('p1'),
    };

    expect(request.reverseApplicationFee).toBe(false);
  });
});
