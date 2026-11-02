import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/config';
import { logger } from '@/lib/logging/logger';
import { composingNotifyPort } from '@/lib/notify/compose-port';
import { publicOrigin } from '@/lib/notify/public-origin';
import { isStripeNotConfigured } from '@/lib/payments/connect-port';
import { isStripeConfigured } from '@/lib/payments/stripe';
import type { ChargePort } from '@/lib/settlement/charge-port';
import { runCutoffTick, type TickResult } from '@/lib/settlement/run-tick';

/**
 * `POST|GET /api/jobs/cutoff` — the deployable entry point (design §9 T06, §12 Q3).
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
 * ## Why `GET` exists as well as `POST`
 *
 * The design left this open (§12 Q3: "how the job is authenticated and where it
 * runs … Infra's call"). It is now answered, and the answer is *both methods, one
 * handler*:
 *
 *   - **`GET` is what platform schedulers actually send.** Vercel Cron issues a
 *     `GET` and, when `CRON_SECRET` is set in the project, attaches
 *     `Authorization: Bearer $CRON_SECRET` itself. A route exporting only `POST`
 *     answers a cron invocation with `405` — the scheduler logs a failed run, no
 *     drop ever settles, and the first symptom is a diner whose card was
 *     authorised a week ago and never charged. That is a silent failure of the
 *     worst kind, and it was one export away.
 *   - **`POST` stays**, because it is the honest verb: this endpoint mutates. Any
 *     other runner (Railway cron with `curl -X POST`, a Kubernetes `CronJob`, or a
 *     human with `curl`) should use it, and a request that changes state should
 *     say so.
 *
 * A `GET` that moves money is a deliberate violation of RFC 9110's safe-method
 * rule, made because the alternative is not configuring the scheduler at all. It
 * is *tolerable* rather than merely convenient only because of two properties this
 * endpoint already has: the tick is idempotent in the sense that matters (every
 * effect is resumable from `Drop.status`, and the ledger's unique index makes a
 * repeated capture impossible), and the response is a summary of what happened,
 * never a mutation of what was requested. So a crawler or a prefetcher that
 * somehow reached it with a valid bearer would re-run a tick — not corrupt one.
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

/**
 * The function ceiling, and why it is the platform maximum rather than a guess.
 *
 * The tick is bounded (§4.4) — 20 drops, 50 participants per drop — but every
 * participant is a Stripe round trip, so a full tick is `20 × 50` sequential
 * provider calls in the worst case and can outlive a default timeout. The
 * platform's default is 300 s on every plan, and 300 s is also the Hobby
 * maximum; Pro allows 800 s. Declaring the Hobby maximum keeps the deployment
 * portable and states the budget in the code rather than in a dashboard setting
 * nobody reads.
 *
 * Being killed mid-tick is *safe* — everything resumes from `Drop.status`, and
 * every provider call carries an idempotency key — which is exactly why the
 * bound exists instead of an unbounded sweep. A truncated tick reports
 * `truncated: true` and the next one continues.
 */
export const maxDuration = 300;

const BEARER_PREFIX = 'Bearer ';

/**
 * Both verbs, one implementation.
 *
 * Written as two exported functions that each delegate, rather than
 * `export { runTick as GET, runTick as POST }`, so that Next's route-type
 * checker and a reader both see the shape plainly, and so neither can be deleted
 * without the other being obviously still there.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return runTick(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return runTick(request);
}

async function runTick(request: NextRequest): Promise<NextResponse> {
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

  // ## The sender, chosen once per tick
  //
  // `resolveSender` returns the Twilio-backed sender when all three credentials are
  // present and the logging sender otherwise. A keyless deployment therefore runs
  // the same code path and reports `NOT_CONFIGURED` per message, rather than taking
  // a different branch here — which is what keeps the compose → send wiring under
  // test on every machine in this repo.
  //
  // The zone is not passed here: it is per merchant, and one tick settles drops
  // belonging to several. `settle` supplies it per drop from the locked row it
  // already holds, which is the only layer that knows which kitchen is being named.
  //
  // `twilio-sender.ts` imports `server-only`, so it is loaded with a dynamic import
  // for the same reason `real-charge-port` is: a **static** import here would make
  // every DB-backed test that touches this route fail at module load. The comment on
  // `resolveChargePort` below records the longer version of this.
  const { resolveSender } = await import('@/lib/notify/twilio-sender');
  const notify = composingNotifyPort({ sender: resolveSender() });

  const result: TickResult = await runCutoffTick({
    now,
    port,
    notify,
    // The origin a diner's SMS will link to. `undefined` when `APP_URL` is unset or
    // unusable, which makes the charged intent carry the code and no link — the
    // deliberate degradation described in `notify/public-origin.ts`.
    //
    // Deliberately *not* derived from this request's `Host`: this is a job
    // invocation, and the header is whatever the scheduler sent. `originOf` in the
    // Stripe onboarding route does the opposite for the opposite reason — there the
    // caller is a merchant's browser, which is the actual origin.
    baseUrl: publicOrigin(),
  });

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
