import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES, platformFeeAt } from '@/lib/guardrail';

import { settleCharge } from '../fee-bearer';
import { forMerchant, isStripeConfigured, platform } from '../stripe';

/**
 * ADR-001 §4 — the live confirmation, gated on credentials.
 *
 * ## What this proves that the unit test cannot
 *
 * `fee-bearer.test.ts` proves the *arithmetic* is self-consistent. It cannot
 * prove the arithmetic describes Stripe. The claim under test is empirical:
 *
 *   > On a direct charge, the connected account bears the Stripe processing fee.
 *
 * That claim came from Stripe's documentation, and documentation has been wrong
 * once already in this project (PRD-v1 §17 D-1 said `on_behalf_of` moves the fee
 * to the merchant; it does not — see ADR-001 §2). So it gets asserted against a
 * real charge or it stays a belief.
 *
 * ## Dated correction — 2026-11-07: still a belief
 *
 * `.env` gained an `sk_test_…` key on 2026-11-06 17:01. That does **not** confirm
 * ADR-001 §4. `scripts/verify-stripe.ts` proved capture, idempotent replay and
 * `refund({ reverseApplicationFee: true })` — it reversed the 89¢ application fee —
 * but it never read the connected account's net balance, so it did **not** measure
 * who bears the Stripe card processing fee. Do not cite that run as evidence for
 * the claim above. ADR-001 §4 remains pending.
 *
 * The other half of the correction is about the gate: the old `canRun` used *key
 * presence* as a proxy for "the operator opted into a live run". With the key
 * present this suite could start making real network calls inside `vitest run`,
 * and it creates a throwaway Express account — which this platform cannot do
 * (Connect is not signed up). Live provider calls are therefore explicitly
 * opt-in via `RUN_STRIPE_LIVE_TESTS=1`. Key presence is not consent.
 *
 * ## Second dated correction — 2026-11-07: the measurement ran, and is RED
 *
 * `scripts/verify-stripe.ts` is now the **standing measurement** for §4 (this suite
 * still cannot run here: it creates a throwaway Express account, which this platform
 * is not Connect-enabled for, and plain `vitest run` lacks
 * `--conditions=react-server`). The measurement was ported there rather than into a
 * second probe, so there is one source of truth. The stamped run
 * `/tmp/stripe_feearer_stamped.log` read, after capture and before the refund on
 * charge `ch_3UZEji6TRDhMU3fu1H6e1jy7`:
 *
 *   - connected balance txn: `amount=1112, fee=160, net=952`;
 *   - `fee_details`: `application_fee=89`, `stripe_fee=71`;
 *   - platform application fee: `+89`, `amount_refunded=0`, correct `charge` and
 *     `account`; its balance transaction has `fee=0`, `fee_details=[]`;
 *   - `settleCharge(1112, 89, 62, DIRECT)` gives `merchantGrossCents=961`,
 *     `platformNetCents=89`; with the measured 71¢ it gives `952` / `89`.
 *
 * §1's direction was observed — the connected account bears the card fee and the
 * platform bears none of it — but §4's **62/961 vectors did not hold**: Stripe charged
 * 71¢, not 62¢. The script asserted the published vectors and exited `LIVE_EXIT=1`;
 * the charge was still refunded. `RUN_STRIPE_LIVE_TESTS=1` gating below is unchanged:
 * key presence is not consent.
 *
 * ## Third dated correction — 2026-11-07 (Gao's ruling, D4): §4 tests the QUALITATIVE bearer only
 *
 * §4 as written was **internally inconsistent**: it demanded `fee === 62` **and**
 * `net === 961` on the same transaction, but on a direct charge Stripe defines
 * `fee = Σ fee_details` and `net = amount − fee`. Both cannot hold. The stamped
 * run above exposed the spec defect, not a code defect: `fee=160 (=89+71)`,
 * `net=952 = 1112 − 160`. The 62¢ is `cardFeeAt(1112)` — a frozen §2.1 guardrail
 * constant (domestic 2.9% + 30¢), **not** a Stripe measurement.
 *
 * The knowingly-wrong `expect(connectedTxn.fee).toBe(62)` / `toBe(961)` assertions
 * are therefore **removed**, and this block now mirrors D1's qualitative set:
 * `amount=1112`; `stripe_fee > 0`; `application_fee=89`;
 * `fee === stripe_fee + application_fee`; `fee !== 0`; `net === amount − fee`;
 * the platform's application fee retrieved by the charge's own `application_fee`
 * id (never `applicationFees.list({limit:1})`, which can be stale) with
 * `amount=89`, `amount_refunded=0`, matching charge/account; its balance txn
 * `fee=0`, no `stripe_fee`, `net=89`; and `settleCharge(DIRECT)` fed the
 * **measured** `stripe_fee` (NEVER 62) reproducing `net`, `platformNetCents=89`,
 * `cardFeeBearer='MERCHANT'`. The +9¢ divergence is INFO only (§4.2 calibration
 * OPEN). `DEFAULT_FEES`, `SNAPSHOT_VERSION=1` and §2.1's vectors are unchanged.
 *
 * `scripts/verify-stripe.ts` is the standing proof; the fresh passing stamped run
 * is `/tmp/stripe_feearer_final.log` (`LIVE_EXIT=0`). This suite stays an **UNRUN
 * record**: the `RUN_STRIPE_LIVE_TESTS=1` opt-in gate, the named skip, the
 * Express-account caveat (this platform is not Connect-enabled) and the bottom
 * guard are all kept. **Bearer confirmed, vectors decoupled** — never "§4 confirmed".
 *
 * ## Why it skips with a named reason
 *
 * `describe.skipIf` with a **named reason** printed at collection time is chosen
 * over `it.todo` or a silently-passing stub: a green suite must never be
 * mistakable for an executed live test. If this file reports "skipped", it is an
 * unrun record; the bearer was confirmed by `scripts/verify-stripe.ts`, and only
 * §4.2 calibration stays open. The skip message says so.
 *
 * ## What it costs to run
 *
 * Real test-mode money on a real test-mode account. The connected account is
 * created fresh and its id is printed for cleanup; **this platform cannot create
 * one** (Connect is not signed up), which is why the standing proof uses the
 * `STRIPE_CONNECTED_ACCOUNT_ID` override instead. Nothing here touches live
 * mode: `isTestMode()` is asserted before any charge.
 */

