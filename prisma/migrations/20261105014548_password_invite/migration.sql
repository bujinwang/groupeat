-- FR-101: the one-time set-password invitation.
--
-- The stored value is SHA-256 of the token, never the token. The link is a bearer
-- credential; a database read must not be enough to take over an account. A fast
-- hash is right here because the token is 32 random bytes, not a password — there
-- is no dictionary to stretch against.
--
-- `userId` is indexed but not unique: re-inviting marks the previous row used and
-- inserts a new one, so the history survives and the old link is inert under the
-- consume predicate (`usedAt IS NULL AND expiresAt > now`).
--
-- No backfill: existing accounts keep their temporary passwords. The invite path is
-- additive; the admin form's password remains the fallback when email is unconfigured.

-- CreateTable
CREATE TABLE "PasswordInvite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordInvite_tokenHash_key" ON "PasswordInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordInvite_userId_usedAt_idx" ON "PasswordInvite"("userId", "usedAt");

-- AddForeignKey
ALTER TABLE "PasswordInvite" ADD CONSTRAINT "PasswordInvite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
