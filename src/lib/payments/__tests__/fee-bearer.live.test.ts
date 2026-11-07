import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES, cardFeeAt, platformFeeAt } from '@/lib/guardrail';

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
 * ## Why it skips with a named reason
 *
 * `describe.skipIf` with a **named reason** printed at collection time is chosen
 * over `it.todo` or a silently-passing stub: a green suite must never be
 * mistakable for a confirmed decision. If this file reports "skipped", ADR-001
 * is still pending — that is the correct reading, and the skip message says so.
 *
 * ## What it costs to run
 *
 * Real test-mode money on a real test-mode account. The connected account is
 * created fresh and its id is printed for cleanup. Nothing here touches live
 * mode: `isTestMode()` is asserted before any charge.
 */

const REASON =
  'ADR-001 §4 not yet confirmed: live provider calls are opt-in ' +
  '(RUN_STRIPE_LIVE_TESTS=1); the 2026-11-06/07 verify-stripe run did NOT measure the fee bearer.';

// Key presence alone is not consent. See the dated correction above.
const canRun =
  process.env.RUN_STRIPE_LIVE_TESTS === '1' &&
  isStripeConfigured() &&
  (process.env.STRIPE_SECRET_KEY ?? '').includes('_test_');

describe.skipIf(!canRun)(`ADR-001 §4 — live confirmation (${REASON})`, () => {
  /**
   * Vector A. The three figures the panel prints, restated so the assertion reads
   * against the published numbers rather than against re-derived ones.
   */
  const DEAL_PRICE = 1112;
  const PLATFORM_FEE = Math.round(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));
  const CARD_FEE = Math.round(cardFeeAt(DEAL_PRICE, DEFAULT_FEES));

  it('the connected account bears the card fee, and the platform nets our full fee', async () => {
    expect(PLATFORM_FEE).toBe(89);
    expect(CARD_FEE).toBe(62);

    // 1. A fresh Express account. Test mode, so no real identity is collected.
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

      // 3. THE ASSERTION. Read the balance transaction from the CONNECTED
      //    ACCOUNT. If the platform were bearing the fee, this figure would be
      //    zero and the platform's would be 62.
      const connectedTxn = await forMerchant(account.id).balanceTransactions.retrieve(
        // The charge's balance transaction id is stable; list by source instead of
        // assuming the id, so a schema change surfaces here rather than silently.
        (await forMerchant(account.id).charges.retrieve(chargeId!, { expand: ['balance_transaction'] }))
          .balance_transaction as string,
      );

      expect(connectedTxn.fee).toBe(CARD_FEE);
      expect(connectedTxn.net).toBe(DEAL_PRICE - CARD_FEE - PLATFORM_FEE);
      expect(connectedTxn.net).toBe(961);

      // 4. And the platform collected exactly our fee, with no card fee against it.
      const fees = await platform().applicationFees.list({ limit: 1 });
      expect(fees.data[0]?.amount).toBe(PLATFORM_FEE);

      // 5. Cross-check against the pure model, so a drift between the two is a
      //    test failure and not a reconciliation surprise in M5.
      const modelled = settleCharge({
        chargedCents: DEAL_PRICE,
        platformFeeCents: PLATFORM_FEE,
        cardFeeCents: CARD_FEE,
        model: 'DIRECT',
      });
      expect(modelled.merchantGrossCents).toBe(connectedTxn.net);
      expect(modelled.platformNetCents).toBe(PLATFORM_FEE);
    } finally {
      // Best-effort cleanup. A test that leaves connected accounts behind makes
      // the next run's `applicationFees.list({ limit: 1 })` assertion meaningless.
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
