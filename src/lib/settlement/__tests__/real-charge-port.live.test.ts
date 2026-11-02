import 'dotenv/config';

import { describe, expect, it } from 'vitest';

import { forMerchant, isStripeConfigured, platform } from '@/lib/payments/stripe';

/**
 * The live confirmation for the real charge port — design §9 T05.
 *
 * ## What this proves that nothing else can
 *
 * `settle.test.ts` proves the *sequencing* against a fake. It cannot prove the
 * fake describes Stripe, and `real-charge-port.ts` has never been executed. This
 * file is the only evidence that will ever exist, and until it runs, a capture
 * failure must be treated as that module's bug before it is treated as the
 * diner's.
 *
 * ## Why it skips with a named reason
 *
 * No `STRIPE_SECRET_KEY` exists in this environment, so the assertions cannot run.
 * `describe.skipIf` with a reason printed at collection time is chosen over
 * `it.todo` or a silently-passing stub: **a green suite must never be readable as
 * "capture is verified against Stripe"**. If this file reports "skipped", the
 * answer to "does capture work?" is still "nobody knows".
 *
 * ## Why the port is imported dynamically
 *
 * `real-charge-port.ts` imports `server-only`, which throws outside a React Server
 * Component graph — that is the isolation property §9 T05 relies on, and it is
 * exactly why the import cannot be static here either. It is inside the test body,
 * so it never evaluates while the suite is skipped.
 *
 * ## What it costs to run
 *
 * Test-mode money on a throwaway Express account. `isTestMode` is asserted before
 * any charge. The account is left behind (Stripe has no account delete) and its id
 * is printed for cleanup.
 */

const REASON =
  'T05 not verified: STRIPE_SECRET_KEY absent. Run with a test-mode key (sk_test_...) ' +
  'to make the first real capture — until then real-charge-port.ts is unexecuted code.';

const canRun = isStripeConfigured() && (process.env.STRIPE_SECRET_KEY ?? '').includes('_test_');

describe.skipIf(!canRun)(`the real charge port (${REASON})`, () => {
  it('captures a manual PaymentIntent, then refunds it with the application fee reversed', async () => {
    const { realChargePort } = await import('../real-charge-port');

    const account = await platform().accounts.create({
      type: 'express',
      country: 'CA',
      email: 'm5-settlement+connect@example.test',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { name: 'M5 settlement probe' },
      metadata: { purpose: 'm5-real-charge-port-confirmation' },
    });
    // Printed for cleanup: Stripe cannot delete an account, only close it.
    process.stdout.write(`created connected account ${account.id} for the M5 probe\n`);

    const intent = await forMerchant(account.id).paymentIntents.create({
      amount: 1112,
      currency: 'cad',
      payment_method: 'pm_card_visa',
      confirm: true,
      // The whole design assumes a manual capture: the authorisation is taken at
      // join time and the capture happens at the cutoff, or never.
      capture_method: 'manual',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    const port = realChargePort();

    const captured = await port.capture({
      participantId: 'live-probe',
      dropId: 'live-probe',
      stripeAccountId: account.id,
      paymentIntentId: intent.id,
      amountCents: 1112,
      // roundHalfUp(platformFeeAt(1112)) = 89
      platformFeeCents: 89,
      idempotencyKey: 'capture:live-probe',
    });

    expect(captured.status).toBe('CAPTURED');
    if (captured.status !== 'CAPTURED') {
      throw new Error('expected a capture');
    }

    // The second call with the same key must return the same charge, not a new one.
    const replayed = await port.capture({
      participantId: 'live-probe',
      dropId: 'live-probe',
      stripeAccountId: account.id,
      paymentIntentId: intent.id,
      amountCents: 1112,
      platformFeeCents: 89,
      idempotencyKey: 'capture:live-probe',
    });
    expect(replayed).toEqual(captured);

    const refunded = await port.refund({
      participantId: 'live-probe',
      stripeAccountId: account.id,
      chargeId: captured.chargeId,
      amountCents: 1112,
      platformFeeCents: 89,
      // ADR-001 §3.2: not optional, and the type refuses `false`.
      reverseApplicationFee: true,
      idempotencyKey: 'refund:live-probe',
    });

    expect(refunded.status).toBe('REFUNDED');
  });

  it('cancels an authorisation, and reports an already-cancelled one as ALREADY_EXPIRED', async () => {
    const { realChargePort } = await import('../real-charge-port');

    const account = await platform().accounts.create({
      type: 'express',
      country: 'CA',
      email: 'm5-settlement-void+connect@example.test',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { name: 'M5 void probe' },
      metadata: { purpose: 'm5-real-charge-port-void-confirmation' },
    });

    const intent = await forMerchant(account.id).paymentIntents.create({
      amount: 1112,
      currency: 'cad',
      payment_method: 'pm_card_visa',
      confirm: true,
      capture_method: 'manual',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    const port = realChargePort();
    const request = {
      participantId: 'live-void',
      stripeAccountId: account.id,
      paymentIntentId: intent.id,
      idempotencyKey: 'void:live-void',
    };

    expect(await port.voidAuthorization(request)).toEqual({ status: 'VOIDED' });
    // A second cancel of the same intent is a terminal answer, not an exception:
    // the diner's hold is gone either way.
    expect(await port.voidAuthorization({ ...request, idempotencyKey: 'void:live-void:again' })).toEqual({
      status: 'ALREADY_EXPIRED',
    });
  });
});
