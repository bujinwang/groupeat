import { Card } from '@/components/ui/Card';
import { floorWarningCopy } from '@/lib/copy/guardrail-copy';
import { requireMerchant } from '@/lib/auth/authorize';
import { highestMenuPriceCents } from '@/lib/db/items';
import { getMerchant } from '@/lib/db/merchants';
import { FLOOR_WARN_THRESHOLD, formatCents, roundHalfUp } from '@/lib/guardrail';

/**
 * `/merchant/settings` — the minimum margin, read-only (PRD-sprint1 §5.1, A-4).
 *
 * Two product rules are enforced by what this page *does not* do:
 *
 *   1. **The field is not editable here.** Q-4: a merchant who lowers their floor
 *      to "make the deal work" has defeated the guardrail. The only path is the
 *      INFEASIBLE escape hatch, behind a confirmation that names the consequence.
 *   2. **The warning appears only here, and only under 15%.** It must never
 *      appear on first login, on the dish screen, in the panel, as a modal, a
 *      toast or an email — a warning shown before the merchant has a reason to
 *      care teaches them to dismiss warnings.
 */

export const dynamic = 'force-dynamic';

export default async function MerchantSettingsPage() {
  const { merchantIds } = await requireMerchant();
  const merchantId = merchantIds[0];

  if (!merchantId) {
    return <p className="text-sm text-ink-soft">No merchant is attached to this account.</p>;
  }

  const [merchant, highest] = await Promise.all([
    getMerchant(merchantId),
    highestMenuPriceCents(merchantIds),
  ]);

  if (!merchant) {
    return <p className="text-sm text-ink-soft">No merchant is attached to this account.</p>;
  }

  // PRD-sprint1 §5.1: the example uses the merchant's own highest-priced dish, and
  // falls back to $16.00 only when they have none.
  const exampleMenuPriceCents = highest ?? 1600;
  const floorCents = roundHalfUp(exampleMenuPriceCents * merchant.floorPctOfMenu);
  const floorPercent = roundHalfUp(merchant.floorPctOfMenu * 100);
  const isThin = merchant.floorPctOfMenu < FLOOR_WARN_THRESHOLD;
  const warning = isThin ? floorWarningCopy({ pct: merchant.floorPctOfMenu, menuPriceCents: exampleMenuPriceCents }) : null;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card>
        <h2 className="text-sm font-semibold">Your minimum margin</h2>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{floorPercent}%</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          The least you&apos;ll accept per plate on a batch order, as a share of your menu price. At{' '}
          {floorPercent}%, a {formatCents(exampleMenuPriceCents)} dish must leave you at least{' '}
          {formatCents(floorCents)} per plate.
        </p>

        {warning ? (
          <div className="mt-4 rounded-lg border border-thin/30 bg-thin/5 p-3">
            <p className="text-sm font-medium text-thin">{warning.headline}</p>
            {warning.body.map((line) => (
              <p key={line} className="mt-1 text-sm leading-relaxed text-ink-soft">
                {line}
              </p>
            ))}
          </div>
        ) : null}

        <p className="mt-4 text-xs leading-relaxed text-ink-soft">
          Only your GroupEat contact can change this, so it cannot be lowered in the middle of
          pricing a deal. If a dish cannot be a deal at your minimum, the dish screen explains the
          two ways out.
        </p>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Pickup</h2>
        <p className="mt-2 text-sm text-ink">
          {merchant.pickupAddress ?? 'No pickup address set yet.'}
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          {merchant.pickupInstructions ?? 'No pickup instructions set yet.'}
        </p>
      </Card>
    </div>
  );
}
