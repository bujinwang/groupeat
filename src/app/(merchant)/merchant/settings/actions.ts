'use server';

import { revalidatePath } from 'next/cache';

import { requireMerchantWrite } from '@/lib/auth/authorize';
import { setDigestConsent } from '@/lib/db/digest';
import { primaryMerchantId } from '@/lib/db/items';
import { logger } from '@/lib/logging/logger';

/**
 * FR-704's consent form, as a server action.
 *
 * ## Why the merchant is resolved from the session, not the form
 *
 * The page renders one merchant and posts one checkbox. Accepting a `merchantId` from
 * the body would let any signed-in owner toggle consent on a merchant they are not a
 * member of — a small hole, but the kind that is invisible in a test that only ever
 * posts the right id. `primaryMerchantId(merchantIds)` is the same resolution the page
 * uses, from the same session-scoped list.
 *
 * The **role** is not trusted from the page either. `setDigestConsent` re-reads the
 * membership and refuses a MANAGER or STAFF, because "the button was only rendered for
 * owners" is a UI affordance and this is a public endpoint.
 *
 * ## Why the checkbox is read as `=== 'on'`
 *
 * An unchecked checkbox is **absent** from `FormData`, not `false`. `Boolean(value)`
 * would therefore be correct for the two states the form produces, but it would also
 * treat a body that omitted the field for another reason as consent — which is the
 * wrong default for a decision that controls whether we email someone. Explicit
 * equality makes every other shape mean "off".
 */

export type DigestConsentState = {
  error: string | null;
  notice: string | null;
  /** The value the server stored, so the form can show what is true after a save. */
  optIn: boolean | null;
};

export async function setDigestConsentAction(
  _previous: DigestConsentState,
  formData: FormData,
): Promise<DigestConsentState> {
  let merchantId: string;
  try {
    const { session, merchantIds } = await requireMerchantWrite();
    merchantId = await primaryMerchantId(merchantIds);
    const optIn = formData.get('digestOptIn') === 'on';

    const result = await setDigestConsent({
      merchantId,
      userId: session.userId,
      optIn,
    });

    if (!result.ok) {
      return {
        error:
          result.reason === 'NOT_OWNER'
            ? 'Only an owner can change the digest setting.'
            : 'This account is not a member of that merchant.',
        notice: null,
        optIn: null,
      };
    }

    logger.info('digest.consent_changed', { merchantId, optIn });
    revalidatePath('/merchant/settings');

    return {
      error: null,
      notice: optIn
        ? 'You will get the weekly digest on Monday mornings.'
        : 'The weekly digest is off. You can turn it back on any time.',
      optIn: result.digestOptIn,
    };
  } catch (error) {
    // A thrown authorisation error (impersonation, no session) is a page-level
    // condition, not a form field error. Say the one thing the user can act on.
    logger.warn('digest.consent_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      error: 'That could not be saved. Reload the page and try again.',
      notice: null,
      optIn: null,
    };
  }
}
