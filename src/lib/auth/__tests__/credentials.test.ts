import 'dotenv/config';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `users` module's type, imported as a name rather than as an inline
 * `typeof import('…')`.
 *
 * This repo forbids inline `import()` type annotations
 * (`@typescript-eslint/consistent-type-imports`), and the `vi.mock` factory below needs the
 * module type to keep `importOriginal` typed. Aliasing it at the top is the idiomatic way
 * round that rule, and `usersModule` is only ever used in a type position — the real module
 * is loaded lazily below so the mock is installed first.
 */
import type * as usersModule from '@/lib/db/users';

/**
 * S1-005 / S1-019 / PRD-sprint1 §6.1 — the login path itself.
 *
 * ## Why this file exists, and what was true before it
 *
 * `src/lib/auth/credentials.ts` is the single implementation of "verify, sign, set a
 * cookie" — both `POST /api/auth/login` and the login server action call it, deliberately,
 * so the sequence cannot drift between them. Until this file existed, the module had
 * **zero** real tests. It appeared in two test files and both of them mock it:
 *
 *     src/app/login/__tests__/page.test.ts:78
 *       vi.mock('@/lib/auth/credentials', () => ({ authenticate }))
 *     src/app/change-password/__tests__/page.test.ts
 *       (the same shape)
 *
 * Those suites are about the pages — what a failure renders — and mocking the operation is
 * right there. The consequence is that the security claims this module makes in *prose*
 * were the only place they existed: the 10-attempt limit ran only in production, the
 * enumeration guard was a comment, and `assertPasswordPolicy` had never been called by
 * anything that could fail. This is the front door, and it was unlocked from the inside.
 *
 * ## What is real
 *
 * The real `authenticate`, the real `changePassword`, real bcrypt, the real Prisma client,
 * real Postgres. Only two replacements:
 *
 *   - `server-only`, which throws outside a React Server Component graph (Vitest is not
 *     one) — the marker belongs where it is, so the mock stands in for the bundler.
 *   - `@/lib/logging/logger`, so the log *lines* can be asserted rather than observed.
 *     The logger is a seam whose output is part of the contract here: the refusal paths
 *     are required to write a reason, and one of them must not write PII.
 *
 * Nothing else. In particular `rate-limit` is **not** mocked: the limit is one of the
 * behaviours under test, and a mock would let both the module and the test agree on a
 * fiction.
 *
 * ## The ordering this file is arranged around
 *
 * `authenticate` makes five decisions in a fixed order, and each one is a claim:
 *
 *   1. rate limit   — before the database, so a blocked caller learns nothing
 *   2. normalize    — the email is lowercased/trimmed before *any* lookup
 *   3. dummy hash   — bcrypt runs even when no user was found
 *   4. `!user || !pw` — the `!user` half is load-bearing; see the probe note below
 *   5. `reset` then `touchLastLogin` — only on success, and in that order
 *
 * ## The single most important mutation in this slice
 *
 * `if (!user || !passwordMatches)` — collapsing this to `if (!passwordMatches)` makes the
 * dummy-hash path a **universal login**: the dummy hash is a bcrypt hash of a plaintext
 * written in `password.ts`, so anyone who has read the repository can authenticate as any
 * email that does not exist. `password.test.ts` asserts that the dummy hash verifies
 * against that literal. The test named *"the dummy hash cannot authenticate a
 * non-existent account"* below is the other half, and it is the one that kills the mutant.
 */

vi.mock('server-only', () => ({}));

const logLines = vi.hoisted(() => [] as { event: string; fields?: Record<string, unknown> }[]);

