'use server';

import { redirect } from 'next/navigation';

import { changePassword } from '@/lib/auth/credentials';
import { applySessionCookie, getSession } from '@/lib/auth/session';

/**
 * S1-019 — the forced password change.
 *
 * There is no separate "forced" action: the same server action serves the
 * voluntary change and the temporary-password bootstrap. On success the session
 * is re-signed with `mv = false`, so the middleware gate opens without a
 * re-login and the user lands on their role's home page.
 */

export type ChangePasswordFormState = {
  error: string | null;
  field: 'currentPassword' | 'newPassword' | null;
};

export async function changePasswordAction(
  _previous: ChangePasswordFormState,
  formData: FormData,
): Promise<ChangePasswordFormState> {
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');

  const session = await getSession();
  if (!session) {
    redirect('/login');
  }

  const result = await changePassword(session.userId, currentPassword, newPassword);
  if (!result.ok) {
    return { error: result.message, field: result.field ?? null };
  }

  await applySessionCookie(result.session);
  redirect(result.redirectTo);
}
