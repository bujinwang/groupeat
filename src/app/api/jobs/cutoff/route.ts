import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/config';
import { logger } from '@/lib/logging/logger';
import { isStripeNotConfigured } from '@/lib/payments/connect-port';
import { isStripeConfigured } from '@/lib/payments/stripe';
import type { ChargePort } from '@/lib/settlement/charge-port';
import { noopNotifyPort } from '@/lib/settlement/notify-port';
import { runCutoffTick, type TickResult } from '@/lib/settlement/run-tick';

/**
 * `POST /api/jobs/cutoff` — the deployable entry point (design §9 T06, §12 Q3).
 *
 * ## Why an HTTP route and not a cron package
 *
 * `node-cron` runs in-process, so a second web instance runs the job twice. The
 * design survives that (§4.2: three independent guards, all of them redundant on
 * purpose), but two schedulers is strictly worse than one and buys a dependency.
 * The platform's scheduler hitting this route is the only option that needs no new
 * infrastructure, and it is why the tick is **bounded** (§4.4) rather than
 * exhaustive: a long settlement can outlive a serverless function timeout, and a
 * tick that is killed mid-loop must be safe — which it is, because everything is
 * resumable from `Drop.status`.
 *
 * ## The three refusals, in order
 *
 * | Condition | Response | Why this and not something else |
 * |---|---|---|
 * | `CRON_SECRET` unset | `503 NOT_CONFIGURED` | A job route with no auth is a public endpoint that moves money. Refusing is the safe default, and it makes "the scheduler was never wired" visible in the first tick instead of silently not settling drops. |
 * | Bearer token missing or wrong | `401` | Compared in constant time: a token comparison that leaks its prefix length is a token that can be guessed a character at a time. |
 * | Stripe unconfigured | `503 NOT_CONFIGURED` | There is no port to call. Running the decision phase anyway would write `LOCKED` and then be unable to charge, which is a drop stuck in the one state that has no automated exit. |
 *
 * `401` carries no body detail: the caller is either the scheduler or an attacker,
 * and neither is helped by knowing which part of the token was wrong.
 *
 * ## The clock
 *
 * `new Date()` appears here and nowhere else in `src/lib/settlement/**` (§11.2).
 * One `now` per tick, threaded down, so a drop cannot be both due and not due
 * within a single invocation.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BEARER_PREFIX = 'Bearer ';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = env.CRON_SECRET;
  if (!secret) {
    logger.warn('settlement.tick_refused', { reason: 'not_configured' });
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  }

  if (!isAuthorized(request.headers.get('authorization'), secret)) {
    logger.warn('settlement.tick_refused', { reason: 'unauthorized' });
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  if (!isStripeConfigured()) {
    logger.warn('settlement.tick_refused', { reason: 'no_provider' });
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  }

  let port: ChargePort;
  try {
    port = await resolveChargePort();
  } catch (error) {
    if (isStripeNotConfigured(error)) {
      logger.warn('settlement.tick_refused', { reason: 'no_provider' });
      return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
    }
    throw error;
  }

  const now = new Date();
  const result: TickResult = await runCutoffTick({ now, port, notify: noopNotifyPort() });

  return NextResponse.json(result, { status: 200 });
}

/**
 * The one non-test reference to `real-charge-port`, and it is a dynamic import.
 *
 * `real-charge-port.ts` imports `server-only`, which throws outside a React Server
 * Component graph — so a static import here would still be fine in the route, but a
 * static import *anywhere shared with a test* would break every DB-backed test at
 * module load. Keeping it dynamic in one place makes that impossible to get wrong
 * by accident.
 */
async function resolveChargePort(): Promise<ChargePort> {
  const { realChargePort } = await import('@/lib/settlement/real-charge-port');
  return realChargePort();
}

/**
 * Constant-time bearer comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the length is
 * compared first — and that early return is not a leak worth worrying about: the
 * length of the secret is not the secret, and a caller cannot choose the length of
 * the stored value.
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
