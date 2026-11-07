/**
 * Proves — or fails to prove — that the real Stripe money seam works, against
 * real Stripe in test mode: the /join hold, the cutoff capture, and ADR-001 §1's
 * qualitative fee-bearer claim.
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
 *   8. **ADR-001 §1 / §4 — the QUALITATIVE fee bearer.** On a direct charge
 *      Stripe defines `fee = Σ fee_details` and `net = amount − fee`. Assert
 *      that the connected account carries a non-zero `stripe_fee` and the 89¢
 *      `application_fee`, that the platform's fee txn has `fee=0` and no
 *      `stripe_fee`, and that `settleCharge(DIRECT)` fed the **measured**
 *      `stripe_fee` reproduces `net`. Must run BEFORE the refund.
 *   9. `refund({ reverseApplicationFee: true })` — the platform fee is reversed.
 *      It must run LAST: a refund reverses the application fee and makes the
 *      measurement meaningless.
 *
 * A green run is evidence that the production ports actually talk to Stripe
 * correctly and hand off to each other — not merely that the SDK accepts our
 * arguments (which `stripe-mock` already proves).
 *
 * ## Dated correction — 2026-11-07: the ADR-001 §4 measurement lives here
 *
 * `src/lib/payments/__tests__/fee-bearer.live.test.ts` already encodes the §4
 * measurement, but that suite cannot run on this platform: it creates a
 * throwaway Express account (`platform().accounts.create(...)` fails with HTTP
 * 400 "You can only create new accounts if you've signed up for Connect"), and
 * plain `vitest run` lacks the `--conditions=react-server` the real ports need.
 * Rather than add a second live probe, the measurement was ported into this
 * script, which already has the connected-account override and the react-server
 * condition. **This script is the single source of truth for §4**; the test file
 * stays an opt-in record pointing here.
 *
 * The measurement uses the charge's own `application_fee` id and
 * `platform().applicationFees.retrieve(feeId)` — never
 * `applicationFees.list({ limit: 1 })`, which can pick up a stale run. A missing
 * or unreadable balance transaction is a failure, never a silent skip. All
 * mismatches are collected and passed to `fail()` **after** the refund, because
 * `fail()` calls `process.exit(1)` and the test-mode money must net to zero on
 * every path.
 *
 * ## Third dated correction — 2026-11-07 (Gao's ruling, D1): §4 tests the QUALITATIVE bearer only
 *
 * The first stamped run (`/tmp/stripe_feearer_stamped.log`, `LIVE_EXIT=1`)
 * measured `amount=1112, fee=160, net=952` with
 * `fee_details = application_fee 89 + stripe_fee 71`, and the platform's
 * application-fee txn `amount=89, fee=0, fee_details=[]`. §4 as originally
 * written was **internally inconsistent**: it asked for `fee` to equal the 62¢
 * card fee *and* for `net` to be `1112 − 62 − 89 = 961`, but on a direct charge
 * `fee = Σ fee_details` and `net = amount − fee`, so both cannot hold. The 62¢
 * is `cardFeeAt(1112)` — a frozen §2.1 guardrail constant (domestic 2.9% + 30¢),
 * not a Stripe measurement.
 *
 * Per the architect's ruling, this script now asserts only the **bearer**:
 * `amount=1112`; `stripe_fee > 0`; `application_fee=89`;
 * `fee === stripe_fee + application_fee`; `fee !== 0`; `net === amount − fee`;
 * platform fee `+89`, `amount_refunded=0`, matching charge/account, its txn
 * `fee=0`, no `stripe_fee`, `net=89`; and `settleCharge(DIRECT)` fed the
 * **measured** `stripe_fee` reproduces `net` with `platformNetCents=89` and
 * `cardFeeBearer='MERCHANT'`. The +9¢ divergence from `cardFeeAt(1112)=62¢` is
 * printed as **INFO only** (§4.2 calibration OPEN), never as a failure;
 * `DEFAULT_FEES` and `SNAPSHOT_VERSION=1` are untouched. The 62/961 vectors are
 * NOT asserted and remain unconfirmed.
 *
 * ## What it costs and what it touches
 *
 * One throwaway CA **express** account when no override is set (Stripe cannot
 * delete accounts, only close them — its id is printed for the user to close).
 * Test-mode money: a 1112-cent CAD hold, captured, then fully refunded, so it
 * nets to zero. The §4 measurement only reads — it creates no extra charges.
 * One declined confirmation attempt may leave an unusable test-mode intent; no
 * money moves on it. No row is written to the app's database. It is not imported
 * by the app.
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
import type Stripe from 'stripe';

import { settleCharge } from '../src/lib/payments/fee-bearer';
import { forMerchant, isStripeConfigured, isTestMode, platform } from '../src/lib/payments/stripe';

/**
 * The single amount/account pair the live test uses, repeated here so two runs
 * are comparable. `roundHalfUp(platformFeeAt(1112))` is 89, matching the test.
 */
