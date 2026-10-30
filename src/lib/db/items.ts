import type { MenuItem } from '@prisma/client';

import { AppError } from '@/lib/errors';
import { prisma } from './prisma';

/**
 * Merchant-scoped item queries (ARCHITECTURE-sprint1 §3.4 `ItemService`).
 *
 * **Every** function takes the caller's `merchantIds` and filters by it. There is
 * no "merchant id from the URL" trust anywhere: a user with an empty scope gets
 * `404` on every route, and a foreign id gets `404` rather than `403` (US-M1) —
 * a merchant must not be able to learn that another merchant's item exists.
 */

export type ItemInput = {
  name: string;
  description: string | null;
  menuPriceCents: number;
  foodCostCents: number;
  packagingCents: number;
  batchYield: number;
  prepMinutes: number | null;
  isBatchable: boolean;
  containsAlcohol: boolean;
  category: string | null;
};

const LIST_SELECT = {
  id: true,
  merchantId: true,
  name: true,
  description: true,
  photoUrl: true,
  menuPriceCents: true,
  foodCostCents: true,
  packagingCents: true,
  batchYield: true,
  prepMinutes: true,
  isBatchable: true,
  containsAlcohol: true,
  category: true,
  archivedAt: true,
} as const;

export async function listItems(merchantIds: readonly string[]): Promise<MenuItem[]> {
  if (merchantIds.length === 0) {
    return [];
  }
  return prisma.menuItem.findMany({
    where: { merchantId: { in: [...merchantIds] }, archivedAt: null },
    orderBy: { name: 'asc' },
    select: LIST_SELECT,
  });
}

/**
 * Scoped lookup that returns `null` instead of throwing — for server components,
 * which must call `notFound()` rather than produce a status code.
 */
export async function findItem(
  merchantIds: readonly string[],
  id: string,
): Promise<MenuItem | null> {
  if (merchantIds.length === 0) {
    return null;
  }
  return prisma.menuItem.findFirst({
    where: { id, merchantId: { in: [...merchantIds] } },
    select: LIST_SELECT,
  });
}

/** Throws 404 when the id is outside the caller's scope (route handlers). */
export async function getItem(merchantIds: readonly string[], id: string): Promise<MenuItem> {
  const item = await findItem(merchantIds, id);
  if (!item) {
    throw AppError.notFound('That dish could not be found.');
  }
  return item;
}

/** Sprint 1 gives an owner exactly one merchant; the scope decides which. */
export async function primaryMerchantId(merchantIds: readonly string[]): Promise<string> {
  const first = merchantIds[0];
  if (!first) {
    throw AppError.notFound('No merchant is attached to this account.');
  }
  return first;
}

export async function createItem(
  merchantIds: readonly string[],
  input: ItemInput,
): Promise<MenuItem> {
  const merchantId = await primaryMerchantId(merchantIds);

  return prisma.menuItem.create({
    data: { merchantId, ...input },
    select: LIST_SELECT,
  });
}

export async function updateItem(
  merchantIds: readonly string[],
  id: string,
  input: ItemInput,
): Promise<MenuItem> {
  // Ownership is checked before the write, so a foreign id is a 404 and never a
  // silent no-op.
  await getItem(merchantIds, id);

  return prisma.menuItem.update({
    where: { id },
    data: input,
    select: LIST_SELECT,
  });
}

/**
 * The merchant's highest-priced dish, in cents — the `{menuPrice}` for the
 * minimum-margin dollar example (PRD-sprint1 §5.1). `null` when they have none,
 * which is when the caller falls back to $16.00.
 */
export async function highestMenuPriceCents(
  merchantIds: readonly string[],
): Promise<number | null> {
  if (merchantIds.length === 0) {
    return null;
  }
  const highest = await prisma.menuItem.findFirst({
    where: { merchantId: { in: [...merchantIds] }, archivedAt: null },
    orderBy: { menuPriceCents: 'desc' },
    select: { menuPriceCents: true },
  });
  return highest?.menuPriceCents ?? null;
}
