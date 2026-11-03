import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import {
  adminCommissionRollupFor,
  currentCommissionMonthKey,
  resolveCommissionMonth,
} from '@/lib/db/commission';
import { formatCents } from '@/lib/guardrail';
import {
  commissionPctLabel,
  shiftMonthKey,
} from '@/lib/organisers/commission';

/**
 * `/admin/commission` — the P1 half of FR-804, and the screen the e-transfer run needs.
 *
 * > Admin variant `GET /api/admin/commission?month=YYYY-MM`: one row per organiser
 * > for the whole month … the human doing e-transfers works from one file, not
 * > fifteen. — `docs/specs/FR-804-…md`
 *
 * ## Why this page is not just the CSV
 *
 * The file is the deliverable — it is what the operator pays from. But a file is read
 * *after* someone has decided the numbers are right, and until this page existed the
 * only way to decide that was to open fifteen separate statements. The page is the
 * month at a glance: who is owed what, in one screen, before anything is downloaded.
 *
 * The figures here and the figures in the file come from the same `rollup` object, so
 * "the page says $412.30 and the file says $412.30" holds by construction rather than by
 * a test comparing two implementations.
 *
 * ## The warning that is not in the CSV
 *
 * The statement is a live query (decision 1 in the spec). On this screen that matters
 * more than on the organiser's, because the operator is about to make payments *from*
 * this list: if a refund lands between the download and the transfer, the file they hold
 * is already stale. So the page says, in words, that the download is the record — and
 * that it is worth re-downloading rather than trusting a copy from last week.
 *
 * ## Zero-activity organisers are listed, with a dash rather than a zero
 *
 * `$0.00` in a money column reads as "computed, and it is zero". An organiser with no
 * lines at all has not been computed to zero — they have nothing attributed — and the
 * difference is the difference between "nothing to pay" and "attribution may be
 * broken". The row shows `—` and `no activity`, so the operator has something to ask
 * about instead of a number to accept.
 */

export const dynamic = 'force-dynamic';

