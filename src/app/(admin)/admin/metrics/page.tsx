import { Card } from '@/components/ui/Card';
import { requireAdmin } from '@/lib/auth/authorize';
import { loadNorthStarMetrics } from '@/lib/db/metrics';
import type { MetricRatio } from '@/lib/metrics/north-star';

/**
 * `/admin/metrics` — PRD-v1 §10.2's north-star dashboard.
 *
 * The PRD calls the threshold hit rate the only V1 success metric and asks for the
 * board before feature polish. It was absent; the eight definitions existed only in
 * prose and in per-drop reports.
 *
 * ## What the page adds that the reports do not
 *
 * `/merchant/reports` answers "how did my drop do" for one merchant. This answers
 * "is the mechanic working" across every drop, including the ones no merchant would
 * show you: the failed ones, the uncancelled live ones waiting for a cutoff, and the
 * customers whose second order is the only proof of retention.
 *
 * ## All-time, and stated as such
 *
 * There is no period selector. A period control would need a definition of which
 * drops belong to a month (cutoff? pickup? capture?) and the reports already disagree
 * with the commission statement on that boundary; adding a third answer to a dashboard
 * is worse than an honest all-time figure. `since` is a later slice if the beta asks.
 *
 * ## Zero denominators are `null`, not 0%
 *
 * "No drop has been decided yet" and "0% of drops hit" are different facts. The pure
 * module returns `null`; this page prints "Not measured yet" and the counts so an
 * operator can tell which one they are looking at.
 */

export const dynamic = 'force-dynamic';

function pct(value: number | null): string {
  return value === null ? 'Not measured yet' : `${Math.round(value * 100)}%`;
}

function ratioDetail(metric: MetricRatio): string {
  return `${metric.numerator} / ${metric.denominator}`;
}

function fillLabel(value: number | null): string {
  return value === null ? 'Not measured yet' : `${value.toFixed(2)}×`;
}

function hoursLabel(value: number | null): string {
  return value === null ? 'Not measured yet' : `${value.toFixed(1)} h`;
}

function MetricCard({
  title,
  value,
  detail,
  helper,
}: {
  title: string;
  value: string;
  detail: string;
  helper: string;
}) {
  return (
    <Card>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs tabular-nums text-ink-soft">{detail}</p>
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">{helper}</p>
    </Card>
  );
}

export default async function AdminMetricsPage() {
  await requireAdmin();
  const metrics = await loadNorthStarMetrics();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">North-star</h1>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          All drops, all time. Threshold hit rate is the V1 success metric; the rest
          explain it. A blank denominator means there is nothing to measure yet, not
          that the answer is zero.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          title="Threshold hit rate"
          value={pct(metrics.thresholdHitRate.value)}
          detail={ratioDetail(metrics.thresholdHitRate)}
          helper="Decided drops that reached their minimum ÷ all decided drops. Cancelled and still-filling drops are not decisions."
        />
        <MetricCard
          title="Median fill rate"
          value={fillLabel(metrics.medianFillRate)}
          detail="joined ÷ minimum, median over decided drops"
          helper="1.00× is exactly the minimum. Voided authorisations still count as demand; declined cards do not."
        />
        <MetricCard
          title="Time to first publish"
          value={hoursLabel(metrics.medianHoursToFirstPublish)}
          detail="median across merchants with a published drop"
          helper="From merchant creation to the first publish. The PRD target is under 20 minutes."
        />
        <MetricCard
          title="Join conversion"
          value={pct(metrics.joinConversion.value)}
          detail={ratioDetail(metrics.joinConversion)}
          helper="Authorised joins ÷ human deal-page views, from the analytics sink. A missing sink reads as not measured."
        />
        <MetricCard
          title="Organiser share rate"
          value={pct(metrics.organiserShareRate.value)}
          detail={ratioDetail(metrics.organiserShareRate)}
          helper="Drops with at least one share link ÷ drops ever published."
        />
        <MetricCard
          title="Redemption rate"
          value={pct(metrics.redemptionRate.value)}
          detail={ratioDetail(metrics.redemptionRate)}
          helper="Redeemed plates ÷ captured plates. A no-show is a merchant loss, not a refund."
        />
        <MetricCard
          title="Repeat participant rate"
          value={pct(metrics.repeatParticipantRate.value)}
          detail={ratioDetail(metrics.repeatParticipantRate)}
          helper="Customers with two or more captured orders ÷ customers with at least one."
        />
        <MetricCard
          title="New-customer share"
          value={pct(metrics.newCustomerShare.value)}
          detail={ratioDetail(metrics.newCustomerShare)}
          helper="Orders that were the customer's first capture anywhere ÷ all captured orders. The PRD target is at least 50%."
        />
      </div>

      <p className="text-xs leading-relaxed text-ink-soft">
        The last two are the merchant&apos;s proof that a drop was incremental rather than
        cannibalised. A low new-customer share is the signal to change item selection,
        not to discount harder.
      </p>
    </div>
  );
}
