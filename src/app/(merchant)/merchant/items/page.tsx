import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { requireMerchant } from '@/lib/auth/authorize';
import { listItems, primaryMerchantId } from '@/lib/db/items';
import { getFloor } from '@/lib/db/merchants';
import { formatCents } from '@/lib/guardrail';
import { PanelState } from '@/lib/guardrail';
import { evaluateItem } from '@/lib/items/evaluate';

/**
 * `/merchant/items` — the merchant's dish list (PRD-sprint1 §6.2).
 *
 * Each card shows the dish name, menu price, and a status badge derived from the
 * guardrail evaluation. The evaluation is computed server-side on every request;
 * it is cheap (pure function, no I/O) and guarantees the badge reflects the
 * current floor setting.
 */

export const dynamic = 'force-dynamic';

function statusOf(
  evaluation: ReturnType<typeof evaluateItem>,
): { label: string; tone: 'ok' | 'thin' | 'blocked' | 'neutral' } {
  if (evaluation.ineligible) {
    return { label: 'Blocked', tone: 'blocked' };
  }
  switch (evaluation.state) {
    case PanelState.OK:
    case PanelState.FLOOR:
      return { label: 'Ready', tone: 'ok' };
    case PanelState.THIN:
      return { label: 'Thin margin', tone: 'thin' };
    case PanelState.INFEASIBLE:
      return { label: "Can't deal", tone: 'blocked' };
    default:
      return { label: 'Needs work', tone: 'neutral' };
  }
}

export default async function ItemsListPage() {
  const { merchantIds } = await requireMerchant();
  const items = await listItems(merchantIds);
  const merchantId = await primaryMerchantId(merchantIds);
  const floorPctOfMenu = await getFloor(merchantId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dishes</h1>
        <Link
          href="/merchant/items/new"
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark"
        >
          + New dish
        </Link>
      </div>

      {items.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-soft">No dishes yet.</p>
          <p className="mt-1 text-xs text-ink-soft">
            Add your first dish and we&apos;ll tell you whether it can be part of a deal.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const evaluation = evaluateItem({ item, floorPctOfMenu });
            const status = statusOf(evaluation);
            return (
              <li key={item.id}>
                <Card as="article">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-medium text-ink">{item.name}</h2>
                      <p className="text-xs text-ink-soft">
                        {formatCents(item.menuPriceCents)} menu price
                      </p>
                    </div>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <Link
                    href={`/merchant/items/${item.id}`}
                    className="mt-3 inline-block text-sm text-brand hover:text-brand-dark"
                  >
                    Edit →
                  </Link>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
