import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { buttonClass } from '@/components/ui/Button';
import { requireMerchant } from '@/lib/auth/authorize';
import { listDrops } from '@/lib/db/drops';
import { listItems } from '@/lib/db/items';
import { formatCents } from '@/lib/guardrail';

/**
 * `/merchant/drops` — the merchant's drops, newest first.
 *
 * Reads `Drop.status` rather than deriving anything: unlike the dish list, there
 * is no guardrail state to compute here. A published drop's money lives in its
 * frozen snapshot, and a draft's money is provisional by definition — so the
 * list shows the price and the status and does not pretend to evaluate them.
 */

export const dynamic = 'force-dynamic';

const STATUS_COPY: Record<string, { label: string; tone: 'ok' | 'thin' | 'blocked' | 'neutral' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PUBLISHED: { label: 'Live', tone: 'ok' },
  LOCKED: { label: 'Locked in', tone: 'ok' },
  CAPTURED: { label: 'Charged', tone: 'ok' },
  PICKUP_OPEN: { label: 'Pickup open', tone: 'ok' },
  COMPLETED: { label: 'Done', tone: 'neutral' },
  FAILED: { label: 'Did not fill', tone: 'blocked' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export default async function DropsListPage() {
  const { merchantIds } = await requireMerchant();
  const [drops, items] = await Promise.all([listDrops(merchantIds), listItems(merchantIds)]);

  const itemNames = new Map(items.map((item) => [item.id, item.name]));
  // A merchant with no batchable dish cannot create a drop: FR-201 starts by
  // picking one. Saying so up front is kinder than an empty select.
  const hasBatchableDish = items.some((item) => item.isBatchable && !item.containsAlcohol);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Drops</h1>
        {hasBatchableDish ? (
          <Link href="/merchant/drops/new" className={buttonClass('primary')}>
            New drop
          </Link>
        ) : (
          <Link href="/merchant/items/new" className={buttonClass('secondary')}>
            Add a dish first
          </Link>
        )}
      </div>

      {drops.length === 0 ? (
        <Card>
          <p className="text-sm font-medium">No drops yet.</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            {hasBatchableDish
              ? 'A drop is a batch of one dish, sold in advance to a group, collected in a window you choose. You set the lowest price you will accept, and GroupEat will not let you publish below it.'
              : 'A drop needs a dish you can make in batches. Add one with its ingredient cost, and it becomes available here.'}
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {drops.map((drop) => {
            const status = STATUS_COPY[drop.status] ?? { label: drop.status, tone: 'neutral' as const };
            return (
              <li key={drop.id}>
                <Link href={`/merchant/drops/${drop.id}`} className="block">
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{drop.title}</p>
                        <p className="mt-1 text-xs text-ink-soft">
                          {itemNames.get(drop.menuItemId) ?? 'Dish removed'} ·{' '}
                          {formatCents(drop.dealPriceCents)} · need {drop.minQty}
                        </p>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
