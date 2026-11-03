import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchantWrite } from '@/lib/auth/authorize';
import { buildDealProposals } from '@/lib/ai/deal-builder';
import { parseDealBuilderInput } from '@/lib/ai/input';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';

/**
 * `POST /api/merchant/ai/deal-builder` — the five-question interview, answered.
 *
 * ## What this route decides, and what it does not
 *
 * It does not decide a price. The body carries a dish, a quiet slot, an intent
 * and a quantity ceiling; the guardrail decides every price from the merchant's
 * own floor and their dish's own costs, and `plan.ts` decides the shape of the
 * three offers. The route's only job is authorisation, parsing, and the shape of
 * the response.
 *
 * ## Why a POST that writes nothing to `Drop`
 *
 * It does write — an `AiDraft` audit row (PRD-v1 §9.1.3). What it does not do is
 * create a drop. The merchant sees three offers, picks one, and *that* action
 * posts to `/api/merchant/drops`, where the same validation every manual draft
 * goes through runs again. Planning is cheap and reversible; creating is neither.
 *
 * `now` is read here rather than inside the service so that every proposal in one
 * response is measured against a single instant — three offers with three
 * different "publish times" would make the five-day check disagree with itself
 * at the boundary.
 */

const ROUTE = 'api/merchant/ai/deal-builder';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchantWrite();

    const raw: unknown = await request.json().catch(() => null);
    const parsed = parseDealBuilderInput(raw);

    if (!parsed.ok) {
      logger.info('drop.validation_failed', {
        actorId: session.userId,
        merchantId: merchantIds[0] ?? 'none',
        issueCount: Object.keys(parsed.fieldErrors).length,
      });
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Check your answers.',
          fieldErrors: parsed.fieldErrors,
        },
        { status: 422 },
      );
    }

    const result = await buildDealProposals({
      merchantIds,
      answers: parsed.value,
      now: new Date(),
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
