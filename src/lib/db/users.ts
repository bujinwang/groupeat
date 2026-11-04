import { prisma } from '@/lib/db/prisma';
import type { Merchant, MerchantUser, User } from '@prisma/client';

/**
 * User reads and writes.
 *
 * No `server-only` here, for the same reason as `prisma.ts`: the DB tests import
 * this module under Vitest, and `server-only` throws outside a React Server
 * Component graph. The boundary is held by `lib/auth`, which does import it. Email is normalised **once**, here, so every caller
 * compares like with like (PRD-sprint1 §7.1: lowercased before store).
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type AuthUser = Pick<
  User,
  'id' | 'email' | 'passwordHash' | 'name' | 'role' | 'mustChangePassword' | 'lastLoginAt'
>;

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  return prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      name: true,
      role: true,
      mustChangePassword: true,
      lastLoginAt: true,
    },
  });
}

export async function findUserById(id: string): Promise<AuthUser | null> {
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      name: true,
      role: true,
      mustChangePassword: true,
      lastLoginAt: true,
    },
  });
}

export async function touchLastLogin(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
  });
}

export async function updatePassword(userId: string, passwordHash: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, mustChangePassword: false },
  });
}

export type AdminUserRow = Pick<User, 'id' | 'email' | 'name' | 'role' | 'mustChangePassword' | 'lastLoginAt'> & {
  merchantUsers: { merchant: Pick<Merchant, 'id' | 'name'> }[];
};

/** The role filter. Same three values as the `UserRole` enum; no `ALL` member — `null` is "all". */
export const ADMIN_USER_ROLES = ['ADMIN', 'MERCHANT', 'ORGANISER'] as const;
export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];

/**
 * A role from a query string, or `null`.
 *
 * Case-insensitive and total: anything unrecognised is `null`, which means "no filter",
 * so a mistyped `?role=whatever` shows every account rather than an empty list. That is
 * the same rule `parseAdminDropStatus` follows and for the same reason — on this screen
 * an empty list is indistinguishable from "there are no admins", and the operator is
 * usually on the phone with somebody who believes there is one.
 */
export function parseAdminUserRole(value: string | undefined | null): AdminUserRole | null {
  if (!value) {
    return null;
  }
  const upper = value.trim().toUpperCase();
  return (ADMIN_USER_ROLES as readonly string[]).includes(upper) ? (upper as AdminUserRole) : null;
}

export type AdminUserList = {
  /** At most `limit` rows. */
  readonly rows: readonly AdminUserRow[];
  /**
   * How many accounts match the filter, **not** how many are on screen.
   *
   * The header used to print `users.length`, which was correct only because the list was
   * unbounded — the read and the total were the same number. The moment the read is
   * capped those two facts separate, and printing `rows.length` under `?role=ADMIN` would
   * say "3" when the database holds 1,040. This field is a separate `count` against the
   * same `where`, so the two cannot drift.
   */
  readonly total: number;
  /** Exactly what was asked for, so the page can render an honest "showing X of Y". */
  readonly limit: number;
};

/**
 * The `/admin/users` list (PRD-sprint1 §6.5), **bounded**, filterable and searchable.
 *
 * ## Why this is no longer `findMany` with no `take`
 *
 * It was, and it measured **6,289,778 bytes / 12,518 nodes** — of which 87.7% was RSC flight
 * data and 66.6% of the markup was one `<li>` per user. The page grew linearly with the `User`
 * table, so it was fine at seed scale and a page that would not load at beta scale. Re-measured
 * on a **production build** the same page is **1,856,483 bytes / 11,205 nodes**, because dev-mode
 * flight data is about 3.4x the production size — so the first figure was a dev-server reading
 * and the real number is smaller and still unreasonable. Either way the shape was the defect:
 * an unbounded read behind a screen whose PRD sketch (PRD-sprint1 §6.5) shows three example
 * rows. With the cap it is **400,428 bytes / 2,294 nodes**.
 *
 * The cap matches `/admin/drops` (100) and `/admin/ai-drafts` (50): the PRD gives no
 * number, so the repo's own precedent decides it rather than a new opinion.
 *
 * ## Why a cap needs a search, and a filter needs no justification
 *
 * A cap alone makes the 941st account **unreachable** from the only screen that lists
 * accounts, which is worse than the slow page it replaces. Truncation without a way to
 * narrow is data loss with a scrollbar. So the cap comes with two ways to name what you
 * want:
 *
 *   - `?role=` for "show me the organisers", which is the question this screen is
 *     actually used for.
 *   - `?q=` for "find bob@beefbowl.ca", which is the other one. The operator is usually
 *     on the phone with somebody reading an address out loud, and scrolling 100
 *     alphabetised rows is not a search.
 *
 * Both are `contains`, case-insensitive, and deliberately unindexed: this is an admin
 * screen with a thousand rows, not a query path a diner waits on.
 */
