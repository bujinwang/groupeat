import { prisma } from '@/lib/db/prisma';

/**
 * FR-906 — an organiser account created by ops, with the profile it needs.
 *
 * > `FR-906 | Manually create organiser accounts |` — PRD-v1.md:553
 * > "The organiser is onboarded **manually by ops** in V1 — no self-serve. There are
 * > 5–15 of them in beta" — PRD-v1.md §3.3
 *
 * ## The bug this module exists to close
 *
 * `/admin/users` has offered `Organiser` in its role dropdown and created a `User` row
 * with `role: 'ORGANISER'` since Sprint 1. `OrganiserProfile` was created in exactly
 * one place: `prisma/seed.ts`. So an organiser made through the UI was a `User` with
 * no profile — no `displayName`, no `commissionPct` (the schema default is 5.0, but
 * it lives on a row that does not exist), and nothing for `/organiser` or a future
 * `ShareLink.organiserId` to point at.
 *
 * The account also *looked* created: the action returned "Created someone@…", the list
 * rendered them, and signing in worked. Nothing failed until someone tried to use the
 * organiser for the only thing organisers do. That is the same shape as the defect
 * this milestone keeps finding — a capability that renders nowhere — except inverted:
 * here the screen existed and the record behind it did not.
 *
 * ## Why one transaction rather than two creates
 *
 * A `User` with `role: 'ORGANISER'` and no profile is not a partial success, it is a
 * broken account, and it is silently broken: `role` is what the layout gate reads, so
 * the person signs in and lands on a page that has nothing to show them. Splitting the
 * writes means a window — and, on a unique-constraint race, a permanent state — where
 * that account exists.
 *
 * Both rows are created inside `prisma.$transaction`, which rolls the `User` back if
 * the profile insert fails. Note that this is what `createMerchantWithOwner` *claims*
 * to do in its docblock and does not: only its `MerchantUser` link is nested inside
 * the merchant create, and `createUser` runs as a separate statement before it. That
 * is a real gap in a neighbouring path, recorded in PROGRESS.md rather than fixed
 * here, because changing it is a merchant-onboarding change and this slice is about
 * organisers.
 *
 * ## Why the display name is required and the commission is not
 *
 * `displayName` is `String` (non-null) in the schema, and for good reason: it is the
 * name a diner or a merchant reads next to a share link, so "undefined" is not an
 * acceptable value. It is required on the form and trimmed here.
 *
 * `commissionPct` defaults to 5.0 in the schema. The service accepts `null` and lets
 * the default apply rather than restating the number in TypeScript — two copies of a
 * default is how the form and the database come to disagree.
 *
 * The **range** of a supplied rate is validated by `commissionRefusal`, which the
 * admin action calls, and not by this function. That is deliberate and it is what
 * makes the transaction testable: `Decimal(5,2)` cannot hold `1234.56`, so a caller
 * that skips the form check gets a database error *after* the `User` row exists — the
 * one sequence that can leave a half-built account. The transaction is what makes that
 * safe, and the test proves it rather than asserting the code looks right.
 *
 * ## V1 explicitly does not pay organisers
 *
 * "Do not build automated organiser payouts in V1" — PRD-v1.md §3.3. So
 * `commissionPct` is recorded and displayed and nothing computes a payout from it.
 * Stating that here matters because the field looks like it does something.
 */

/** `Decimal(5,2)` holds 0–999.99; a commission above 100% is a typo. */
export const MAX_COMMISSION_PCT = 100;

export type OrganiserProfileRow = {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly commissionPct: number;
};

export type AdminOrganiserRow = OrganiserProfileRow & {
  readonly email: string;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  /** Share links this organiser owns. Zero for everyone until M7's share-link UI. */
  readonly shareLinkCount: number;
};

/**
 * An `ORGANISER` account with no profile — the exact defect above, as data.
 *
 * Returned by `listProfilelessOrganisers` so `/admin/users` can show the operator what
 * is broken instead of leaving them to discover it when the organiser complains.
 */
export type ProfilelessOrganiser = {
  readonly userId: string;
  readonly email: string;
  readonly createdAt: Date;
};

export type CreateOrganiserInput = {
  readonly email: string;
  readonly displayName: string;
  readonly phone: string | null;
  /** `null` means "use the schema default". A number is validated. */
  readonly commissionPct: number | null;
  readonly passwordHash: string;
};

export type CreateOrganiserResult = {
  readonly userId: string;
  readonly profileId: string;
  readonly email: string;
};

/**
 * The commission rule, exported so the form and the service cannot disagree.
 *
 * Returns a sentence for the field, or `null` when the value is acceptable. Accepting
 * `null`/empty as "use the default" is deliberate: an operator who does not know the
 * rate yet should be able to create the account and set it later, and 5.0 is the
 * schema's own answer.
 */
