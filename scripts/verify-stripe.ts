/**
 * Proves — or fails to prove — that both halves of the real Stripe money seam
 * work, against real Stripe in test mode: the /join hold and the cutoff capture.
 *
 *   npx tsx --conditions=react-server scripts/verify-stripe.ts
 *   npx tsx --conditions=react-server scripts/verify-stripe.ts --dry
 *   # optional: reuse an existing connected account instead of creating a throwaway:
 *   STRIPE_CONNECTED_ACCOUNT_ID=acct_1xyz npx tsx --conditions=react-server scripts/verify-stripe.ts
 *
 * ## Why this exists
 *
 * Two production ports carried the header *THIS IMPLEMENTATION HAS NEVER BEEN
 * EXECUTED AGAINST STRIPE*:
 *
 *   - `src/lib/settlement/real-charge-port.ts` — retired 2026-11-06, when this
 *     script captured and refunded a real test-mode charge.
 *   - `src/lib/join/real-payment-port.ts` — retired 2026-11-07, when this script
 *     was extended to create the hold through that port too.
 *
 * Both were transcribed from the API docs. `real-charge-port.live.test.ts` and
 * `real-payment-port.contract.test.ts` encode the steps, but the live test **skips
 * with a named reason** whenever `STRIPE_SECRET_KEY` is absent, and the contract
 * test runs against `stripe-mock` whose `POST /v1/payment_intents` fixture is
 * permanently `requires_payment_method` — so a successful authorisation is
 * unreachable there by construction. A skipped test cannot be run on demand with
 * the user's keys; this script can. It is the smallest thing that can end the
 * "never executed" status for the whole money seam, the same role
 * `verify-sms.ts` fills for Twilio.
 *
 * ## What it actually exercises
 *
 * Not the SDK directly — the *real production ports*, scoped to one connected
 * account via `forMerchant()`. The hold is created by `realJoinPaymentPort()`
 * and then captured and refunded by `realChargePort()` **on that same intent**,
 * which is exactly the handoff between /join and the cutoff tick. A green run
 * therefore proves the two halves connect, not merely that each port can talk
 * to Stripe on its own:
 *
 *   1. `createJoinAuthorisation()` — must return AUTHORIZED / `requires_capture`.
 *   2. **FR-404, "no charge at join"** — read the hold back and assert
 *      `status: requires_capture`, `capture_method: manual`, `amount_received: 0`.
 *      Note that Stripe *does* create an uncaptured `latest_charge` object at
 *      authorisation (measured in test mode 2026-11-07); "no charge" means no
 *      money was captured, not that no Charge object exists. Asserting
 *      `latest_charge === null` here would be a false failure.
 *   3. **ADR-001 §3.1, direct charges** — `platform().paymentIntents.retrieve()`
 *      cannot see the hold; it exists only on the connected account.
 *   4. **§11.5 / FR-405** — replaying the join with the *same* idempotency key
 *      returns the same intent, so a retry cannot create a second hold.
 *   5. **The decline branch** — `pm_card_chargeDeclined` must arrive as
 *      `DECLINED` with a usable decline code. `stripe-mock` could never prove
 *      this (gap 9's second item); a real test-mode decline can.
 *   6. `capture()` — FR-403 / design §9 T05, with the application fee attached
 *      at capture (ADR-001 §3.2).
 *   7. `capture()` again with the **same** idempotency key — the §4.2 retry
 *      property: the same charge, not a second one.
 *   8. `refund({ reverseApplicationFee: true })` — the platform fee is reversed.
 *
 * A green run is evidence that the production ports actually talk to Stripe
 * correctly and hand off to each other — not merely that the SDK accepts our
 * arguments (which `stripe-mock` already proves).
 *
 * ## What it costs and what it touches
 *
 * One throwaway CA **express** account when no override is set (Stripe cannot
 * delete accounts, only close them — its id is printed for the user to close).
 * Test-mode money: a 1112-cent CAD hold, captured, then fully refunded, so it
 * nets to zero. One declined confirmation attempt may leave an unusable
 * test-mode intent; no money moves on it. No row is written to the app's
 * database. It is not imported by the app.
 *
 * ## Why the idempotency keys carry a per-run nonce
 *
 * Stripe keeps an idempotency key for 24 hours and rejects its reuse with
 * different request parameters. The original script used fixed keys, which
 * meant a second run within a day could fail for a reason that had nothing to
 * do with the ports. Every key here is derived from a fresh UUID; the replay
 * checks still use one key twice *within* the run, which is the property under
 * test. This also makes two consecutive runs genuinely comparable.
 *
 * ## Using an existing connected account (skips the Connect requirement)
 *
 * If you already hold a connected account and cannot or will not enable Connect on
 * the platform, set `STRIPE_CONNECTED_ACCOUNT_ID` in the environment. The script then
 * runs both probes against that account and skips the throwaway-account creation
 * step — which is the only part that requires Connect to be signed up.
 *
 * ## Why `--conditions=react-server`
 *
 * Both ports import `server-only`, which throws outside the React server graph.
 * The guard is correct and stays; this flag resolves the modules the way a Server
 * Component does, which is the only context they are meant to run in — and it is
 * why the ports are reached by dynamic `await import()` here, never a static
 * import.
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { forMerchant, isStripeConfigured, isTestMode, platform } from '../src/lib/payments/stripe';

/**
 * The single amount/account pair the live test uses, repeated here so two runs
 * are comparable. `roundHalfUp(platformFeeAt(1112))` is 89, matching the test.
 */
