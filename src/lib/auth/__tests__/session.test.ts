import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

import {
  SESSION_ABSOLUTE_DAYS,
  SESSION_SLIDING_MINUTES,
  needsRefresh,
  newAbsoluteExpiry,
  newSession,
  signSession,
  verifySession,
} from '@/lib/auth/jwt';

/**
 * S1-005 — the session contract.
 *
 * Pure: no database, no Next runtime. `jwt.ts` is deliberately Edge-safe and
 * reads the secret from `process.env`, so the test sets it and calls the real
 * signing functions rather than a mock.
 *
 * Imported from `@/lib/auth/jwt` rather than the `@/lib/auth` barrel: the barrel
 * re-exports modules that import `server-only`, which throws outside a React
 * Server Component graph (i.e. under Vitest). That is the same reason
 * `src/middleware.ts` imports this file directly.
 */

process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const NOW = Math.floor(Date.now() / 1000);

function claims(overrides: Partial<Parameters<typeof signSession>[0]> = {}) {
  return {
    userId: '11111111-1111-1111-1111-111111111111',
    role: 'MERCHANT' as const,
    mustChangePassword: false,
    absoluteExpiresAt: newAbsoluteExpiry(),
    expiresAt: NOW + SESSION_SLIDING_MINUTES * 60,
    ...overrides,
  };
}

describe('S1-005 · sign and verify round-trip', () => {
  it('returns the claims that were signed', async () => {
    const token = await signSession(claims({ mustChangePassword: true }));
    const verified = await verifySession(token);

    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe('11111111-1111-1111-1111-111111111111');
    expect(verified?.role).toBe('MERCHANT');
    expect(verified?.mustChangePassword).toBe(true);
    expect(verified?.absoluteExpiresAt).toBeGreaterThan(NOW);
  });

  it('caps the token expiry at the absolute cap', async () => {
    // A session with only 5 minutes of absolute life left must not receive a
    // 60-minute token.
    const absoluteExpiresAt = NOW + 5 * 60;
    const token = await signSession(claims({ absoluteExpiresAt }));
    const verified = await verifySession(token);

    expect(verified?.expiresAt).toBeLessThanOrEqual(absoluteExpiresAt + 1);
  });

  it('newAbsoluteExpiry is 7 days out', () => {
    const expiry = newAbsoluteExpiry(NOW);
    expect(expiry - NOW).toBe(SESSION_ABSOLUTE_DAYS * 24 * 60 * 60);
  });
});

describe('S1-005 · rejection paths', () => {
  it('rejects a tampered token', async () => {
    const token = await signSession(claims());
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload}.${signature?.slice(0, -4)}AAAA`;

    expect(await verifySession(tampered)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = await new SignJWT({ role: 'ADMIN', mv: false, absAt: NOW + 86_400 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('attacker')
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 3600)
      .sign(new TextEncoder().encode('a-different-secret-at-least-32-characters'));

    expect(await verifySession(forged)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const expired = await new SignJWT({ role: 'MERCHANT', mv: false, absAt: NOW + 86_400 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('11111111-1111-1111-1111-111111111111')
      .setIssuedAt(NOW - 7200)
      .setExpirationTime(NOW - 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    expect(await verifySession(expired)).toBeNull();
  });

  it('rejects a token past the absolute cap even when its own expiry is in the future', async () => {
    // The "8 days old but refreshed" case: a validly signed token whose absAt has
    // passed must die, otherwise a session could live forever by refreshing.
    const pastCap = await new SignJWT({ role: 'MERCHANT', mv: false, absAt: NOW - 60 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('11111111-1111-1111-1111-111111111111')
      .setIssuedAt(NOW - 60)
      .setExpirationTime(NOW + 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    expect(await verifySession(pastCap)).toBeNull();
  });

  it('rejects a token with an unknown role', async () => {
    const badRole = await new SignJWT({ role: 'SUPERUSER', mv: false, absAt: NOW + 86_400 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('11111111-1111-1111-1111-111111111111')
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    expect(await verifySession(badRole)).toBeNull();
  });

  it('rejects a token with no subject', async () => {
    const noSub = await new SignJWT({ role: 'MERCHANT', mv: false, absAt: NOW + 86_400 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    expect(await verifySession(noSub)).toBeNull();
  });

  it('returns null rather than throwing for garbage input', async () => {
    expect(await verifySession('')).toBeNull();
    expect(await verifySession('not-a-token')).toBeNull();
    expect(await verifySession('a.b.c')).toBeNull();
  });
});

describe('S1-005 · sliding refresh', () => {
  it('asks for a refresh only inside the last 15 minutes', () => {
    const fresh = { ...claims(), expiresAt: NOW + 45 * 60 };
    const nearlyExpired = { ...claims(), expiresAt: NOW + 5 * 60 };

    expect(needsRefresh(fresh)).toBe(false);
    expect(needsRefresh(nearlyExpired)).toBe(true);
  });

  it('a refreshed token is capped by the same absolute expiry', async () => {
    const session = newSession({
      userId: '11111111-1111-1111-1111-111111111111',
      role: 'ADMIN',
      mustChangePassword: false,
    });
    const token = await signSession(session);
    const verified = await verifySession(token);

    expect(verified?.absoluteExpiresAt).toBe(session.absoluteExpiresAt);
    expect(verified?.expiresAt).toBeLessThanOrEqual(session.absoluteExpiresAt);
  });
});
