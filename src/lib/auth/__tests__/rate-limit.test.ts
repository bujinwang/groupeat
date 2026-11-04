import { beforeEach, describe, expect, it } from 'vitest';

import {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  clearAll,
  hit,
  reset,
} from '@/lib/auth/rate-limit';

/**
 * S1-005 / PRD-sprint1 §6.1 — the login rate limit.
 *
 * ## What this module is, stated before anything is asserted about it
 *
 * `rate-limit.ts` opens with "⚠️ **NOT PRODUCTION-GRADE, BY DECISION (ARCHITECTURE-sprint1
 * A-3)**" and closes with "do not describe it as a security control in any document". That
 * is an accurate description of an in-memory `Map` that does not survive a restart, is not
 * shared between replicas, and is keyed on a header a client can choose. So nothing below
 * is a claim that brute-forcing is prevented. What is asserted is that **the arithmetic is
 * what the PRD asked for** — 10 attempts, 15 minutes, counted attempts cannot shorten the
 * block — because a limiter whose counter is off by one is not even the thing it admits to
 * being.
 *
 * ## Why `now` is injected rather than slept through
 *
 * `hit(key, now, maxAttempts, windowMs)` takes the clock as a parameter, so every boundary
 * here is exact. A test that waited 15 real minutes would never be run; a test that waited
 * even 1 second per case would be the slowest thing in the suite and would still be a
 * guess about scheduling. The one place a real clock is unavoidable is `Date.now()`'s
 * default, which is asserted once by calling without the argument.
 *
 * ## The off-by-one worth naming
 *
 * `hit` blocks when `count > maxAttempts`, not `>=`, so the **11th** attempt is the first
 * refusal and the first 10 are allowed. That is the reading that matches "10 attempts".
 * Reaching for `>=` is the natural edit and it silently makes the limit 9 — which no
 * assertion about "many attempts are blocked" would catch. The test below counts to the
 * boundary one attempt at a time for exactly that reason.
 */

const KEY = 'test-key';

beforeEach(() => {
  clearAll();
});

describe('§6.1 · the limit is 10 attempts in 15 minutes', () => {
  it('pins both constants', () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(10);
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('allows exactly ten attempts and refuses the eleventh', () => {
    const t0 = 1_000_000;

    // One attempt at a time, so the exact boundary is asserted rather than inferred.
    for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
      const result = hit(KEY, t0 + attempt);
      expect(result.allowed, `attempt ${attempt} should be allowed`).toBe(true);
      expect(result.remaining).toBe(LOGIN_MAX_ATTEMPTS - attempt);
    }

    const eleventh = hit(KEY, t0 + 11);
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.remaining).toBe(0);
  });

  it('reports the remaining count as a descending sequence, never negative', () => {
    const t0 = 1_000_000;
    const remaining: number[] = [];

    for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS + 3; attempt += 1) {
      remaining.push(hit(KEY, t0 + attempt).remaining);
    }

    // 9, 8, … 0, then 0 for every refusal. A `remaining` that went to -1 or -2 would leak
    // how far past the limit the caller has gone, which is information the block should
    // not hand out.
    expect(remaining).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0]);
    expect(Math.min(...remaining)).toBe(0);
  });

  it('gives the first attempt a remaining count of maxAttempts - 1', () => {
    // The fresh-bucket branch returns `maxAttempts - 1` from a literal, while the
    // incrementing branch returns `maxAttempts - count`. Two expressions for one idea, so
    // the first attempt is the only input that tells them apart at the seam.
    expect(hit(KEY, 1_000).remaining).toBe(LOGIN_MAX_ATTEMPTS - 1);
  });

  it('honours a custom maxAttempts and window, because both are parameters', () => {
    const t0 = 1_000_000;

    expect(hit(KEY, t0, 2).allowed).toBe(true);
    expect(hit(KEY, t0 + 1, 2).allowed).toBe(true);
    expect(hit(KEY, t0 + 2, 2).allowed).toBe(false);

    // …and the window is a parameter too, so an expired bucket starts over.
    clearAll();
    expect(hit(KEY, t0, 10, 60_000).allowed).toBe(true);
    expect(hit(KEY, t0 + 60_001, 10, 60_000).allowed).toBe(true);
  });
});