export default async function AdminCommissionPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const params = await searchParams;
  // Same rule as the organiser page: a repeated `?month=a&month=b` arrives as an array
  // and must not be read as *absent*, or the fallback silently answers a question
  // nobody asked.
  const rawMonth = Array.isArray(params.month) ? params.month.join(',') : (params.month ?? null);
  const { monthKey, ignored } = resolveCommissionMonth(rawMonth);

  const rollup = await adminCommissionRollupFor({ monthKey });

  const currentMonth = currentCommissionMonthKey();
  const previousMonth = shiftMonthKey(monthKey, -1);
  // No "next" past the current month: a future month is always empty, and offering it
  // invites the operator to conclude the roster is missing.
  const nextMonth = monthKey < currentMonth ? shiftMonthKey(monthKey, 1) : null;

  const owing = rollup.rows.filter((row) => row.totals.commissionCents > 0);
  const idle = rollup.rows.filter((row) => row.totals.commissionCents === 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold">Commission</h1>
        <Link href="/admin/drops" className="text-xs text-ink-soft hover:text-ink">
          Back to drops
        </Link>
      </div>

      <nav className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <Link href={`/admin/commission?month=${previousMonth}`} className="text-ink-soft hover:text-ink">
          ← {previousMonth}
        </Link>
        {nextMonth ? (
          <Link
            href={`/admin/commission?month=${nextMonth}`}
            className="text-ink-soft hover:text-ink"
          >
            {nextMonth} →
          </Link>
        ) : null}
        <Link
          href={`/admin/commission?month=${currentMonth}`}
          className={
            monthKey === currentMonth
              ? 'rounded-full bg-slate-100 px-2 py-0.5 font-medium text-ink'
              : 'rounded-full px-2 py-0.5 text-ink-soft hover:text-ink'
          }
        >
          {currentMonth}
        </Link>
      </nav>

      {ignored ? (
        <p className="text-xs leading-relaxed text-ink-soft">
          That month was not a month we can read ({rawMonth}), so this is {monthKey}.
        </p>
      ) : null}

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{rollup.monthKey} · owed to organisers</h2>
            <p className="mt-1 text-xs text-ink-soft">
              {owing.length} to pay, {idle.length} with nothing this month — every organiser
              on the roster is listed, so a missing name means a missing profile rather than a
              quiet month.
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-lg font-semibold tabular-nums">
              {formatCents(rollup.totals.commissionCents)}
            </p>
            <p className="text-[10px] text-ink-soft">total to transfer</p>
          </div>
        </div>

        <p className="mt-3 rounded-lg border border-thin/30 bg-thin/5 p-3 text-xs leading-relaxed text-ink">
          These figures are <strong>live, current as of this page load</strong> — not a
          frozen invoice. A refund landing after you pay restates the month, and the
          organiser&apos;s own page will show the new number. The CSV you download at the
          moment you send the money is the record of what was transferred: re-download it
          if you are paying even a day later.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <a
            href={`/api/admin/commission?month=${monthKey}&format=csv`}
            download
            className="text-xs font-medium text-ink underline underline-offset-2 hover:text-ink-soft"
          >
            Download {monthKey} for all organisers as CSV
          </a>
          <a
            href={`/api/admin/commission?month=${monthKey}`}
            className="text-xs text-ink-soft hover:text-ink"
          >
            View as JSON
          </a>
        </div>
      </Card>

      {rollup.rows.length === 0 ? (
        <Card>
          <p className="text-sm leading-relaxed text-ink-soft">
            There are no organiser profiles yet, so there is nobody to pay. Create one from{' '}
            <Link href="/admin/users" className="underline underline-offset-2">
              Users
            </Link>
            ; an organiser account without a profile cannot earn anything.
          </p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">
              Commission owed for {rollup.monthKey}: one row per organiser, with a grand
              total.
            </caption>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-ink-soft">
                <th scope="col" className="p-3 font-medium">
                  Organiser
                </th>
                <th scope="col" className="p-3 font-medium">
                  Rate
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  Drops
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  Kept
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  To transfer
                </th>
              </tr>
            </thead>
            <tbody>
              {rollup.rows.map((row) => (
                <tr
                  key={row.organiserProfileId}
                  className="border-b border-slate-100 align-top last:border-0"
                >
                  <td className="p-3">
                    <p className="font-medium">{row.organiserName}</p>
                    <p className="text-xs text-ink-soft">{row.organiserEmail}</p>
                  </td>
                  <td className="p-3 text-xs text-ink-soft">
                    {commissionPctLabel(row.commissionBasisPoints)}%
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {row.lineCount === 0 ? (
                      <span className="text-xs text-ink-soft">no activity</span>
                    ) : (
                      row.lineCount
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {row.lineCount === 0 ? '—' : formatCents(row.totals.netCapturedCents)}
                  </td>
                  <td className="p-3 text-right font-medium tabular-nums">
                    {row.lineCount === 0 ? (
                      <span className="text-ink-soft">—</span>
                    ) : (
                      formatCents(row.totals.commissionCents)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 font-medium">
                <td className="p-3" colSpan={2}>
                  Total
                </td>
                <td className="p-3 text-right tabular-nums">
                  {rollup.rows.reduce((sum, row) => sum + row.lineCount, 0)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {formatCents(rollup.totals.netCapturedCents)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {formatCents(rollup.totals.commissionCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-soft">
        Each organiser&apos;s figure here is the same number their own{' '}
        <Link href="/commission" className="underline underline-offset-2">
          commission page
        </Link>{' '}
        shows — one computation, two views, so they cannot disagree. A rate change takes
        effect for the whole month it is set in; rates are not changed mid-month.
      </p>

      <p className="text-xs leading-relaxed text-ink-soft">
        Nothing is paid automatically and nothing here moves money. This is the work list
        for a manual e-transfer; there is no payout table behind it, which is why the
        download is the record.
      </p>
    </div>
  );
}
