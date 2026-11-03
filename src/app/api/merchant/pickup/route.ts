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

    const written = await updateOwnPickup({
      merchantIds,
      merchantId,
      pickupAddress: parsed.value.pickupAddress,
      pickupInstructions: parsed.value.pickupInstructions,
    });

    if (!written) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });
    }

    return NextResponse.json(
      {
        pickupAddress: parsed.value.pickupAddress,
        pickupInstructions: parsed.value.pickupInstructions,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