describe('§6.1 · the window', () => {
  it('does not reset one millisecond before the window ends', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit(KEY, t0);
    }
    expect(hit(KEY, t0).allowed).toBe(false);

    // `existing.resetAt <= now` is the expiry test, so at resetAt - 1 the bucket is still
    // live and the caller is still blocked. Off by one the other way and a caller could
    // shave the window by a millisecond on every attempt.
    expect(hit(KEY, t0 + LOGIN_WINDOW_MS - 1).allowed).toBe(false);
  });

  it('resets exactly at the window boundary', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit(KEY, t0);
    }

    // `resetAt = t0 + WINDOW`, and `resetAt <= now` is the reset condition, so at exactly
    // `t0 + WINDOW` the bucket is expired and the caller is allowed again with a full
    // budget rather than a remaining count near zero.
    const atBoundary = hit(KEY, t0 + LOGIN_WINDOW_MS);
    expect(atBoundary.allowed).toBe(true);
    expect(atBoundary.remaining).toBe(LOGIN_MAX_ATTEMPTS - 1);
  });

  it('reports retryAfterSeconds as a whole number of seconds, and never zero when blocked', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit(KEY, t0);
    }

    // 5 minutes into a 15-minute window: 10 minutes left, i.e. 600 seconds.
    const blocked = hit(KEY, t0 + 5 * 60 * 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(10 * 60);

    // A sub-second remainder must round *up*: `Retry-After: 0` would tell a client to
    // retry immediately and invite a tight loop.
    expect(hit(KEY, t0 + LOGIN_WINDOW_MS - 100).retryAfterSeconds).toBe(1);
    expect(hit(KEY, t0 + LOGIN_WINDOW_MS - 1).retryAfterSeconds).toBe(1);
  });

  it('the Math.max(1, …) clamp is unreachable, and that is a finding rather than a gap', () => {
    // `retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))`.
    //
    // A probe replacing the whole expression with the bare `Math.ceil(…)` **survived every
    // test in this file, and in the whole suite**. It is an equivalent mutant, and the
    // argument is arithmetic rather than empirical:
    //
    //   - the refusal branch is only reached after `if (!existing || existing.resetAt <= now)`
    //     has fallen through, so `existing.resetAt > now` strictly — the remainder is
    //     **positive**;
    //   - `Math.ceil` of any value in `(0, 1]` is `1`, and of anything larger is `>= 2`;
    //   - so `Math.ceil(positive / 1000) >= 1` always, and `Math.max(1, x) === x` for every
    //     input this line can receive.
    //
    // That makes the clamp dead code today. It is **worth keeping**: the guarantee it states
    // (`Retry-After` is never 0) is the one a client depends on, and the line that would
    // make it necessary is a future one that computes the remainder differently or clamps
    // `resetAt` into the past. A test cannot kill it without weakening the real invariant to
    // reach an impossible input, so the honest treatment is to assert the invariant
    // (`>= 1` for every blocked result) and record why the mutation survives.
    //
    // This is the one survivor in the sweep that is neither a fixture gap nor dead code with
    // no purpose — it is dead code with a defensive purpose, and dressing it up as a kill
    // would be a worse outcome than saying so.
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit(KEY, t0);
    }

    // The invariant the clamp exists to state, checked across the whole refused window
    // rather than at one point.
    for (let msLeft = 1; msLeft <= LOGIN_WINDOW_MS; msLeft += 60_000) {
      const refused = hit(KEY, t0 + LOGIN_WINDOW_MS - msLeft);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(refused.retryAfterSeconds)).toBe(true);
    }
  });

  it('reports retryAfterSeconds as 0 whenever the attempt is allowed', () => {
    const t0 = 1_000_000;

    expect(hit(KEY, t0).retryAfterSeconds).toBe(0);
    expect(hit(KEY, t0 + 1).retryAfterSeconds).toBe(0);
  });
});

describe('§6.1 · keys are independent', () => {
  it('does not let one key exhaust another', () => {
    const t0 = 1_000_000;

    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit('10.0.0.1', t0 + i);
    }
    expect(hit('10.0.0.1', t0).allowed).toBe(false);

    // A second caller is unaffected. The whole point of keying by client is that one
    // attacker cannot lock out everyone else, so a shared counter would pass a
    // single-key test and fail this one.
    //
    // One call, then two assertions on its result. Calling `hit` twice to read
    // `.allowed` and `.remaining` separately would count two attempts — the first draft
    // of this test did exactly that and asserted 8.
    const other = hit('10.0.0.2', t0);
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(LOGIN_MAX_ATTEMPTS - 1);
  });

  it('treats an empty key as an ordinary key rather than a shared bucket', () => {
    // `clientKey()` falls back to `'local'` rather than `''`, so an empty key should not
    // arise — but if it did, it must not behave specially. A `if (!key) return allowed`
    // short circuit would make an unkeyed request unlimited.
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit('', t0);
    }
    expect(hit('', t0).allowed).toBe(false);
    expect(hit('local', t0).allowed).toBe(true);
  });
});

