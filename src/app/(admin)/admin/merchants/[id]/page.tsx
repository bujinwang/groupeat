import Link from 'next/link';
import { notFound } from 'next/navigation';

import { FloorEditor } from '@/components/admin/FloorEditor';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { getMerchant } from '@/lib/db/merchants';
import { highestMenuPriceCents, listItems } from '@/lib/db/items';
import { evaluateItem } from '@/lib/items/evaluate';
import { formatCents } from '@/lib/guardrail';
import { panelCopy } from '@/lib/copy/guardrail-copy';
import { ineligibleCopy } from '@/lib/copy/guardrail-copy';

/**
 * `/admin/merchants/:id` — pickup details, the minimum-margin editor, and a
 * read-only view of each dish's evaluation (US-A2).
 *
 * The floor editor is the admin's job, not the merchant's: PRD-sprint1 Q-4 keeps
 * it out of the merchant's first session so a merchant cannot lower the floor to
 * "make the deal work".
 */

export const dynamic = 'force-dynamic';

export default async function AdminMerchantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const merchant = await getMerchant(id);
  if (!merchant) {
    notFound();
  }

  const merchantIds = [merchant.id];
  const [items, highest] = await Promise.all([
    listItems(merchantIds),
    highestMenuPriceCents(merchantIds),
  ]);

  // PRD-sprint1 §5.1: the dollar example uses the merchant's own highest-priced
  // dish, and falls back to $16.00 only when they have none.
  const exampleMenuPriceCents = highest ?? 1600;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/users" className="text-sm text-ink-soft underline underline-offset-4">
          ← Users
        </Link>
        <div className="mt-2 flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">{merchant.name}</h1>
          <Badge tone={merchant.status === 'ACTIVE' ? 'ok' : 'neutral'}>{merchant.status}</Badge>
        </div>
        <p className="text-xs text-ink-soft">/{merchant.slug}</p>
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">Settings</h2>
        <FloorEditor
          merchantId={merchant.id}
          floorPctOfMenu={merchant.floorPctOfMenu}
          pickupAddress={merchant.pickupAddress}
          pickupInstructions={merchant.pickupInstructions}
          exampleMenuPriceCents={exampleMenuPriceCents}
        />
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Dishes ({items.length})</h2>
        <ul className="space-y-2">
          {items.map((item) => {
            const evaluation = evaluateItem({ item, floorPctOfMenu: merchant.floorPctOfMenu });
            const copy = evaluation.ineligible
              ? ineligibleCopy(evaluation.ineligible)
              : panelCopy(evaluation.state, evaluation.view);
            const lowest = evaluation.view?.minViablePriceCents ?? null;

            return (
              <Card as="li" key={item.id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium">{item.name}</p>
                  <span className="shrink-0 text-sm">{formatCents(item.menuPriceCents)}</span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  {lowest === null
                    ? copy.headline
                    : `Lowest deal price ${formatCents(lowest)}`}
                </p>
              </Card>
            );
          })}
        </ul>
        {items.length === 0 ? (
          <p className="text-sm text-ink-soft">This merchant has no dishes yet.</p>
        ) : null}
      </section>
    </div>
  );
}
