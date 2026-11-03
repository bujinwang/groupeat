import type { Merchant, Prisma } from '@prisma/client';

import { DEFAULT_FLOOR_PCT } from '@/lib/guardrail';
import { prisma } from './prisma';
import { normalizeEmail } from './users';

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

/**
 * The slice of the Prisma client that the merchant writes need, so a helper can
 * take either the global client or a transaction client.
 *
 * `Prisma.TransactionClient` is the type Prisma exports for exactly this, and it
 * is a `Pick` over the full client rather than a subclass — a plain
 * `PrismaClient` satisfies it, so `uniqueSlug(prisma, …)` and `uniqueSlug(tx, …)`
 * are both valid and neither needs a cast.
 */
type PrismaClientLike = Pick<Prisma.TransactionClient, 'merchant'>;

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

/** A merchant's people, for the admin screen that offers impersonation (FR-904). */
export type MerchantMember = {
  readonly merchantUserId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: 'OWNER' | 'MANAGER' | 'STAFF';
};

/**
 * Everyone attached to one merchant, owners first.
 *
 * ## Why the admin page needs this rather than impersonating the merchant
 *
 * FR-904 is *"impersonate a merchant **owner**"*. The unit the admin is on the page
 * for is a merchant, but the unit the session is minted for is a **user** — and one
 * merchant can have several. A button that read "Impersonate" off the merchant row
 * would have to pick somebody, and picking the first row (or the oldest) without
 * saying so is how an admin ends up looking at a different person's view than the one
 * on the phone. So the page lists the people and the admin chooses, and the chosen
 * `MerchantUser.id` is what the route takes.
 *
 * Ordered by role then email so the list is stable between renders and owners come
 * first — the role the requirement actually covers.
 */