export function commissionRefusal(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return 'Enter a number, or leave it blank for the default of 5%.';
  }
  if (value < 0) {
    return 'A commission cannot be negative. Leave it blank for the default of 5%.';
  }
  if (value > MAX_COMMISSION_PCT) {
    return `Enter at most ${MAX_COMMISSION_PCT}%.`;
  }
  // One decimal place is the practical limit — `Decimal(5,2)` stores hundredths, but a
  // rate like 7.375% is a spreadsheeting mistake rather than an agreed term.
  if (Math.round(value * 100) !== Math.round(value * 100 * 100) / 100) {
    return 'Use at most two decimal places.';
  }
  return null;
}

/**
 * Creates the `User` and its `OrganiserProfile` together, or neither.
 *
 * The `role` is set here rather than taken from the caller: this function *is* the
 * organiser path, and a parameter would allow `createOrganiser({ role: 'ADMIN' })`.
 */
export async function createOrganiser(
  input: CreateOrganiserInput,
): Promise<CreateOrganiserResult> {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new Error('An organiser needs a display name.');
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email.trim().toLowerCase(),
        // The `User.name` and the profile's `displayName` are the same fact stored
        // twice, and the schema forces that. Writing both from one value keeps them
        // from diverging on the day someone edits one of them; `displayName` is the
        // one that renders, so it wins.
        name: displayName,
        role: 'ORGANISER',
        passwordHash: input.passwordHash,
        // Every account in V1 is bootstrapped by an admin with a temporary password.
        mustChangePassword: true,
      },
      select: { id: true, email: true },
    });

    const profile = await tx.organiserProfile.create({
      data: {
        userId: user.id,
        displayName,
        phone: input.phone,
        ...(input.commissionPct === null ? {} : { commissionPct: input.commissionPct }),
      },
      select: { id: true },
    });

    return { userId: user.id, profileId: profile.id, email: user.email };
  });
}

/**
 * Every organiser, with their profile — and only those who have one.
 *
 * Orders by display name because the list is read to find a person, and an operator
 * scanning for "Alice" is doing something different from scanning for a recent signup.
 */
export async function listOrganisers(): Promise<AdminOrganiserRow[]> {
  const profiles = await prisma.organiserProfile.findMany({
    orderBy: { displayName: 'asc' },
    select: {
      id: true,
      userId: true,
      displayName: true,
      phone: true,
      commissionPct: true,
      user: {
        select: {
          email: true,
          mustChangePassword: true,
          lastLoginAt: true,
          createdAt: true,
        },
      },
      _count: { select: { shareLinks: true } },
    },
  });

  return profiles.map((profile) => ({
    id: profile.id,
    userId: profile.userId,
    displayName: profile.displayName,
    phone: profile.phone,
    // `Decimal` → `number` at the boundary, as `MerchantRepo.toPct` does for the floor.
    commissionPct: Number(profile.commissionPct),
    email: profile.user.email,
    mustChangePassword: profile.user.mustChangePassword,
    lastLoginAt: profile.user.lastLoginAt,
    createdAt: profile.user.createdAt,
    shareLinkCount: profile._count.shareLinks,
  }));
}

/**
 * Organisers with no profile — the bug, listed.
 *
 * This is the query that would have caught the original defect on the day it was
 * introduced, and it is worth having permanently rather than as a one-off repair
 * script: accounts can still be created by other paths (`prisma/seed.ts`, a future
 * import, a role change made by hand in Postgres), and every one of them can produce
 * this state again.
 */
export async function listProfilelessOrganisers(): Promise<ProfilelessOrganiser[]> {
  const users = await prisma.user.findMany({
    where: { role: 'ORGANISER', organiser: { is: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, createdAt: true },
  });

  return users.map((user) => ({
    userId: user.id,
    email: user.email,
    createdAt: user.createdAt,
  }));
}

/**
 * Gives an existing profile-less organiser the profile they should have had.
 *
 * Refuses rather than silently doing nothing when the account already has a profile,
 * because "repair" that succeeds on a healthy row hides the fact that the check that
 * found it was wrong. Refuses a non-organiser too: attaching a profile to a MERCHANT
 * would make two role systems disagree about what that account is.
 */
export async function backfillOrganiserProfile(args: {
  userId: string;
  displayName: string;
  phone?: string | null;
  commissionPct?: number | null;
}): Promise<{ profileId: string } | null> {
  const displayName = args.displayName.trim();
  if (displayName.length === 0) {
    throw new Error('An organiser needs a display name.');
  }

  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { role: true, organiser: { select: { id: true } } },
  });

  if (!user || user.role !== 'ORGANISER' || user.organiser !== null) {
    return null;
  }

  const profile = await prisma.organiserProfile.create({
    data: {
      userId: args.userId,
      displayName,
      phone: args.phone ?? null,
      ...(args.commissionPct === null || args.commissionPct === undefined
        ? {}
        : { commissionPct: args.commissionPct }),
    },
    select: { id: true },
  });

  return { profileId: profile.id };
}