vi.mock('@/lib/logging/logger', () => ({
  logger: {
    info: (event: string, fields?: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    warn: (event: string, fields?: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    error: (event: string, fields?: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
  },
}));

/**
 * `findUserByEmail` is wrapped rather than replaced: the wrapper calls the real function,
 * so the database is still queried for real, and the *call count* becomes assertable.
 *
 * ## Why not `vi.spyOn(prisma.user, 'findUnique')`
 *
 * Tried first, and it broke the client for every subsequent test in this file with
 * `TypeError: prisma.user.findUnique is not a function`. Prisma's delegates are proxies
 * whose methods resolve through a getter; `spyOn` defines an own property over the top of
 * it, and `mockRestore()` does not put the proxy behaviour back. A destructive spy in a
 * shared singleton is the wrong tool — and it failed loudly rather than silently, which is
 * the only reason it cost minutes instead of a mystery.
 *
 * `importOriginal` keeps `normalizeEmail`, `touchLastLogin`, `updatePassword` and
 * `findUserById` as the shipped functions, so only the one seam is touched.
 */
vi.mock('@/lib/db/users', async (importOriginal) => {
  // `importOriginal` keeps `normalizeEmail`, `touchLastLogin`, `updatePassword` and
  // `findUserById` as the shipped functions, so only the one seam is touched. The return
  // type is the module itself, taken from a `type` import at the top of the file: an
  // inline `typeof import('…')` is a lint error in this repo
  // (`@typescript-eslint/consistent-type-imports`), which is why the alias exists.
  const actual = await importOriginal<typeof usersModule>();
  return {
    ...actual,
    findUserByEmail: vi.fn(actual.findUserByEmail),
  };
});

const { prisma } = await import('@/lib/db/prisma');
const users = await import('@/lib/db/users');
const { authenticate, changePassword } = await import('@/lib/auth/credentials');
const { hashPassword, verifyPassword } = await import('@/lib/auth/password');
const { clearAll, hit } = await import('@/lib/auth/rate-limit');
const { verifySession } = await import('@/lib/auth/jwt');

const findUserByEmail = vi.mocked(users.findUserByEmail);

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

/**
 * The plaintext of `getDummyHash`, duplicated here on purpose.
 *
 * `password.test.ts` asserts that `getDummyHash()` verifies against this string. This file
 * needs the string itself, to attempt the login that must fail. Writing it as a literal in
 * both places is the point: if that value ever changes, the universal-login test below
 * stops testing anything, and a `password.test.ts` failure sends the reader here.
 */
const DUMMY_PLAINTEXT = 'groupeat-timing-equaliser-not-a-password';

const PREFIX = `cred${Date.now().toString(36).slice(-5)}`;

const GOOD_PASSWORD = 'initial-password-42';
const NEW_PASSWORD = 'replacement-pass-77';

const userIds: string[] = [];

let adminId = '';
let organiserId = '';
let mustChangeId = '';

/**
 * A distinct client key per test, so one test's attempts never pre-block another's.
 *
 * The rate limiter is a module-level `Map` keyed by whatever the caller passes, and
 * `clearAll()` is available — but relying on `beforeEach` alone would hide a bug where a
 * test blocks a key it did not own. Keys are derived from the test name and joined with
 * the prefix so a failure names its own bucket.
 */
function keyFor(label: string): string {
  return `${PREFIX}-key-${label}`;
}

/**
 * Fills a bucket to the limit using `hit()`, which is what `authenticate` calls first.
 *
 * ## Why the priming loops below do not go through `authenticate`
 *
 * A test that wants a *blocked* caller only needs the counter at its maximum. Reaching it
 * through `authenticate` costs **ten real bcrypt compares** — the password is wrong, so
 * each call hashes — to build a counter that `hit()` builds in microseconds. The blocked
 * call that follows returns before any DB read or compare, so nothing under test observes
 * the difference.
 *
 * Measured on 2026-11-07 on the M4 Pro this suite runs on:
 *
 *   - idle: 55 ms per compare at cost 10, so ten priming calls = **550 ms per test**
 *   - under load (load average 22, 15.7 GB of 16 GB swap in use): **610 ms per compare**,
 *     so the same ten calls = **6 100 ms** — past a 5 000 ms timeout, and close to the
 *     current 15 000 ms one. That is exactly what failed: eight tests across
 *     `credentials.test.ts` and `login-logout.test.ts` timed out in one gate run while
 *     every database-bound test in the same run passed.
 *
 * This is not a slowdown to be out-waited. The work is *pure JavaScript* (bcryptjs), it is
 * proportional to machine load rather than to the property under test, and it was already
 * documented as the cause of one earlier timeout on a sibling test (see *"answers a blocked
 * unknown email exactly as it answers a blocked real one"*). Every priming loop here is the
 * same shape, so the same fix applies: prime the counter, then assert on the real call.
 *
 * ## What this does *not* change
 *
 * The tests that assert something *happens during* the allowed attempts keep their real
 * `authenticate` calls — `hit()` records an attempt but proves nothing about the 401 path,
 * the query count or the log line. Those are marked individually below.
 */
function primeToLimit(keys: string | readonly string[]): void {
  const all = typeof keys === 'string' ? [keys] : keys;
  for (let i = 0; i < 10; i += 1) {
    for (const key of all) hit(key);
  }
}

async function makeUser(args: {
  tag: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  password?: string;
  mustChangePassword?: boolean;
  lastLoginAt?: Date | null;
}): Promise<{ id: string; email: string; password: string }> {
  const password = args.password ?? GOOD_PASSWORD;
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${args.tag}@example.test`,
      name: `Credential ${args.tag}`,
      passwordHash: await hashPassword(password),
      role: args.role,
      mustChangePassword: args.mustChangePassword ?? false,
      lastLoginAt: args.lastLoginAt ?? null,
    },
    select: { id: true, email: true },
  });
  userIds.push(user.id);
  return { id: user.id, email: user.email, password };
}

beforeAll(async () => {
  const admin = await makeUser({ tag: 'admin', role: 'ADMIN' });
  // Created but deliberately not bound: the merchant fixtures are looked up by email
  // through `authenticate`, and the `merchant` row here exists so `good-password` tests
  // have a second account of a different role. An unused binding is a lint error, and
  // naming it `_merchant` to silence that would be worse than a comment saying why.
  await makeUser({ tag: 'merchant', role: 'MERCHANT' });
  const organiser = await makeUser({ tag: 'organiser', role: 'ORGANISER' });
  const mustChange = await makeUser({
    tag: 'mustchange',
    role: 'MERCHANT',
    password: 'temporary-pass-99',
    mustChangePassword: true,
  });

  adminId = admin.id;
  organiserId = organiser.id;
  mustChangeId = mustChange.id;
});

beforeEach(() => {
  // The limiter is global state. Every test starts from an empty map *and* its own key,
  // which is belt and braces on purpose: `clearAll` proves the map is emptied, and the
  // per-test key means an ordering change cannot make one test depend on another's count.
  clearAll();
  logLines.length = 0;
  // `mockClear` only — see the wrapper's comment. Resetting would drop the real
  // implementation and every test after the first would find no user at all.
  findUserByEmail.mockClear();
});

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // `User` is collected, not a child of it: `OrganiserProfile.user` and
  // `MerchantUser.user` are both `onDelete: Cascade`, so deleting the account is the
  // complete delete and there is no ordering to get wrong. `credentials.ts` creates no
  // other row — `touchLastLogin` updates, it does not insert.
  await step(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));

  if (failures.length > 0) {
    throw new AggregateError(failures, `credentials.test.ts teardown failed`);
  }
});

// ---------------------------------------------------------------------------
// authenticate — success
// ---------------------------------------------------------------------------

describe('§6.1 · authenticate — a correct password', () => {
  it('returns a session, a redirect target and the user it belongs to', async () => {
    const user = await makeUser({ tag: 'ok-merchant', role: 'MERCHANT' });

    const result = await authenticate(user.email, user.password, keyFor('ok'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.session.userId).toBe(user.id);
    expect(result.session.role).toBe('MERCHANT');
    expect(result.session.mustChangePassword).toBe(false);
    expect(result.redirectTo).toBe('/merchant/drops');
  });

  it('signs a token that verifies, so the session is the real one', async () => {
    // `newSession` is pure and tested elsewhere (session.test.ts). What is *not* tested
    // elsewhere is that `authenticate` puts the right claims in it — this is the seam
    // between the database row and the token, and a `role: 'ADMIN'` copied from the wrong
    // variable would pass a test that only checked `ok`.
    const user = await makeUser({ tag: 'ok-token', role: 'ORGANISER' });

    const result = await authenticate(user.email, user.password, keyFor('token'));
    if (!result.ok) throw new Error('expected success');

    const { signSession } = await import('@/lib/auth/jwt');
    const token = await signSession(result.session);
    const claims = await verifySession(token);

    expect(claims?.userId).toBe(user.id);
    expect(claims?.role).toBe('ORGANISER');
    expect(claims?.mustChangePassword).toBe(false);
  });

  it('sends each role to its own home', async () => {
    // `roleHome` is pure and pinned in session.test.ts. This asserts `authenticate`
    // *calls* it with the row's role rather than a constant — the three cases differ, so
    // a hardcoded `/merchant/drops` fails two of them.
    const admin = await authenticate(
      (await prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { email: true } })).email,
      GOOD_PASSWORD,
      keyFor('home-admin'),
    );
    const organiser = await authenticate(
      (await prisma.user.findUniqueOrThrow({ where: { id: organiserId }, select: { email: true } })).email,
      GOOD_PASSWORD,
      keyFor('home-organiser'),
    );

    expect(admin.ok && admin.redirectTo).toBe('/admin/users');
    expect(organiser.ok && organiser.redirectTo).toBe('/organiser');
  });

  it('sends a mustChangePassword user to /change-password instead of their home', async () => {
    // S1-019. The redirect is the product requirement: the temporary password must be
    // replaced before the rest of the app is reachable. A session minted with
    // `mustChangePassword: true` is what middleware gates on, and the redirect is what
    // gets the browser to the one screen that gate allows — so both halves matter and
    // they are asserted separately.
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: mustChangeId },
      select: { email: true },
    });

    const result = await authenticate(user.email, 'temporary-pass-99', keyFor('mustchange'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.redirectTo).toBe('/change-password');
    expect(result.session.mustChangePassword).toBe(true);
  });

  it('normalises the email before the lookup, so case and whitespace do not matter', async () => {
    const user = await makeUser({ tag: 'normalise', role: 'MERCHANT' });
    const shouted = `  ${user.email.toUpperCase()}  `;

    const result = await authenticate(shouted, user.password, keyFor('normalise'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.userId).toBe(user.id);
  });

  it('writes lastLoginAt on success', async () => {
    const user = await makeUser({ tag: 'lastlogin', role: 'MERCHANT' });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { lastLoginAt: true },
    });
    expect(before.lastLoginAt).toBeNull();

    await authenticate(user.email, user.password, keyFor('lastlogin'));

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { lastLoginAt: true },
    });
    expect(after.lastLoginAt).toBeInstanceOf(Date);
    // Recency rather than a fixed instant: the point is that it was written *now*.
    expect(Date.now() - (after.lastLoginAt?.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it('logs auth.login_succeeded with the user id and role, and no password', async () => {
    const user = await makeUser({ tag: 'logs-ok', role: 'ADMIN' });

    await authenticate(user.email, user.password, keyFor('logs-ok'));

    const succeeded = logLines.filter((line) => line.event === 'auth.login_succeeded');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.fields).toEqual({ userId: user.id, role: 'ADMIN' });

    // No log line anywhere in this call may carry the password or the hash. `toEqual` on
    // the fields above already excludes extras, but this checks the whole event stream,
    // because a future `logger.debug('auth.debug', { password })` would sit in a
    // different line from the one asserted.
    const serialised = JSON.stringify(logLines);
    expect(serialised).not.toContain(user.password);
    expect(serialised).not.toContain('$2b$');
  });

  it('clears the rate-limit counter on success', async () => {
    const user = await makeUser({ tag: 'reset-on-success', role: 'MERCHANT' });
    const key = keyFor('reset-on-success');

    // Nine failures, leaving exactly one attempt in the budget. The success below is the
    // tenth and must be allowed — which is what makes the reset observable: without it the
    // *eleventh* attempt would be refused, and this test would look like a limit bug.
    //
    // The count is deliberately NOT checked with `hit(key)` in between: `hit` records an
    // attempt, so observing the budget consumes it. The first draft of this test did that
    // and turned the correct-password login into the eleventh attempt. For the same reason
    // the priming is nine `hit()` calls rather than nine `authenticate()` calls — each of
    // those would be a 55 ms bcrypt compare to build a counter, and the property under test
    // is that the tenth call *succeeds*, not how the first nine failed.
    for (let i = 0; i < 9; i += 1) hit(key);

    const result = await authenticate(user.email, user.password, key);
    expect(result.ok).toBe(true);

    // The counter is gone, so a later attempt starts a fresh window rather than being
    // refused. Without the `reset(clientKey)` a legitimate user who mistyped nine times
    // and then succeeded would have one attempt left in the window — and a user who
    // mistyped ten and then remembered would be locked out for the remaining quarter of
    // an hour. That is the failure the docblock says the reset exists to prevent.
    const fresh = hit(key);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// authenticate — failure
// ---------------------------------------------------------------------------

describe('§6.1 · authenticate — the two failure modes are one answer', () => {
  it('refuses a wrong password with 401 and the generic message', async () => {
    const user = await makeUser({ tag: 'wrong-pw', role: 'MERCHANT' });

    const result = await authenticate(user.email, 'definitely-not-it-9', keyFor('wrong-pw'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(401);
    expect(result.message).toBe('Email or password is incorrect.');
  });

  it('refuses an unknown email with the byte-identical response', async () => {
    // PRD-sprint1 §6.1: "one message for both wrong email and wrong password". Asserting
    // each message separately would pass while the two differed; asserting they are
    // `toEqual` is what makes them indistinguishable to a caller.
    const user = await makeUser({ tag: 'unknown-vs-wrong', role: 'MERCHANT' });

    const unknownEmail = await authenticate(
      `${PREFIX}-nobody-at-all@example.test`,
      'definitely-not-it-9',
      keyFor('unknown'),
    );
    const wrongPassword = await authenticate(
      user.email,
      'definitely-not-it-9',
      keyFor('wrong'),
    );

    expect(unknownEmail).toEqual(wrongPassword);
    expect(unknownEmail).toEqual({
      ok: false,
      status: 401,
      message: 'Email or password is incorrect.',
    });
  });

  it('does not leak the account state through the failure object', async () => {
    // A mustChangePassword account that fails to authenticate must not be distinguishable
    // from an ordinary one, and a locked/disabled state does not exist yet — but the
    // assertion is about the *shape*: a failure carries exactly three keys, so a future
    // `{ ..., mustChangePassword: true }` added for convenience is a test failure rather
    // than an enumeration oracle.
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: mustChangeId },
      select: { email: true },
    });

    const result = await authenticate(user.email, 'wrong-temporary-1', keyFor('shape'));

    expect(Object.keys(result).sort()).toEqual(['message', 'ok', 'status']);
  });

  it('the dummy hash cannot authenticate a non-existent account', async () => {
    // THE test in this file. `if (!user || !passwordMatches)` — delete the `!user ||` half
    // and the dummy-hash verification becomes a login: every address with no account is
    // authenticatable by anyone who has read `password.ts`. Probed by making exactly that
    // edit; this assertion is what fails.
    const result = await authenticate(
      `${PREFIX}-nobody-at-all@example.test`,
      DUMMY_PLAINTEXT,
      keyFor('dummy-login'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(401);
  });

  it('does not write lastLoginAt on a failure', async () => {
    // The mirror of the success assertion. A `touchLastLogin` moved above the guard would
    // stamp a login time on an account nobody signed into, and the admin user list would
    // then show a last-seen for an attack.
    const user = await makeUser({ tag: 'no-lastlogin', role: 'MERCHANT' });

    await authenticate(user.email, 'wrong-password-1', keyFor('no-lastlogin'));

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { lastLoginAt: true },
    });
    expect(after.lastLoginAt).toBeNull();
  });

  it('logs the reason, and distinguishes the two internally while answering identically', async () => {
    // The refusal is uniform to the caller and *not* uniform in the log. That asymmetry is
    // deliberate and is what makes the log useful for an operator: they can see a
    // password-spray against real addresses, which the response deliberately hides.
    const user = await makeUser({ tag: 'log-reason', role: 'MERCHANT' });

    await authenticate(`${PREFIX}-nobody-at-all@example.test`, 'x-wrong-1', keyFor('log-unknown'));
    await authenticate(user.email, 'x-wrong-1', keyFor('log-badpw'));

    const reasons = logLines
      .filter((line) => line.event === 'auth.login_failed')
      .map((line) => line.fields?.reason);

    expect(reasons).toEqual(['unknown_email', 'bad_password']);
  });

  it('does not log the email address, the password, or whether an account exists', async () => {
    // The log is a place an email address is *tempting* to put, and PRD-sprint1 §10 forbids
    // it. `auth.login_failed` carries only `reason`, which is a bucket, not an identifier.
    const user = await makeUser({ tag: 'log-pii', role: 'MERCHANT' });

    await authenticate(user.email, 'x-wrong-1', keyFor('log-pii'));
    await authenticate(`${PREFIX}-nobody-at-all@example.test`, 'x-wrong-1', keyFor('log-pii-2'));

    const serialised = JSON.stringify(logLines);
    expect(serialised).not.toContain(user.email);
    expect(serialised).not.toContain(PREFIX);
    expect(serialised).not.toContain('x-wrong-1');
  });
});

// ---------------------------------------------------------------------------
// authenticate — the rate limit
// ---------------------------------------------------------------------------

describe('§6.1 · authenticate — the rate limit runs first', () => {
  it('refuses the eleventh attempt with 429 and a retry window', async () => {
    const user = await makeUser({ tag: 'limit', role: 'MERCHANT' });
    const key = keyFor('limit');

    // Nine of the ten allowed attempts are primed through `hit()` (see `primeToLimit`).
    // The tenth is deliberately a *real* `authenticate` call, because the boundary is the
    // claim: attempt 10 must still be a 401 and attempt 11 must be the 429. Priming all ten
    // would leave the off-by-one — `count > maxAttempts` rather than `>=` — untested.
    for (let i = 0; i < 9; i += 1) hit(key);

    const tenth = await authenticate(user.email, 'wrong-password-1', key);
    expect(tenth.ok).toBe(false);
    if (tenth.ok) throw new Error('unreachable');
    expect(tenth.status, 'attempt 10 is the last allowed one').toBe(401);

    const eleventh = await authenticate(user.email, 'wrong-password-1', key);
    expect(eleventh.ok).toBe(false);
    if (eleventh.ok) throw new Error('unreachable');
    expect(eleventh.status, 'attempt 11 is refused').toBe(429);
    expect(eleventh.message).toBe('Too many attempts. Try again in a few minutes.');
    expect(eleventh.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refuses even the CORRECT password once the limit is reached', async () => {
    // The ordering claim. `hit()` is the first statement in `authenticate`, before the
    // database read, so a correct password cannot rescue a blocked caller. A limiter moved
    // below the password check would let the eleventh attempt succeed — and that is the
    // one attempt an attacker who *has* found the password cares about, because it means
    // the limit never protects a discovered credential.
    const user = await makeUser({ tag: 'limit-correct', role: 'MERCHANT' });
    const key = keyFor('limit-correct');

    primeToLimit(key);

    const blocked = await authenticate(user.email, user.password, key);

    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unreachable');
    expect(blocked.status).toBe(429);
  });

  it('does not read the user table when blocked, so a blocked caller learns nothing', async () => {
    // "Rate limit first, so a blocked caller learns nothing about the account." The
    // observable consequence is that the lookup is not made at all: no timing difference
    // between a blocked attempt against a real address and one against an invented
    // address, and no query log an operator could correlate.
    //
    // Measured as a call count rather than a stopwatch, because a stopwatch on a single
    // query inside a 54 ms bcrypt budget is a coin flip. The counter is cleared *after*
    // the ten priming attempts so the assertion counts only the blocked call.
    const user = await makeUser({ tag: 'limit-noquery', role: 'MERCHANT' });
    const key = keyFor('limit-noquery');

    primeToLimit(key);

    // `mockClear` keeps the implementation (the wrapper still calls the real function) and
    // only resets the call history — `mockReset` would drop the implementation and make
    // every later test in this file find no user.
    findUserByEmail.mockClear();

    const blocked = await authenticate(user.email, user.password, key);

    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unreachable');
    expect(blocked.status).toBe(429);
    expect(findUserByEmail).not.toHaveBeenCalled();
  });

  it('answers a blocked unknown email exactly as it answers a blocked real one', async () => {
    const user = await makeUser({ tag: 'limit-uniform', role: 'MERCHANT' });
    const realKey = keyFor('limit-uniform-real');
    const fakeKey = keyFor('limit-uniform-fake');
    const unknownEmail = `${PREFIX}-nobody-at-all@example.test`;

    // Prime both buckets past the limit with `hit()` rather than with eleven real
    // `authenticate()` calls each. The claim under test is about the *blocked* branch —
    // that it answers identically whether or not the address exists — and a blocked call
    // returns before any DB read or bcrypt compare. Priming through `authenticate` would
    // pay 22 bcrypt compares (~54 ms each, far more under load) to build a counter that
    // `hit()` builds for free, and that is what made this test time out at 5000 ms on a
    // loaded machine. `hit()` is the same limiter `authenticate` calls first.
    for (let i = 0; i < 10; i += 1) {
      hit(realKey);
      hit(fakeKey);
    }

    const real = await authenticate(user.email, user.password, realKey);
    const fake = await authenticate(unknownEmail, user.password, fakeKey);

    // The enumeration-guard property is "a blocked unknown email answers the same as a
    // blocked real one": same `ok`, same `status`, same `message`, same response *shape*.
    // The exact `retryAfterSeconds` is deliberately NOT cross-compared: each bucket's
    // deadline is `firstAttempt + 15 min`, so the two buckets can start apart and
    // `Math.ceil` makes their whole-second remainders differ. That is a property of *when
    // each caller started*, not of the account, so it is not an oracle. Both being blocked
    // for a near-full window is what matters.
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
    if (real.ok || fake.ok) throw new Error('unreachable');

    expect(real.status).toBe(fake.status);
    expect(real.message).toBe(fake.message);
    expect(Object.keys(real).sort()).toEqual(Object.keys(fake).sort());

    // Both buckets are fresh, so each reports a near-full 15-minute window. Asserted as a
    // band rather than an exact value so the test does not depend on elapsed wall-clock.
    expect(real.retryAfterSeconds).toBeGreaterThan(800);
    expect(fake.retryAfterSeconds).toBeGreaterThan(800);
  });

  it('logs auth.login_failed with reason rate_limited, and nothing about the account', async () => {
    const user = await makeUser({ tag: 'limit-log', role: 'MERCHANT' });
    const key = keyFor('limit-log');

    primeToLimit(key);
    logLines.length = 0;

    await authenticate(user.email, user.password, key);

    const failed = logLines.filter((line) => line.event === 'auth.login_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields).toEqual({ reason: 'rate_limited' });
    // In particular there is no `auth.login_succeeded`: the block happens before the
    // password is verified, so a correct password must not reach the success branch.
    expect(logLines.some((line) => line.event === 'auth.login_succeeded')).toBe(false);
  });

  it('treats each client key as its own budget', async () => {
    const user = await makeUser({ tag: 'limit-keys', role: 'MERCHANT' });
    const attacker = keyFor('limit-attacker');
    const victim = keyFor('limit-victim');

    primeToLimit(attacker);
    expect((await authenticate(user.email, user.password, attacker)).ok).toBe(false);

    // The legitimate user, from a different key, is unaffected. A limiter keyed on the
    // email address instead of the client would lock the real user out of their own
    // account — which is the denial-of-service a per-client key avoids.
    const legitimate = await authenticate(user.email, user.password, victim);
    expect(legitimate.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// authenticate — the timing equaliser
// ---------------------------------------------------------------------------

describe('§6.1 · authenticate — the enumeration guard costs the same either way', () => {
  it('spends bcrypt time on an unknown email, not just on a wrong password', async () => {
    // The docblock's claim: "`verifyPassword` runs even when the user does not exist,
    // against a dummy hash, so timing does not reveal whether an email is registered."
    //
    // Probed first, so the threshold is measured rather than guessed: on this machine a
    // bcrypt compare at cost 10 takes ~54 ms and a bare `findUnique` takes ~1 ms. That is
    // a 50× gap, so a floor at 20 ms cleanly separates "hashed" from "did not hash"
    // without being sensitive to load. A stopwatch assertion that could not tell those
    // apart would be worse than no assertion.
    //
    // The threshold is deliberately loose in one direction only (`>=`): the mutant this
    // kills is `verifyPassword` being skipped, which removes the whole 54 ms, not part of
    // it.
    const started = process.hrtime.bigint();

    await authenticate(
      `${PREFIX}-nobody-at-all@example.test`,
      'some-password-1',
      keyFor('timing-unknown'),
    );

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThan(20);
  });

  it('spends comparable time on a real account with a wrong password', async () => {
    // The other side of the same claim, and the reason the first test is meaningful: if
    // only the unknown-email path paid for bcrypt, the previous assertion would pass while
    // the two paths differed by 50 ms in the other direction.
    const user = await makeUser({ tag: 'timing-real', role: 'MERCHANT' });

    const started = process.hrtime.bigint();

    await authenticate(user.email, 'some-password-1', keyFor('timing-real'));

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThan(20);
  });

  it('gives the two paths medians within a factor of two of each other', async () => {
    // The assertions above each prove a floor. This one proves they are *similar*, which
    // is the actual security property — an equaliser that made both paths slow but
    // unequal would pass both of the above.
    //
    // Medians of five, and a factor of two rather than a tight bound: this runs on a
    // shared machine, and a tight bound would be a flaky test rather than a stronger one.
    // The mutant it kills (skipping bcrypt on the unknown path) produces a ratio near 50,
    // so a factor of two has a great deal of headroom.
    const user = await makeUser({ tag: 'timing-median', role: 'MERCHANT' });

    // Both paths are symmetric — one rate-limit hit, one DB lookup, one bcrypt compare —
    // so their medians should land within a factor of two. Two properties keep this from
    // being a coin flip on a loaded machine:
    //
    //   1. The samples are *interleaved* (one unknown, one real, repeated) so both medians
    //      see the same sequence of load conditions. Measuring each path in its own batch
    //      let a slow-DB window land on one batch and not the other.
    //   2. Five pairs, not more: every `authenticate` costs a real bcrypt compare (~54 ms
    //      nominal, much more under load), and the default test timeout is 5000 ms. Ten
    //      calls is the budget.
    //
    // The mutant this kills — skipping bcrypt on the unknown path — produces a ratio near
    // 50, so a factor of two has enormous headroom. A fresh client key per call keeps the
    // rate limiter out of the measurement.
    const PAIRS = 5;
    const unknownSamples: number[] = [];
    const realSamples: number[] = [];
    for (let i = 0; i < PAIRS; i += 1) {
      const unknownStart = process.hrtime.bigint();
      await authenticate(
        `${PREFIX}-nobody-at-all@example.test`,
        'some-password-1',
        keyFor(`timing-median-unknown-${i}`),
      );
      unknownSamples.push(Number(process.hrtime.bigint() - unknownStart) / 1e6);

      const realStart = process.hrtime.bigint();
      await authenticate(user.email, 'some-password-1', keyFor(`timing-median-real-${i}`));
      realSamples.push(Number(process.hrtime.bigint() - realStart) / 1e6);
    }
    unknownSamples.sort((a, b) => a - b);
    realSamples.sort((a, b) => a - b);
    const unknownMedian = unknownSamples[Math.floor(PAIRS / 2)] ?? 0;
    const realMedian = realSamples[Math.floor(PAIRS / 2)] ?? 0;

    const ratio = Math.max(unknownMedian, realMedian) / Math.min(unknownMedian, realMedian);
    expect(ratio).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// changePassword
// ---------------------------------------------------------------------------

describe('S1-019 · changePassword — the happy path', () => {
  it('replaces the hash, clears the flag, and re-signs the session with mv: false', async () => {
    const user = await makeUser({
      tag: 'cp-ok',
      role: 'MERCHANT',
      password: 'temporary-pass-99',
      mustChangePassword: true,
    });

    const result = await changePassword(user.id, 'temporary-pass-99', NEW_PASSWORD);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // The session returned to the caller must open the middleware gate immediately, which
    // means `mustChangePassword: false` — this is the whole of S1-019's "without a
    // re-login".
    expect(result.session.mustChangePassword).toBe(false);
    expect(result.session.userId).toBe(user.id);
    expect(result.redirectTo).toBe('/merchant/drops');

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true, mustChangePassword: true },
    });
    expect(stored.mustChangePassword).toBe(false);
    expect(await verifyPassword(NEW_PASSWORD, stored.passwordHash)).toBe(true);
    expect(await verifyPassword('temporary-pass-99', stored.passwordHash)).toBe(false);
  });

  it('returns a token whose mv claim is false, so middleware lets it through', async () => {
    // The session object is a plain claim bag; what middleware reads is the *token*. A
    // `result.session` that looked right and a token that still said `mv: true` would
    // leave the user bouncing back to /change-password forever, and only a token check
    // would see it.
    const user = await makeUser({
      tag: 'cp-token',
      role: 'ORGANISER',
      password: 'temporary-pass-99',
      mustChangePassword: true,
    });

    const result = await changePassword(user.id, 'temporary-pass-99', NEW_PASSWORD);
    if (!result.ok) throw new Error('expected success');

    const { signSession } = await import('@/lib/auth/jwt');
    const claims = await verifySession(await signSession(result.session));

    expect(claims?.mustChangePassword).toBe(false);
    expect(claims?.userId).toBe(user.id);
    expect(claims?.role).toBe('ORGANISER');
  });

  it('logs auth.password_changed with the user id', async () => {
    const user = await makeUser({
      tag: 'cp-log',
      role: 'MERCHANT',
      password: 'temporary-pass-99',
      mustChangePassword: true,
    });

    await changePassword(user.id, 'temporary-pass-99', NEW_PASSWORD);

    const changed = logLines.filter((line) => line.event === 'auth.password_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.fields).toEqual({ userId: user.id });

    const serialised = JSON.stringify(logLines);
    expect(serialised).not.toContain(NEW_PASSWORD);
    expect(serialised).not.toContain('temporary-pass-99');
  });

  it('works for a user who was not flagged, so a voluntary change is the same path', async () => {
    // `actions.ts`'s comment: "the same server action serves the voluntary change and the
    // temporary-password bootstrap". A `mustChangePassword` check in `changePassword`
    // would make the voluntary case unreachable, and nothing else would notice.
    const user = await makeUser({ tag: 'cp-voluntary', role: 'ADMIN' });

    const result = await changePassword(user.id, GOOD_PASSWORD, NEW_PASSWORD);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.redirectTo).toBe('/admin/users');
  });

  it('does not write lastLoginAt, whatever its docblock says', async () => {
    // A documented-but-absent behaviour, asserted so the discrepancy is recorded rather
    // than rediscovered. The docblock above `changePassword` says:
    //
    //   "On success the flag is cleared, `lastLoginAt` is refreshed and the session is
    //    re-signed with `mv = false`"
    //
    // The function never calls `touchLastLogin`. So either the sentence is wrong or the
    // code is missing a line — and since `authenticate` already stamps `lastLoginAt` at
    // the moment of sign-in, and a forced change always follows a sign-in, the sentence is
    // the thing that is wrong. Pinned as current behaviour; the fix belongs with a
    // decision about whether a password change should count as activity, which is not
    // this slice's to make.
    const user = await makeUser({
      tag: 'cp-lastlogin',
      role: 'MERCHANT',
      password: 'temporary-pass-99',
      mustChangePassword: true,
      lastLoginAt: new Date('2026-01-01T00:00:00Z'),
    });

    await changePassword(user.id, 'temporary-pass-99', NEW_PASSWORD);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { lastLoginAt: true },
    });
    expect(after.lastLoginAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('S1-019 · changePassword — the refusals', () => {
  it('refuses a wrong current password with 422 on the currentPassword field', async () => {
    const user = await makeUser({ tag: 'cp-wrong', role: 'MERCHANT' });

    const result = await changePassword(user.id, 'not-the-current-1', NEW_PASSWORD);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(422);
    expect(result.field).toBe('currentPassword');
    expect(result.message).toBe('That is not your current password.');
  });

  it('leaves the hash untouched when the current password is wrong', async () => {
    // A `updatePassword` that ran unconditionally would let the 422 response accompany a
    // successful change — the caller is told to retry, and the password has moved.
    const user = await makeUser({ tag: 'cp-wrong-unchanged', role: 'MERCHANT' });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    await changePassword(user.id, 'not-the-current-1', NEW_PASSWORD);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await verifyPassword(GOOD_PASSWORD, after.passwordHash)).toBe(true);
  });

  it('refuses reusing the current password with 422 on the newPassword field', async () => {
    // The reuse check is `newPassword === currentPassword`, i.e. a string comparison
    // against the *submitted* current password — not against the stored hash. That is
    // correct and cheap, and it means the check must come after the current password was
    // verified: before it, any caller could learn "this is your password" for free.
    const user = await makeUser({ tag: 'cp-reuse', role: 'MERCHANT' });

    const result = await changePassword(user.id, GOOD_PASSWORD, GOOD_PASSWORD);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(422);
    expect(result.field).toBe('newPassword');
    expect(result.message).toBe('Choose a password you have not used here before.');
  });

  it('refuses a too-short new password with the policy message', async () => {
    const user = await makeUser({ tag: 'cp-short', role: 'MERCHANT' });

    const result = await changePassword(user.id, GOOD_PASSWORD, 'short1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(422);
    expect(result.field).toBe('newPassword');
    expect(result.message).toBe('Use at least 12 characters.');
  });

  it('refuses a new password with no number, and one with no letter', async () => {
    const user = await makeUser({ tag: 'cp-composition', role: 'MERCHANT' });

    const noNumber = await changePassword(user.id, GOOD_PASSWORD, 'alllettersnonumber');
    const noLetter = await changePassword(user.id, GOOD_PASSWORD, '1234567890123');

    expect(noNumber.ok).toBe(false);
    expect(noLetter.ok).toBe(false);
    if (noNumber.ok || noLetter.ok) throw new Error('unreachable');

    expect(noNumber.message).toBe('Use at least one letter and one number.');
    expect(noLetter.message).toBe('Use at least one letter and one number.');
  });

  it('checks the current password BEFORE the policy, so the policy cannot be probed', async () => {
    // Ordering, and it is a leak in the other direction: if the policy ran first, a caller
    // holding no credential could learn a password's acceptability. Asserted with a new
    // password that is *both* too short and not the current one — the two failures produce
    // different messages, so which one comes back is the order.
    const user = await makeUser({ tag: 'cp-order', role: 'MERCHANT' });

    const result = await changePassword(user.id, 'not-the-current-1', 'short1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.field).toBe('currentPassword');
    expect(result.message).toBe('That is not your current password.');
  });

  it('refuses a vanished user with 401 and no field', async () => {
    // The session outlived the row. `changePassword` returns a bare 401 rather than a 422,
    // because "sign in again" is not something the user can fix on this form.
    const result = await changePassword(
      '00000000-0000-4000-8000-000000000000',
      GOOD_PASSWORD,
      NEW_PASSWORD,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(401);
    expect(result.message).toBe('Please sign in again.');
    expect(result.field).toBeUndefined();
  });

  it('does not log a password change that did not happen', async () => {
    const user = await makeUser({ tag: 'cp-nolog', role: 'MERCHANT' });

    await changePassword(user.id, 'not-the-current-1', NEW_PASSWORD);
    await changePassword(user.id, GOOD_PASSWORD, 'short1');

    expect(logLines.some((line) => line.event === 'auth.password_changed')).toBe(false);
  });
});

describe('S1-019 · changePassword — what it does not check', () => {
  it('changes the password of an IMPERSONATED user if handed their id', async () => {
    // A reachability note, asserted so the next reader knows the boundary of this
    // function's responsibility rather than assuming it.
    //
    // `changePassword(userId, …)` has no session parameter and no
    // `refuseIfImpersonating` call — it trusts the caller for *who* it is acting on. The
    // route and the server action both pass `session.userId`, and neither reaches here
    // for a borrowed session, so nothing exploitable exists today. The assertion records
    // that the guard is at the edge, not here, which is where a future caller that accepts
    // a user id from a request body would have to add it.
    const user = await makeUser({ tag: 'cp-imp', role: 'MERCHANT' });

    const result = await changePassword(user.id, GOOD_PASSWORD, NEW_PASSWORD);

    expect(result.ok).toBe(true);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(NEW_PASSWORD, stored.passwordHash)).toBe(true);
  });

  it('does not re-run the policy when the current password is already wrong', async () => {
    // Cheap half of the ordering assertion above, and phrased as the negative: no write,
    // no log, and a 422 that names the current password. Belt-and-braces with the earlier
    // test, kept because this one would still pass if the messages were changed.
    const user = await makeUser({ tag: 'cp-no-write', role: 'MERCHANT' });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true, mustChangePassword: true },
    });

    const result = await changePassword(user.id, 'not-the-current-1', 'x1');

    expect(result.ok).toBe(false);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true, mustChangePassword: true },
    });
    expect(after).toEqual(before);
  });
});
