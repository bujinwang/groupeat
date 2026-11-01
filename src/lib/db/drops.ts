import type { Prisma } from '@prisma/client';

import { AppError } from '@/lib/errors';
import { generatePublicCode } from '@/lib/drops/public-code';
import { prisma } from './prisma';

/**
 * Merchant-scoped drop queries (ARCHITECTURE-sprint1 §3.4 `DropService`).
 *
 * Follows the same rule as `db/items.ts`: **every** function takes the caller's
 * `merchantIds` and filters by it, so a foreign drop id is a `404` rather than a
 * `403` (US-M1) and a user with an empty scope sees nothing.
 *
 * ## What is deliberately absent
 *
 * No `deleteDrop`, no `setStatus`, no `updateGuardrailSnapshot`. Status
 * transitions belong to `lib/drops/publish.ts`, which applies the rules; a
 * generic setter here would be a way to skip them. The single exception
 * (`markPublished`) is named for the one transition it performs.
 */

/** Everything a merchant may set on a draft. Money is decided elsewhere. */
export type DraftInput = {
  menuItemId: string;
  title: string;
  description: string | null;
  heroImageUrl: string | null;
  dealPriceCents: number;
  minQty: number;
  maxQty: number;
  maxPerCustomer: number;
  windowStart: Date;
  windowEnd: Date;
  cutoffAt: Date;
  aiRationale: string | null;
};

const DROP_SELECT = {
  id: true,
  merchantId: true,
  menuItemId: true,
  publicCode: true,
  title: true,
  description: true,
  heroImageUrl: true,
  dealPriceCents: true,
  minQty: true,
  maxQty: true,
  maxPerCustomer: true,
  windowStart: true,
  windowEnd: true,
  cutoffAt: true,
  status: true,
  guardrailSnapshot: true,
  aiRationale: true,
  createdAt: true,
  publishedAt: true,
  lockedAt: true,
  completedAt: true,
} as const;

export type DropRow = Prisma.DropGetPayload<{ select: typeof DROP_SELECT }>;

/**
 * How many times to retry a `publicCode` collision before giving up.
 *
 * A collision is a 1-in-6×10¹¹ event per attempt, so three failures in a row is
 * not bad luck — it means something is wrong (a broken random source, a
 * truncated column) and a loud error is more useful than a fourth attempt.
 */
const PUBLIC_CODE_ATTEMPTS = 3;

export async function listDrops(merchantIds: readonly string[]): Promise<DropRow[]> {
  if (merchantIds.length === 0) {
    return [];
  }
  return prisma.drop.findMany({
    where: { merchantId: { in: [...merchantIds] } },
    orderBy: { createdAt: 'desc' },
    select: DROP_SELECT,
  });
}

/** `null` instead of throwing — for server components, which must call `notFound()`. */
export async function findDrop(
  merchantIds: readonly string[],
  id: string,
): Promise<DropRow | null> {
  if (merchantIds.length === 0) {
    return null;
  }
  return prisma.drop.findFirst({
    where: { id, merchantId: { in: [...merchantIds] } },
    select: DROP_SELECT,
  });
}

/** Throws 404 when the id is outside the caller's scope (route handlers). */
export async function getDrop(merchantIds: readonly string[], id: string): Promise<DropRow> {
  const drop = await findDrop(merchantIds, id);
  if (!drop) {
    throw AppError.notFound('That drop could not be found.');
  }
  return drop;
}

/**
 * Public lookup by code. **Not** merchant-scoped — this is the diner's path.
 *
 * Returns `null` for anything that does not exist or is not visible to the
 * public. A `DRAFT` is invisible even to someone who guesses its code, because
 * an unpublished drop has no price commitment behind it yet.
 */
export async function findPublicDrop(publicCode: string): Promise<DropRow | null> {
  return prisma.drop.findFirst({
    where: {
      publicCode,
      status: { in: ['PUBLISHED', 'LOCKED', 'CAPTURED', 'PICKUP_OPEN', 'COMPLETED'] },
    },
    select: DROP_SELECT,
  });
}

/**
 * Creates a `DRAFT`.
 *
 * The `publicCode` is generated here rather than at publish, because a draft
 * needs a stable URL to preview at (FR-206's `?preview=1`), and because
 * generating it at publish would mean a merchant who shared a preview link
 * before publishing shared a link that changed.
 *
 * A draft's code is not reachable publicly — `findPublicDrop` filters on status —
 * so generating it early leaks nothing.
 */
