import 'dotenv/config';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The digest consent action, against real Postgres.
 *
 * ## Why this is not a page test
 *
 * A render proves the box appears for an owner and not for a manager. It cannot prove
 * that posting the form as a manager is refused, because the form is not there to post.
 * A server action is a public endpoint: its authorisation is a claim about what happens
 * when somebody hand-builds the request, and that is what this file exercises.
 *
 * `next/cache` is mocked because a test does not have a router cache to revalidate;
 * `server-only` because it is a build marker; `getSession` because the session is the
 * seam every authorisation test in this repo replaces. The Prisma calls, the role
 * check and the update are real.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sessionState: {
  session: { userId: string; role: string; mustChangePassword: boolean } | null;
} = { session: null };

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { setDigestConsentAction } = await import(
  '@/app/(merchant)/merchant/settings/actions'
);

const PREFIX = `digact${Date.now().toString(36).slice(-5)}`;
let merchantId = '';
let ownerId = '';
let managerId = '';
const createdUserIds: string[] = [];

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: { name: `${PREFIX} café`, slug: `${PREFIX}-cafe`, status: 'ACTIVE' },
    select: { id: true },
  });
  merchantId = merchant.id;

  for (const [tag, role] of [
    ['owner', 'OWNER'],
    ['manager', 'MANAGER'],
  ] as const) {
    const user = await prisma.user.create({
      data: {
        email: `${PREFIX}-${tag}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    await prisma.merchantUser.create({
      data: { merchantId, userId: user.id, role },
    });
    if (role === 'OWNER') ownerId = user.id;
    if (role === 'MANAGER') managerId = user.id;
  }
});

beforeEach(() => {
  sessionState.session = { userId: ownerId, role: 'MERCHANT', mustChangePassword: false };
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

function form(optIn: boolean): FormData {
  const data = new FormData();
  if (optIn) {
    data.set('digestOptIn', 'on');
  }
  return data;
}

async function storedOptIn(userId: string): Promise<boolean | null> {
  const membership = await prisma.merchantUser.findUnique({
    where: { merchantId_userId: { merchantId, userId } },
    select: { digestOptIn: true },
  });
  return membership?.digestOptIn ?? null;
}

describe('setDigestConsentAction', () => {
  it('turns consent on for an owner and says so', async () => {
    const state = await setDigestConsentAction(
      { error: null, notice: null, optIn: null },
      form(true),
    );

    expect(state).toEqual({
      error: null,
      notice: 'You will get the weekly digest on Monday mornings.',
      optIn: true,
    });
    expect(await storedOptIn(ownerId)).toBe(true);
  });

  it('turns it off when the checkbox is absent, because an unchecked box is absent', async () => {
    // The dangerous default is treating a missing field as consent. Explicit `=== 'on'`
    // is what makes this false; a truthiness check on `FormData.get()` would also be
    // false here, but the test names the shape the browser actually sends.
    const state = await setDigestConsentAction(
      { error: null, notice: null, optIn: true },
      form(false),
    );

    expect(state.optIn).toBe(false);
    expect(state.notice).toBe(
      'The weekly digest is off. You can turn it back on any time.',
    );
    expect(await storedOptIn(ownerId)).toBe(false);
  });

  it('refuses a manager even though the same form posts the same field', async () => {
    sessionState.session = { userId: managerId, role: 'MERCHANT', mustChangePassword: false };

    const state = await setDigestConsentAction(
      { error: null, notice: null, optIn: false },
      form(true),
    );

    expect(state.error).toBe('Only an owner can change the digest setting.');
    expect(state.optIn).toBeNull();
    expect(await storedOptIn(managerId)).toBe(false);
  });

  it('does not write for a user with no session', async () => {
    sessionState.session = null;

    const state = await setDigestConsentAction(
      { error: null, notice: null, optIn: false },
      form(true),
    );

    expect(state.error).toBe('That could not be saved. Reload the page and try again.');
    expect(await storedOptIn(ownerId)).toBe(false);
  });
});
