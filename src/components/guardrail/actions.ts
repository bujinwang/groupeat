'use server';

import { requireMerchant } from '@/lib/auth/authorize';
import { findItem } from '@/lib/db/items';
import { getFloor } from '@/lib/db/merchants';
import { evaluateItem } from '@/lib/items/evaluate';
import { roundHalfUp } from '@/lib/guardrail';

/**
 * The INFEASIBLE escape hatch's **preview** (PRD-sprint1 §5.5 "Change my minimum
 * margin", Q-6).
 *
 * Q-6 requires the confirmation to *name the consequence*, and the lead requires
 * the consequence to be real numbers rather than a template. That means the server
 * has to evaluate the dish at a floor the merchant has not saved yet.
 *
 * ### Why a server action and not a route
 *
 * §5.6 forbids the guardrail **endpoint** from accepting a cost or a floor from the
 * request body, and that rule stays intact: `POST /api/merchant/items/:id/guardrail`
 * still reads everything from the database. This is a different question —
 * *"what would happen if my minimum were 18%?"* — and it **writes nothing**. The
 * item and the current floor are still loaded from the database under the caller's
 * merchant scope; only the hypothetical floor is a parameter, which is the entire
 * point of a what-if.
 *
 * Nothing here persists. The write goes through `PATCH /api/merchant/settings`,
 * which re-validates the value, requires `acknowledgedConsequence`, and emits
 * `floor_changed`.
 */

export type FloorPreview =
  | {
      ok: true;
      /** Whole percent, as the merchant picked it. */
      candidatePct: number;
      minViablePriceCents: number;
      /** What they would keep per plate at that lowest sellable price. */
      keepCents: number;
      currentFloorCents: number;
    }
  | { ok: false; message: string };

export async function previewFloorAction(args: {
  itemId: string;
  candidatePct: number;
}): Promise<FloorPreview> {
  const { merchantIds } = await requireMerchant();

  const item = await findItem(merchantIds, args.itemId);
  if (!item) {
    return { ok: false, message: 'That dish could not be found.' };
  }

  const candidatePct = Math.round(args.candidatePct);
  if (!Number.isFinite(candidatePct) || candidatePct < 1 || candidatePct > 100) {
    return { ok: false, message: 'Choose a minimum between 1% and 100%.' };
  }

  const currentFloorPct = await getFloor(item.merchantId);
  const evaluation = evaluateItem({
    item,
    floorPctOfMenu: candidatePct / 100,
  });

  const view = evaluation.view;
  if (!view || view.minViablePriceCents === null) {
    return {
      ok: false,
      message: `At a ${candidatePct}% minimum this dish still can't be a deal. A cheaper ingredient cost is the other way out.`,
    };
  }

  return {
    ok: true,
    candidatePct,
    minViablePriceCents: view.minViablePriceCents,
    keepCents: view.breakdown.contributionCents,
    currentFloorCents: roundHalfUp(item.menuPriceCents * currentFloorPct),
  };
}