export async function createDraft(
  merchantIds: readonly string[],
  input: DraftInput,
): Promise<DropRow> {
  const merchantId = merchantIds[0];
  if (!merchantId) {
    throw AppError.notFound('No merchant is attached to this account.');
  }

  // Ownership of the dish is checked before the write, so a foreign `menuItemId`
  // is a 404 and never a draft pointing at another merchant's dish.
  const item = await prisma.menuItem.findFirst({
    where: { id: input.menuItemId, merchantId },
    select: { id: true },
  });
  if (!item) {
    throw AppError.notFound('That dish could not be found.');
  }

  for (let attempt = 1; attempt <= PUBLIC_CODE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.drop.create({
        data: {
          merchantId,
          publicCode: generatePublicCode(),
          status: 'DRAFT',
          // The snapshot is empty until publish. §7.7's shape is the contract for
          // what arrives later; a placeholder object here would be a lie about
          // when the maths was frozen.
          guardrailSnapshot: {},
          ...input,
        },
        select: DROP_SELECT,
      });
    } catch (error) {
      if (!isUniqueViolation(error, 'publicCode') || attempt === PUBLIC_CODE_ATTEMPTS) {
        throw error;
      }
    }
  }

  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error('publicCode generation failed after retries.');
}

/**
 * Updates a draft. Refuses anything that is not `DRAFT` — a published drop's
 * terms are frozen, and the only transitions out of `PUBLISHED` are cancel and
 * the cutoff job.
 */
export async function updateDraft(
  merchantIds: readonly string[],
  id: string,
  input: Partial<DraftInput>,
): Promise<DropRow> {
  const existing = await getDrop(merchantIds, id);

  if (existing.status !== 'DRAFT') {
    // 409, not 422: the body was valid and no other body would be accepted. The
    // drop's state is the obstacle, so the status code should say so — a client
    // retrying with corrected fields would loop forever against a 422.
    throw AppError.conflict(
      'This drop is already live. Cancel it and start again to change the details.',
    );
  }

  if (input.menuItemId !== undefined) {
    const item = await prisma.menuItem.findFirst({
      where: { id: input.menuItemId, merchantId: existing.merchantId },
      select: { id: true },
    });
    if (!item) {
      throw AppError.notFound('That dish could not be found.');
    }
  }

  return prisma.drop.update({
    where: { id },
    data: input,
    select: DROP_SELECT,
  });
}

/**
 * The one status transition this module performs, and only in one direction.
 *
 * Named for the transition rather than `setStatus` so a caller cannot reach it
 * intending something else. The `where` clause carries the `DRAFT` precondition
 * into the database, which makes a double-publish impossible even if two
 * requests race: the second update matches zero rows and throws.
 */
export async function markPublished(args: {
  id: string;
  publishedAt: Date;
  guardrailSnapshot: Prisma.InputJsonValue;
}): Promise<DropRow> {
  const updated = await prisma.drop.updateMany({
    where: { id: args.id, status: 'DRAFT' },
    data: {
      status: 'PUBLISHED',
      publishedAt: args.publishedAt,
      guardrailSnapshot: args.guardrailSnapshot,
    },
  });

  if (updated.count === 0) {
    // Either already published, or cancelled between the read and this write.
    // Both mean "not a draft any more" and neither should overwrite a snapshot.
    throw AppError.validation(
      { status: 'This drop has already been published.' },
      'This drop has already been published.',
    );
  }

  return prisma.drop.findUniqueOrThrow({ where: { id: args.id }, select: DROP_SELECT });
}

/**
 * Prisma wraps unique violations in `P2002`, and the target is either a string
 * or a list depending on the connector. Both shapes are handled so the retry
 * loop cannot be defeated by a driver detail.
 */
function isUniqueViolation(error: unknown, field: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') {
    return false;
  }
  const target = candidate.meta?.target;
  if (typeof target === 'string') {
    return target.includes(field);
  }
  if (Array.isArray(target)) {
    return target.includes(field);
  }
  // A unique violation with no target reported is still almost certainly the
  // publicCode (it is the only unique column we generate), so retrying is
  // correct and cheaper than failing.
  return true;
}
