import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ItemForm, type ItemFormValues } from '@/components/items/ItemForm';
import { requireMerchant } from '@/lib/auth/authorize';
import { findItem } from '@/lib/db/items';
import { getFloor } from '@/lib/db/merchants';
import { evaluateItem, ineligibilityOf } from '@/lib/items/evaluate';

/**
 * `/merchant/items/:id` — the dish form plus the evaluation for the saved dish.
 *
 * The evaluation is computed **on the server** and passed in, so the first paint
 * already shows a number; the form re-evaluates on a cost change, debounced.
 *
 * A dish outside the caller's scope is a `notFound()`, never a 403.
 */

export const dynamic = 'force-dynamic';

export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { merchantIds } = await requireMerchant();

  const item = await findItem(merchantIds, id);
  if (!item) {
    notFound();
  }

  const floorPctOfMenu = await getFloor(item.merchantId);
  const evaluation = evaluateItem({ item, floorPctOfMenu });

  const initialValues: ItemFormValues = {
    id: item.id,
    name: item.name,
    menuPriceCents: item.menuPriceCents,
    foodCostCents: item.foodCostCents,
    packagingCents: item.packagingCents,
    batchYield: String(item.batchYield),
    prepMinutes: item.prepMinutes === null ? '' : String(item.prepMinutes),
    isBatchable: item.isBatchable,
    containsAlcohol: item.containsAlcohol,
    category: item.category ?? '',
  };

  return (
    <div className="space-y-4">
      <div>
        <Link href="/merchant/items" className="text-sm text-ink-soft underline underline-offset-4">
          ← Dishes
        </Link>
        <h1 className="mt-2 text-lg font-semibold">{item.name}</h1>
      </div>
      <ItemForm
        initialValues={initialValues}
        initialEvaluation={evaluation}
        ineligible={ineligibilityOf(item)}
      />
    </div>
  );
}
