import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PASSWORD_INVITE_TTL_MS,
  acceptPasswordInvite,
  findValidPasswordInvite,
  hashPasswordInviteToken,
  issuePasswordInvite,
} from '@/lib/auth/password-invite';
import { prisma } from '@/lib/db/prisma';

/**
 * FR-101's invitation, against real Postgres.
 *
 * Four claims, and each is a way a bearer link can be wrong:
 *
 *   1. **The token is not stored.** A database read must not be enough to take over
 *      the account.
 *   2. **It expires**, and the boundary is the expiry instant, not the day.
 *   3. **It works once.** A replay gets the same refusal as an unknown token.
 *   4. **Re-inviting kills the old link**, so "send again" does not leave two working
 *      credentials in two inboxes.
 */

const PREFIX = `invite${Date.now().toString(36).slice(-6)}`;
const createdUserIds: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}@example.test`,
      passwordHash: 'old-hash-not-a-password',
      role: 'MERCHANT',
      mustChangePassword: true,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  // The fixture helper is exercised by the tests; this hook only makes the teardown
  // contract explicit.
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe('issuePasswordInvite', () => {
  it('returns a token that is not what the database stores, and a 72-hour expiry', async () => {
    const userId = await makeUser('storage');
    const before = Date.now();
    const invite = await issuePasswordInvite(userId);

    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invite.expiresAt.getTime()).toBeGreaterThanOrEqual(before + PASSWORD_INVITE_TTL_MS);
    expect(invite.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + PASSWORD_INVITE_TTL_MS);

    const row = await prisma.passwordInvite.findFirstOrThrow({
      where: { userId },
      select: { tokenHash: true },
    });
    expect(row.tokenHash).toBe(hashPasswordInviteToken(invite.token));
    expect(row.tokenHash).not.toBe(invite.token);
  });

  it('invalidates an earlier unused link when a new one is issued', async () => {
    const userId = await makeUser('reissue');
    const first = await issuePasswordInvite(userId);
    const second = await issuePasswordInvite(userId);

    expect(await findValidPasswordInvite(first.token)).toBeNull();
    expect(await findValidPasswordInvite(second.token)).not.toBeNull();
  });
});

describe('findValidPasswordInvite', () => {
  it('finds a live token and refuses it one millisecond after expiry', async () => {
    const userId = await makeUser('expiry');
    const invite = await issuePasswordInvite(userId);

    expect(await findValidPasswordInvite(invite.token)).not.toBeNull();
    expect(
      await findValidPasswordInvite(
        invite.token,
        new Date(invite.expiresAt.getTime() + 1),
      ),
    ).toBeNull();
  });

  it('returns null for an empty or unknown token without throwing', async () => {
    expect(await findValidPasswordInvite('')).toBeNull();
    expect(await findValidPasswordInvite('not-a-token')).toBeNull();
  });
});

describe('acceptPasswordInvite', () => {
  it('sets the password, clears mustChangePassword, and cannot be replayed', async () => {
    const userId = await makeUser('accept');
    const invite = await issuePasswordInvite(userId);

    const first = await acceptPasswordInvite({ token: invite.token, passwordHash: 'new-hash' });
    expect(first).toEqual({ ok: true, userId });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, mustChangePassword: true },
    });
    expect(user).toEqual({ passwordHash: 'new-hash', mustChangePassword: false });

    const replay = await acceptPasswordInvite({ token: invite.token, passwordHash: 'other-hash' });
    expect(replay).toEqual({ ok: false, reason: 'INVALID_OR_USED' });

    // The replay did not overwrite the first password.
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).toBe('new-hash');
  });

  it('refuses an expired token and writes no password', async () => {
    const userId = await makeUser('expired-accept');
    const invite = await issuePasswordInvite(userId);

    const result = await acceptPasswordInvite({
      token: invite.token,
      passwordHash: 'should-not-land',
      now: new Date(invite.expiresAt.getTime() + 1),
    });

    expect(result).toEqual({ ok: false, reason: 'INVALID_OR_USED' });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, mustChangePassword: true },
    });
    expect(user).toEqual({ passwordHash: 'old-hash-not-a-password', mustChangePassword: true });
  });
});