export async function listMerchantMembers(merchantId: string): Promise<MerchantMember[]> {
  const rows = await prisma.merchantUser.findMany({
    where: { merchantId },
    select: {
      id: true,
      role: true,
      userId: true,
      user: { select: { email: true, name: true } },
    },
  });

  const order: readonly MerchantMember['role'][] = ['OWNER', 'MANAGER', 'STAFF'];
  return rows
    .map((row) => ({
      merchantUserId: row.id,
      userId: row.userId,
      email: row.user.email,
      name: row.user.name,
      role: row.role,
    }))
    .sort((a, b) => {
      const byRole = order.indexOf(a.role) - order.indexOf(b.role);
      return byRole !== 0 ? byRole : a.email.localeCompare(b.email);
    });
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

/**
 * FR-103 / US-M2 — the merchant's own pickup details.
 *
 * Deliberately narrower than `updatePickup`, which the admin surface uses: this
 * one **cannot touch `floorPctOfMenu`**, because the floor has its own governed
 * path (`updateFloor` + `acknowledgedConsequence`). Two writes with different
 * governance must not share a function, or the governance on the stricter one
 * becomes advisory.
 *
 * Scoped by `merchantIds` for the same reason every item query is (US-M1): the
 * caller's reachable merchants are the authority, not an id from the request.
 * Returns `false` when the id is outside scope, so the route can answer 404
 * rather than 403 and not confirm that someone else's merchant exists.
 */
export async function updateOwnPickup(args: {
  merchantIds: readonly string[];
  merchantId: string;
  pickupAddress: string | null;
  pickupInstructions: string | null;
}): Promise<boolean> {
  if (!args.merchantIds.includes(args.merchantId)) {
    return false;
  }

  // The scope check above is done in memory rather than as a `where` clause, so
  // the caller's reachable ids are the single authority. A `where: { id, users:
  // { some: … } }` variant would re-derive scope from the database and could
  // disagree with the session that authorised the request.
  await prisma.merchant.update({
    where: { id: args.merchantId },
    data: {
      pickupAddress: args.pickupAddress,
      pickupInstructions: args.pickupInstructions,
    },
  });
  return true;
}

/**
 * Slug from a trading name: lowercase a-z0-9-, 3–40 chars (PRD-sprint1 §7.2).
 *
 * Two things this has to get right, both of which it used to get wrong:
 *
 * 1. **Accents are folded, not split.** `NFKD` decomposes `é` into `e` + a
 *    combining acute accent. Replacing "everything not a-z0-9" with `-` therefore
 *    turned each accented letter into *two* separators, so `Déjà Vu` became
 *    `de-ja-vu` — a URL with a hole in the middle of a word. The combining marks
 *    are stripped first, so the letter survives as itself.
 * 2. **The result always ends in a slug character.** Stripping leading/trailing
 *    hyphens happened *before* the minimum-length fallback, so a name with no
 *    slug-worthy characters at all produced `merchant-` — trailing hyphen, and a
 *    different value from the same input slugified again. Trimming after the
 *    fallback keeps `Merchant.slug` stable and the URL clean.
 *
 * `Merchant.slug` is `@unique` and appears in every share link, so a slug that
 * changes shape depending on the merchant's name is a link that breaks.
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    // Strip the combining marks NFKD just separated out, so `é` stays `e`.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const padded = base.length >= 3 ? base : `merchant-${base}`.slice(0, 40);
  // Trim again: the fallback can introduce or leave a trailing hyphen.
  return padded.replace(/^-+|-+$/g, '');
}

/**
 * The first free slug at or after `desired`.
 *
 * Takes a client rather than closing over `prisma` so the caller can run this on
 * the same connection as the insert it is choosing a slug for. Note that this
 * does *not* by itself make two concurrent onboardings safe — see
 * `createMerchantWithOwner` for what the read on `tx` does and does not buy.
 */
async function uniqueSlug(client: PrismaClientLike, desired: string): Promise<string> {
  let candidate = desired;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const taken = await client.merchant.findUnique({
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
 * ## Why this is now actually a transaction
 *
 * It always *said* it was one. It was not: `createUser` ran as a separate
 * statement, and only the `MerchantUser` link was nested inside the merchant
 * create. A failure between the two left a `MERCHANT` account attached to
 * nothing — an account that signs in and then finds no merchant, which
 * `requireMerchant` refuses rather than explains. (Gap 15 in PROGRESS.md, closed
 * here with `createOrganiser`'s pattern as the template.)
 *
 * The tell was in the docblock, not the code: the prose described a guarantee
 * the body did not make. That is this milestone's recurring defect shape in its
 * least dramatic form — nothing is *wrong*, something is *claimed*.
 *
 * ## What sits inside the transaction, and what honestly does not guarantee what
 *
 * All three writes. `uniqueSlug`'s read is also inside, but for a humbler reason
 * than "it closes the race" — a probe run against real Postgres showed that two
 * `Promise.all`'d onboardings of the same trading name **both succeed** with
 * distinct slugs, because the slug read and the merchant insert are close enough
 * together that the second transaction sees the first one's uncommitted row. The
 * retry loop does the real work there.
 *
 * So the reason the read lives on `tx` is that it costs nothing and keeps the
 * slug decision on the same snapshot as the insert it is deciding for, rather
 * than reading a view of the table that could already be stale by the time the
 * insert runs. It is not load-bearing, no test can distinguish it, and saying
 * otherwise is exactly the mistake this function's previous docblock made. A
 * genuinely tight race (same slug, far enough apart to miss the same snapshot)
 * still ends in a `Merchant_slug_key` violation and a clean rollback — which is
 * the correct outcome, and this is the guarantee the transaction actually buys.
 *
 * The `Role` is not a parameter: this *is* the merchant-owner path, so a caller
 * cannot ask for an `ADMIN` here. `createOrganiser` makes the same choice for the
 * same reason.
 *
 * Note that the email is normalised but *not* created via `createUser`, which
 * would be a separate statement against the global client. The two writes that
 * must see the same connection are written here; `createUser` remains the one
 * place that decides what a new account looks like, and it is deliberately
 * bypassed only for its client, not for its rules — `mustChangePassword: true`
 * and the `MERCHANT` role are restated below with the same values it uses.
 */
export async function createMerchantWithOwner(
  input: CreateMerchantInput,
): Promise<{ merchantId: string; ownerId: string; slug: string }> {
  return prisma.$transaction(async (tx) => {
    const slug = await uniqueSlug(tx, slugify(input.name));

    const owner = await tx.user.create({
      data: {
        email: normalizeEmail(input.ownerEmail),
        name: input.ownerName,
        role: 'MERCHANT',
        passwordHash: input.ownerPasswordHash,
        // Every account in V1 is bootstrapped by an admin with a temporary
        // password — the same rule `createUser` applies, restated because this
        // path writes the row directly in order to stay on `tx`.
        mustChangePassword: true,
      },
      select: { id: true },
    });

    const merchant = await tx.merchant.create({
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
  });
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
