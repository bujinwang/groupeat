import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

import {
  IMPERSONATION_MAX_MINUTES,
  SESSION_SLIDING_MINUTES,
  isImpersonating,
  needsRefresh,
  newAbsoluteExpiry,
  newImpersonationSession,
  newSession,
  signSession,
  verifySession,
} from '@/lib/auth/jwt';

/**
 * FR-904 — the borrowed session's token contract.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## The one test this file exists for
 *
 * `signSession` is the login path **and** the refresh path. Middleware calls it on every
 * request that lands inside the sliding window, which is every request in the last
 * fifteen minutes of a session — and an impersonation session is *thirty* minutes long,
 * so it is inside that window from minute fifteen onward. Half of every impersonation
 * runs through the refresh path.
 *
 * If `signSession` dropped the `imp` claim, the failure would be silent and total: the
 * refreshed token would be a plain `MERCHANT` session for the same user id. The read-only
 * guard would stop firing, the audit link would be gone, `/api/auth/impersonation/end`
 * would answer "you are not impersonating anyone", and the admin would be left holding a
 * merchant cookie with their own role lost. No error, no log line, no obvious symptom —
 * just a normal-looking merchant session that one person gained without a password.
 *
 * So the first describe block refreshes a real impersonation session the way middleware
 * does and asserts the claim is still there, still names the same admin, and still
 * expires when it said it would.
 *
 * The rest is the ordinary rejection surface, extended by the claim: a token that
 * half-declares an impersonation is refused outright rather than degraded, because
 * "ignore the field we do not understand" is how a read-only session becomes a writable
 * one.
 */

process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const NOW = Math.floor(Date.now() / 1000);

const MERCHANT_USER = '22222222-2222-2222-2222-222222222222';
const ADMIN_USER = '33333333-3333-3333-3333-333333333333';
const AUDIT_ID = '44444444-4444-4444-4444-444444444444';

function borrowed() {
  return newImpersonationSession({
    merchantUserId: MERCHANT_USER,
    actorUserId: ADMIN_USER,
    auditId: AUDIT_ID,
  });
}

describe('FR-904 · the claim survives the sliding refresh', () => {
  it('re-signing a borrowed session keeps the claim, the actor and the audit id', async () => {
    // The exact sequence middleware performs: verify the cookie, decide it is inside
    // the window, hand the verified claims straight back to `signSession`.
    const original = await signSession(borrowed());
    const verified = await verifySession(original);
    expect(verified).not.toBeNull();

    const refreshed = await signSession(verified!);
    const afterRefresh = await verifySession(refreshed);

    expect(afterRefresh?.impersonation).toEqual({
      actorUserId: ADMIN_USER,
      auditId: AUDIT_ID,
      expiresAt: expect.any(Number),
    });
    expect(isImpersonating(afterRefresh)).toBe(true);
    // The identity being borrowed is unchanged too.
    expect(afterRefresh?.userId).toBe(MERCHANT_USER);
    expect(afterRefresh?.role).toBe('MERCHANT');
  });

  it('a refresh cannot extend the impersonation', async () => {
    // `signSession` accepts any claims it is handed, and middleware hands it whatever
    // `verifySession` returned. The clamp is the only thing standing between "a refresh
    // renews the 60-minute sliding window" and "a read-only session that never ends".
    const session = borrowed();
    const claimedExpiry = session.impersonation!.expiresAt;

    const refreshed = await verifySession(await signSession(session));

    expect(refreshed?.expiresAt).toBeLessThanOrEqual(claimedExpiry);
    expect(refreshed?.absoluteExpiresAt).toBeLessThanOrEqual(claimedExpiry);
    expect(refreshed?.impersonation?.expiresAt).toBe(claimedExpiry);
  });

  it('a borrowed session is inside the refresh window for most of its life', async () => {
    // Not an assertion about `jwt.ts` so much as about why the previous two matter: an
    // impersonation is 30 minutes and the refresh threshold is 15, so from minute
    // fifteen the session takes the refresh path on *every* request. If the claim were
    // dropped there, this is the window in which it would be dropped.
    const session = borrowed();
    const halfway = {
      ...session,
      expiresAt: NOW + (IMPERSONATION_MAX_MINUTES * 60) / 2 - 1,
    };

    expect(needsRefresh(halfway)).toBe(true);
  });

  it('ordinary sessions carry no claim at all', async () => {
    const plain = newSession({ userId: ADMIN_USER, role: 'ADMIN', mustChangePassword: false });
    const verified = await verifySession(await signSession(plain));

    // Absent, not `undefined`-valued: `isImpersonating` and the banner both branch on
    // presence, and a `null` that reads as present would be a permanently stuck banner.
    expect(verified && 'impersonation' in verified).toBe(false);
    expect(isImpersonating(verified)).toBe(false);
  });
});

