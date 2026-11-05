import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/config';
import { logger } from '@/lib/logging/logger';
import { isStripeConfigured } from '@/lib/payments/stripe';
import { runL5Reconciliation, type L5RunResult } from '@/lib/settlement/l5-run';

/**
 * `POST|GET /api/jobs/reconcile` — ADR-004's nightly L5 job.
 *
 * > L5: `Σ CHARGE + Σ REFUND + Σ card fees == connected-account balance delta`; and
 * > `Σ PLATFORM_FEE + Σ ADJUSTMENT == Σ application_fee`
 *
 * ## Why a separate route from settlement
 *
 * Settlement runs every minute and moves money. Reconciliation runs nightly, moves
 * nothing, and is allowed to be slow: it makes a Stripe round trip per charge and per
 * application fee. Putting it in the cutoff tick would make a provider timeout delay a
 * capture, which is the one failure this split exists to prevent.
 *
 * ## The refusals
 *
 * | Condition | Response | Why |
 * |---|---|---|
 * | `CRON_SECRET` unset | `503 NOT_CONFIGURED` | An unauthenticated job that reads two Stripe accounts is an information leak and a quota sink. |
 * | Wrong/missing bearer | `401` | Constant-time comparison, same as the other job routes. |
 * | Stripe unconfigured | `503 NOT_CONFIGURED` | There is no port to read. Running anyway would report every drop as a provider error. |
 * | Bad `?since=` | `422` | A hand-edited recovery parameter should fail visibly rather than silently use the default window. |
 *
 * The body reports `ok: false` and the mismatches rather than a 500: a mismatch is the
 * job's finding, not its failure. A provider error on one drop is also in that list;
 * the run continues with the rest.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BEARER_PREFIX = 'Bearer ';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return runReconcile(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return runReconcile(request);
}

async function runReconcile(request: NextRequest): Promise<NextResponse> {
  const secret = env.CRON_SECRET;
  if (!secret) {
    logger.warn('reconciliation.job_refused', { reason: 'not_configured' });
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  }

  if (!isAuthorized(request.headers.get('authorization'), secret)) {
    logger.warn('reconciliation.job_refused', { reason: 'unauthorized' });
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  if (!isStripeConfigured()) {
    logger.warn('reconciliation.job_refused', { reason: 'no_provider' });
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  }

  const sinceRaw = request.nextUrl.searchParams.get('since');
  let since: Date | undefined;
  if (sinceRaw !== null) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: 'VALIDATION', message: 'since must be an ISO-8601 instant.' },
        { status: 422 },
      );
    }
    since = parsed;
  }

  // Dynamic import for the same reason the other provider routes use one:
  // `l5-real-port` imports `server-only`, so a static import would break every test
  // that loads this route for its auth branches.
  const { realL5Port } = await import('@/lib/settlement/l5-real-port');
  const result: L5RunResult = await runL5Reconciliation({
    now: new Date(),
    port: realL5Port(),
    ...(since ? { since } : {}),
  });

  return NextResponse.json(result, {
    status: 200,
    // A run report is not a cacheable resource; a retried scheduler must read its own
    // run, not yesterday's.
    headers: { 'cache-control': 'no-store' },
  });
}

function isAuthorized(header: string | null, secret: string): boolean {
  if (!header || !header.startsWith(BEARER_PREFIX)) return false;
  const provided = Buffer.from(header.slice(BEARER_PREFIX.length), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
