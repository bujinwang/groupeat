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

/** The `/admin/users` list (PRD-sprint1 §6.5). */
export async function listUsers(): Promise<AdminUserRow[]> {
  return prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      mustChangePassword: true,
      lastLoginAt: true,
      merchantUsers: { select: { merchant: { select: { id: true, name: true } } } },
    },
  });
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
