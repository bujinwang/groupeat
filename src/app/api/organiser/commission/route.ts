import { NextResponse, type NextRequest } from 'next/server';

import { requireRole, requireSession } from '@/lib/auth/authorize';
import {
  commissionStatementFor,
  currentCommissionMonthKey,
  resolveCommissionMonth,
} from '@/lib/db/commission';
import { organiserProfileForUser } from '@/lib/db/share-links';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/lib/http';
import {
  COMMISSION_PERIOD_TZ,
  commissionPctLabel,
  parseCommissionPeriod,
  toCsv,
} from '@/lib/organisers/commission';

/**
 * `GET /api/organiser/commission?month=YYYY-MM&format=csv` — FR-804's export.
 *
 * > `FR-804 | Commission statement: units × 5% of captured GMV | Monthly,
 * > exportable` — PRD-v1.md:539
 *
 * ## Why this route exists when the page already renders the table
 *
 * "Exportable" means a plain `<a download>`, and a server component cannot set
 * `Content-Disposition`. That is the whole reason. The CSV is produced by `toCsv`
 * from the same `commissionStatementFor` the page uses, so the file and the screen
 * cannot disagree — the route test asserts the file's column sums equal the figures
 * the statement reports, rather than asserting the file looks right.
 *
 * ## A bad `?month=` is a 400 on the CSV path, and a fallback on the page
 *
 * The page falls back to the current month, because a page reached from a truncated
 * URL must render something. A **file** must not: the export taken at payment time is
 * the record of what was transferred (see `lib/db/commission.ts`), so handing someone
 * a CSV whose filename says `2026-03` because we quietly substituted a month they did
 * not ask for would corrupt exactly the artefact that matters. Different surfaces,
 * different correct answers.
 *
 * ## 401 vs 403, and why the no-profile case is a 403
 *
 * No session is 401. A MERCHANT or ADMIN session is 403. An ORGANISER with no
 * `OrganiserProfile` is also 403 with a message that says why: they are the right role
 * and there is no rate to compute with, and a 404 would tell them the endpoint does not
 * exist when in fact their account is unfinished. That account is a known real state
 * (FR-906), not an error.
 *
 * ## Nothing here writes
 *
 * Every read is a `findUnique`/`findMany`. There is no payout row to create, no audit
 * entry for a download, and no state to advance — AC12 asserts the row counts are
 * identical before and after a render and an export.
 */

const ROUTE = 'api/organiser/commission';

/** The only two representations this endpoint offers. Anything else is a typo, not a request. */
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
    const session = await requireSession();
    requireRole(session, ['ORGANISER']);

    const profile = await organiserProfileForUser(session.userId);
    if (!profile) {
      throw AppError.forbidden(
        'Your account has no organiser profile yet, so there is no commission rate to compute a statement with. Ask the team to complete it.',
      );
    }

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

    const statement = await commissionStatementFor({
      organiserProfileId: profile.id,
      monthKey,
    });

    if (!statement) {
      // The profile existed two statements ago. Reaching this means it was deleted
      // mid-request, which is a race rather than a rule — so it is reported as the
      // same unfinished-account answer rather than as a 500.
      throw AppError.forbidden(
        'Your account has no organiser profile yet, so there is no commission rate to compute a statement with.',
      );
    }

    if (format === 'csv') {
      const filename = `groupeat-commission-${statement.organiserSlug}-${statement.monthKey}.csv`;
      return new NextResponse(toCsv(statement.lines), {
        status: 200,
        headers: {
          // ASCII content, so the declared charset is a truthful superset rather than
          // a promise the bytes do not keep. See `toCsv`.
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          // The figure moves when a refund lands. A cached download is a stale record
          // of a payment, which is the one thing this endpoint must not produce.
          'cache-control': 'no-store',
        },
      });
    }

    return NextResponse.json(
      {
        month: statement.monthKey,
        period: {
          from: statement.periodFrom.toISOString(),
          to: statement.periodTo.toISOString(),
          timeZone: COMMISSION_PERIOD_TZ,
        },
        organiser: {
          name: statement.organiserName,
          slug: statement.organiserSlug,
        },
        commissionPct: commissionPctLabel(statement.commissionBasisPoints),
        commissionBasisPoints: statement.commissionBasisPoints,
        lines: statement.lines,
        totals: statement.totals,
        // What was asked for versus what was answered, so an unparseable month is
        // visible rather than looking like an empty statement. Same shape and same
        // reason as `/api/admin/drops`' `requestedStatus`/`appliedStatus`.
        requestedMonth,
        monthIgnored: ignored,
        // The statement is a live query. Naming it in the payload means a caller that
        // stores this JSON knows it is not a settlement record.
        liveQuery: true,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