const PROBE_AMOUNT_CENTS = 1112;
const PLATFORM_FEE_CENTS = 89;
const CURRENCY = 'cad';

/** Stripe's documented test PaymentMethods, not real card tokens. */
const HOLD_PAYMENT_METHOD = 'pm_card_visa';
const DECLINE_PAYMENT_METHOD = 'pm_card_chargeDeclined';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const overrideAccountId = process.env.STRIPE_CONNECTED_ACCOUNT_ID?.trim() || undefined;

  // A dry run is the one case where missing credentials is fine — it never
  // reaches the provider. It shows exactly what the script will do, so the user
  // can confirm the plan before spending a test-mode cent.
  if (!isStripeConfigured()) {
    if (dryRun) {
      printPlan(
        'Dry run: no STRIPE_SECRET_KEY present, so nothing was sent.\n' +
          'That is expected for --dry. Set STRIPE_SECRET_KEY (sk_test_…) in .env to run for real.',
        overrideAccountId,
      );
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
    printPlan(
      'Dry run: credentials look like a test key, but nothing was sent.\n' +
        'Run without --dry to create the probe account and run both probes.',
      overrideAccountId,
    );
    return;
  }

  // From here on we are talking to Stripe test mode. Both ports import
  // `server-only`; the dynamic imports resolve them under the react-server
  // condition set by the npm script.
  const { realChargePort } = await import('../src/lib/settlement/real-charge-port');
  const { realJoinPaymentPort } = await import('../src/lib/join/real-payment-port');

  let accountId: string;
  if (overrideAccountId) {
    accountId = overrideAccountId;
    process.stdout.write('\n--- using existing connected account (STRIPE_CONNECTED_ACCOUNT_ID override) ---\n');
    process.stdout.write(`account: ${accountId} — no throwaway account is created\n`);
  } else {
    process.stdout.write('\n--- creating throwaway CA express account ---\n');
    let account;
    try {
      account = await platform().accounts.create({
        type: 'express',
        country: 'CA',
        email: 'stripe-verify+connect@example.test',
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: { name: 'stripe-verify probe' },
        metadata: { purpose: 'stripe-verify-live-smoke' },
      });
    } catch (err) {
      const message = (err as { message?: string })?.message ?? '';
      if (/signed up for Connect|Connect/i.test(message)) {
        fail(
          'Could not create a throwaway connected account because Stripe Connect is not enabled\n' +
            'on this account. Two fixes: (a) enable Connect (Stripe Dashboard → stripe.com/connect,\n' +
            'or the Stripe CLI `stripe tools search enable_connect`, or Stripe MCP `EnableConnect`), or\n' +
            '(b) set STRIPE_CONNECTED_ACCOUNT_ID to an existing connected account and re-run — that\n' +
            'skips account creation entirely.',
        );
      }
      throw err;
    }
    accountId = account.id;
    process.stdout.write(`created connected account ${account.id} — close it after the run\n`);
  }

  // Fresh per run: Stripe holds idempotency keys for 24h. See the docblock.
  const nonce = randomUUID();
  const joinKey = `join:stripe-verify:${nonce}`;
  const declineKey = `join-decline:stripe-verify:${nonce}`;
  const captureKey = `capture:stripe-verify:${nonce}`;
  const refundKey = `refund:stripe-verify:${nonce}`;

  // ------------------------------------------------------------------ phase 1
  process.stdout.write('\n--- phase 1: /join hold via realJoinPaymentPort() ---\n');
  const joinPort = realJoinPaymentPort();
  const joinRequest = {
    dropId: 'stripe-verify',
    participantId: 'stripe-verify',
    stripeAccountId: accountId,
    amountCents: PROBE_AMOUNT_CENTS,
    platformFeeCents: PLATFORM_FEE_CENTS,
    paymentMethodId: HOLD_PAYMENT_METHOD,
    currency: CURRENCY,
    idempotencyKey: joinKey,
  };

  const hold = await joinPort.createJoinAuthorisation(joinRequest);
  if (hold.status !== 'AUTHORIZED') {
    fail(`join returned ${hold.status} — real-payment-port.ts did not authorise the hold.`);
  }
  if (hold.providerStatus !== 'requires_capture') {
    fail(`join reported ${hold.providerStatus}, expected "requires_capture".`);
  }
  process.stdout.write(`hold ${hold.paymentIntentId} (${hold.providerStatus})\n`);

  // FR-404: a hold is not a charge. Read it back rather than trusting the port's
  // own mapping. `latest_charge` is deliberately NOT asserted null — Stripe
  // creates an uncaptured Charge at authorisation (measured 2026-11-07).
  const holdIntent = await forMerchant(accountId).paymentIntents.retrieve(hold.paymentIntentId);
  if (holdIntent.status !== 'requires_capture' || holdIntent.capture_method !== 'manual') {
    fail(
      `hold ${hold.paymentIntentId} came back ${holdIntent.status} / ` +
        `${holdIntent.capture_method}; expected requires_capture / manual — FR-404 is broken.`,
    );
  }
  if (holdIntent.amount_received !== 0) {
    fail(
      `hold ${hold.paymentIntentId} already received ${holdIntent.amount_received} cents — ` +
        'a join charged the diner before the cutoff, which FR-404 forbids.',
    );
  }
  process.stdout.write(
    `no charge at join: status=${holdIntent.status}, capture_method=${holdIntent.capture_method}, ` +
      `amount_received=${holdIntent.amount_received}, amount_capturable=${holdIntent.amount_capturable}\n`,
  );

  // ADR-001 §3.1: the hold lives on the connected account, not the platform.
  let platformRefusal = 'none';
  try {
    await platform().paymentIntents.retrieve(hold.paymentIntentId);
  } catch (err) {
    platformRefusal = String((err as { code?: string })?.code ?? (err as { type?: string })?.type ?? 'unknown');
  }
  if (platformRefusal === 'none') {
    fail(
      `the platform client could retrieve ${hold.paymentIntentId} — the hold is not scoped to the\n` +
        'connected account, which is the wrong-account bug ADR-001 §3.1 exists to prevent.',
    );
  }
  process.stdout.write(`platform client refused the hold (${platformRefusal}) — direct charge confirmed\n`);

  // §11.5 / FR-405: one join, one hold, even on a retry.
  const replayedHold = await joinPort.createJoinAuthorisation(joinRequest);
  if (replayedHold.status !== 'AUTHORIZED' || replayedHold.paymentIntentId !== hold.paymentIntentId) {
    fail('replaying the join with the same idempotency key did not return the same hold.');
  }
  process.stdout.write(`idempotent replay returned the same hold ${replayedHold.paymentIntentId}\n`);

  // The decline branch: unreachable on stripe-mock, provable here.
  const declined = await joinPort.createJoinAuthorisation({
    ...joinRequest,
    paymentMethodId: DECLINE_PAYMENT_METHOD,
    idempotencyKey: declineKey,
  });
  if (declined.status !== 'DECLINED' || !declined.declineCode) {
    fail(
      `a real declined card returned ${declined.status} without a decline code — ` +
        'the StripeCardError classification in real-payment-port.ts is broken.',
    );
  }
  process.stdout.write(`declined card mapped to DECLINED / ${declined.declineCode}\n`);

  // ------------------------------------------------------------------ phase 2
  // Capture the SAME intent the /join port created — this is the handoff the
  // cutoff tick performs. A green run proves the halves connect.
  process.stdout.write('\n--- phase 2: cutoff capture/refund on that same hold ---\n');
  const port = realChargePort();

  process.stdout.write('--- realChargePort().capture() ---\n');
  const captured = await port.capture({
    participantId: 'stripe-verify',
    dropId: 'stripe-verify',
    stripeAccountId: accountId,
    paymentIntentId: hold.paymentIntentId,
    amountCents: PROBE_AMOUNT_CENTS,
    platformFeeCents: PLATFORM_FEE_CENTS,
    idempotencyKey: captureKey,
  });

  if (captured.status !== 'CAPTURED') {
    fail(`capture returned ${captured.status} — real-charge-port.ts did not capture as designed.`);
  }
  process.stdout.write(`captured: charge ${captured.chargeId}\n`);

  process.stdout.write('--- replay capture with same idempotency key ---\n');
  const replayed = await port.capture({
    participantId: 'stripe-verify',
    dropId: 'stripe-verify',
    stripeAccountId: accountId,
    paymentIntentId: hold.paymentIntentId,
    amountCents: PROBE_AMOUNT_CENTS,
    platformFeeCents: PLATFORM_FEE_CENTS,
    idempotencyKey: captureKey,
  });
  if (replayed.status !== 'CAPTURED' || replayed.chargeId !== captured.chargeId) {
    fail('idempotent replay did not return the same charge — the §4.2 retry property is broken.');
  }
  process.stdout.write('replay returned the same charge — idempotency holds\n');

  process.stdout.write('--- realChargePort().refund({ reverseApplicationFee: true }) ---\n');
  const refunded = await port.refund({
    participantId: 'stripe-verify',
    stripeAccountId: accountId,
    chargeId: captured.chargeId,
    amountCents: PROBE_AMOUNT_CENTS,
    platformFeeCents: PLATFORM_FEE_CENTS,
    reverseApplicationFee: true,
    idempotencyKey: refundKey,
  });
  if (refunded.status !== 'REFUNDED') {
    fail(`refund returned ${refunded.status} — the application-fee reversal path did not run.`);
  }
  process.stdout.write(
    `refunded: ${refunded.refundId}, application fee reversed ${refunded.applicationFeeRefundCents} cents\n`,
  );

  process.stdout.write('\n--- result ---\n');
  process.stdout.write(
    'VERIFIED against Stripe test mode. real-payment-port.ts created a manual-capture hold\n' +
      '(no money captured at join, scoped to the connected account, idempotent, real declines\n' +
      'classified), and real-charge-port.ts captured and refunded that SAME intent with the\n' +
      'platform fee reversed. Both halves of the money seam are executed and connect.\n' +
      'The "never executed" header in real-payment-port.ts is retired as of 2026-11-07.\n',
  );
  if (overrideAccountId) {
    process.stdout.write(
      `\nUsed existing connected account ${accountId} via STRIPE_CONNECTED_ACCOUNT_ID — no throwaway to close.\n`,
    );
  } else {
    process.stdout.write(`\nClose the probe account ${accountId} in the Stripe Dashboard when done.\n`);
  }
}

