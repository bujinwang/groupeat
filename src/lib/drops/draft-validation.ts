import { findItem } from '@/lib/db/items';
import type { DraftInput } from '@/lib/db/drops';
import { validateDropQuantities, validateDropTiming } from './rules';

/**
 * The policy checks that run when a draft is **saved** — create or update.
 *
 * Shared by `POST /api/merchant/drops` and `PATCH /api/merchant/drops/:id` so
 * the two cannot drift. Before this existed, create rejected a window that
 * closed before it opened while update accepted it, which meant a draft could
 * be born valid and then edited into a state that could never publish — with no
 * warning until the merchant pressed Publish days later.
 *
 * ## What this is not
 *
 * This is **not** the publish gate. It checks the things a draft can be
 * *structurally* wrong about — an impossible window, a minimum above a maximum,
 * a maximum above what the kitchen can make. It deliberately does **not** check
 * price against the floor: a draft is allowed to be unprofitable, because FR-203's
 * slider needs a state to exist before the merchant has moved it. `publishDrop`
 * is where money is judged, against the database, at the moment it matters.
 *
 * `now` is passed in rather than read here, so the caller decides what "today"
 * means and a test can pin it.
 */
export async function collectDraftFieldErrors(args: {
  merchantIds: readonly string[];
  value: DraftInput;
  now: Date;
}): Promise<Record<string, string>> {
  const fieldErrors: Record<string, string> = {};

  for (const issue of validateDropTiming(
    {
      windowStart: args.value.windowStart,
      windowEnd: args.value.windowEnd,
      cutoffAt: args.value.cutoffAt,
    },
    args.now,
  )) {
    fieldErrors[issue.field] ??= issue.message;
  }

  // A dish that is missing or foreign leaves `batchYield` unknown, and the
  // ceiling check is skipped: `createDraft` / `updateDraft` turn that into a 404,
  // and reporting a yield error would name the wrong fault.
  const item = await findItem(args.merchantIds, args.value.menuItemId);

  for (const issue of validateDropQuantities({
    minQty: args.value.minQty,
    maxQty: args.value.maxQty,
    batchYield: item?.batchYield ?? Number.MAX_SAFE_INTEGER,
  })) {
    fieldErrors[issue.field] ??= issue.message;
  }

  return fieldErrors;
}
