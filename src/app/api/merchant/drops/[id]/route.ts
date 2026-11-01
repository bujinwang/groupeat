import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant } from '@/lib/auth/authorize';
import { getDrop, updateDraft } from '@/lib/db/drops';
import { collectDraftFieldErrors } from '@/lib/drops/draft-validation';
import { parseDraftInput } from '@/lib/drops/input';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';

/**
 * `GET   /api/merchant/drops/:id` — one draft or drop.
 * `PATCH /api/merchant/drops/:id` — edit a draft (**409 once published**).
 *
 * A published drop's terms are frozen: `updateDraft` refuses anything not in
 * `DRAFT`, so this route cannot be used to change the price of a live drop after
 * money has been authorised against it.
 *
 * That refusal is a **409** (`AppError.conflict`), not a 422: the body was
 * perfectly valid, and no different body would be accepted. It is the *state* of
 * the resource that says no.
 */

const ROUTE = 'api/merchant/drops/[id]';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const { merchantIds } = await requireMerchant();
    const { id } = await context.params;
    const drop = await getDrop(merchantIds, id);
    return NextResponse.json({ drop }, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}

export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchant();
    const { id } = await context.params;

    // Ownership before parsing: a foreign id must be a 404 even when the body is
    // also malformed, or the error shape would confirm the drop exists.
    await getDrop(merchantIds, id);

    const raw: unknown = await request.json().catch(() => null);
    const parsed = parseDraftInput(raw);

    if (!parsed.ok) {
      logger.info('drop.validation_failed', {
        actorId: session.userId,
        merchantId: merchantIds[0] ?? 'none',
        issueCount: Object.keys(parsed.fieldErrors).length,
      });
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Check the details for this drop.',
          fieldErrors: parsed.fieldErrors,
        },
        { status: 422 },
      );
    }

    // The same policy checks `POST` runs, so a draft cannot be edited into a
    // state it could never have been created in. Without this, a merchant could
    // create a valid draft and then move the cutoff after the pickup window,
    // discovering the problem only when they pressed Publish.
    const fieldErrors = await collectDraftFieldErrors({
      merchantIds,
      value: parsed.value,
      now: new Date(),
    });

    if (Object.keys(fieldErrors).length > 0) {
      logger.info('drop.validation_failed', {
        actorId: session.userId,
        merchantId: merchantIds[0] ?? 'none',
        issueCount: Object.keys(fieldErrors).length,
      });
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Check the details for this drop.',
          fieldErrors,
        },
        { status: 422 },
      );
    }

    const drop = await updateDraft(merchantIds, id, parsed.value);
    logger.info('drop.draft_updated', {
      actorId: session.userId,
      dropId: drop.id,
      merchantId: drop.merchantId,
    });

    return NextResponse.json({ drop }, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
