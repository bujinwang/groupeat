import 'dotenv/config';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { changePassword } from '@/lib/auth/credentials';
import { POST } from '../route';

/**
 * FR-904 — a borrowed (impersonating) session cannot change a merchant's password.
 *
 * The change-password route takes `session.userId` and changes *that* user's
 * credentials. For an impersonation session the borrowed id is the merchant's, so
 * without the guard an admin holding a borrowed token would silently reset the
 * merchant's password and the audit trail would attribute it to the merchant.
 *
 * Mirrors merchant/settings/__tests__/impersonation-refused.test.ts: only
 * `getSession` is mocked, the real `refuseIfImpersonating` runs, and we assert the
 * refusal is a 403 with the human sentence and that `changePassword` is never
 * reached. `errorResponse` turns the thrown `AppError.forbidden` into the 403.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/lib/auth/credentials', () => ({
  changePassword: vi.fn(async () => ({
    ok: true,
    session: {
      userId: 'changed-user',
      role: 'MERCHANT',
      mustChangePassword: false,
      absoluteExpiresAt: 0,
      expiresAt: 0,
    },
    redirectTo: '/',
  })),
}));

let currentSession: {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword: boolean;
  absoluteExpiresAt: number;
  expiresAt: number;
  impersonation?: { actorUserId: string; auditId: string; expiresAt: number };
} | null = null;

vi.mock('@/lib/auth/session', async () => {
  const jwt = await import('@/lib/auth/jwt');
  return {
    getSession: async () => currentSession,
    setSessionCookie: vi.fn(),
    roleHome: jwt.roleHome,
    newSession: jwt.newSession,
  };
});

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const OWNER = 'owner-user-id';
const ADMIN = 'admin-user-id';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(changePassword).mockClear();
});

describe('FR-904 · POST /api/auth/change-password under a borrowed session', () => {
  it('refuses with 403 and never reaches changePassword', async () => {
    currentSession = {
      userId: OWNER,
      role: 'MERCHANT',
      mustChangePassword: false,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      impersonation: {
        actorUserId: ADMIN,
        auditId: '44444444-4444-4444-4444-444444444444',
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
      },
    };

    const response = await POST(request({ currentPassword: 'hunter2', newPassword: 'newPassw0rd!' }));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/viewing this account as an admin/i);
    expect(body.message).toMatch(/end the session/i);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('refuses before the body is parsed, not after', async () => {
    // An impersonating caller sending a *malformed* body must still get 403, not 400 —
    // the refusal is the first thing that happens, so the request shape is not leaked.
    currentSession = {
      userId: OWNER,
      role: 'MERCHANT',
      mustChangePassword: false,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      impersonation: {
        actorUserId: ADMIN,
        auditId: '55555555-5555-5555-5555-555555555555',
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
      },
    };

    const response = await POST(request({ currentPassword: 12345 }));

    expect(response.status).toBe(403);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('allows an ordinary session to change its own password', async () => {
    // The control: without impersonation the path must still work, or the guard would
    // have broken the product. `changePassword` is reached with the session's own id.
    currentSession = {
      userId: OWNER,
      role: 'MERCHANT',
      mustChangePassword: false,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const response = await POST(request({ currentPassword: 'hunter2', newPassword: 'newPassw0rd!' }));

    expect(response.status).toBe(200);
    expect(changePassword).toHaveBeenCalledTimes(1);
    expect(changePassword).toHaveBeenCalledWith(OWNER, 'hunter2', 'newPassw0rd!');
  });
});
