import 'server-only';

import { forMerchant, platform } from '@/lib/payments/stripe';

import type { ConnectedBalanceLine, PlatformBalanceLine } from './l5';
import type { L5Port, L5ProviderLines } from './l5-port';

/**
 * L5's real provider read.
 *
 * ## THIS IMPLEMENTATION HAS NEVER BEEN EXECUTED AGAINST STRIPE
 *
 * There is no `STRIPE_SECRET_KEY` on this machine. It is transcribed from the SDK's
 * documented balance-transaction and application-fee surface, and the first real run
 * is the first evidence. Treat a failure as this file's bug before a Stripe outage —
 * the same warning `twilio-sender.ts` and `real-charge-port.ts` carry, for the same
 * reason.
 *
 * **Dated correction — 2026-11-11.** The paragraph above was true of *every* execution
 * path: no test imported this module for real. `l5-run.test.ts` supplies a
 * `fakeL5Port`, so the level that fetches the numbers reconciliation trusts had zero
 * executed statements in the gate. `l5-real-port.wire.test.ts` now records the requests
 * against a local `node:http` server, so the request shapes and the account each one is
 * scoped to are checked on every commit. That is not the same as being executed against
 * Stripe, and the first sentence above still stands.
 *
 * ## Why the platform fee is found through the charge
 *
 * `application_fee_amount` is set on the connected charge, and the platform's
 * `applicationFees.list({ charge })` is the documented lookup. The fee's own
 * `balance_transaction` is retrieved on the platform client; it must not be fetched
 * through `forMerchant`, which would look on the wrong account and find nothing.
 *
 * "Find nothing" is the reason that sentence needed a test rather than a comment:
 * `forMerchant` would return an empty list, not an error, so `Σ application_fee` would
 * come back short and the only symptom would be a reconciliation mismatch somebody has
 * to interpret. `l5-real-port.wire.test.ts` asserts the `Stripe-Account` header is
 * **absent** on both the fee list and the fee's transaction read — the one difference a
 * fake port cannot see. Verified by mutation: swapping `platformClient` for
 * `connectedClient` there fails that assertion.
 *
 * ## Why it lists by `source`
 *
 * A charge's balance transaction is identified by the charge id (`source`), and a
 * refund's by the refund id. The service supplies the ids from `Order.stripeChargeId`
 * and the `REFUND` ledger rows, so this file does not guess which transactions belong
 * to a drop: a drop's ledger already names them.
 *
 * Both guards that keep this honest are asserted, because both failures are silent
 * rather than loud. An unfiltered `balanceTransactions.list()` — what you get if the
 * loop runs with no ids — returns the account's entire history: a plausible number that
 * is wrong for every drop. And a transaction returned under two `source` queries would
 * be counted twice, inflating the expected delta by a whole charge, which reads as a
 * ledger failure caused by the reader. `l5-real-port.wire.test.ts` covers each, plus
 * the `kind` classification following the sign of the amount rather than which argument
 * list the id arrived in.
 */
export function realL5Port(): L5Port {
  return {
    async read(args): Promise<L5ProviderLines> {
      const connectedClient = forMerchant(args.stripeAccountId);
      const platformClient = platform();

      const connected: ConnectedBalanceLine[] = [];
      const seenConnected = new Set<string>();

      for (const sourceId of [...args.chargeIds, ...args.refundIds]) {
        const transactions = await connectedClient.balanceTransactions.list({
          source: sourceId,
          limit: 10,
        });
        for (const transaction of transactions.data) {
          if (seenConnected.has(transaction.id)) continue;
          seenConnected.add(transaction.id);
          connected.push({
            id: transaction.id,
            kind: transaction.amount >= 0 ? 'charge' : 'refund',
            amountCents: transaction.amount,
            // Signed as Stripe reports it: negative on a charge, usually positive on
            // a refund. `amount + fee` is the net balance movement.
            feeCents: transaction.fee,
          });
        }
      }

      const platformFees: PlatformBalanceLine[] = [];
      const seenFees = new Set<string>();

      for (const chargeId of args.chargeIds) {
        const fees = await platformClient.applicationFees.list({ charge: chargeId, limit: 10 });
        for (const fee of fees.data) {
          const reference = fee.balance_transaction;
          const transaction =
            typeof reference === 'string'
              ? await platformClient.balanceTransactions.retrieve(reference)
              : reference;
          if (!transaction || seenFees.has(transaction.id)) continue;
          seenFees.add(transaction.id);
          platformFees.push({
            id: transaction.id,
            kind: 'application_fee',
            // The fee's gross amount, not net: the platform's application fee does not
            // carry the merchant's card fee under ADR-001.
            amountCents: transaction.amount,
          });
        }
      }

      return { connected, platform: platformFees };
    },
  };
}
