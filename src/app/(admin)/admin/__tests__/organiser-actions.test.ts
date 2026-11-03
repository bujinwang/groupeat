import 'dotenv/config';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FR-906 — the admin action that creates accounts, driven for real.
 *
 * ## Why this test exists at all
 *
 * The defect was not in a service, it was in a **branch**. `/admin/users` offered
 * `Organiser` in the dropdown and `createUserAction` handled it by calling
 * `createUser` — the same function it calls for `ADMIN` and `MERCHANT`. So the
 * behaviour was correct for the role it was written for and silently wrong for the
 * third option, and no unit test of `createUser` or of `createOrganiser` can see that.
 *
 * These tests therefore call the action itself, with a real `FormData`, against real
 * Postgres, and assert on **both** rows: the account and the profile. Asserting only
 * that the account was created is precisely the mistake the page made.
 *
 * `getSession` and `revalidatePath` are mocked because neither is what is under test —
 * one is an authorisation check proven elsewhere, the other is a cache hint.
 *
 * `server-only` is neutralised for this file, following the other admin route tests.
 * The action module reaches it through `@/lib/auth/session`, which is correct in
 * production and throws on a plain import outside a React server graph. The boundary
 * being tested here is the action's own `requireAdminSession`, which is real and is
 * exercised by the "not an admin" case.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const SESSION = { userId: '', role: 'ADMIN' as const, mustChangePassword: false };

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(async () => (SESSION.userId ? SESSION : null)),
}));

const { createUserAction, backfillOrganiserAction } = await import('@/app/(admin)/admin/actions');
const { prisma } = await import('@/lib/db/prisma');

const PREFIX = `act${Date.now()}`;
const INITIAL = { error: null, fieldErrors: {}, notice: null };
// Satisfies `assertPasswordPolicy`: 12+ characters with a letter and a digit. The
// first version of this fixture had no digit and every creation test failed on it —
// the policy doing its job, and a reminder that the action validates before it writes.
const PASSWORD = 'correct-horse-battery-9';

let adminId = '';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

function uniqueEmail(tag: string): string {
  return `${PREFIX}-${tag}@example.test`;
}

