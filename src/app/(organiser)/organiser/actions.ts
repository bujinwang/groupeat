'use server';

import { revalidatePath } from 'next/cache';

import { getSession } from '@/lib/auth/session';
import { organiserProfileForUser } from '@/lib/db/share-links';
import { ensureShareLink } from '@/lib/db/share-links';
import { logger } from '@/lib/logging/logger';

/**
 * FR-802's one server action: mint (or find) the organiser's link for a drop.
 *
 * ## Why this is an action and not a link the page pre-computes
 *
 * The page could generate a token for every drop it lists, but that writes a
 * `ShareLink` row for every drop an organiser merely *looks at* — including the ones
 * they decide not to share. Rows that exist only because a page rendered are not
 * attribution; they are clutter that makes "how many drops did Sam share?" unanswerable.
 *
 * So the token is created by the intent: tap "Get share link", the row appears, the
 * page re-renders with the link and its copy button. Two taps, and the second one is
 * the copy — which is what FR-802's acceptance actually asks for.
 *
 * ## Authorisation
 *
 * A server action is a public endpoint; middleware's matcher is not an authorisation
 * gate. So the role is re-checked here, and the profile is resolved from the session's
 * `userId` rather than accepted from the form. A `dropId` is the only thing the client
 * supplies, and `ensureShareLink` re-checks that the drop is live before minting
 * anything.
 *
 * `mustChangePassword` is refused for the same reason `/admin/*` refuses it: a
 * temporary password is not a person yet.
 */

export type ShareLinkState = {
  error: string | null;
  /** Set once a link exists, so the page can render it without a second round trip. */
  token: string | null;
};

export async function getShareLinkAction(
  _previous: ShareLinkState,
  formData: FormData,
): Promise<ShareLinkState> {
  const session = await getSession();
  if (!session || session.role !== 'ORGANISER' || session.mustChangePassword) {
    return { error: 'You do not have access to this action.', token: null };
  }

  const profile = await organiserProfileForUser(session.userId);
  if (!profile) {
    // The FR-906 account: an ORGANISER with no profile. Nothing to attribute a link to,
    // so say so instead of creating a row that points at nothing.
    return {
      error: 'Your organiser profile is missing. Ask the team to finish setting up your account.',
      token: null,
    };
  }

  const dropId = String(formData.get('dropId') ?? '').trim();
  if (dropId.length === 0) {
    return { error: 'That drop is no longer available.', token: null };
  }

  const link = await ensureShareLink({ organiserProfileId: profile.id, dropId });
  if (!link) {
    // Not published, past cutoff, or nonexistent — all the same sentence, because the
    // organiser's next action is identical in every case: pick another drop.
    return { error: 'That drop has closed. Refresh to see what is still open.', token: null };
  }

  logger.info(link.created ? 'organiser.share_link_created' : 'organiser.share_link_reused', {
    organiserProfileId: profile.id,
    dropId,
    source: 'action',
  });
  revalidatePath('/organiser');

  return { error: null, token: link.token };
}