const PROBE_AMOUNT_CENTS = 1112;
const PLATFORM_FEE_CENTS = 89;
const CURRENCY = 'cad';

/**
 * §2.1's published domestic base (2.9% + 30¢), **INFORMATIONAL ONLY**.
 *
 * `0.029 × 1112 + 30 = 62.248 → 62`. This is a frozen guardrail constant, never
 * a Stripe measurement: it is printed as a §4.2 calibration INFO line, never
 * asserted, and never fed to `settleCharge()`. Per D3, `DEFAULT_FEES` and
 * `SNAPSHOT_VERSION` stay unchanged, and the 71-vs-62 gap is a hypothesis
 * (possible cross-border surcharge), not a fact.
 */
const GUARDRAIL_BASE_CARD_FEE_CENTS = Math.round(0.029 * PROBE_AMOUNT_CENTS + 30);

/** Stripe's documented test PaymentMethods, not real card tokens. */
const HOLD_PAYMENT_METHOD = 'pm_card_visa';
const DECLINE_PAYMENT_METHOD = 'pm_card_chargeDeclined';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** An expandable Stripe field arrives either as an id or as the full object. */
function expandedId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === 'string') {
    return value.length > 0 ? value : null;
  }
  if (value !== null && typeof value === 'object' && typeof value.id === 'string') {
    return value.id.length > 0 ? value.id : null;
  }
  return null;
}

/** Sum of one `fee_details` component, e.g. `stripe_fee` or `application_fee`. */
function feeComponent(details: Stripe.BalanceTransaction.FeeDetail[], type: string): number {
  return details
    .filter((detail) => detail.type === type)
    .reduce((sum, detail) => sum + detail.amount, 0);
}

/** A short, non-secret discriminator for a Stripe API error. */
function errorCode(error: unknown): string {
  const candidate = error as { code?: unknown; type?: unknown; message?: unknown } | null;
  const code = candidate?.code ?? candidate?.type;
  if (typeof code === 'string' && code.length > 0) {
    return code;
  }
  return typeof candidate?.message === 'string' ? candidate.message : 'unknown';
}

type FeeBearerMeasurement = {
  /** Lines forming the final VERIFIED banner; printed only when green. */
  banner: string[];
  /** Every failed assertion. Non-empty makes the script exit(1) after the refund. */
  mismatches: string[];
};

