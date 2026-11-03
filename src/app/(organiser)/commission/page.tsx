import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { getSession } from '@/lib/auth/session';
import {
  commissionMonthsFor,
  commissionStatementFor,
  currentCommissionMonthKey,
  resolveCommissionMonth,
} from '@/lib/db/commission';
import { organiserProfileForUser } from '@/lib/db/share-links';
import { formatCents } from '@/lib/guardrail';
import {
  commissionPctLabel,
  shiftMonthKey,
  type CommissionDropStatus,
} from '@/lib/organisers/commission';

/**
 * `/commission` — FR-804's organiser surface.
 *
 * > `FR-804 | Commission statement: units × 5% of captured GMV | Monthly,
 * > exportable` — PRD-v1.md:539
 *
 * A server component reading one live query. No client state, no writes, and
 * `force-dynamic` so a cached render can never show yesterday's figure as today's —
 * the whole point of the page is that the number moves.
 *
 * ## The page has one obligation the spec does not put in a table: say what the number is
 *
 * Because there is no `CommissionPayout` table (see `lib/db/commission.ts`), the
 * statement is recomputed every time it is opened. That has a consequence an operator
 * can be badly misled by, and it is not visible anywhere in the arithmetic:
 * **a refund landing after a month was paid restates that month.** Someone who
 * believes March is frozen will pay from a stale export, then re-open March, see a
 * smaller number, and conclude the system is broken — or, worse, never re-open it and
 * not notice they overpaid.
 *
 * So the sentence is on the page, in words, above the figures. It is not in the CSV:
 * the CSV is a data file, and a preamble row in a data file breaks the first thing
 * anyone does with it. The CSV's job is to be the record; this paragraph's job is to
 * say that it is.
 *
 * ## The missing-profile case, from FR-906
 *
 * An `ORGANISER` account with no `OrganiserProfile` signs in — the layout gate reads
 * `role` — and arrives here with nothing behind it. That is the same one sentence
 * `/organiser` already prints, because it is the same state and the organiser cannot
 * fix it themselves. Not an error page.
 *
 * ## FR-805 on this page
 *
 * The row type has no field that could hold a phone number, an email, a customer name
 * or a per-order id, so there is no projection here to get wrong. The page also shows
 * nothing drop-level and nothing cross-organiser: an organiser who sees "drop total 40
 * units" beside "your line 12" has learned a competitor sold 28. The test asserts the
 * serialised rows *and* the CSV bytes carry neither the phone nor its last four digits.
 */

export const dynamic = 'force-dynamic';

/** Status → chip tone. `FAILED` and `CANCELLED` are the rows that explain a `$0.00`. */
const STATUS_TONE: Record<CommissionDropStatus, BadgeTone> = {
  DRAFT: 'neutral',
  PUBLISHED: 'neutral',
  LOCKED: 'thin',
  CAPTURED: 'ok',
  PICKUP_OPEN: 'ok',
  COMPLETED: 'ok',
  FAILED: 'blocked',
  CANCELLED: 'blocked',
};

