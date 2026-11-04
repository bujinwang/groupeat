import { prisma } from '@/lib/db/prisma';

/**
 * FR-704 — consent, recipients, and the delivery record.
 *
 * ## Why consent lives on `MerchantUser` and is read here
 *
 * The acceptance criterion is "sent only to consenting owners". Both words matter:
 * **owner** is a `MerchantUser.role`, and **consenting** is a column on the same row.
 * Reading them together in one query is what makes it impossible to send to a
 * consented MANAGER or to an owner who never ticked the box. A second query that
 * resolved owners and then joined consent in memory would have two chances to get the
 * predicate wrong, and the failure — one unwanted email — is exactly the kind of thing
 * that gets a feature switched off rather than debugged.
 *
 * ## Why the delivery record is a table rather than an `AuditLog` row
 *
 * `AuditLog` has no unique constraint and is append-only by design. Idempotency needs
 * a database-enforced key, not a read-then-write pair with a window as wide as a cron
 * retry. `DigestDelivery` is that key: `(merchantId, userId, weekStart)`.
 */

/** One owner who has consented to this merchant's digest. */
export type DigestRecipient = {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
};

export type DigestMerchant = {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly owners: readonly DigestRecipient[];
};

/**
 * Every merchant with at least one consenting owner, and those owners.
 *
 * Ordered by merchant id and then user id so a run's output is reproducible. A cron
 * job that emails the same set in a different order every week is harder to diff
 * against the previous run's log when something goes wrong.
 *
 * Merchants with no consenting owner are excluded by the `some` predicate rather than
 * fetched and filtered, so the query cost is proportional to the work.
 */
export async function merchantsForDigest(): Promise<DigestMerchant[]> {
  const merchants = await prisma.merchant.findMany({
    where: {
      users: { some: { role: 'OWNER', digestOptIn: true } },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      name: true,
      timezone: true,
      users: {
        where: { role: 'OWNER', digestOptIn: true },
        orderBy: { userId: 'asc' },
        select: {
          userId: true,
          user: { select: { email: true, name: true } },
        },
      },
    },
  });

  return merchants.map((merchant) => ({
    id: merchant.id,
    name: merchant.name,
    timezone: merchant.timezone,
    owners: merchant.users.map((membership) => ({
      userId: membership.userId,
      email: membership.user.email,
      name: membership.user.name,
    })),
  }));
}

/** Whether this owner has already received this week's digest for this merchant. */
export async function digestAlreadySent(args: {
  merchantId: string;
  userId: string;
  weekStart: Date;
}): Promise<boolean> {
  const existing = await prisma.digestDelivery.findUnique({
    where: {
      merchantId_userId_weekStart: {
        merchantId: args.merchantId,
        userId: args.userId,
        weekStart: args.weekStart,
      },
    },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Records a successful send.
 *
 * Called **after** the provider accepted the message, never before. A row written
 * before the send would make a provider failure permanent: the next run would see the
 * key and skip, and the merchant would never receive that week. The opposite failure —
 * a crash between acceptance and this insert — duplicates one email, which is the
 * cheaper way to be wrong for a digest.
 *
 * `upsert` rather than `create`: a concurrent retry can race the same key, and the
 * second writer should record the newer provider id rather than throw a unique
 * constraint that reads like a bug.
 */
export async function recordDigestDelivery(args: {
  merchantId: string;
  userId: string;
  weekStart: Date;
  providerId?: string;
}): Promise<void> {
  await prisma.digestDelivery.upsert({
    where: {
      merchantId_userId_weekStart: {
        merchantId: args.merchantId,
        userId: args.userId,
        weekStart: args.weekStart,
      },
    },
    create: {
      merchantId: args.merchantId,
      userId: args.userId,
      weekStart: args.weekStart,
      ...(args.providerId ? { providerId: args.providerId } : {}),
    },
    update: {
      sentAt: new Date(),
      ...(args.providerId ? { providerId: args.providerId } : {}),
    },
  });
}

/** The signed-in user's membership on one merchant, for the Settings card. */
export async function digestSettingsFor(args: {
  merchantId: string;
  userId: string;
}): Promise<{
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  digestOptIn: boolean;
  digestOptInAt: Date | null;
} | null> {
  const membership = await prisma.merchantUser.findUnique({
    where: { merchantId_userId: { merchantId: args.merchantId, userId: args.userId } },
    select: { role: true, digestOptIn: true, digestOptInAt: true },
  });
  return membership;
}

export type DigestConsentResult =
  | { readonly ok: true; readonly digestOptIn: boolean }
  | { readonly ok: false; readonly reason: 'NOT_A_MEMBER' | 'NOT_OWNER' };

/**
 * Sets the consent flag, for an OWNER only.
 *
 * The role is re-read here rather than accepted from the page that rendered the form.
 * A server action is a public endpoint, and "the button was only shown to owners" is
 * not an authorisation check — the same rule `getShareLinkAction` states for organiser
 * links.
 *
 * `digestOptInAt` records when consent was last given. Turning the box off clears it:
 * a timestamp that survived a withdrawal would say someone consented when they had
 * not, which is worse than no record.
 */
export async function setDigestConsent(args: {
  merchantId: string;
  userId: string;
  optIn: boolean;
}): Promise<DigestConsentResult> {
  const membership = await prisma.merchantUser.findUnique({
    where: { merchantId_userId: { merchantId: args.merchantId, userId: args.userId } },
    select: { role: true },
  });

  if (!membership) {
    return { ok: false, reason: 'NOT_A_MEMBER' };
  }
  if (membership.role !== 'OWNER') {
    return { ok: false, reason: 'NOT_OWNER' };
  }

  await prisma.merchantUser.update({
    where: { merchantId_userId: { merchantId: args.merchantId, userId: args.userId } },
    data: {
      digestOptIn: args.optIn,
      digestOptInAt: args.optIn ? new Date() : null,
    },
  });

  return { ok: true, digestOptIn: args.optIn };
}
