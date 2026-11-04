import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant, requireMerchantWrite } from '@/lib/auth/authorize';
import { primaryMerchantId } from '@/lib/db/items';
import { getMerchant, updateOwnPickup } from '@/lib/db/merchants';
import { errorResponse } from '@/lib/http';
import { parsePickupInput } from '@/lib/merchants/pickup';

/**
 * `GET   /api/merchant/pickup` — the caller's pickup details.
 * `PATCH /api/merchant/pickup` — FR-103, set the address and instructions.
 *
 * ## Why this is a separate route from `PATCH /api/merchant/settings`
 *
 * `settings` carries the minimum margin, and moving the floor is governed: a
 * lowering needs `acknowledgedConsequence: true` and writes a `floor_changed`
 * audit event. Pickup details need none of that.
 *
 * Putting both on one endpoint would mean a merchant editing their address
 * submits a body that also contains a floor field, and the safety of the floor
 * then depends on the form sending the right thing — which is exactly how a
 * governed write becomes an ungoverned one. Two resources, two routes, and this
 * one has no way to express a floor change at all.
 *
 * Scope comes from the session (`requireMerchant`), never from the body. A
 * merchant id outside the caller's reach is a **404**, not a 403 (US-M1).
 */

const ROUTE = 'api/merchant/pickup';

export async function GET(): Promise<NextResponse> {
  try {
    const { merchantIds } = await requireMerchant();
    const merchantId = await primaryMerchantId(merchantIds);
    const merchant = await getMerchant(merchantId);

    if (!merchant) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });
    }

    return NextResponse.json(
      {
        pickupAddress: merchant.pickupAddress,
        pickupInstructions: merchant.pickupInstructions,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const { merchantIds } = await requireMerchantWrite();
    const merchantId = await primaryMerchantId(merchantIds);

    const raw: unknown = await request.json().catch(() => null);
    const parsed = parsePickupInput(raw);

    if (!parsed.ok) {
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Check the pickup details you entered.',
          fieldErrors: parsed.fieldErrors,
        },
        { status: 422 },
      );
    }

    /**
     * A body naming no known field is refused, not accepted as a no-op.
     *
     * `{}` — or `{"pickupAddressTypo": "1 New Rd"}` — used to be a 200 that
     * deleted both columns. Answering 200 for "changed nothing" would also be
     * defensible, but a `PATCH` carrying no recognisable field is a client bug,
     * and a 422 is the only answer that makes it visible instead of silent. Zod
     * strips unknown keys rather than failing on them, so this is the only place
     * a misspelled field name can be caught.
     */
    if (Object.keys(parsed.value).length === 0) {
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Nothing to update. Send pickupAddress, pickupInstructions, or both.',
          fieldErrors: {},
        },
        { status: 422 },
      );
    }

    const written = await updateOwnPickup({
      merchantIds,
      merchantId,
      ...parsed.value,
    });

    if (!written) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });
    }

    /**
     * Answer with the row as stored, not with the patch.
     *
     * The response used to be the parsed body, which was correct only because the
     * body was always the whole row — every field was written, so echoing the
     * input and reading the table gave the same answer. With a partial write that
     * stops being true: echoing `{ pickupAddress }` would tell the client the
     * instructions are gone, which is the same lie as before in a new place.
     * `PickupForm` applies this object straight to its inputs, so it has to be
     * the truth. One extra read on a save the merchant pressed a button for.
     */
    const merchant = await getMerchant(merchantId);
    if (!merchant) {
      // The row was in scope and writable a statement ago; this is a concurrent
      // delete, not a scope refusal.
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });
    }

    return NextResponse.json(
      {
        pickupAddress: merchant.pickupAddress,
        pickupInstructions: merchant.pickupInstructions,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
