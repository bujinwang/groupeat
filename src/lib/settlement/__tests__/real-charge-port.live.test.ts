import 'dotenv/config';

import { describe, expect, it } from 'vitest';

import { forMerchant, isStripeConfigured, platform } from '@/lib/payments/stripe';

/**
 * The live confirmation for the real charge port — design §9 T05.
 *
 * ## Dated correction — 2026-11-07: the port is no longer unproven
 *
 * This docblock used to say `real-charge-port.ts` "has never been executed" and
 * that this file "is the only evidence that will ever exist". Both are superseded.
 * `scripts/verify-stripe.ts` ran `capture()`, an idempotent replay, and
 * `refund({ reverseApplicationFee: true })` against real Stripe test mode first
 * on 2026-11-06 (charge-port-only script, recorded with its `pi_` / `ch_` / `re_`
 * ids in the workspace daily log `2026-11-06.md`), and then as the second half of
 * **all three** chained `/join` runs on 2026-11-07 — `/tmp/stripe_join_live.log`,
 * `/tmp/stripe_join_live_run2.log`, `/tmp/stripe_join_final.log`. Each printed the
 * `VERIFIED` banner. The "treat a capture failure as this module's bug first"
 * discipline from ADR-001 §4 still applies to future changes. The standing live
 * proof is that script, not this suite.
 *
 * ## Why this suite is explicitly opt-in (and was never runnable under `vitest`)
 *
 * `.env` gained an `sk_test_…` key on 2026-11-06 17:01 for the Tier 2 live work.
 * The old `canRun` used *key presence* as a proxy for "the operator opted into a
 * live run"; with the key present it flipped true, the tests below stopped
 * skipping, and plain `vitest run` failed — `real-charge-port.ts` imports
 * `server-only`, which throws under Vitest's default (client) condition. The
 * standalone script works because `npm run stripe:verify` passes
 * `--conditions=react-server`. A second blocker: this file creates a throwaway
 * Express account with `platform().accounts.create()`, which this platform cannot
 * do (Connect is not signed up) — the script's `STRIPE_CONNECTED_ACCOUNT_ID`
 * override exists for exactly that reason.
 *
 * Live provider calls are therefore gated on an explicit `RUN_STRIPE_LIVE_TESTS=1`,
 * not on a key merely being present. Key presence is not consent to make network
 * calls in the unit gate. **A green suite must still never be readable as
 * "capture is verified against Stripe"**; the named skip reason says so.
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
  'live provider calls are opt-in: set RUN_STRIPE_LIVE_TESTS=1 with a test-mode key; ' +
  'the standing T05 proof is `npm run stripe:verify` (verified 2026-11-06/07).';

// Key presence alone is not consent. See the dated correction above.
const canRun =
  process.env.RUN_STRIPE_LIVE_TESTS === '1' &&
  isStripeConfigured() &&
  (process.env.STRIPE_SECRET_KEY ?? '').includes('_test_');

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
