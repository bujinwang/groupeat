'use server';

import { revalidatePath } from 'next/cache';

import { emit } from '@/lib/analytics/events';
import { assertPasswordPolicy, hashPassword } from '@/lib/auth/password';
import {
  PASSWORD_INVITE_TTL_LABEL,
  issuePasswordInvite,
} from '@/lib/auth/password-invite';
import { getSession } from '@/lib/auth/session';
import {
  addMerchantMember,
  createMerchantWithOwner,
  getMerchant,
  updateFloor,
  updatePickup,
} from '@/lib/db/merchants';
import {
  backfillOrganiserProfile,
  commissionRefusal,
  createOrganiser,
} from '@/lib/db/organisers';
import { createUser, emailExists } from '@/lib/db/users';
import { logger } from '@/lib/logging/logger';
import { publicOrigin } from '@/lib/notify/public-origin';
import { ownerInviteEmail } from '@/lib/notify/invite-email';

/**
 * Admin server actions (US-A1, US-A2).
 *
 * The admin surface has no `POST /api/admin/*` route in Sprint 1 — the file list
 * stops at the auth routes — so these forms post to server actions. Authorisation
 * is re-checked here: a server action is a public endpoint, and middleware's
 * matcher is not an authorisation gate.
 */

export type AdminFormState = {
  error: string | null;
  fieldErrors: Record<string, string>;
  notice: string | null;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAdminSession(): Promise<{ userId: string } | AdminFormState> {
  const session = await getSession();
  if (!session || session.role !== 'ADMIN' || session.mustChangePassword) {
    return {
      error: 'You do not have access to this action.',
      fieldErrors: {},
      notice: null,
    };
  }
  return { userId: session.userId };
}

function isFailure(value: { userId: string } | AdminFormState): value is AdminFormState {
  return 'error' in value;
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

export async function createUserAction(
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const actor = await requireAdminSession();
  if (isFailure(actor)) {
    return actor;
  }

  const email = text(formData, 'email').toLowerCase();
  const name = text(formData, 'name');
  const role = text(formData, 'role');
  const password = String(formData.get('password') ?? '');

  // FR-906. The display name is asked for only when the role needs it, so the form
  // stays as short as it was for admins and merchants — but it is *required* here,
  // because `OrganiserProfile.displayName` is non-null and this action is the only
  // place a human is present to supply it.
  const displayName = text(formData, 'displayName');
  const phone = text(formData, 'phone');
  const commissionRaw = text(formData, 'commissionPct');

  const fieldErrors: Record<string, string> = {};
  if (!EMAIL_PATTERN.test(email)) {
    fieldErrors.email = 'Enter a valid email address.';
  }
  if (role !== 'ADMIN' && role !== 'MERCHANT' && role !== 'ORGANISER') {
    fieldErrors.role = 'Choose a role.';
  }
  if (role === 'ORGANISER') {
    if (displayName.length === 0) {
      fieldErrors.displayName = 'Enter the name their share links will show.';
    } else if (displayName.length > 80) {
      fieldErrors.displayName = 'Use 80 characters or fewer.';
    }
    if (phone.length > 32) {
      fieldErrors.phone = 'Use 32 characters or fewer.';
    }
    const commissionError = commissionRefusal(commissionRaw);
    if (commissionError) {
      fieldErrors.commissionPct = commissionError;
    }
  }
  const policyError = assertPasswordPolicy(password);
  if (policyError) {
    fieldErrors.password = policyError;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors, notice: null };
  }

  if (await emailExists(email)) {
    return { error: null, fieldErrors: { email: 'That email is already in use.' }, notice: null };
  }

  try {
    // The organiser path goes through its own service, because an organiser is a
    // `User` **plus** an `OrganiserProfile` and `createUser` writes only the first.
    // Before FR-906 this branch did not exist: the dropdown offered Organiser, the
    // account was created, and the profile it needed was created nowhere except
    // `prisma/seed.ts`.
    if (role === 'ORGANISER') {
      const organiser = await createOrganiser({
        email,
        displayName,
        phone: phone.length > 0 ? phone : null,
        commissionPct: commissionRaw.length > 0 ? Number(commissionRaw) : null,
        passwordHash: await hashPassword(password),
      });

      logger.info('organiser.created', {
        actorId: actor.userId,
        userId: organiser.userId,
        profileId: organiser.profileId,
      });
      emit('organiser_created', { actorUserId: actor.userId, organiserUserId: organiser.userId });
      revalidatePath('/admin/users');
      revalidatePath('/admin/organisers');
      return {
        error: null,
        fieldErrors: {},
        notice: `Created ${organiser.email} as an organiser. They must change the password on first sign-in.`,
      };
    }

    const user = await createUser({
      email,
      name: name.length > 0 ? name : null,
      role: role as 'ADMIN' | 'MERCHANT',
      passwordHash: await hashPassword(password),
    });

    logger.info('user.created', { actorId: actor.userId, userId: user.id, role: user.role });
    revalidatePath('/admin/users');
    return {
      error: null,
      fieldErrors: {},
      notice: `Created ${user.email}. They must change the password on first sign-in.`,
    };
  } catch {
    logger.warn('user.duplicate_email', { actorId: actor.userId });
    return { error: null, fieldErrors: { email: 'That email is already in use.' }, notice: null };
  }
}

/**
 * FR-906's repair path — give an existing profile-less organiser the profile that
 * should have been created with the account.
 *
 * A separate action rather than a "fix" inside the list, so the operator states the
 * display name deliberately: it is the name a diner will read, and defaulting it from
 * the email local-part would put `bujin1984` on a share link.
 */
export async function backfillOrganiserAction(
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const actor = await requireAdminSession();
  if (isFailure(actor)) {
    return actor;
  }

  const userId = text(formData, 'userId');
  const displayName = text(formData, 'displayName');

  const fieldErrors: Record<string, string> = {};
  if (userId.length === 0) {
    fieldErrors.userId = 'Choose an organiser.';
  }
  if (displayName.length === 0) {
    fieldErrors.displayName = 'Enter the name their share links will show.';
  } else if (displayName.length > 80) {
    fieldErrors.displayName = 'Use 80 characters or fewer.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors, notice: null };
  }

  const repaired = await backfillOrganiserProfile({ userId, displayName });
  if (!repaired) {
    // Not an error the operator caused, and not one they can fix by retrying: either
    // the account is already fine or it is not an organiser. Saying so is better than
    // a success message that changed nothing.
    return {
      error: 'That account already has an organiser profile, or is not an organiser.',
      fieldErrors: {},
      notice: null,
    };
  }

  logger.info('organiser.profile_backfilled', {
    actorId: actor.userId,
    userId,
    profileId: repaired.profileId,
  });
  revalidatePath('/admin/users');
  revalidatePath('/admin/organisers');
  return { error: null, fieldErrors: {}, notice: `Profile created for ${displayName}.` };
}

export async function createMerchantAction(
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const actor = await requireAdminSession();
  if (isFailure(actor)) {
    return actor;
  }

  const name = text(formData, 'name');
  const pickupAddress = text(formData, 'pickupAddress');
  const pickupInstructions = text(formData, 'pickupInstructions');
  const ownerEmail = text(formData, 'ownerEmail').toLowerCase();
  const ownerName = text(formData, 'ownerName');
  const password = String(formData.get('password') ?? '');

  const fieldErrors: Record<string, string> = {};
  if (name.length < 1 || name.length > 100) {
    fieldErrors.name = 'Use 1–100 characters.';
  }
  if (!EMAIL_PATTERN.test(ownerEmail)) {
    fieldErrors.ownerEmail = 'Enter a valid email address.';
  }
  const policyError = assertPasswordPolicy(password);
  if (policyError) {
    fieldErrors.password = policyError;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors, notice: null };
  }

  if (await emailExists(ownerEmail)) {
    return {
      error: null,
      fieldErrors: { ownerEmail: 'That email is already in use.' },
      notice: null,
    };
  }

  try {
    const created = await createMerchantWithOwner({
      name,
      pickupAddress: pickupAddress.length > 0 ? pickupAddress : null,
      pickupInstructions: pickupInstructions.length > 0 ? pickupInstructions : null,
      ownerEmail,
      ownerName: ownerName.length > 0 ? ownerName : null,
      ownerPasswordHash: await hashPassword(password),
    });

    logger.info('merchant.created', { actorId: actor.userId, merchantId: created.merchantId });

    // FR-101. The account and merchant exist now; the invitation is a second,
    // recoverable step. A failure here must not turn a successful creation into the
    // outer `catch`, which would report "email already in use" for a merchant that
    // was just created.
    let inviteNotice = ' Use the temporary password you set to sign in.';
    try {
      const origin = publicOrigin();
      if (!origin) {
        inviteNotice =
          ' No public address is configured, so no invitation email was sent; use the temporary password.';
      } else {
        const invite = await issuePasswordInvite(created.ownerId);
        const email = ownerInviteEmail({
          to: ownerEmail,
          ownerName: ownerName.length > 0 ? ownerName : null,
          merchantName: name,
          inviteUrl: `${origin}/set-password?token=${encodeURIComponent(invite.token)}`,
          expiresInLabel: PASSWORD_INVITE_TTL_LABEL,
        });
        // Dynamic import for the same reason the job route uses one: `resend-sender`
        // imports `server-only`, and a static import here would break every test that
        // loads this action module for an unrelated branch.
        const { resolveEmailSender } = await import('@/lib/notify/resend-sender');
        const sent = await resolveEmailSender().send([email]);
        if (sent.sentCount === 1) {
          logger.info('merchant.invite_sent', {
            merchantId: created.merchantId,
            ownerId: created.ownerId,
          });
          inviteNotice = ' An invitation email with a set-password link was sent.';
        } else {
          logger.warn('merchant.invite_failed', {
            merchantId: created.merchantId,
            reason: sent.outcomes[0]?.reason ?? 'UNKNOWN',
          });
          inviteNotice =
            ' The invitation email could not be sent; use the temporary password.';
        }
      }
    } catch (error) {
      logger.warn('merchant.invite_failed', {
        merchantId: created.merchantId,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      inviteNotice = ' The invitation email could not be sent; use the temporary password.';
    }

    revalidatePath('/admin/users');
    return {
      error: null,
      fieldErrors: {},
      notice: `Created ${name} (/${created.slug}) with owner ${ownerEmail}.${inviteNotice}`,
    };
  } catch {
    logger.warn('user.duplicate_email', { actorId: actor.userId });
    return {
      error: null,
      fieldErrors: { ownerEmail: 'That email is already in use.' },
      notice: null,
    };
  }
}

/**
 * Adds an existing MERCHANT account to a merchant.
 *
 * The role is part of the form because OWNER, MANAGER and STAFF are genuinely different
 * grants: a STAFF account can scan and redeem, a MANAGER can run the merchant surface,
 * an OWNER can do everything including changing the people. The action validates the
 * union rather than trusting the select.
 */
export async function addMerchantMemberAction(
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const actor = await requireAdminSession();
  if (isFailure(actor)) {
    return actor;
  }

  const merchantId = text(formData, 'merchantId');
  const email = text(formData, 'memberEmail').toLowerCase();
  const role = text(formData, 'role');

  const fieldErrors: Record<string, string> = {};
  if (!EMAIL_PATTERN.test(email)) {
    fieldErrors.memberEmail = 'Enter a valid email address.';
  }
  if (role !== 'OWNER' && role !== 'MANAGER' && role !== 'STAFF') {
    fieldErrors.role = 'Choose OWNER, MANAGER or STAFF.';
  }
  if (merchantId.length === 0) {
    fieldErrors.merchantId = 'That merchant no longer exists.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors, notice: null };
  }

  const result = await addMerchantMember({
    merchantId,
    email,
    role: role as 'OWNER' | 'MANAGER' | 'STAFF',
  });

  if (!result.ok) {
    if (result.reason === 'NO_MERCHANT_ACCOUNT') {
      return {
        error: null,
        fieldErrors: {
          memberEmail:
            'No MERCHANT account uses that email. Create the account on the Users page first.',
        },
        notice: null,
      };
    }
    return {
      error: null,
      fieldErrors: { memberEmail: 'That account is already attached to this merchant.' },
      notice: null,
    };
  }

  logger.info('merchant.member_added', {
    actorId: actor.userId,
    merchantId,
    userId: result.member.userId,
    role: result.member.role,
  });
  revalidatePath(`/admin/merchants/${merchantId}`);
  return {
    error: null,
    fieldErrors: {},
    notice: `Added ${result.member.email} as ${result.member.role}.`,
  };
}

export async function updateMerchantAction(
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const actor = await requireAdminSession();
  if (isFailure(actor)) {
    return actor;
  }

  const merchantId = text(formData, 'merchantId');
  const floorPercent = text(formData, 'floorPctOfMenu');
  const pickupAddress = text(formData, 'pickupAddress');
  const pickupInstructions = text(formData, 'pickupInstructions');

  const fieldErrors: Record<string, string> = {};
  const floorPct = Number(floorPercent) / 100;

  if (!Number.isFinite(floorPct) || floorPct <= 0 || floorPct > 1) {
    fieldErrors.floorPctOfMenu = 'Enter a minimum margin between 1% and 100%.';
  }
  if (pickupAddress.length > 300) {
    fieldErrors.pickupAddress = 'Use 300 characters or fewer.';
  }
  if (pickupInstructions.length > 300) {
    fieldErrors.pickupInstructions = 'Use 300 characters or fewer.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors, notice: null };
  }

  try {
    const before = await getMerchant(merchantId);
    if (!before) {
      return { error: 'That merchant no longer exists.', fieldErrors: {}, notice: null };
    }

    const updatedFloor = await updateFloor(merchantId, floorPct);
    await updatePickup({
      merchantId,
      pickupAddress: pickupAddress.length > 0 ? pickupAddress : null,
      pickupInstructions: pickupInstructions.length > 0 ? pickupInstructions : null,
    });

    if (updatedFloor !== before.floorPctOfMenu) {
      logger.info('floor.changed', {
        actorId: actor.userId,
        merchantId,
        fromPct: before.floorPctOfMenu,
        toPct: updatedFloor,
      });
      emit('floor_changed', {
        merchantId,
        actorUserId: actor.userId,
        fromPct: before.floorPctOfMenu,
        toPct: updatedFloor,
      });
    }

    revalidatePath(`/admin/merchants/${merchantId}`);
    revalidatePath('/admin/users');
    return { error: null, fieldErrors: {}, notice: 'Saved.' };
  } catch {
    return { error: 'That could not be saved. Try again.', fieldErrors: {}, notice: null };
  }
}
