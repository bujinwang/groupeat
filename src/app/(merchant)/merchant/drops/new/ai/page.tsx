import { Card } from '@/components/ui/Card';
import { DealBuilder, type BuilderDish } from '@/components/drops/DealBuilder';
import { requireMerchant } from '@/lib/auth/authorize';
import { listItems } from '@/lib/db/items';
import { getMerchantInScope, primaryMerchantFloor } from '@/lib/db/merchants';
import { DEFAULT_FEES, minViablePrice } from '@/lib/guardrail';

/**
 * `/merchant/drops/new/ai` — the five-question interview (PRD-v1 §9.2).
 *
 * The dish list is built here, on the server, from the same filter the manual
 * form uses: batchable, not alcohol, not archived. A dish the publish path would
 * refuse never reaches the picker, so the interview cannot plan an offer that
 * cannot go live.
 *
 * `timeZone` is the merchant's own, read from `Merchant.timezone` and passed down
 * so the card labels and the generated group-chat message cannot disagree about
 * what time pickup starts.
 */

export const dynamic = 'force-dynamic';

export default async function DealBuilderPage() {
  const { merchantIds } = await requireMerchant();
  const [items, floor] = await Promise.all([listItems(merchantIds), primaryMerchantFloor(merchantIds)]);
  const merchant = merchantIds[0]
    ? await getMerchantInScope(merchantIds, merchantIds[0])
    : null;

  const dishes: BuilderDish[] = items
    .filter((item) => item.isBatchable && !item.containsAlcohol)
    .map((item) => ({
      id: item.id,
      name: item.name,
      menuPriceCents: item.menuPriceCents,
      foodCostCents: item.foodCostCents,
      packagingCents: item.packagingCents,
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
        <h1 className="text-lg font-semibold">Plan a drop</h1>
        <Card>
          <p className="text-sm font-medium">No dish can be a drop yet.</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            A drop starts with a dish you can make in batches, with its ingredient cost filled in.
            Add one on the Dishes screen and come back.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Plan a drop</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          Five questions. You will get three ways to run it, each with a price that still clears
          your minimum margin.
        </p>
      </div>

      <DealBuilder dishes={dishes} timeZone={merchant?.timezone ?? 'America/Edmonton'} />
    </div>
  );
}
