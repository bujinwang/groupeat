import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';

import { reconcileL5, type L5Check } from './l5';
import type { L5Port } from './l5-port';

/**
 * The nightly L5 job, with the clock and the provider as arguments.
 *
 * ## What it reconciles, and why the window starts at both tables
 *
 * A drop enters the run if it has an **order** created in the window or a
 * **ledger entry** created in the window. The second half matters: a refund today on
 * a drop settled three weeks ago is a balance movement now, and a job that selected
 * only by `Order.createdAt` would never see it.
 *
 * Once a drop is selected, the whole drop is read — all its orders and ledger rows —
 * because L5 is a total over the drop, not over the window.
 *
 * ## Why one drop's provider failure does not stop the run
 *
 * A Stripe timeout on drop 17 is not a reason to leave drops 18–100 unreconciled. The
 * failure becomes a reported mismatch for that drop and the loop continues. The route's
 * response says `ok: false`, so an operator or an alert can page; silence would be the
 * only wrong outcome.
 *
 * ## Missing Stripe account
 *
 * A charged order on a merchant with no `stripeAccountId` is a data defect that L5
 * cannot reconcile at all. It is reported, not skipped, because "we could not check"
 * and "we checked and it agreed" are different answers and only one of them is safe.
 */

export type L5Mismatch = {
  readonly dropId: string;
  readonly reason: 'MISSING_STRIPE_ACCOUNT' | 'PROVIDER_ERROR' | 'L5';
  readonly detail?: string;
  readonly checks?: readonly L5Check[];
};

export type L5RunResult = {
  readonly since: string;
  readonly dropsChecked: number;
  readonly dropsSkipped: number;
  readonly ok: boolean;
  readonly mismatches: readonly L5Mismatch[];
};

export async function runL5Reconciliation(args: {
  now: Date;
  port: L5Port;
  /** Defaults to the previous 24 hours. */
  since?: Date;
  /** Bound the run; the route's response reports how many were examined. */
  limit?: number;
}): Promise<L5RunResult> {
  const since = args.since ?? new Date(args.now.getTime() - 24 * 60 * 60 * 1000);
  const limit = args.limit ?? 100;

  const [recentOrders, recentLedger] = await Promise.all([
    prisma.order.findMany({
      where: { createdAt: { gte: since } },
      select: { dropId: true },
      distinct: ['dropId'],
    }),
    prisma.ledgerEntry.findMany({
      where: { createdAt: { gte: since }, dropId: { not: null } },
      select: { dropId: true },
      distinct: ['dropId'],
    }),
  ]);

  const candidateIds = [
    ...new Set([
      ...recentOrders.map((row) => row.dropId),
      ...recentLedger.map((row) => row.dropId as string),
    ]),
  ].slice(0, limit);

  const drops = await prisma.drop.findMany({
    where: { id: { in: candidateIds } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      merchant: { select: { stripeAccountId: true } },
      orders: { select: { stripeChargeId: true } },
    },
  });

  const ledgerRows = await prisma.ledgerEntry.findMany({
    where: { dropId: { in: drops.map((drop) => drop.id) } },
    select: { dropId: true, type: true, amountCents: true, stripeRef: true },
  });

  const mismatches: L5Mismatch[] = [];
  let checked = 0;
  let skipped = 0;

  for (const drop of drops) {
    const stripeAccountId = drop.merchant.stripeAccountId;
    if (!stripeAccountId) {
      mismatches.push({
        dropId: drop.id,
        reason: 'MISSING_STRIPE_ACCOUNT',
        detail: 'A drop with orders has no connected Stripe account.',
      });
      continue;
    }

    const chargeIds = [
      ...new Set(
        drop.orders
          .map((order) => order.stripeChargeId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (chargeIds.length === 0) {
      // No charge was ever taken; there is no connected-account balance to reconcile.
      skipped += 1;
      continue;
    }

    const rows = ledgerRows.filter((row) => row.dropId === drop.id);
    const refundIds = [
      ...new Set(
        rows
          .filter((row) => row.type === 'REFUND')
          .map((row) => row.stripeRef)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];

    try {
      const provider = await args.port.read({ stripeAccountId, chargeIds, refundIds });
      const result = reconcileL5({
        entries: rows.map((row) => ({ type: row.type, amountCents: row.amountCents })),
        connected: provider.connected,
        platform: provider.platform,
      });
      checked += 1;

      if (!result.ok) {
        mismatches.push({ dropId: drop.id, reason: 'L5', checks: result.checks });
        for (const failed of result.checks.filter((entry) => !entry.ok)) {
          logger.error('reconciliation.mismatch', {
            dropId: drop.id,
            check: failed.name,
            expectedCents: failed.expectedCents,
            actualCents: failed.actualCents,
            differenceCents: failed.differenceCents,
          });
        }
      }
    } catch (error) {
      checked += 1;
      mismatches.push({
        dropId: drop.id,
        reason: 'PROVIDER_ERROR',
        detail: error instanceof Error ? error.name : 'unknown',
      });
      logger.warn('reconciliation.provider_error', {
        dropId: drop.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  return {
    since: since.toISOString(),
    dropsChecked: checked,
    dropsSkipped: skipped,
    ok: mismatches.length === 0,
    mismatches,
  };
}
