import { createHash, randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db/prisma';

/**
 * FR-101 — the one-time set-password invitation.
 *
 * > `FR-101 | Ops creates a Merchant and invites an Owner by email | Owner receives a
 * > set-password link valid 72h` — PRD-v1.md:442
 *
 * ## The token is a credential, so only its hash is stored
 *
 * Thirty-two random bytes, base64url. The plaintext exists in the email and nowhere
 * else: the database holds SHA-256 of it. A backup, a support query or a leaked
 * `DATABASE_URL` therefore cannot take over an account, which is the same property
 * the session and redemption-code keys are built for. A fast hash is correct here
 * (not bcrypt) because the input is already 256 bits of entropy and the lookup is by
 * hash on every attempt; stretching a random token buys nothing an attacker can use.
 *
 * ## Issuing invalidates, and accepting is a conditional update
 *
 * Two rules make a bearer link safe to email:
 *
 *   - **Re-invite invalidates the old link.** `issuePasswordInvite` marks every
 *     unused row for that user consumed before inserting the new one. An operator who
 *     clicks "send again" must not leave two working links in two inboxes.
 *   - **Only one accept can win.** `setPasswordWithInvite` claims the row with an
 *     `updateMany` whose predicate includes `usedAt: null` and `expiresAt: { gt: now }`,
 *     then writes the password in the same transaction. A double tap or a replay
 *     gets the same "invalid or expired" answer, and no second password write occurs.
 *
 * ## What it deliberately does not do
 *
 * It does not sign the user in. Choosing a password proves possession of an inbox,
 * not that the person is at a trusted device; the next step is the ordinary login,
 * which exercises the same rate limit and enumeration guard as every other sign-in.
 */

/** PRD-v1 FR-101's validity window. */
export const PASSWORD_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/** The human label the email uses, derived from the window above. */
export const PASSWORD_INVITE_TTL_LABEL = '72 hours';

/** 32 bytes → 43 base64url characters. */
export function generatePasswordInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256, hex. Exported for the test that proves the stored value is not the token.
 */
export function hashPasswordInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type IssuedPasswordInvite = {
  readonly token: string;
  readonly expiresAt: Date;
};

/**
 * Creates a fresh invitation for one account, invalidating any earlier unused one.
 *
 * The transaction is load-bearing in one direction: if the insert fails, the
 * invalidation must roll back too, or a retry would leave the account with no working
 * link at all. Both statements are in one transaction for that reason, not for the
 * read.
 */
export async function issuePasswordInvite(userId: string): Promise<IssuedPasswordInvite> {
  const token = generatePasswordInviteToken();
  const tokenHash = hashPasswordInviteToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_INVITE_TTL_MS);

  await prisma.$transaction(async (tx) => {
    await tx.passwordInvite.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.passwordInvite.create({
      data: { userId, tokenHash, expiresAt },
      select: { id: true },
    });
  });

  return { token, expiresAt };
}

/**
 * The invitation a token names, if it is still usable.
 *
 * Returns `null` for an unknown, consumed or expired token — one answer, because the
 * page must not tell a stranger which of those is true. `now` is a parameter so the
 * expiry test does not sleep.
 */
export async function findValidPasswordInvite(
  token: string,
  now: Date = new Date(),
): Promise<{ readonly id: string; readonly userId: string; readonly expiresAt: Date } | null> {
  if (token.trim().length === 0) {
    return null;
  }

  const invite = await prisma.passwordInvite.findUnique({
    where: { tokenHash: hashPasswordInviteToken(token) },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });

  if (!invite || invite.usedAt !== null || invite.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  return { id: invite.id, userId: invite.userId, expiresAt: invite.expiresAt };
}

export type AcceptPasswordInviteResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: 'INVALID_OR_USED' };

/**
 * Consumes the invitation and sets the account's password, atomically.
 *
 * `updateMany` is the claim: its `where` is the whole rule, and the count is the
 * answer. The later `findUnique` inside the same transaction sees the row this
 * transaction just updated, so it can recover the `userId` without a second
 * read-then-write window. `mustChangePassword` goes false because the invitation is
 * the bootstrap: the user has now chosen their own password.
 */
export async function acceptPasswordInvite(args: {
  token: string;
  passwordHash: string;
  now?: Date;
}): Promise<AcceptPasswordInviteResult> {
  if (args.token.trim().length === 0) {
    return { ok: false, reason: 'INVALID_OR_USED' };
  }

  const now = args.now ?? new Date();
  const tokenHash = hashPasswordInviteToken(args.token);

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordInvite.updateMany({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });

    if (claimed.count !== 1) {
      return { ok: false, reason: 'INVALID_OR_USED' } as const;
    }

    const invite = await tx.passwordInvite.findUnique({
      where: { tokenHash },
      select: { userId: true },
    });
    if (!invite) {
      // Unreachable after a successful claim, but a silent success would be worse
      // than an explicit refusal if a future schema change breaks the read.
      throw new Error('Password invite disappeared after being claimed.');
    }

    await tx.user.update({
      where: { id: invite.userId },
      data: { passwordHash: args.passwordHash, mustChangePassword: false },
    });

    return { ok: true, userId: invite.userId } as const;
  });
}
