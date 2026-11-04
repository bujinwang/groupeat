/**
 * Login rate limiting — 10 attempts / 15 minutes / key (PRD-sprint1 §6.1).
 *
 * ⚠️ **NOT PRODUCTION-GRADE, BY DECISION (ARCHITECTURE-sprint1 A-3).**
 *
 * This is an in-memory `Map` in a single Node process:
 *
 *   - it does **not** survive a restart;
 *   - it is **not** shared between instances, so N replicas give N × the limit;
 *   - it is keyed on a caller-supplied string, which behind a proxy must be a
 *     trusted client IP or it is trivially bypassed by a header;
 *   - the map is pruned opportunistically, not on a timer.
 *
 * It exists so a white-glove beta of five merchants cannot be trivially brute
 * forced, and for no other reason. **Do not build on this module's internals, and
 * do not describe it as a security control in any document.**
 *
 * ## The M9 obligation was not discharged, and is now re-deferred explicitly
 *
 * This note used to read "**before M9 this must be replaced** with a durable, shared
 * counter (Redis, or a table with a unique index)". **M9 shipped and it was not replaced.**
 * That is a commitment that lapsed, and leaving the sentence in place would have made this
 * file claim a deadline it had already passed — the kind of stale promise that reads as
 * "someone is on it" when nobody is.
 *
 * Status as of the auth slice: **re-deferred, with the reason written down.** The
 * replacement needs infrastructure this repo does not have (a Redis instance, or a
 * migration plus a sweeper for a `LoginAttempt` table), and it is not a correctness fix for
 * the beta the module was written for. What it *is* required for is any deployment with
 * more than one instance, because N replicas multiply the limit by N — so the trigger for
 * doing it is "the app runs on more than one process", not a milestone number.
 *
 * The 10/15-minute arithmetic itself *is* now tested (`__tests__/rate-limit.test.ts`), which
 * is the part a unit test can reach. Nothing here can test "survives a restart" or "is
 * shared between replicas": those are properties of a store this module does not have.
 *
 * NFR-07 (the join endpoint's limit) is a different requirement and is not
 * implemented here.
 */

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 10;

type Bucket = {
  count: number;
  /** Epoch ms when the window resets. */
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Whole seconds until the window resets; 0 when allowed. */
  retryAfterSeconds: number;
};

function prune(now: number): void {
  // Cheap and bounded: the map only ever holds keys that failed recently.
  if (buckets.size < 1_000) {
    return;
  }
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

/**
 * Records one attempt and reports whether it is allowed.
 *
 * The attempt is counted even when it is rejected, so a caller that keeps trying
 * during a block does not shorten the block.
 */
export function hit(
  key: string,
  now: number = Date.now(),
  maxAttempts: number = LOGIN_MAX_ATTEMPTS,
  windowMs: number = LOGIN_WINDOW_MS,
): RateLimitResult {
  prune(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxAttempts - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > maxAttempts) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return {
    allowed: true,
    remaining: maxAttempts - existing.count,
    retryAfterSeconds: 0,
  };
}

/**
 * Clears the counter for a key. Called after a *successful* login so that a
 * legitimate user who mistyped a few times is not punished for the rest of the
 * window.
 */
export function reset(key: string): void {
  buckets.delete(key);
}

/** Test helper. Never call this from application code. */
export function clearAll(): void {
  buckets.clear();
}
