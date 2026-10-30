import { formatCents } from '@/lib/guardrail';
import type { DealView } from '@/lib/guardrail';
import { breakdownLabels } from '@/lib/copy/guardrail-copy';

/**
 * PRD-sprint1 §6.4 rule 1 — the breakdown the merchant can add up.
 *
 * `keep + our fee + card fees + ingredients = the price`. That is a structural
 * guarantee from `buildDealView` (the contribution row is derived as the
 * remainder), not arithmetic luck, so this component does no maths: it prints four
 * integers and the total.
 *
 * The total row is rendered on purpose. A merchant who adds the column and gets
 * the price back is the single highest-leverage trust device on the screen, and
 * making them do the addition themselves wastes it.
 *
 * No arithmetic on money here (§7.2 rule 2): every figure comes from the view,
 * formatted.
 */
export function BreakdownTable({ view }: { view: DealView }) {
  const labels = breakdownLabels();
  const rows: readonly { label: string; cents: number }[] = [
    { label: labels.keep, cents: view.breakdown.contributionCents },
    { label: labels.ourFee, cents: view.breakdown.platformFeeCents },
    { label: labels.cardFees, cents: view.breakdown.cardFeeCents },
    { label: labels.ingredientsAndContainer, cents: view.breakdown.ingredientsAndPackagingCents },
  ];

  return (
    <div className="mt-4 border-t border-slate-200 pt-3">
      <dl className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="text-ink-soft">{row.label}</dt>
            <dd className="tabular-nums text-ink">{formatCents(row.cents)}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-slate-200 pt-1.5 text-sm">
          <dt className="text-ink-soft">Deal price</dt>
          <dd className="tabular-nums font-medium text-ink">
            {formatCents(view.dealPriceCents)}
          </dd>
        </div>
      </dl>

      <dl className="mt-3 space-y-1.5 border-t border-slate-200 pt-3">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <dt className="text-ink-soft">{labels.shareOfMenuPrice}</dt>
          <dd className="tabular-nums text-ink">{view.contributionPctOfMenu}%</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <dt className="text-ink-soft">{labels.yourMinimum}</dt>
          <dd className="tabular-nums text-ink">{view.floorPctOfMenu}%</dd>
        </div>
      </dl>
    </div>
  );
}
