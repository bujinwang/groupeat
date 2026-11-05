import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FR-101's admin path, with the provider and the database replaced.
 *
 * The action has three outcomes that matter and only one of them is success:
 *
 *   - an origin and a working sender → the owner gets a link;
 *   - no origin → the merchant is still created, and the notice says to use the
 *     temporary password;
 *   - a provider refusal → same, plus a `merchant.invite_failed` log line.
 *
 * The first version of this code put the whole invitation inside the same `try` as
 * `createMerchantWithOwner`, whose `catch` reports "email already in use". A mail
 * failure would therefore have told the operator the merchant already existed, after
 * creating it. These tests fail on that shape.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const originState = vi.hoisted(() => ({ origin: 'https://groupeat.example' as string | undefined }));

vi.mock('@/lib/notify/public-origin', () => ({
  publicOrigin: () => originState.origin,
}));

const sent = vi.hoisted(() => [] as { kind: string; to: string; subject: string; text: string }[]);
const sendState = vi.hoisted(() => ({ fail: false }));

vi.mock('@/lib/notify/resend-sender', () => ({
  resolveEmailSender: () => ({
    name: 'test',
    async send(messages: { kind: string; to: string; subject: string; text: string }[]) {
      if (sendState.fail) {
        return {
          outcomes: messages.map((message) => ({
            kind: message.kind,
            to: message.to,
            sent: false,
            reason: 'PROVIDER_ERROR',
          })),
          sentCount: 0,
          failedCount: messages.length,
        };
      }
      sent.push(...messages);
      return {
        outcomes: messages.map((message) => ({ kind: message.kind, to: message.to, sent: true })),
        sentCount: messages.length,
        failedCount: 0,
      };
    },
  }),
}));

vi.mock('@/lib/auth/password', () => ({
  assertPasswordPolicy: () => null,
  hashPassword: async () => 'hashed',
}));

const issueMock = vi.hoisted(() =>
  vi.fn(async () => ({ token: 'invite-token-abc', expiresAt: new Date(Date.now() + 72 * 3600_000) })),
);

vi.mock('@/lib/auth/password-invite', () => ({
  issuePasswordInvite: issueMock,
  PASSWORD_INVITE_TTL_LABEL: '72 hours',
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ userId: 'admin-1', role: 'ADMIN', mustChangePassword: false }),
}));

const createMerchantMock = vi.hoisted(() =>
  vi.fn(async () => ({ merchantId: 'merchant-1', ownerId: 'owner-1', slug: 'copper-kettle' })),
);

vi.mock('@/lib/db/merchants', () => ({
  createMerchantWithOwner: createMerchantMock,
  getMerchant: vi.fn(),
  updateFloor: vi.fn(),
  updatePickup: vi.fn(),
}));

vi.mock('@/lib/db/users', () => ({
  createUser: vi.fn(),
  emailExists: async () => false,
}));

vi.mock('@/lib/db/organisers', () => ({
  backfillOrganiserProfile: vi.fn(),
  commissionRefusal: () => null,
  createOrganiser: vi.fn(),
}));

vi.mock('@/lib/analytics/events', () => ({ emit: vi.fn() }));
vi.mock('@/lib/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

const { createMerchantAction } = await import('@/app/(admin)/admin/actions');

function form(): FormData {
  const data = new FormData();
  data.set('name', 'Copper Kettle');
  data.set('ownerEmail', 'owner@example.test');
  data.set('ownerName', 'Sam Okafor');
  data.set('password', 'temporary-password-9');
  return data;
}

const INITIAL = { error: null, fieldErrors: {}, notice: null };

beforeEach(() => {
  originState.origin = 'https://groupeat.example';
  sent.length = 0;
  sendState.fail = false;
  createMerchantMock.mockClear();
  issueMock.mockClear();
});

describe('createMerchantAction — FR-101', () => {
  it('creates the merchant and emails a one-time set-password link', async () => {
    const state = await createMerchantAction(INITIAL, form());

    expect(createMerchantMock).toHaveBeenCalledTimes(1);
    expect(issueMock).toHaveBeenCalledWith('owner-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('owner_invite');
    expect(sent[0]?.to).toBe('owner@example.test');
    expect(sent[0]?.text).toContain(
      'https://groupeat.example/set-password?token=invite-token-abc',
    );
    expect(state.notice).toContain('An invitation email with a set-password link was sent.');
  });

  it('still creates the merchant when the provider refuses, and says to use the password', async () => {
    sendState.fail = true;

    const state = await createMerchantAction(INITIAL, form());

    expect(createMerchantMock).toHaveBeenCalledTimes(1);
    expect(issueMock).toHaveBeenCalledTimes(1);
    expect(state.notice).toContain('could not be sent');
    expect(state.notice).toContain('use the temporary password');
    // The failure is not reported as a duplicate email.
    expect(state.fieldErrors.ownerEmail).toBeUndefined();
  });

  it('still creates the merchant when no public origin is configured', async () => {
    originState.origin = undefined;

    const state = await createMerchantAction(INITIAL, form());

    expect(createMerchantMock).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(issueMock).not.toHaveBeenCalled();
    expect(state.notice).toContain('No public address is configured');
    expect(state.notice).toContain('use the temporary password');
  });
});
