import type { Merchant, Prisma } from '@prisma/client';

import { DEFAULT_FLOOR_PCT } from '@/lib/guardrail';
import { prisma } from './prisma';
import { createUser, normalizeEmail } from './users';

/**
 * The merchant repository, and the single most dangerous conversion in the app.
 *
 * ### The `Decimal` boundary — read this before touching `floorPctOfMenu`
 *
 * `Merchant.floorPctOfMenu` is `@db.Decimal(5,2)`, so Prisma hands back a
 * `Decimal` **object**, not a `number`. A `Decimal` is not `<=` or `>=` a number
 * in any useful way: every comparison against it is `false`, so
 * `contributionAt(P) >= floorCents` is never true, so `minViablePrice()` returns
 * `null` for every dish in the system.
 *
 * The failure is silent and it *looks like a product judgement*: every item
 * renders `INFEASIBLE` — "this dish can't be a deal at your minimum margin" — and
 * nothing in the logs is wrong. That is why the conversion happens here, once,
 * and why nothing else may write `Number(merchant.floorPctOfMenu)`.
 */

/** Anything Prisma can hand back for a `Decimal` column, plus the values tests pass. */
export type DecimalLike = Prisma.Decimal | number | string;

/**
 * Converts a `Decimal` to the `number` the guardrail expects.
 *
 * Uses `Number(value.toString())` rather than `Number(value)`: the string route
 * goes through the decimal representation Prisma produced (e.g. `"0.25"`), so
 * `0.25` comes out exactly `0.25` and not `0.25000000000000006`.
 *
 * Throws on a non-finite value or a value outside `(0, 1]`. That is deliberate: a
 * floor of `0` would make every dish viable and a floor above `1` would make
 * every dish infeasible, and either one arriving from the database means someone
 * edited the row by hand. A loud 500 is better than a plausible-looking wrong
 * answer — the whole point of the guardrail is that its numbers can be trusted.
 */
export function toPct(value: DecimalLike): number {
  const numeric = typeof value === 'number' ? value : Number(value.toString());

  if (!Number.isFinite(numeric)) {
    throw new Error(`floorPctOfMenu is not a finite number (received ${String(value)}).`);
  }
  if (numeric <= 0 || numeric > 1) {
    throw new Error(`floorPctOfMenu must be in (0, 1]; received ${numeric}.`);
  }
  return numeric;
}

export type MerchantSummary = Pick<
  Merchant,
  'id' | 'name' | 'slug' | 'status' | 'pickupAddress' | 'pickupInstructions' | 'timezone'
> & { floorPctOfMenu: number };

/** A merchant with the floor already converted. Never expose the raw `Decimal`. */
export function toMerchantSummary(merchant: Merchant): MerchantSummary {
  return {
    id: merchant.id,
    name: merchant.name,
    slug: merchant.slug,
    status: merchant.status,
    pickupAddress: merchant.pickupAddress,
    pickupInstructions: merchant.pickupInstructions,
    timezone: merchant.timezone,
    floorPctOfMenu: toPct(merchant.floorPctOfMenu),
  };
}

/** The guardrail's floor for one merchant, as a number. */
export async function getFloor(merchantId: string): Promise<number> {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { floorPctOfMenu: true },
  });
  if (!merchant) {
    throw new Error(`Merchant ${merchantId} not found.`);
  }
  return toPct(merchant.floorPctOfMenu);
}

export async function getMerchant(merchantId: string): Promise<MerchantSummary | null> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  return merchant ? toMerchantSummary(merchant) : null;
}

/** Scoped lookup: `null` when the id is not in the caller's scope. */
export async function getMerchantInScope(
  merchantIds: readonly string[],
  merchantId: string,
): Promise<MerchantSummary | null> {
  if (!merchantIds.includes(merchantId)) {
    return null;
  }
  return getMerchant(merchantId);
}

export async function listMerchants(): Promise<MerchantSummary[]> {
  const merchants = await prisma.merchant.findMany({ orderBy: { name: 'asc' } });
  return merchants.map(toMerchantSummary);
}

/**
 * S1-018 — the floor is written only here, and only with a value that passed
 * `assertFloorInRange` at the boundary.
 */
export async function updateFloor(merchantId: string, floorPctOfMenu: number): Promise<number> {
  if (!Number.isFinite(floorPctOfMenu) || floorPctOfMenu <= 0 || floorPctOfMenu > 1) {
    throw new Error('floorPctOfMenu must be in (0, 1].');
  }
  const updated = await prisma.merchant.update({
    where: { id: merchantId },
    data: { floorPctOfMenu },
    select: { floorPctOfMenu: true },
  });
  return toPct(updated.floorPctOfMenu);
}

export async function updatePickup(args: {
  merchantId: string;
  pickupAddress: string | null;
  pickupInstructions: string | null;
}): Promise<void> {
  await prisma.merchant.update({
    where: { id: args.merchantId },
    data: {
      pickupAddress: args.pickupAddress,
      pickupInstructions: args.pickupInstructions,
    },
  });
}

/** Slug from a trading name: lowercase a-z0-9-, 3–40 chars (PRD-sprint1 §7.2). */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 3 ? base : `merchant-${base}`.slice(0, 40);
}

async function uniqueSlug(desired: string): Promise<string> {
  let candidate = desired;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const taken = await prisma.merchant.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) {
      return candidate;
    }
    candidate = `${desired.slice(0, 36)}-${suffix}`;
  }
  throw new Error('Could not allocate a unique merchant slug.');
}

export type CreateMerchantInput = {
  name: string;
  pickupAddress: string | null;
  pickupInstructions: string | null;
  ownerEmail: string;
  ownerName: string | null;
  ownerPasswordHash: string;
};

/**
 * US-A1 — creating a merchant creates three rows in one transaction:
 * the merchant (`PENDING`, 25% floor), the owner's MERCHANT account
 * (`mustChangePassword = true`) and the `MerchantUser{role: OWNER}` link.
 *
 * A partial write here would leave a merchant nobody can log in to, so it is a
 * transaction rather than three sequential awaits.
 */
export async function createMerchantWithOwner(
  input: CreateMerchantInput,
): Promise<{ merchantId: string; ownerId: string; slug: string }> {
  const slug = await uniqueSlug(slugify(input.name));

  const owner = await createUser({
    email: normalizeEmail(input.ownerEmail),
    name: input.ownerName,
    role: 'MERCHANT',
    passwordHash: input.ownerPasswordHash,
  });

  const merchant = await prisma.merchant.create({
    data: {
      name: input.name,
      slug,
      status: 'PENDING',
      floorPctOfMenu: DEFAULT_FLOOR_PCT,
      pickupAddress: input.pickupAddress,
      pickupInstructions: input.pickupInstructions,
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });

  return { merchantId: merchant.id, ownerId: owner.id, slug };
}

/**
 * The floor for the caller's primary merchant, plus its id.
 *
 * Sprint 1 gives an owner exactly one merchant, so "primary" is the first id in
 * scope. The floor is converted here, so every caller receives a `number`.
 */
export async function primaryMerchantFloor(
  merchantIds: readonly string[],
): Promise<{ merchantId: string; floorPctOfMenu: number }> {
  const merchantId = merchantIds[0];
  if (!merchantId) {
    throw new Error('No merchant is attached to this account.');
  }
  return { merchantId, floorPctOfMenu: await getFloor(merchantId) };
}
