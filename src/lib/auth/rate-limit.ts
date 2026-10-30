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
 * forced, and for no other reason. **Before M9 this must be replaced with a
 * durable, shared counter** (Redis, or a table with a unique index). Do not build
 * on this module's internals, and do not describe it as a security control in any
 * document.
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
