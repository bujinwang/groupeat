'use server';

import { acceptPasswordInvite } from '@/lib/auth/password-invite';
import { assertPasswordPolicy, hashPassword } from '@/lib/auth/password';
import { logger } from '@/lib/logging/logger';

/**
 * FR-101's accept step.
 *
 * ## The token comes from the form, and that is fine
 *
 * It is the same token that is in the URL, and the page already proved it is valid
 * before rendering the form. The action re-validates it by consuming it, because a
 * page render is not a lock: the link may have been used in another tab, or expired,
 * between the GET and the POST. The consume predicate is the authority.
 *
 * ## What the action refuses to say
 *
 * "Expired" and "already used" and "never existed" are one sentence. A stranger
 * holding a guessed token learns nothing, and the legitimate holder's next action is
 * the same in all three cases: ask for a new link.
 */

export type SetPasswordState = {
  error: string | null;
  fieldErrors: Record<string, string>;
  done: boolean;
};

export async function setPasswordAction(
  _previous: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const token = String(formData.get('token') ?? '');
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirmPassword') ?? '');

  const fieldErrors: Record<string, string> = {};
  const policyError = assertPasswordPolicy(password);
  if (policyError) {
    fieldErrors.password = policyError;
  }
  if (password !== confirm) {
    fieldErrors.confirmPassword = 'The two passwords do not match.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors, done: false };
  }

  const result = await acceptPasswordInvite({
    token,
    passwordHash: await hashPassword(password),
  });

  if (!result.ok) {
    return {
      error:
        'That link is no longer valid. It may have expired, or already been used. Ask your GroupEat contact to send a new one.',
      fieldErrors: {},
      done: false,
    };
  }

  logger.info('auth.password_changed', { userId: result.userId });
  return { error: null, fieldErrors: {}, done: true };
}