// Historical wording (the first 2026-11-07 correction) said the earlier run did NOT
// measure the fee bearer; the second recorded the RED vector run. Both are kept as
// records. This named skip now reflects the split ruling: bearer confirmed, vectors
// decoupled, §4.2 calibration OPEN.
const REASON =
  'ADR-001 §1 fee bearer CONFIRMED 2026-11-07 by scripts/verify-stripe.ts ' +
  '(ch_3UZF9m6TRDhMU3fu1TYUh3ST); §4.2 calibration OPEN (cardFeeAt(1112)=62¢ vs measured 71¢, +9¢); ' +
  'this suite is an UNRUN record — live calls stay opt-in (RUN_STRIPE_LIVE_TESTS=1)';

// Key presence alone is not consent. See the dated correction above.
const canRun =
  process.env.RUN_STRIPE_LIVE_TESTS === '1' &&
  isStripeConfigured() &&
  (process.env.STRIPE_SECRET_KEY ?? '').includes('_test_');

/** Sum of one `fee_details` component. Structural type avoids an SDK value import. */
type FeeDetailLike = { type: string; amount: number };

function sumFeeDetails(details: FeeDetailLike[], type: string): number {
  return details.filter((detail) => detail.type === type).reduce((sum, detail) => sum + detail.amount, 0);
}

