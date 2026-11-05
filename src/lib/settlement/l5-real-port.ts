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
 * ## Why it lists by `source`
 *
 * A charge's balance transaction is identified by the charge id (`source`), and a
 * refund's by the refund id. The service supplies the ids from `Order.stripeChargeId`
 * and the `REFUND` ledger rows, so this file does not guess which transactions belong
 * to a drop: a drop's ledger already names them.
 *
 * ## Why the platform fee is found through the charge
 *
 * `application_fee_amount` is set on the connected charge, and the platform's
 * `applicationFees.list({ charge })` is the documented lookup. The fee's own
 * `balance_transaction` is retrieved on the platform client; it must not be fetched
 * through `forMerchant`, which would look on the wrong account and find nothing.
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