/**
 * ADR-001 §4 — measure the **qualitative** fee bearer on a DIRECT charge.
 *
 * Runs against the SAME charge the /join port authorised and `realChargePort()`
 * captured, after capture and before the refund. A refund with
 * `reverseApplicationFee: true` reverses the 89¢ and would invalidate the
 * platform-side half of the measurement.
 *
 * Reads are split deliberately: the charge is fetched with
 * `expand: ['balance_transaction']` to name the connected account's transaction,
 * then that transaction is retrieved through `forMerchant()` so the numbers come
 * from an explicit, account-scoped read rather than an assumed expansion. The
 * platform fee is read by the charge's own `application_fee` id, which cannot
 * pick up a stale run.
 *
 * D1: `fee = Σ fee_details` and `net = amount − fee` are Stripe's definitions,
 * so those identities — plus "the connected account carries the stripe_fee and
 * the platform does not" — are what gets asserted. The frozen 62¢ guardrail
 * constant is INFO only. Assertions are collected, not thrown: `fail()` exits,
 * and the caller must still refund even when a measurement is wrong.
 */
async function measureFeeBearer(accountId: string, chargeId: string): Promise<FeeBearerMeasurement> {
  const banner: string[] = [];
  const mismatches: string[] = [];

  process.stdout.write('\n--- ADR-001 §4: qualitative fee-bearer measurement (after capture, before refund) ---\n');

  // 1. The charge on the CONNECTED account, with its balance transaction expanded.
  const charge = await forMerchant(accountId).charges.retrieve(chargeId, {
    expand: ['balance_transaction'],
  });
  const balanceTxnId = expandedId(charge.balance_transaction);
  if (!balanceTxnId) {
    mismatches.push(
      `charge ${chargeId} has no readable balance_transaction — §4 cannot be measured. ` +
        'A missing balance transaction is a failure, never a skip.',
    );
    return { banner, mismatches };
  }
  process.stdout.write(`charge ${chargeId} → connected balance transaction ${balanceTxnId}\n`);

  // 2. Read it back through the merchant-scoped client — the explicit §4 read.
  const txn = await forMerchant(accountId).balanceTransactions.retrieve(balanceTxnId);
  const { amount, fee, net } = txn;
  const details = txn.fee_details ?? [];
  const cardFeeCents = feeComponent(details, 'stripe_fee');
  const applicationFeeInTxn = feeComponent(details, 'application_fee');
  process.stdout.write(
    `connected txn ${txn.id}: type=${txn.type}, amount=${amount}, fee=${fee}, net=${net}\n`,
  );
  process.stdout.write(`connected txn fee_details: ${JSON.stringify(details)}\n`);
  process.stdout.write(
    `fee_details components: stripe_fee=${cardFeeCents}, application_fee=${applicationFeeInTxn}\n`,
  );

  // 3. D1, connected account — qualitative bearer assertions only.
  if (amount !== PROBE_AMOUNT_CENTS) {
    mismatches.push(
      `connected txn amount measured ${amount}¢, expected ${PROBE_AMOUNT_CENTS}¢ ` +
        `(difference ${amount - PROBE_AMOUNT_CENTS}¢).`,
    );
  }
  if (fee === 0) {
    mismatches.push('connected txn fee is zero — the connected account bears no fee at all, so §1 is not observed.');
  }
  if (cardFeeCents <= 0) {
    mismatches.push(
      'no positive stripe_fee component in the connected txn fee_details — the card fee bearer is unreadable.',
    );
  }
  if (applicationFeeInTxn !== PLATFORM_FEE_CENTS) {
    mismatches.push(
      `connected txn application_fee component is ${applicationFeeInTxn}¢, expected ${PLATFORM_FEE_CENTS}¢.`,
    );
  }
  if (fee !== cardFeeCents + applicationFeeInTxn) {
    mismatches.push(
      `fee=${fee}¢ but Σ fee_details = ${cardFeeCents + applicationFeeInTxn}¢ ` +
        `(stripe_fee ${cardFeeCents} + application_fee ${applicationFeeInTxn}) — the txn is not a direct charge.`,
    );
  }
  if (net !== amount - fee) {
    mismatches.push(`net=${net}¢ but amount - fee = ${amount - fee}¢ — Stripe's balance identity is broken.`);
  }

  // D1: the +9¢ divergence is INFO ONLY, never a mismatch. It is a §4.2
  // calibration question, not a bearer question. Nothing here feeds settleCharge.
  const divergence = cardFeeCents - GUARDRAIL_BASE_CARD_FEE_CENTS;
  const divergenceText = `${divergence >= 0 ? '+' : ''}${divergence}¢`;
  process.stdout.write(
    `INFO (§4.2 calibration OPEN): measured stripe_fee=${cardFeeCents}¢ vs ` +
      `cardFeeAt(1112)=${GUARDRAIL_BASE_CARD_FEE_CENTS}¢ (${divergenceText}). ` +
      '62/961 vectors are NOT asserted and remain unconfirmed; DEFAULT_FEES unchanged, ' +
      'SNAPSHOT_VERSION=1. No failure is raised by this divergence.\n',
  );

  // 4. D1, platform side. Retrieve THIS charge's application fee by id.
  const applicationFeeId = expandedId(charge.application_fee);
  if (!applicationFeeId) {
    mismatches.push(
      `charge ${chargeId} has no application_fee id — the platform half cannot be measured. ` +
        'Refusing applicationFees.list({limit:1}), which could read a stale run.',
    );
    return { banner, mismatches };
  }
  const applicationFee = await platform().applicationFees.retrieve(applicationFeeId);
  const feeAccountId = expandedId(applicationFee.account);
  const feeChargeId = expandedId(applicationFee.charge);
  process.stdout.write(
    `platform application fee ${applicationFee.id}: amount=${applicationFee.amount}, ` +
      `amount_refunded=${applicationFee.amount_refunded}, currency=${applicationFee.currency}, ` +
      `account=${feeAccountId}, charge=${feeChargeId}\n`,
  );

  if (applicationFee.amount !== PLATFORM_FEE_CENTS) {
    mismatches.push(
      `platform collected ${applicationFee.amount}¢, expected ${PLATFORM_FEE_CENTS}¢ ` +
        `(difference ${applicationFee.amount - PLATFORM_FEE_CENTS}¢).`,
    );
  }
  if (applicationFee.amount_refunded !== 0) {
    mismatches.push(
      `application fee ${applicationFee.id} is already reversed by ${applicationFee.amount_refunded}¢ — ` +
        'the measurement is post-refund and invalid.',
    );
  }
  if (feeChargeId !== chargeId || feeAccountId !== accountId) {
    mismatches.push(
      `application fee ${applicationFee.id} belongs to charge=${feeChargeId} / account=${feeAccountId}, ` +
        `not ${chargeId} / ${accountId} — a stale fee was read.`,
    );
  }

  // 4a. The platform must carry NO card fee against its +89. Prefer the fee's own
  // balance transaction id; fall back to the connected account's copy only to
  // report which account Stripe attached it to, never to fabricate a pass.
  let platformFeeTxnSummary = 'unreadable';
  const feeTxnId = expandedId(applicationFee.balance_transaction);
  if (!feeTxnId) {
    mismatches.push(
      `application fee ${applicationFee.id} has no balance_transaction — cannot assert "no card fee against the platform".`,
    );
  } else {
    let feeTxn: Stripe.BalanceTransaction | null = null;
    let feeTxnScope = 'unreadable';
    try {
      feeTxn = await platform().balanceTransactions.retrieve(feeTxnId);
      feeTxnScope = 'platform';
    } catch (err) {
      process.stdout.write(
        `platform client could not read ${feeTxnId} (${errorCode(err)}); trying the connected account\n`,
      );
      try {
        feeTxn = await forMerchant(accountId).balanceTransactions.retrieve(feeTxnId);
        feeTxnScope = 'connected';
      } catch {
        feeTxn = null;
      }
    }
    if (!feeTxn) {
      mismatches.push(
        `could not read balance transaction ${feeTxnId} of application fee ${applicationFee.id} from either account.`,
      );
    } else {
      const feeTxnDetails = feeTxn.fee_details ?? [];
      const feeTxnStripeFee = feeComponent(feeTxnDetails, 'stripe_fee');
      platformFeeTxnSummary =
        `${feeTxnScope} fee txn ${feeTxn.id}: fee=${feeTxn.fee}, no stripe_fee ` +
        `(stripe_fee=${feeTxnStripeFee}), amount=${feeTxn.amount}, net=${feeTxn.net}`;
      process.stdout.write(
        `${platformFeeTxnSummary}, fee_details=${JSON.stringify(feeTxnDetails)}\n`,
      );
      if (feeTxn.fee !== 0 || feeTxnStripeFee !== 0) {
        mismatches.push(
          `the ${feeTxnScope} application-fee balance transaction carries fee=${feeTxn.fee}¢ / ` +
            `stripe_fee=${feeTxnStripeFee}¢ — a card fee landed against the platform, contradicting §1.`,
        );
      }
      if (feeTxnScope === 'platform' &&
          (feeTxn.amount !== PLATFORM_FEE_CENTS || feeTxn.net !== PLATFORM_FEE_CENTS)) {
        mismatches.push(
          `platform fee txn amount=${feeTxn.amount}¢ / net=${feeTxn.net}¢, expected +${PLATFORM_FEE_CENTS}¢ / +${PLATFORM_FEE_CENTS}¢.`,
        );
      }
      if (feeTxnScope === 'connected' &&
          (Math.abs(feeTxn.amount) !== PLATFORM_FEE_CENTS || Math.abs(feeTxn.net) !== PLATFORM_FEE_CENTS)) {
        mismatches.push(
          `connected-side fee txn magnitude amount=${feeTxn.amount}¢ / net=${feeTxn.net}¢, ` +
            `expected ${PLATFORM_FEE_CENTS}¢.`,
        );
      }
    }
  }

  // 5. D1 — cross-check the pure model with the MEASURED card fee, NEVER with 62.
  const modelled = settleCharge({
    chargedCents: PROBE_AMOUNT_CENTS,
    platformFeeCents: PLATFORM_FEE_CENTS,
    cardFeeCents: cardFeeCents,
    model: 'DIRECT',
  });
  process.stdout.write(
    `settleCharge(DIRECT, charged=1112, platformFee=89, cardFee=MEASURED ${cardFeeCents}): ` +
      `merchantGrossCents=${modelled.merchantGrossCents}, platformNetCents=${modelled.platformNetCents}, ` +
      `cardFeeBearer=${modelled.cardFeeBearer}\n`,
  );
  if (modelled.merchantGrossCents !== net) {
    mismatches.push(
      `modelled merchantGrossCents=${modelled.merchantGrossCents}¢ but measured connected net=${net}¢ ` +
        `(difference ${modelled.merchantGrossCents - net}¢).`,
    );
  }
  if (modelled.platformNetCents !== PLATFORM_FEE_CENTS || modelled.platformNetCents !== applicationFee.amount) {
    mismatches.push(
      `modelled platformNetCents=${modelled.platformNetCents}¢, measured platform application fee=` +
        `${applicationFee.amount}¢, expected ${PLATFORM_FEE_CENTS}¢.`,
    );
  }
  if (modelled.cardFeeBearer !== 'MERCHANT') {
    mismatches.push(`modelled cardFeeBearer=${modelled.cardFeeBearer}, expected MERCHANT.`);
  }

  // D5 banner. Every figure is measured on this run, not copied from an older log.
  banner.push(
    `VERIFIED vs Stripe test mode: money seam end-to-end (join→capture→refund) and ADR-001 §1 fee bearer ` +
      `CONFIRMED — this DIRECT charge's connected account bears the processing fee ` +
      `(fee=${fee}=${applicationFeeInTxn}+${cardFeeCents}, net=${net}); ${platformFeeTxnSummary}; ` +
      `settleCharge(DIRECT) reproduces net with the measured card fee.`,
    `NOT confirmed / OPEN (§4.2): cardFeeAt(1112)=${GUARDRAIL_BASE_CARD_FEE_CENTS}¢ vs ${cardFeeCents}¢ ` +
      `(${divergenceText}); 62/961 vectors unconfirmed; DEFAULT_FEES unchanged, SNAPSHOT_VERSION=1.`,
    `connected txn ${txn.id}: amount=${amount}¢, fee=${fee}¢, net=${net}¢, fee_details=${JSON.stringify(details)}.`,
    `platform application fee ${applicationFee.id}=+${applicationFee.amount}¢, amount_refunded=` +
      `${applicationFee.amount_refunded}, charge=${feeChargeId}, account=${feeAccountId}.`,
    `settleCharge(DIRECT, cardFee=${cardFeeCents}): merchantGrossCents=${modelled.merchantGrossCents} ` +
      `=== connected net ${net}; platformNetCents=${modelled.platformNetCents}; cardFeeBearer=${modelled.cardFeeBearer}.`,
  );

  return { banner, mismatches };
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
        'Run without --dry to run the hold, capture, §4 measurement and refund.',
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

  // ADR-001 §4: measure the qualitative fee bearer AFTER capture and BEFORE the
  // refund. A thrown read is turned into a mismatch too, so it can never be a
  // silent skip; the refund below runs on every path.
  let feeBearer: FeeBearerMeasurement;
  try {
    feeBearer = await measureFeeBearer(accountId, captured.chargeId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`fee-bearer measurement could not complete: ${message}\n`);
    feeBearer = {
      banner: [],
      mismatches: [
        `§4 measurement threw before the balance transaction could be read: ${message}. ` +
          'An unreadable balance transaction is a failure, never a skip.',
      ],
    };
  }

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

  // fail() calls process.exit(1), so mismatches are reported only AFTER the
  // money has been returned. A failed measurement must never leave a captured
  // test-mode charge behind, and must never print the VERIFIED banner.
  if (feeBearer.mismatches.length > 0) {
    fail(
      'ADR-001 §4 qualitative fee-bearer measurement FAILED — the fee bearer is NOT confirmed.\n' +
        feeBearer.mismatches.map((line) => `  - ${line}`).join('\n') +
        '\nThe charge was still refunded (see above). Do not cite this run as a fee-bearer confirmation.',
    );
  }

  process.stdout.write('\n--- result ---\n');
  process.stdout.write(`${feeBearer.banner[0]}\n`);
  process.stdout.write(`${feeBearer.banner[1]}\n`);
  process.stdout.write(
    'real-payment-port.ts created a manual-capture hold (no money captured at join, scoped to\n' +
      'the connected account, idempotent, real declines classified), and real-charge-port.ts\n' +
      'captured and refunded that SAME intent with the platform fee reversed. Both halves of\n' +
      'the money seam are executed and connect. The "never executed" header in\n' +
      'real-payment-port.ts is retired as of 2026-11-07.\n',
  );
  process.stdout.write('\n--- ADR-001 §4 — fee bearer (measured) ---\n');
  for (const line of feeBearer.banner.slice(2)) {
    process.stdout.write(`${line}\n`);
  }
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
  process.stdout.write(
    `8. ADR-001 §4 qualitative bearer: read amount/fee/net/fee_details; assert fee === stripe_fee + ` +
      `application_fee and net === amount - fee; platform fee txn fee=0 / no stripe_fee / net=89; ` +
      `settleCharge(DIRECT) with the MEASURED card fee reproduces net — BEFORE the refund. ` +
      `The +9¢ vs cardFeeAt(1112)=62¢ divergence is INFO only (§4.2 OPEN).\n`,
  );
  process.stdout.write('9. realChargePort().refund({ reverseApplicationFee: true }) — ALWAYS, even if step 8 fails\n');
  process.stdout.write(`\n${note}\n`);
}

await main();