describe.skipIf(!canRun)(`ADR-001 §4 — live confirmation (${REASON})`, () => {
  /** Vector A's deal price and the frozen platform fee. No card-fee constant here. */
  const DEAL_PRICE = 1112;
  const PLATFORM_FEE = Math.round(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

  it('the connected account bears the card fee, and the platform nets our full fee', async () => {
    expect(PLATFORM_FEE).toBe(89);

    // 1. A fresh Express account. Test mode, so no real identity is collected.
    //    CAVEAT: this platform is not Connect-enabled, so this call would fail
    //    with HTTP 400. The standing proof uses an existing connected account.
    const account = await platform().accounts.create({
      type: 'express',
      country: 'CA',
      email: 'adr001+connect@example.test',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { name: 'ADR-001 fee bearer probe' },
      metadata: { purpose: 'adr-001-fee-bearer-confirmation' },
    });

    try {
      // 2. A DIRECT charge on that account, with our fee attached. Deliberately
      //    no `transfer_data` and no `on_behalf_of`: they are destination-charge
      //    parameters and would test the model we rejected.
      const intent = await forMerchant(account.id).paymentIntents.create(
        {
          amount: DEAL_PRICE,
          currency: 'cad',
          payment_method: 'pm_card_visa', // Stripe's test token
          confirm: true,
          application_fee_amount: PLATFORM_FEE,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        },
        { idempotencyKey: `adr001-${account.id}` },
      );

      expect(intent.status).toBe('succeeded');

      const chargeId =
        typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
      expect(chargeId).toBeTruthy();

      // 3. THE ASSERTION (D1, qualitative bearer). Read the balance transaction
      //    from the CONNECTED ACCOUNT by the charge's expanded txn id. If the
      //    platform were bearing the fee, `stripe_fee` here would be absent and
      //    the platform's fee txn would carry it instead.
      const charge = await forMerchant(account.id).charges.retrieve(chargeId!, {
        expand: ['balance_transaction'],
      });
      const balanceTxnId =
        typeof charge.balance_transaction === 'string'
          ? charge.balance_transaction
          : charge.balance_transaction?.id;
      expect(balanceTxnId).toBeTruthy();
      const connectedTxn = await forMerchant(account.id).balanceTransactions.retrieve(balanceTxnId!);

      const feeDetails = connectedTxn.fee_details ?? [];
      const stripeFee = sumFeeDetails(feeDetails, 'stripe_fee');
      const applicationFeeInTxn = sumFeeDetails(feeDetails, 'application_fee');

      expect(connectedTxn.amount).toBe(DEAL_PRICE);
      expect(connectedTxn.fee).not.toBe(0);
      expect(stripeFee).toBeGreaterThan(0);
      expect(applicationFeeInTxn).toBe(PLATFORM_FEE);
      expect(connectedTxn.fee).toBe(stripeFee + applicationFeeInTxn);
      expect(connectedTxn.net).toBe(connectedTxn.amount - connectedTxn.fee);

      // 4. The platform collected exactly our fee, with NO card fee against it.
      //    Retrieve by THIS charge's application_fee id, never a stale list.
      const feeId =
        typeof charge.application_fee === 'string'
          ? charge.application_fee
          : charge.application_fee?.id;
      expect(feeId).toBeTruthy();
      const applicationFee = await platform().applicationFees.retrieve(feeId!);
      expect(applicationFee.amount).toBe(PLATFORM_FEE);
      expect(applicationFee.amount_refunded).toBe(0);
      expect(typeof applicationFee.charge === 'string' ? applicationFee.charge : applicationFee.charge.id).toBe(
        chargeId,
      );
      expect(typeof applicationFee.account === 'string' ? applicationFee.account : applicationFee.account.id).toBe(
        account.id,
      );

      const feeTxnId =
        typeof applicationFee.balance_transaction === 'string'
          ? applicationFee.balance_transaction
          : applicationFee.balance_transaction?.id;
      expect(feeTxnId).toBeTruthy();
      const platformFeeTxn = await platform().balanceTransactions.retrieve(feeTxnId!);
      expect(platformFeeTxn.fee).toBe(0);
      expect(sumFeeDetails(platformFeeTxn.fee_details ?? [], 'stripe_fee')).toBe(0);
      expect(platformFeeTxn.net).toBe(PLATFORM_FEE);

      // 5. Cross-check against the pure model with the MEASURED card fee, so a
      //    drift is a test failure rather than an M5 reconciliation surprise.
      //    NEVER feed the frozen 62¢ here.
      const modelled = settleCharge({
        chargedCents: DEAL_PRICE,
        platformFeeCents: PLATFORM_FEE,
        cardFeeCents: stripeFee,
        model: 'DIRECT',
      });
      expect(modelled.merchantGrossCents).toBe(connectedTxn.net);
      expect(modelled.platformNetCents).toBe(PLATFORM_FEE);
      expect(modelled.cardFeeBearer).toBe('MERCHANT');
    } finally {
      // Best-effort cleanup. A test that leaves connected accounts behind makes
      // any later fee read ambiguous, even when it is by id rather than a list.
      await platform()
        .accounts.del(account.id)
        .catch(() => undefined);
    }
  }, 60_000);
});

/**
 * A guard that runs whether or not credentials exist.
 *
 * If someone later "fixes" the skip by adding a destination-charge parameter to
 * the block above, this catches the intent drift without needing a key.
 */
describe('ADR-001 · the integration test tests the model we ship', () => {
  it('the confirmation block contains no destination-charge parameters', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', '..', '..', 'lib', 'payments', 'stripe.ts'), 'utf8');

    // The factory must not smuggle destination-charge semantics in.
    expect(source).not.toMatch(/transfer_data/);
    expect(source).not.toMatch(/on_behalf_of/);
  });
});
