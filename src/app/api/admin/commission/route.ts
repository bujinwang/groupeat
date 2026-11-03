import { NextResponse, type NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/auth/authorize';
import {
  adminCommissionRollupFor,
  currentCommissionMonthKey,
  resolveCommissionMonth,
} from '@/lib/db/commission';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/lib/http';
import {
  COMMISSION_PERIOD_TZ,
  commissionPctLabel,
  parseCommissionPeriod,
  toAdminCsv,
  type AdminCommissionCsvRow,
} from '@/lib/organisers/commission';

/**
 * `GET /api/admin/commission?month=YYYY-MM&format=csv` — the P1 half of FR-804.
 *
 * > Admin variant `GET /api/admin/commission?month=YYYY-MM`: one row per organiser
 * > for the whole month, adding `organiser_name`, `organiser_email` — the human doing
 * > e-transfers works from one file, not fifteen. — `docs/specs/FR-804-…md`
 *
 * ## Why a separate route rather than a flag on the organiser one
 *
 * `GET /api/organiser/commission` resolves the caller's *own* profile from their
 * session; its whole authorisation is "you are this organiser". An admin version with a
 * `?all=1` switch would have two authorisation paths inside one handler, and the failure
 * mode of getting that wrong is one organiser reading another's statement. Two routes
 * with one guard each is the shape where that cannot happen.
 *
 * They share `commissionStatementFor` and the CSV helpers, so the numbers and the bytes
 * still cannot drift — only the authorisation and the row set differ.
 *
 * ## A bad `?month=` is a 400 on the CSV path
 *
 * Same rule, same reason as the organiser route: the export is the record of what was
 * transferred, so a file named `2026-13` whose figures are another month's corrupts the
 * one artefact that matters. The page falls back to the current month and says so; the
 * file refuses.
 *
 * Unlike the organiser route, `format` defaults to **JSON** here too. The admin screen
 * calls the roll-up directly (it is a server component), so the only caller of the CSV
 * path is the download link — which always passes `format=csv`. Defaulting to JSON keeps
 * the endpoint inspectable with `curl`, which is how an operator debugs "the total looks
 * wrong" without downloading a file.
 *
 * ## Nothing here writes
 *
 * Reads only. There is no payout row and no audit entry for a download; the record is
 * the file. AC12's "no writes" property holds here for the same reason it holds on the
 * organiser route, and the route test asserts row counts are unchanged.
 */

const ROUTE = 'api/admin/commission';

/** The only two representations this endpoint offers. Anything else is a typo. */
const FORMATS = ['csv', 'json'] as const;

type Format = (typeof FORMATS)[number];

function parseFormat(raw: string | null): Format | null {
  if (raw === null) {
    return 'json';
  }
  return FORMATS.find((format) => format === raw) ?? null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin();

    const params = request.nextUrl.searchParams;
    const requestedMonth = params.get('month');
    const format = parseFormat(params.get('format'));

    if (format === null) {
      throw AppError.badRequest(
        `Unknown format "${params.get('format') ?? ''}". Use format=csv for the download, or omit it for JSON.`,
      );
    }

    if (format === 'csv' && requestedMonth !== null && parseCommissionPeriod(requestedMonth) === null) {
      throw AppError.badRequest(
        `"${requestedMonth}" is not a month we can export. Use YYYY-MM, for example ${currentCommissionMonthKey()}. Nothing was downloaded.`,
      );
    }

    const { monthKey, ignored } = resolveCommissionMonth(requestedMonth);
    const rollup = await adminCommissionRollupFor({ monthKey });

    if (format === 'csv') {
      // Flattened here rather than in the query: the roll-up's job is the figures, the
      // export's job is the shape. Keeping them apart is what lets the page render one
      // row per organiser while this renders one row per line.
      const rows: AdminCommissionCsvRow[] = [];

      for (const row of rollup.rows) {
        // An organiser with no activity has no lines and therefore no rows. They are in
        // the JSON and on the page, where "earned nothing" is a useful fact worth
        // seeing; a CSV row with no drop and `0` would read as a line item instead.
        for (const line of row.lines) {
          rows.push({
            organiserName: row.organiserName,
            organiserEmail: row.organiserEmail,
            organiserSlug: row.organiserSlug,
            line,
          });
        }
      }

      const filename = `groupeat-commission-all-${rollup.monthKey}.csv`;
      return new NextResponse(toAdminCsv({ rows, totals: rollup.totals }), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          // The figure moves when a refund lands, and this file is the record of a
          // payment. A cached copy is a stale record.
          'cache-control': 'no-store',
        },
      });
    }

    return NextResponse.json(
      {
        month: rollup.monthKey,
        period: {
          from: rollup.periodFrom.toISOString(),
          to: rollup.periodTo.toISOString(),
          timeZone: COMMISSION_PERIOD_TZ,
        },
        organisers: rollup.rows.map((row) => ({
          // `lines` is the CSV's grain, not the JSON's: an operator inspecting this
          // payload wants the per-organiser figure and how many lines made it. Sending
          // the lines too would make this endpoint a participant-level document by
          // another name, which the spec's privacy boundary rules out.
          organiserProfileId: row.organiserProfileId,
          organiserName: row.organiserName,
          organiserEmail: row.organiserEmail,
          organiserSlug: row.organiserSlug,
          commissionPct: commissionPctLabel(row.commissionBasisPoints),
          commissionBasisPoints: row.commissionBasisPoints,
          lineCount: row.lineCount,
          totals: row.totals,
        })),
        totals: rollup.totals,
        requestedMonth,
        monthIgnored: ignored,
        // Named for the same reason the organiser route names it: a caller that stores
        // this JSON should know it is not a settlement record.
        liveQuery: true,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
