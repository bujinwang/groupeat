import { Card } from '@/components/ui/Card';
import { DropForm, type DishOption } from '@/components/drops/DropForm';
import { requireMerchant } from '@/lib/auth/authorize';
import { listItems } from '@/lib/db/items';
import { primaryMerchantFloor } from '@/lib/db/merchants';
import { DEFAULT_FEES, minViablePrice } from '@/lib/guardrail';

/**
 * `/merchant/drops/new` — start a drop from a batchable dish (FR-201).
 *
 * The per-dish minimum is computed **here**, on the server, and passed to the
 * form as a prop. That is the point: the form shows the real floor in the helper
 * text and as a warning, but it cannot decide it. A tampered value in the browser
 * changes what the merchant sees, not what the server enforces.
 */

export const dynamic = 'force-dynamic';

export default async function NewDropPage() {
  const { merchantIds } = await requireMerchant();
  const [items, floor] = await Promise.all([listItems(merchantIds), primaryMerchantFloor(merchantIds)]);

  // FR-104 / AGLC: alcohol and non-batchable dishes never appear as options, so
  // the merchant cannot build a drop the publish path would refuse.
  const dishes: DishOption[] = items
    .filter((item) => item.isBatchable && !item.containsAlcohol)
    .map((item) => ({
      id: item.id,
      name: item.name,
      menuPriceCents: item.menuPriceCents,
      batchYield: item.batchYield,
      minViablePriceCents: minViablePrice({
        ...DEFAULT_FEES,
        menuPriceCents: item.menuPriceCents,
        foodCostCents: item.foodCostCents,
        packagingCents: item.packagingCents,
        floorPctOfMenu: floor.floorPctOfMenu,
      }),
    }));

  if (dishes.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">New drop</h1>
        <Card>
          <p className="text-sm font-medium">No dish can be a drop yet.</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            A drop starts with a dish you can make in batches, with its ingredient cost filled
            in. Add one on the Dishes screen and it will appear here.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">New drop</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          Save it as a draft first. Nothing is shown to anyone until you publish.
        </p>
      </div>

      <Card>
        <DropForm dishes={dishes} submitLabel="Save draft" />
      </Card>
    </div>
  );
}
