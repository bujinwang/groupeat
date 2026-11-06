/**
 * Proves — or fails to prove — that the real Stripe charge port works, against
 * real Stripe in test mode.
 *
 *   npx tsx --conditions=react-server scripts/verify-stripe.ts
 *   npx tsx --conditions=react-server scripts/verify-stripe.ts --dry
 *
 * ## Why this exists
 *
 * `src/lib/settlement/real-charge-port.ts` carries the exact header
 * `real-charge-port.ts` and `real-payment-port.ts` carry: *THIS IMPLEMENTATION HAS
 * NEVER BEEN EXECUTED AGAINST STRIPE*. It is transcribed from the API docs. The
 * only evidence it works will be the first test-mode capture, and until that run
 * a capture failure must be treated as this module's bug before it is treated as
 * the diner's — ADR-001 §4, because `on_behalf_of` did not do what the PRD said.
 *
 * `real-charge-port.live.test.ts` already encodes the exact steps, but it is a
 * *test* that **skips with a named reason** whenever `STRIPE_SECRET_KEY` is
 * absent — which it always is here. A skipped test cannot be run on demand with
 * the user's keys; this script can. It is the smallest thing that can end the
 * "never executed" status for the money seam, the same role `verify-sms.ts`
 * fills for Twilio.
 *
 * ## What it actually exercises
 *
 * Not the SDK directly — the *real production port*: it creates a throwaway CA
 * express account, opens a manual-capture `PaymentIntent` on it, then drives it
 * through `realChargePort()` exactly as the cutoff tick would:
 *
 *   1. `capture()`  — the FR-403 / design §9 T05 path, with the application fee
 *      attached at capture (ADR-001 §3.2), scoped to the connected account via
 *      `forMerchant()`.
 *   2. `capture()` again with the **same idempotency key** — must return the
 *      same charge, not a second one (the §4.2 retry property).
 *   3. `refund()`   — with `reverseApplicationFee: true`, the ADR-001 §3.2 rule
 *      that the platform fee must be returned on refund.
 *
 * A green run is therefore evidence that the production capture/refund code
 * actually talks to Stripe correctly — not merely that the SDK accepts our
 * arguments (which `stripe-mock` already proves).
 *
 * ## What it costs and what it touches
 *
 * One throwaway CA **express** account (Stripe cannot delete accounts, only
 * close them — its id is printed for the user to close). Test-mode money: a
 * 1112-cent CAD authorisation, captured, then fully refunded, so it nets to
 * zero. No row is written to the app's database. It is not imported by the app.
 *
 * ## Why `--conditions=react-server`
 *
 * `real-charge-port.ts` imports `server-only`, which throws outside the React
 * server graph. The guard is correct and stays; this flag resolves the module
 * the way a Server Component does, which is the only context it is meant to run
 * in — and it is why the port is reached by dynamic `await import()` here, never
 * a static import.
 */
import 'dotenv/config';

import { forMerchant, isStripeConfigured, isTestMode, platform } from '../src/lib/payments/stripe';

/**
 * The single amount/account pair the live test uses, repeated here so two runs
 * are comparable. `roundHalfUp(platformFeeAt(1112))` is 89, matching the test.
 */