beforeAll(async () => {
  const admin = await prisma.user.create({
    data: {
      email: uniqueEmail('admin'),
      role: 'ADMIN',
      passwordHash: 'not-a-real-hash',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  adminId = admin.id;
});

beforeEach(() => {
  SESSION.userId = adminId;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('createUserAction, the organiser branch', () => {
  it('creates the OrganiserProfile that used to be missing', async () => {
    const email = uniqueEmail('organiser');

    const state = await createUserAction(
      INITIAL,
      form({
        email,
        role: 'ORGANISER',
        displayName: 'Dana Okafor',
        phone: '+17805551212',
        commissionPct: '6.5',
        password: PASSWORD,
      }),
    );

    expect(state.error).toBeNull();
    expect(state.notice).toMatch(/organiser/i);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: {
        role: true,
        mustChangePassword: true,
        organiser: { select: { displayName: true, phone: true, commissionPct: true } },
      },
    });

    expect(user.role).toBe('ORGANISER');
    expect(user.mustChangePassword).toBe(true);
    // The two assertions that would have failed before this slice. The account existed
    // and looked created; `organiser` was null for every organiser made this way.
    expect(user.organiser).not.toBeNull();
    expect(user.organiser?.displayName).toBe('Dana Okafor');
    expect(user.organiser?.phone).toBe('+17805551212');
    expect(Number(user.organiser?.commissionPct)).toBe(6.5);

    // And the password was actually hashed, not stored — the account is signable-in.
    const stored = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { passwordHash: true },
    });
    expect(stored.passwordHash).not.toBe(PASSWORD);
  });

  it('refuses an organiser with no display name, and creates nothing', async () => {
    const email = uniqueEmail('no-name');

    const state = await createUserAction(
      INITIAL,
      form({ email, role: 'ORGANISER', displayName: '   ', password: PASSWORD }),
    );

    expect(state.error).toBeNull();
    // The sentence names the consequence, which is why the server checks rather than
    // relying on the conditional input being rendered.
    expect(state.fieldErrors.displayName).toMatch(/share links/i);

    // Nothing written — not a User, and therefore not an orphan.
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('refuses a commission that is not a number, before creating anything', async () => {
    const email = uniqueEmail('bad-commission');

    const state = await createUserAction(
      INITIAL,
      form({
        email,
        role: 'ORGANISER',
        displayName: 'Bad Commission',
        commissionPct: 'lots',
        password: PASSWORD,
      }),
    );

    expect(state.fieldErrors.commissionPct).toBeTruthy();
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('defaults the commission to the schema value when the field is left blank', async () => {
    const email = uniqueEmail('blank-commission');

    const state = await createUserAction(
      INITIAL,
      form({ email, role: 'ORGANISER', displayName: 'Blank Commission', password: PASSWORD }),
    );

    expect(state.fieldErrors).toEqual({});

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { organiser: { select: { commissionPct: true } } },
    });
    expect(Number(user.organiser?.commissionPct)).toBe(5);
  });

  it('still creates a MERCHANT account without a profile', async () => {
    // The branch must not have swallowed the other roles. A merchant is a `User` and a
    // `MerchantUser`, and giving one an `OrganiserProfile` would make two role systems
    // disagree about what the account is.
    const email = uniqueEmail('merchant');

    const state = await createUserAction(
      INITIAL,
      form({ email, role: 'MERCHANT', name: 'A Merchant', password: PASSWORD }),
    );

    expect(state.notice).toMatch(/Created/i);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { role: true, name: true, organiser: { select: { id: true } } },
    });
    expect(user.role).toBe('MERCHANT');
    expect(user.name).toBe('A Merchant');
    expect(user.organiser).toBeNull();
  });

  it('rejects a duplicate email without creating a second profile', async () => {
    const email = uniqueEmail('dupe');
    await createUserAction(
      INITIAL,
      form({ email, role: 'ORGANISER', displayName: 'First', password: PASSWORD }),
    );

    const second = await createUserAction(
      INITIAL,
      form({ email, role: 'ORGANISER', displayName: 'Second', password: PASSWORD }),
    );

    expect(second.fieldErrors.email).toMatch(/already in use/i);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(
      await prisma.organiserProfile.count({ where: { user: { email } } }),
    ).toBe(1);
  });

  it('refuses when the caller is not an admin', async () => {
    // A server action is a public endpoint; middleware is not an authorisation gate.
    SESSION.userId = '';
    const email = uniqueEmail('unauthorised');

    const state = await createUserAction(
      INITIAL,
      form({ email, role: 'ORGANISER', displayName: 'Nope', password: PASSWORD }),
    );

    expect(state.error).toMatch(/do not have access/i);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });
});

describe('backfillOrganiserAction', () => {
  it('repairs a profile-less organiser created by some other path', async () => {
    const email = uniqueEmail('legacy');
    const legacy = await prisma.user.create({
      data: {
        email,
        role: 'ORGANISER',
        passwordHash: 'not-a-real-hash',
        mustChangePassword: true,
      },
      select: { id: true },
    });

    const state = await backfillOrganiserAction(
      INITIAL,
      form({ userId: legacy.id, displayName: 'Legacy Organiser' }),
    );

    expect(state.error).toBeNull();
    expect(state.notice).toMatch(/Legacy Organiser/);

    const profile = await prisma.organiserProfile.findUniqueOrThrow({
      where: { userId: legacy.id },
      select: { displayName: true },
    });
    expect(profile.displayName).toBe('Legacy Organiser');
  });

  it('says so when there is nothing to repair, instead of reporting success', async () => {
    // A "repair" that succeeds on a healthy account hides the fact that whatever
    // flagged it was wrong.
    const email = uniqueEmail('healthy');
    const healthy = await prisma.user.create({
      data: {
        email,
        role: 'ORGANISER',
        passwordHash: 'not-a-real-hash',
        organiser: { create: { displayName: 'Already Fine' } },
      },
      select: { id: true },
    });

    const state = await backfillOrganiserAction(
      INITIAL,
      form({ userId: healthy.id, displayName: 'Different Name' }),
    );

    expect(state.error).toMatch(/already has an organiser profile/i);

    const profile = await prisma.organiserProfile.findUniqueOrThrow({
      where: { userId: healthy.id },
      select: { displayName: true },
    });
    expect(profile.displayName).toBe('Already Fine');
  });

  it('refuses a MERCHANT account', async () => {
    const email = uniqueEmail('merchant-not-organiser');
    const merchant = await prisma.user.create({
      data: { email, role: 'MERCHANT', passwordHash: 'not-a-real-hash' },
      select: { id: true },
    });

    const state = await backfillOrganiserAction(
      INITIAL,
      form({ userId: merchant.id, displayName: 'Wrong Role' }),
    );

    expect(state.error).toMatch(/not an organiser/i);
    expect(await prisma.organiserProfile.count({ where: { userId: merchant.id } })).toBe(0);
  });
});