function printPlan(note: string, overrideAccountId?: string): void {
  process.stdout.write('\n--- plan (no network) ---\n');
  process.stdout.write(
    overrideAccountId
      ? `1. use existing connected account ${overrideAccountId} (STRIPE_CONNECTED_ACCOUNT_ID override — no account created)\n`
      : `1. create a CA express account (express, country CA)\n`,
  );
  process.stdout.write(
    `2. realJoinPaymentPort().createJoinAuthorisation(): ${PROBE_AMOUNT_CENTS} ${CURRENCY}, ${HOLD_PAYMENT_METHOD}, manual capture\n`,
  );
  process.stdout.write('3. assert the hold: requires_capture, amount_received 0, platform client cannot see it (FR-404 / ADR-001)\n');
  process.stdout.write('4. replay the join with the same idempotency key (must return the same hold)\n');
  process.stdout.write(`5. ${DECLINE_PAYMENT_METHOD} must map to DECLINED with a decline code\n`);
  process.stdout.write(`6. realChargePort().capture() on that hold with platformFee=${PLATFORM_FEE_CENTS}\n`);
  process.stdout.write('7. replay capture with the same idempotency key (must return same charge)\n');
  process.stdout.write('8. realChargePort().refund({ reverseApplicationFee: true })\n');
  process.stdout.write(`\n${note}\n`);
}

await main();