export async function listUsers(args: {
  role?: AdminUserRole | null;
  /** Email substring. Trimmed; empty means "no search". */
  q?: string | null;
  /** Cap. Mirrors `/admin/drops`; the PRD gives no number. */
  limit?: number;
} = {}): Promise<AdminUserList> {
  const limit = args.limit ?? 100;
  const search = (args.q ?? '').trim();

  const where = {
    ...(args.role ? { role: args.role } : {}),
    // `mode: 'insensitive'` rather than a lowercased column: emails are stored lowercased
    // by `normalizeEmail`, but a *search* is typed by a human who capitalises.
    ...(search === '' ? {} : { email: { contains: search, mode: 'insensitive' as const } }),
  };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      // ## Why email and not `role` first
      //
      // It was `[{ role: 'asc' }, { email: 'asc' }]`, which was harmless while the read
      // was unbounded: ordering only grouped the rows on a page that showed all of them.
      // The moment the read is capped the ordering decides *what is visible*, and this
      // database has 760 ADMINs, 130 MERCHANTs and 150 ORGANISERs — so `role` ascending
      // puts every admin first and the default screen becomes 100 admins with no merchant
      // and no organiser in sight. That is worse than the slow page it replaces: a
      // truncated list nobody can browse is a list that has lost rows.
      //
      // Alphabetical by email is the sort an operator can actually search: it is stable
      // between reloads, the same account is always in the same place, and "scroll to
      // where it should be" works. Grouping by role is now the filter's job, which is a
      // better tool for it than a sort order — it says how many of each there are.
      orderBy: { email: 'asc' },
      take: limit,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        mustChangePassword: true,
        lastLoginAt: true,
        merchantUsers: { select: { merchant: { select: { id: true, name: true } } } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return { rows, total, limit };
}

export async function emailExists(email: string): Promise<boolean> {
  const found = await prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: { id: true },
  });
  return found !== null;
}

export type CreateUserInput = {
  email: string;
  name: string | null;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  passwordHash: string;
};

/**
 * Creates an account. Always `mustChangePassword = true`: every account in
 * Sprint 1 is bootstrapped by an admin with a temporary password, because there
 * is no email delivery until M2 (PRD-sprint1 §7.1, Q-5).
 */
export async function createUser(input: CreateUserInput): Promise<Pick<User, 'id' | 'email' | 'role'>> {
  return prisma.user.create({
    data: {
      email: normalizeEmail(input.email),
      name: input.name,
      role: input.role,
      passwordHash: input.passwordHash,
      mustChangePassword: true,
    },
    select: { id: true, email: true, role: true },
  });
}

export type MerchantMembership = Pick<MerchantUser, 'merchantId' | 'role'> & {
  merchant: Pick<Merchant, 'id' | 'name' | 'slug' | 'status'>;
};

export async function listMemberships(userId: string): Promise<MerchantMembership[]> {
  return prisma.merchantUser.findMany({
    where: { userId },
    select: {
      merchantId: true,
      role: true,
      merchant: { select: { id: true, name: true, slug: true, status: true } },
    },
  });
}