const PROBE_AMOUNT_CENTS = 1112;
const PLATFORM_FEE_CENTS = 89;
const CURRENCY = 'cad';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');

  // A dry run is the one case where missing credentials is fine — it never
  // reaches the provider. It shows exactly what the script will do, so the user
  // can confirm the plan before spending a test-mode cent.
  if (!isStripeConfigured()) {
    if (dryRun) {
      printPlan('Dry run: no STRIPE_SECRET_KEY present, so nothing was sent.\n' +
        'That is expected for --dry. Set STRIPE_SECRET_KEY (sk_test_…) in .env to run for real.');
      return;
    }
    fail(
      'STRIPE_SECRET_KEY must be set in .env to run a live verification.\n' +
        'It must be a test-mode key (sk_test_…); the script refuses a live key on purpose.\n' +
        'See .env.example. A fabricated or live key is worse than the honest skip.',
    );
  }

  if (!isTestMode()) {
    fail(
      'STRIPE_SECRET_KEY is present but is not a test-mode key (sk_test_… / rk_test_…).\n' +
        'This script creates real charges. It refuses to run against live keys.',
    );
  }

  if (dryRun) {
    printPlan('Dry run: credentials look like a test key, but nothing was sent.\n' +
      'Run without --dry to create the probe account and run the capture/refund.');
    return;
  }

  // From here on we are talking to Stripe test mode. The port decides whether it
  // trusts its own constructor guard; we import it dynamically so `server-only`
  // resolves under the react-server condition set by the npm script.
  const { realChargePort } = await import('../src/lib/settlement/real-charge-port');

  process.stdout.write('\n--- creating throwaway CA express account ---\n');
  const account = await platform().accounts.create({
    type: 'express',
    country: 'CA',
    email: 'stripe-verify+connect@example.test',
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_profile: { name: 'stripe-verify probe' },
    metadata: { purpose: 'stripe-verify-live-smoke' },
  });
  process.stdout.write(`created connected account ${account.id} — close it after the run\n`);

  process.stdout.write('--- opening manual-capture PaymentIntent ---\n');
  const intent = await forMerchant(account.id).paymentIntents.create({
    amount: PROBE_AMOUNT_CENTS,
    currency: CURRENCY,
    payment_method: 'pm_card_visa',
    confirm: true,
    capture_method: 'manual',
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  process.stdout.write(`intent ${intent.id} created (${intent.status})\n`);

  const port = realChargePort();

  process.stdout.write('--- realChargePort().capture() ---\n');
  const captured = await port.capture({
    participantId: 'stripe-verify',
    dropId: 'stripe-verify',
    stripeAccountId: account.id,
    paymentIntentId: intent.id,
    amountCents: PROBE_AMOUNT_CENTS,
    platformFeeCents: PLATFORM_FEE_CENTS,
    idempotencyKey: 'capture:stripe-verify',
  });

  if (captured.status !== 'CAPTURED') {
    fail(`capture returned ${captured.status} — real-charge-port.ts did not capture as designed.`);
  }
  process.stdout.write(`captured: charge ${captured.chargeId}\n`);

  process.stdout.write('--- replay capture with same idempotency key ---\n');
  const replayed = await port.capture({
    participantId: 'stripe-verify',
    dropId: 'stripe-verify',
    stripeAccountId: account.id,
    paymentIntentId: intent.id,
    amountCents: PROBE_AMOUNT_CENTS,
    platformFeeCents: PLATFORM_FEE_CENTS,
    idempotencyKey: 'capture:stripe-verify',
  });
  if (replayed.status !== 'CAPTURED' || replayed.chargeId !== captured.chargeId) {
    fail('idempotent replay did not return the same charge — the §4.2 retry property is broken.');
  }
  process.stdout.write('replay returned the same charge — idempotency holds\n');

  process.stdout.write('--- realChargePort().refund({ reverseApplicationFee: true }) ---\n');
  const refunded = await port.refund({
    participantId: 'stripe-verify',
    stripeAccountId: account.id,
    chargeId: captured.chargeId,
    amountCents: PROBE_AMOUNT_CENTS,
    platformFeeCents: PLATFORM_FEE_CENTS,
    reverseApplicationFee: true,
    idempotencyKey: 'refund:stripe-verify',
  });
  if (refunded.status !== 'REFUNDED') {
    fail(`refund returned ${refunded.status} — the application-fee reversal path did not run.`);
  }
  process.stdout.write(
    `refunded: ${refunded.refundId}, application fee reversed ${refunded.applicationFeeRefundCents} cents\n`,
  );

  process.stdout.write('\n--- result ---\n');
  process.stdout.write(
    'VERIFIED against Stripe test mode. real-charge-port.ts captured and refunded a\n' +
      'real test-mode charge, scoped to the connected account, with the platform fee\n' +
      'reversed — the exact path the cutoff tick uses. The "never executed" header in\n' +
      'that file can now be removed.\n',
  );
  process.stdout.write(`\nClose the probe account ${account.id} in the Stripe Dashboard when done.\n`);
}

function printPlan(note: string): void {
  process.stdout.write('\n--- plan (no network) ---\n');
  process.stdout.write(`1. create a CA express account (${'express'}, country CA)\n`);
  process.stdout.write(
    `2. open a manual-capture PaymentIntent: ${PROBE_AMOUNT_CENTS} ${CURRENCY}, pm_card_visa\n`,
  );
  process.stdout.write('3. realChargePort().capture() with platformFee=' + PLATFORM_FEE_CENTS + '\n');
  process.stdout.write('4. replay capture with the same idempotency key (must return same charge)\n');
  process.stdout.write('5. realChargePort().refund({ reverseApplicationFee: true })\n');
  process.stdout.write(`\n${note}\n`);
}

await main();