describe('FR-904 · a malformed claim rejects the token', () => {
  // Each of these is a token signed with the real secret carrying a broken `imp`. They
  // cannot be produced by this app, which is exactly why they must be refused: the only
  // way one exists is a bug in signing or an attempt to shape a claim we did not mean.
  async function withClaim(claim: unknown, overrides: Record<string, unknown> = {}) {
    return new SignJWT({
      role: 'MERCHANT',
      mv: false,
      absAt: NOW + 86_400,
      imp: claim,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(MERCHANT_USER)
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }

  it('refuses a non-object claim', async () => {
    expect(await verifySession(await withClaim('yes'))).toBeNull();
    expect(await verifySession(await withClaim(null))).toBeNull();
    expect(await verifySession(await withClaim([]))).toBeNull();
  });

  it('refuses a claim missing any field', async () => {
    const complete = { a: ADMIN_USER, i: AUDIT_ID, e: NOW + 600 };

    expect(await verifySession(await withClaim({ ...complete, a: undefined }))).toBeNull();
    expect(await verifySession(await withClaim({ ...complete, i: undefined }))).toBeNull();
    expect(await verifySession(await withClaim({ ...complete, e: undefined }))).toBeNull();
  });

  it('refuses an empty actor or audit id', async () => {
    // An empty string passes a truthiness check on the object but names nobody. The
    // audit link and the exit route both key off these, so "present but blank" is as
    // broken as missing and must not be treated as a valid impersonation.
    expect(await verifySession(await withClaim({ a: '', i: AUDIT_ID, e: NOW + 600 }))).toBeNull();
    expect(await verifySession(await withClaim({ a: ADMIN_USER, i: '', e: NOW + 600 }))).toBeNull();
  });

  it('refuses a claim whose own expiry has passed, even with a live token', async () => {
    // The dead-man switch. `absAt` is a day away and the token does not expire for an
    // hour, so without this check the session would outlive the impersonation window by
    // an hour — the read-only rule would hold, but only because of a different field.
    const expired = await withClaim({ a: ADMIN_USER, i: AUDIT_ID, e: NOW - 1 });
    expect(await verifySession(expired)).toBeNull();
  });

  it('refuses a claim with a non-numeric expiry', async () => {
    expect(
      await verifySession(await withClaim({ a: ADMIN_USER, i: AUDIT_ID, e: String(NOW + 600) })),
    ).toBeNull();
    expect(
      await verifySession(await withClaim({ a: ADMIN_USER, i: AUDIT_ID, e: Number.NaN })),
    ).toBeNull();
  });
});

describe('FR-904 · the constructor cannot mint a seven-day impersonation', () => {
  it('caps the absolute expiry at the impersonation window, not the usual 7 days', () => {
    const session = borrowed();
    const sevenDays = newAbsoluteExpiry();

    expect(session.absoluteExpiresAt).toBe(session.expiresAt);
    expect(session.absoluteExpiresAt).toBeLessThan(sevenDays);
    expect(session.absoluteExpiresAt).toBeLessThanOrEqual(NOW + IMPERSONATION_MAX_MINUTES * 60 + 1);
  });

  it('never sends a borrowed user to the password-change screen', () => {
    // The admin is not this person and cannot set their password. A `mustChangePassword`
    // flag borrowed from the merchant row would strand the session on a form it must not
    // be able to submit.
    expect(borrowed().mustChangePassword).toBe(false);
  });

  it('ordinary newSession cannot be given an impersonation claim', () => {
    // The type takes a closed argument list, so this is a compile-time guarantee. The
    // runtime assertion is here to name the reason: an impersonation minted from a login
    // path has no audit row behind it, and "flagged in audit log" would be unmet.
    const session = newSession({
      userId: MERCHANT_USER,
      role: 'MERCHANT',
      mustChangePassword: false,
    });
    expect(isImpersonating(session)).toBe(false);
    expect(session.absoluteExpiresAt).toBeGreaterThan(NOW + SESSION_SLIDING_MINUTES * 60);
  });
});

describe('FR-904 · isImpersonating', () => {
  it('is false for a null session rather than throwing', () => {
    // Called from a layout that may not have a session at all, one line before a
    // redirect. A throw here would turn a signed-out request into a 500.
    expect(isImpersonating(null)).toBe(false);
  });

  it('is true only when the claim is present', () => {
    expect(isImpersonating(borrowed())).toBe(true);
    expect(isImpersonating(newSession({ userId: MERCHANT_USER, role: 'MERCHANT', mustChangePassword: false }))).toBe(false);
  });
});
