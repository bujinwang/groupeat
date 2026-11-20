import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { reportViewed } from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';
import { requireMerchant } from '@/lib/auth/authorize';
import { primaryMerchantId } from '@/lib/db/items';
import { getMerchant } from '@/lib/db/merchants';
import { merchantReportQuery } from '@/lib/db/reports';
import { formatCents } from '@/lib/guardrail';
import type { CustomerMix, DropReportRow, SuggestedAction } from '@/lib/reports/drop-report';

/**
 * `/merchant/reports` — M9, FR-701…FR-703 and FR-705's merchant surface.
 *
 * ## FR-704 is built, and deliberately not on this page
 *
 * > `FR-704 | Weekly email digest (Monday 08:00 MT) | Sent only to consenting owners`
 * > — PRD-v1.md:520
 *
 * The digest is a separate surface for a reason: it is an **email**, not a screen. Its
 * consent lives in `/merchant/settings` beside the other account preferences; its
 * composition is `lib/reports/digest.ts`; and its sender is the Monday cron at
 * `/api/jobs/digest`. Putting a second copy of the same figures on this page would give
 * the two surfaces different rounding, different periods and different definitions of
 * "kept".
 *
 * The report below is still the full one — every drop, attribution, and the figures a
 * merchant can reconcile against the email. The email is a summary that links here
 * when `APP_URL` provides an origin, and says "open GroupEat" when it does not.
 *
 * ## Why the report is bounded to 50 drops
 *
 * `reportSourcesFor` takes a `limit`. A merchant on their two-hundredth drop would
 * otherwise build a page whose cost grows every week forever, and the figure they
 * actually open this screen for is recent. The page says how many drops it covers
 * rather than implying it is everything.
 *
 * ## The two honesty notes the figures require
 *
 * 1. **New vs returning is whole-history and platform-wide.** The `Customer` row is
 *    keyed on a phone number and is not owned by a merchant, so "returning" means
 *    "this person had bought through GroupEat before", which is the incrementality
 *    question §6.7 asks — not "had bought from *you* before". Saying so is the
 *    difference between a useful number and a misleading one.
 * 2. **Withheld drops are named.** A drop whose figures do not reconcile with its
 *    ledger is left out and counted. A merchant who ran six drops and sees five
 *    needs to know which kind of missing that is.
 */

export const dynamic = 'force-dynamic';

