import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/config';
import { logger } from '@/lib/logging/logger';
import { publicOrigin } from '@/lib/notify/public-origin';
import { runWeeklyDigest, type DigestRunResult } from '@/lib/reports/digest-run';

/**
 * `POST|GET /api/jobs/digest` — FR-704's deployable entry point.
 *
 * > `FR-704 | Weekly email digest (Monday 08:00 MT) | Sent only to consenting owners`
 * > — PRD-v1.md:520
 *
 * ## Why this is a separate route from the cutoff job
 *
 * They share `CRON_SECRET`, not a schedule. Settlement runs every minute and moves
 * money; the digest runs once a week and moves none. Putting the digest inside the
 * minute tick would mean a mail provider's timeout could delay a capture, and a
 * capture's failure could suppress the digest — two unrelated failure modes coupled
 * for no benefit. One route, one job, one reason to fail.
 *
 * ## The three refusals, copied deliberately from the cutoff route
 *
 * | Condition | Response | Why |
 * |---|---|---|
 * | `CRON_SECRET` unset | `503 NOT_CONFIGURED` | An unauthenticated endpoint that emails every merchant is a spam cannon. Refusing is the safe default, and it makes "the scheduler was never wired" visible. |
 * | Bearer token missing or wrong | `401` | Constant-time comparison: a token comparison that leaks its prefix length can be guessed a character at a time. |
 * | No email provider | **`200`, with `notConfigured` in the body** | The run still *measured* what it would send, and reporting that is more useful than a 503 that says nothing about the week. Nothing leaves the building; the delivery table stays empty, so a later keyed run sends the same week. |
 *
 * The third row is the one that differs from settlement, and it is a deliberate
 * difference: settlement without Stripe cannot do its job at all, while a digest
 * without a provider can still compose and account. The body is the honest answer.
 *
 * ## GET, for the scheduler
 *
 * Vercel Cron sends `GET` with `Authorization: Bearer $CRON_SECRET`. A `POST`-only
 * route answers `405` to every scheduled run, and the first symptom is no email. Both
 * verbs delegate to one handler so they cannot diverge — the same argument and shape
 * as `api/jobs/cutoff/route.ts`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A weekly job over a handful of merchants and at most a few dozen emails. Sixty
 * seconds is generous and well inside every plan's default; the cutoff route's 300 is
 * for sequential Stripe round trips, which do not happen here.
 */
export const maxDuration = 60;

const BEARER_PREFIX = 'Bearer ';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return runDigest(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return runDigest(request);
}

async function runDigest(request: NextRequest): Promise<NextResponse> {
  const secret = env.CRON_SECRET;
  if (!secret) {
    logger.warn('digest.job_refused', { reason: 'not_configured' });
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  }

  if (!isAuthorized(request.headers.get('authorization'), secret)) {
    logger.warn('digest.job_refused', { reason: 'unauthorized' });
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  // Dynamic import, exactly as the cutoff route loads its provider. `resend-sender`
  // imports `server-only`, which throws outside a React Server Component graph, so a
  // static import here would break every test that imports this route for its auth
  // branch. Keeping it dynamic makes that impossible to get wrong by accident.
  const { resolveEmailSender } = await import('@/lib/notify/resend-sender');
  const sender = resolveEmailSender();

  const result: DigestRunResult = await runWeeklyDigest({
    now: new Date(),
    sender,
    // The link a merchant clicks from their inbox. Absent when `APP_URL` is unset or
    // unusable, which makes the email say "open GroupEat" rather than carry a
    // `localhost` link. See `notify/public-origin.ts`.
    origin: publicOrigin(),
  });

  return NextResponse.json(
    result,
    {
      status: 200,
      // A digest response is a record of one run, not a resource. A cached body
      // would tell a retried scheduler that nothing was sent.
      headers: { 'cache-control': 'no-store' },
    },
  );
}

/**
 * Constant-time bearer comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the length is checked
 * first — the early return leaks only the secret's length, which is not the secret and
 * is not chosen by the caller.
 */
function isAuthorized(header: string | null, secret: string): boolean {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const provided = Buffer.from(header.slice(BEARER_PREFIX.length), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}