describe('§6.1 · reset', () => {
  it('clears one key and leaves the others alone', () => {
    const t0 = 1_000_000;

    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit('a', t0 + i);
      hit('b', t0 + i);
    }
    expect(hit('a', t0).allowed).toBe(false);
    expect(hit('b', t0).allowed).toBe(false);

    reset('a');

    // The reset key gets a full budget back…
    const afterReset = hit('a', t0);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(LOGIN_MAX_ATTEMPTS - 1);
    // …and the untouched key is still blocked, so `reset` is not `clearAll`.
    expect(hit('b', t0).allowed).toBe(false);
  });

  it('is a no-op for a key that was never seen', () => {
    expect(() => reset('never-seen')).not.toThrow();
    expect(hit('never-seen', 1_000).allowed).toBe(true);
  });

  it('starts the window over rather than resuming the old one', () => {
    const t0 = 1_000_000;

    hit('a', t0);
    hit('a', t0 + 60_000);
    reset('a');

    // The new bucket's window runs from the next hit, not from the original one. If
    // `reset` only zeroed `count` and kept `resetAt`, a caller who reset at minute 14
    // would get a fresh 10 attempts for the remaining minute.
    const fresh = hit('a', t0 + 60_001);
    expect(fresh.remaining).toBe(LOGIN_MAX_ATTEMPTS - 1);

    // Prove the deadline moved: fill the budget, then check it is still blocked at what
    // would have been the old expiry.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit('a', t0 + 60_001);
    }
    expect(hit('a', t0 + LOGIN_WINDOW_MS).allowed).toBe(false);
    expect(hit('a', t0 + 60_001 + LOGIN_WINDOW_MS).allowed).toBe(true);
  });
});

describe('§6.1 · the default clock', () => {
  it('accepts no arguments and uses the real clock', () => {
    // The only test that does not inject `now`. It proves the default parameter is wired
    // to `Date.now()` at all — a `now = 0` default would still pass every test above,
    // because every one of them passes an explicit value, and would make the limiter
    // compare against 1970 in production: every bucket permanently expired.
    const result = hit(KEY);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it('records the default-clock attempt at real time, not at epoch zero', () => {
    // **The test that makes the one above mean something.** A single default call is
    // indistinguishable under a `now = 0` default: both return
    // `{ allowed: true, remaining: 9, retryAfterSeconds: 0 }`, because a fresh bucket looks
    // the same whenever it was created. Probing `now = 0` against the first draft of this
    // suite left it surviving for exactly that reason.
    //
    // The distinguisher is the *second* call made with an explicit real-time value. Under
    // the real default the bucket it created is recent, so this is the second attempt in
    // it and 8 remain. Under `now = 0` the bucket was created with `resetAt = 900000` —
    // fifteen minutes after 1970 — so a real-time caller sees it as long expired and gets
    // a fresh bucket with 9 remaining.
    //
    // Consequence if the mutant were real: every bucket expires the instant it is checked
    // from the real clock, so the limit never fires and nothing else in this file notices.
    hit(KEY);

    const second = hit(KEY, Date.now());
    expect(second.remaining).toBe(LOGIN_MAX_ATTEMPTS - 2);
  });
});

describe('§6.1 · the attempt is counted even when refused', () => {
  it('does not let a caller shorten a block by continuing to try', () => {
    // The docblock: "The attempt is counted even when it is rejected, so a caller that
    // keeps trying during a block does not shorten the block."
    //
    // This is asserted by the *resetAt*, which is written once when the bucket is created
    // and never updated. A version that re-created the bucket on every refused attempt
    // would move the deadline forward for each try, so a caller hammering the endpoint
    // would extend their own block — and, more importantly, a caller who stopped trying
    // and came back would find the window restarted rather than elapsed.
    const t0 = 1_000_000;

    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      hit(KEY, t0 + i);
    }

    // 100 refused attempts spread across the window.
    for (let i = 0; i < 100; i += 1) {
      hit(KEY, t0 + i * 1000);
    }

    // The block still ends at the original deadline, one millisecond of slack for the
    // `<=` comparison — not 100 seconds later.
    expect(hit(KEY, t0 + LOGIN_WINDOW_MS - 1).allowed).toBe(false);
    expect(hit(KEY, t0 + LOGIN_WINDOW_MS).allowed).toBe(true);
  });
});