/** Whole percent, from a 0…1 rate. Rounded at render — rates are exact until here. */
function pctLabel(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

const ACTION_TONE: Record<SuggestedAction['kind'], BadgeTone> = {
  SOLD_OUT: 'ok',
  MISSED_MINIMUM: 'blocked',
  NO_CUSTOMERS: 'thin',
  PERFORMED_WELL: 'neutral',
};

/**
 * FR-705 in words.
 *
 * Each arm names the number it is advising on, because "try 30 units" without "you
 * sold out at 20" is advice a merchant cannot connect to anything they did. The
 * `PERFORMED_WELL` arm says there is nothing to change — a report that always
 * suggests something is a report nobody reads.
 */
function actionSentence(action: SuggestedAction): string {
  switch (action.kind) {
    case 'SOLD_OUT':
      return `Sold out at ${action.soldOutAtQty}. Try ${action.suggestedQty} units next time.`;
    case 'MISSED_MINIMUM':
      return `Fell ${action.shortBy} short of the ${action.minQty} you needed. Try a smaller ask, or move the window.`;
    case 'NO_CUSTOMERS':
      return 'Nobody new bought this one. Worth sharing to a wider audience.';
    case 'PERFORMED_WELL':
      return `Worked. ${pctLabel(action.newCustomerPct)} of buyers were new.`;
  }
}

function CustomerMixCell({ mix }: { mix: CustomerMix }) {
  if (mix.totalCustomers === 0) {
    return <span className="text-xs text-ink-soft">No buyers</span>;
  }
  return (
    <span className="text-xs text-ink-soft">
      {mix.newCustomers} new · {mix.returningCustomers} returning
    </span>
  );
}

function DropRow({ row }: { row: DropReportRow }) {
  return (
    <li className="border-t border-slate-100 py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{row.dropTitle}</p>
          <p className="text-xs text-ink-soft">{row.pickupDate}</p>
        </div>
        <Badge tone={ACTION_TONE[row.suggestedAction.kind]}>
          {row.suggestedAction.kind === 'SOLD_OUT'
            ? 'Sold out'
            : row.suggestedAction.kind === 'MISSED_MINIMUM'
              ? 'Missed minimum'
              : row.suggestedAction.kind === 'NO_CUSTOMERS'
                ? 'No new customers'
                : 'Went well'}
        </Badge>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-ink-soft">Units sold</dt>
          <dd className="font-medium text-ink">{row.figures.unitsSold}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">GMV</dt>
          <dd className="font-medium text-ink">{formatCents(row.figures.gmvCents)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Platform fee</dt>
          <dd className="font-medium text-ink">{formatCents(row.figures.platformFeeCents)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Contribution</dt>
          <dd className="font-medium text-ink">{formatCents(row.figures.contributionCents)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Contribution %</dt>
          <dd className="font-medium text-ink">{pctLabel(row.figures.contributionPctOfGmv)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Customers</dt>
          <dd>
            <CustomerMixCell mix={row.customerMix} />
          </dd>
        </div>
      </dl>

      {row.figures.refundedCents > 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-soft">
          {formatCents(row.figures.refundedCents)} went back to diners, so this drop kept{' '}
          {formatCents(row.figures.netCapturedCents)}.
        </p>
      ) : null}

      {row.attribution.length > 0 ? (
        <div className="mt-3 rounded-lg bg-surface-muted p-2">
          <p className="text-xs font-medium text-ink">Who brought people</p>
          <ul className="mt-1 space-y-0.5">
            {row.attribution.map((entry) => (
              <li key={entry.organiserProfileId} className="text-xs text-ink-soft">
                {entry.organiserName} — {entry.units} {entry.units === 1 ? 'unit' : 'units'},{' '}
                {formatCents(entry.gmvCents)}
              </li>
            ))}
            {row.unattributedUnits > 0 ? (
              <li className="text-xs text-ink-soft">
                Direct link — {row.unattributedUnits}{' '}
                {row.unattributedUnits === 1 ? 'unit' : 'units'}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <p className="mt-2 text-xs leading-relaxed text-ink">{actionSentence(row.suggestedAction)}</p>
    </li>
  );
}

export default async function MerchantReportsPage() {
  const { merchantIds } = await requireMerchant();
  const merchantId = await primaryMerchantId(merchantIds);
  const merchant = await getMerchant(merchantId);

  if (!merchant) {
    return <p className="text-sm text-ink-soft">No merchant is attached to this account.</p>;
  }

  const report = await merchantReportQuery({
    merchantId,
    merchantName: merchant.name,
    timezone: merchant.timezone,
  });

  // The report was assembled for a merchant who has one. The seam is the page,
  // not the shared report layer: the weekly digest assembles the same figures
  // through `reportSourcesFor` + `merchantReportFor` on a schedule, and an email
  // is not a screen. An empty report is still a view — the early return below is
  // a rendering decision, not a measurement one — and the no-merchant early
  // return above never reaches here.
  record(
    reportViewed({
      merchantId,
      dropCount: report.dropCount,
      withheldDropCount: report.withheldDropCount,
    }),
  );

  if (report.dropCount === 0 && report.withheldDropCount === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Reports</h1>
        <Card>
          <p className="text-sm leading-relaxed text-ink-soft">
            Nothing to report yet. Once a drop closes and the cards are charged, its numbers
            appear here — units, revenue, what you kept, and who bought.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Reports</h1>

      {report.withheldDropCount > 0 ? (
        // Named rather than hidden: a merchant who ran six drops and sees five needs
        // to know which kind of missing this is. The figures are withheld because
        // they did not reconcile — printing them would be worse than omitting them.
        <Card>
          <p className="text-sm leading-relaxed text-blocked">
            {report.withheldDropCount}{' '}
            {report.withheldDropCount === 1 ? 'drop is' : 'drops are'} not shown because{' '}
            {report.withheldDropCount === 1 ? 'its figures do' : 'their figures do'} not agree
            with our payment records. We would rather show you nothing than a number we cannot
            stand behind. This has been flagged for review.
          </p>
        </Card>
      ) : null}

      <Card>
        <h2 className="text-sm font-semibold">
          Across {report.dropCount === 1 ? 'this drop' : `all ${report.dropCount} drops`}
        </h2>
        {/*
          The labels are prefixed "Total" rather than reusing the per-drop names.
          Not cosmetic: two `<dt>`s reading "GMV" on one page leave a merchant
          unable to tell which figure is the sum and which is a single drop, and it
          made the page's own test unable to assert either — the duplicate-label
          check in `page.test.ts` is what found it.
        */}
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-soft">Total units sold</dt>
            <dd className="font-semibold text-ink">{report.totals.unitsSold}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-soft">Total GMV</dt>
            <dd className="font-semibold text-ink">{formatCents(report.totals.gmvCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-soft">Total platform fee</dt>
            <dd className="font-semibold text-ink">{formatCents(report.totals.platformFeeCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-soft">Total contribution</dt>
            <dd className="font-semibold text-ink">
              {formatCents(report.totals.contributionCents)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-soft">Overall contribution %</dt>
            <dd className="font-semibold text-ink">
              {pctLabel(report.totals.contributionPctOfGmv)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-soft">New customers, all drops</dt>
            <dd className="font-semibold text-ink">
              {report.totalCustomerMix.newCustomers} of {report.totalCustomerMix.totalCustomers}
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs leading-relaxed text-ink-soft">
          Contribution is what you kept: what diners paid, less food and packaging cost, card
          fees and our fee. Contribution % is that figure divided by GMV, so it is the share of
          each dollar you keep.
        </p>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">By drop</h2>
        <ul className="mt-3">
          {report.rows.map((row) => (
            <DropRow key={row.dropId} row={row} />
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">How &ldquo;new&rdquo; is counted</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          A customer is <span className="font-medium text-ink">new</span> on a drop when that
          drop was the first time they had ever been charged through GroupEat. A card that was
          authorised but never charged — because a drop did not reach its minimum, or was called
          off — does not count as a visit, so it cannot make someone look like a returning
          customer.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          This is measured across the whole platform, not just your deals, because a diner is one
          person with one phone number. It answers &ldquo;did this drop bring me someone who was
          not already buying here&rdquo;, which is what tells you whether running deals grows your
          business.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          The totals above add each drop&rsquo;s count, so somebody who bought on three of your
          drops counts three times. Per-drop figures are the ones to compare; the total is a
          measure of buying, not of people.
        </p>
      </Card>
    </div>
  );
}