export default async function CommissionPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const session = await getSession();
  // The layout already gated the role; this is the second read, because a page must
  // not depend on a parent having done its job.
  const profile = session ? await organiserProfileForUser(session.userId) : null;

  if (!profile) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Commission</h1>
        <Card>
          <p className="text-sm leading-relaxed text-ink-soft">
            Your account is not finished setting up — it has no organiser profile, so
            there is no commission rate to compute a statement with. Ask the team to
            complete it; there is nothing you need to do.
          </p>
        </Card>
      </div>
    );
  }

  const params = await searchParams;
  const rawMonth = typeof params.month === 'string' ? params.month : null;
  const { monthKey, ignored } = resolveCommissionMonth(rawMonth);

  const [statement, activeMonths] = await Promise.all([
    commissionStatementFor({ organiserProfileId: profile.id, monthKey }),
    commissionMonthsFor(profile.id),
  ]);

  // The profile was resolved a moment ago and cannot have been deleted between the two
  // reads in any way worth a 500; a null here means "no statement", which is a sentence.
  if (!statement) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Commission</h1>
        <Card>
          <p className="text-sm leading-relaxed text-ink-soft">
            We could not read your commission rate. Reload this page in a moment; if it
            keeps happening, ask the team to check your organiser profile.
          </p>
        </Card>
      </div>
    );
  }

  const currentMonth = currentCommissionMonthKey();
  const previousMonth = shiftMonthKey(monthKey, -1);
  // No "next" past the current month: a future month is always empty, and offering it
  // invites an organiser to conclude their commission has been cancelled.
  const nextMonth = monthKey < currentMonth ? shiftMonthKey(monthKey, 1) : null;

  // The month being viewed always appears in the selector, even if it has no activity —
  // a link to an empty month must show the empty month it names, not silently jump.
  const selectorMonths = activeMonths.includes(monthKey)
    ? activeMonths
    : [monthKey, ...activeMonths].sort().reverse();

  const { totals, lines } = statement;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold">Commission</h1>
        <Link href="/organiser" className="text-xs text-ink-soft hover:text-ink">
          Back to your drops
        </Link>
      </div>

      <nav className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <Link
          href={`/commission?month=${previousMonth}`}
          className="text-ink-soft hover:text-ink"
        >
          ← {previousMonth}
        </Link>
        {nextMonth ? (
          <Link href={`/commission?month=${nextMonth}`} className="text-ink-soft hover:text-ink">
            {nextMonth} →
          </Link>
        ) : null}
        {selectorMonths.length > 1 ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {selectorMonths.map((key) => (
              <Link
                key={key}
                href={`/commission?month=${key}`}
                className={
                  key === monthKey
                    ? 'rounded-full bg-slate-100 px-2 py-0.5 font-medium text-ink'
                    : 'rounded-full px-2 py-0.5 text-ink-soft hover:text-ink'
                }
              >
                {key}
              </Link>
            ))}
          </span>
        ) : null}
      </nav>

      {ignored ? (
        <p className="text-xs leading-relaxed text-ink-soft">
          {/* A filter that silently answers a different question is indistinguishable
              from one that found nothing — the same reason `/admin/drops` names the
              status it ignored. */}
          That month was not a month we can read ({rawMonth}), so this is {monthKey}.
        </p>
      ) : null}

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{monthKey} · what you earned</h2>
            <p className="mt-1 text-xs text-ink-soft">
              {commissionPctLabel(statement.commissionBasisPoints)}% of what your link
              sold and the restaurant actually kept, over a Mountain-time calendar month
              counted from the moment each order was charged.
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-lg font-semibold tabular-nums">
              {formatCents(totals.commissionCents)}
            </p>
            <p className="text-[10px] text-ink-soft">
              {lines.length} {lines.length === 1 ? 'drop' : 'drops'}
            </p>
          </div>
        </div>

        <p className="mt-3 rounded-lg border border-thin/30 bg-thin/5 p-3 text-xs leading-relaxed text-ink">
          These figures are <strong>current as of right now</strong>, not a frozen
          invoice. A refund that lands after a month has been paid changes that month —
          if you re-open March after an April refund, March is smaller. We download the
          statement at the moment we pay you, and that download is the record of what
          was transferred.
        </p>

        <div className="mt-3">
          <a
            href={`/api/organiser/commission?month=${monthKey}&format=csv`}
            download
            className="text-xs font-medium text-ink underline underline-offset-2 hover:text-ink-soft"
          >
            Download {monthKey} as CSV
          </a>
        </div>
      </Card>

      {lines.length === 0 ? (
        <Card>
          <p className="text-sm leading-relaxed text-ink-soft">
            Nothing was charged on your links in {monthKey}. Orders only count once the
            drop reaches its minimum and the cards are actually charged — a drop that
            failed pays nothing, and a drop still taking orders has taken no money yet.
          </p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">
              Commission for {monthKey}: one row per drop you shared, with a totals row.
            </caption>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-ink-soft">
                <th scope="col" className="p-3 font-medium">
                  Drop
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  Units
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  Charged
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  Refunded
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  Kept
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  Commission
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.dropId} className="border-b border-slate-100 align-top last:border-0">
                  <td className="p-3">
                    <p className="font-medium">{line.drop}</p>
                    <p className="text-xs text-ink-soft">
                      {line.merchant} · pickup {line.pickupDate}
                    </p>
                    <p className="mt-1">
                      <Badge tone={STATUS_TONE[line.dropStatus]}>{line.dropStatus}</Badge>
                    </p>
                  </td>
                  <td className="p-3 text-right tabular-nums">{line.units}</td>
                  <td className="p-3 text-right tabular-nums">
                    {formatCents(line.grossCapturedCents)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {line.refundedCents === 0 ? '—' : formatCents(line.refundedCents)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {formatCents(line.netCapturedCents)}
                  </td>
                  <td className="p-3 text-right font-medium tabular-nums">
                    {formatCents(line.commissionCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 font-medium">
                <td className="p-3">
                  Total
                  <span className="ml-1 text-xs font-normal text-ink-soft">
                    ({commissionPctLabel(statement.commissionBasisPoints)}%)
                  </span>
                </td>
                <td className="p-3 text-right tabular-nums">{totals.units}</td>
                <td className="p-3 text-right tabular-nums">
                  {formatCents(totals.grossCapturedCents)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {totals.refundedCents === 0 ? '—' : formatCents(totals.refundedCents)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {formatCents(totals.netCapturedCents)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {formatCents(totals.commissionCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-soft">
        A refunded order earns nothing, in whole or in part — that is why the base is what
        the restaurant kept, not what was charged. A drop that failed after charging
        everyone appears here at zero, so you can see why it paid nothing instead of
        having to ask. You see your own totals only: never who joined, never their phone
        number, and never another organiser&apos;s share of the same drop.
      </p>

      <p className="text-xs leading-relaxed text-ink-soft">
        Nothing is paid automatically. A person transfers the total for the month, and
        your rate applies to the whole month it is set in — we do not change rates
        mid-month.
      </p>
    </div>
  );
}
