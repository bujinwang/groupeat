'use server';

import { revalidatePath } from 'next/cache';

import { emit } from '@/lib/analytics/events';
import { assertPasswordPolicy, hashPassword } from '@/lib/auth/password';
import { getSession } from '@/lib/auth/session';
import { createMerchantWithOwner, getMerchant, updateFloor, updatePickup } from '@/lib/db/merchants';
import { createUser, emailExists } from '@/lib/db/users';
import { logger } from '@/lib/logging/logger';

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

  const fieldErrors: Record<string, string> = {};
  if (!EMAIL_PATTERN.test(email)) {
    fieldErrors.email = 'Enter a valid email address.';
  }
  if (role !== 'ADMIN' && role !== 'MERCHANT' && role !== 'ORGANISER') {
    fieldErrors.role = 'Choose a role.';
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
    const user = await createUser({
      email,
      name: name.length > 0 ? name : null,
      role: role as 'ADMIN' | 'MERCHANT' | 'ORGANISER',
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
    revalidatePath('/admin/users');
    return {
      error: null,
      fieldErrors: {},
      notice: `Created ${name} (/${created.slug}) with owner ${ownerEmail}.`,
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
