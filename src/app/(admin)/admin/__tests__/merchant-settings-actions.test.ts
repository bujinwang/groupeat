import 'dotenv/config';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two admin actions that write to an existing merchant — driven for real.
 *
 * ## Why this file exists
 *
 * V8 coverage said both functions had executed **zero** times: `updateMerchantAction`
 * and `addMerchantMemberAction` were the only two exported actions in the module with
 * `hits=0`, and `updatePickup` (which only `updateMerchantAction` calls) had `hits=0`
 * too. The action module is the admin write surface for a merchant, so the untested
 * half was exactly the half that can change a number the guardrail depends on.
 *
 * ## The thing that is easy to get wrong
 *
 * `updateMerchantAction` writes two different things through two different functions,
 * and only one of them is governed:
 *
 *   - `updateFloor` takes a **percentage of the menu price** as a fraction in
 *     `(0, 1]`, and the form supplies it as a whole number (`25` → `0.25`).
 *   - `updatePickup` takes the two address fields, and an **empty form field means
 *     "clear this column"** (`null`), not "leave it alone". That is the opposite of
 *     `updateOwnPickup`, where an absent field is left untouched.
 *
 * A test that only asserts "notice === 'Saved.'" would pass while the floor was
 * divided by 100 twice, or while clearing an address silently did nothing. So every
 * case here re-reads the row.
 *
 * `floor_changed` is asserted through the **analytics file**, not through a mock: the
 * event is the record a human reads to answer "who moved this merchant's floor", and a
 * mocked `emit` would prove only that a function was called with some arguments.
 *
 * `getSession` and `revalidatePath` are mocked — the first is an authorisation check
 * proven in `organiser-actions.test.ts`, the second is a cache hint.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const SESSION = { userId: '', role: 'ADMIN' as const, mustChangePassword: false };

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(async () => (SESSION.userId ? SESSION : null)),
}));

const { updateMerchantAction, addMerchantMemberAction } = await import(
  '@/app/(admin)/admin/actions'
);
const { prisma } = await import('@/lib/db/prisma');
const { DEFAULT_FLOOR_PCT } = await import('@/lib/guardrail');

const PREFIX = `mset${Date.now()}`;
const INITIAL = { error: null, fieldErrors: {}, notice: null };

let adminId = '';
let merchantId = '';
let analyticsDir = '';
let analyticsPath = '';
let previousAnalyticsPath: string | undefined;

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

/** Every `floor_changed` line written during this file, newest last. */
function floorChangedEvents(): { event: string; fromPct?: number; toPct?: number }[] {
  let raw: string;
  try {
    raw = readFileSync(analyticsPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { event: string })
    .filter((record) => record.event === 'floor_changed') as {
    event: string;
    fromPct?: number;
    toPct?: number;
  }[];
}

async function readMerchant(id: string) {
  return prisma.merchant.findUniqueOrThrow({
    where: { id },
    select: {
      floorPctOfMenu: true,
      pickupAddress: true,
      pickupInstructions: true,
      status: true,
    },
  });
}

beforeAll(async () => {
  analyticsDir = mkdtempSync(join(tmpdir(), 'groupeat-admin-settings-'));
  analyticsPath = join(analyticsDir, 'events.jsonl');
  previousAnalyticsPath = process.env.ANALYTICS_LOG_PATH;
  process.env.ANALYTICS_LOG_PATH = analyticsPath;

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

  const merchant = await prisma.merchant.create({
    data: {
      name: 'Settings Subject',
      slug: `${PREFIX}-subject`,
      status: 'ACTIVE',
      floorPctOfMenu: DEFAULT_FLOOR_PCT,
    },
    select: { id: true },
  });
  merchantId = merchant.id;
});

beforeEach(async () => {
  SESSION.userId = adminId;
  // Each case starts from a known row: the previous case's write must not be able to
  // make the next one pass.
  await prisma.merchant.update({
    where: { id: merchantId },
    data: {
      floorPctOfMenu: DEFAULT_FLOOR_PCT,
      pickupAddress: '12 Example Ave',
      pickupInstructions: 'Ring the bell',
      status: 'ACTIVE',
    },
  });
  // Truncate the analytics file so `floorChangedEvents()` counts only this case.
  rmSync(analyticsPath, { force: true });
});

afterAll(async () => {
  if (previousAnalyticsPath === undefined) {
    delete process.env.ANALYTICS_LOG_PATH;
  } else {
    process.env.ANALYTICS_LOG_PATH = previousAnalyticsPath;
  }
  rmSync(analyticsDir, { recursive: true, force: true });

  await prisma.merchantUser
    .deleteMany({ where: { merchantId } })
    .catch(() => undefined);
  await prisma.merchant
    .deleteMany({ where: { id: merchantId } })
    .catch(() => undefined);
  await prisma.user
    .deleteMany({ where: { email: { startsWith: PREFIX } } })
    .catch(() => undefined);
  await prisma.$disconnect();
});

describe('updateMerchantAction — the floor', () => {
  it('converts the form percentage into a fraction exactly once', async () => {
    const state = await updateMerchantAction(
      INITIAL,
      form({
        merchantId,
        floorPctOfMenu: '32',
        pickupAddress: '12 Example Ave',
        pickupInstructions: 'Ring the bell',
      }),
    );

    expect(state.error).toBeNull();
    expect(state.notice).toBe('Saved.');

    const row = await readMerchant(merchantId);
    // 32% → 0.32. A double division would land on 0.0032; no division on 32, which
    // `toPct` would then refuse on read.
    expect(Number(row.floorPctOfMenu)).toBeCloseTo(0.32, 10);
  });

  it('emits floor_changed with the previous and the new floor when the floor moves', async () => {
    await updateMerchantAction(
      INITIAL,
      form({ merchantId, floorPctOfMenu: '40' }),
    );

    const events = floorChangedEvents();
    expect(events).toHaveLength(1);
    // `from` is what the row held (0.25), not what the form said.
    expect(events[0]?.fromPct).toBeCloseTo(DEFAULT_FLOOR_PCT, 10);
    expect(events[0]?.toPct).toBeCloseTo(0.4, 10);
  });

  it('does not emit floor_changed when the floor is saved unchanged', async () => {
    // Saving the same value is a no-op for the guardrail, and an event here would
    // make "how often do floors move" count every time an operator pressed Save.
    await updateMerchantAction(
      INITIAL,
      form({ merchantId, floorPctOfMenu: '25' }),
    );

    expect(floorChangedEvents()).toHaveLength(0);
    expect(Number((await readMerchant(merchantId)).floorPctOfMenu)).toBeCloseTo(
      DEFAULT_FLOOR_PCT,
      10,
    );
  });

  it('refuses a floor of zero and writes neither column', async () => {
    // A zero floor would make every dish viable — the guardrail would stop guarding.
    const state = await updateMerchantAction(
      INITIAL,
      form({
        merchantId,
        floorPctOfMenu: '0',
        pickupAddress: 'Changed address',
        pickupInstructions: 'Changed instructions',
      }),
    );

    expect(state.error).toBeNull();
    expect(state.fieldErrors.floorPctOfMenu).toMatch(/between 1% and 100%/i);

    const row = await readMerchant(merchantId);
    // The pickup write is in the same `try` as the floor write, so a rejected floor
    // must reject the whole save rather than half-apply it.
    expect(row.pickupAddress).toBe('12 Example Ave');
    expect(row.pickupInstructions).toBe('Ring the bell');
  });

  it('accepts a floor of exactly 100% — the range is (0, 1], not (0, 1)', async () => {
    // The inclusive end matters: 100% is "cost recovery with no margin", which is a
    // ridiculous setting but a legal one, and the guardrail's own contract says
    // `toPct` accepts `1`. A `>= 1` rejection here would disagree with the module
    // that consumes the number.
    const state = await updateMerchantAction(
      INITIAL,
      form({ merchantId, floorPctOfMenu: '100' }),
    );

    expect(state.fieldErrors).toEqual({});
    expect(Number((await readMerchant(merchantId)).floorPctOfMenu)).toBeCloseTo(1, 10);
  });

  it('refuses a floor above 100%', async () => {
    const state = await updateMerchantAction(
      INITIAL,
      form({ merchantId, floorPctOfMenu: '101' }),
    );

    expect(state.fieldErrors.floorPctOfMenu).toBeTruthy();
    expect(Number((await readMerchant(merchantId)).floorPctOfMenu)).toBeCloseTo(
      DEFAULT_FLOOR_PCT,
      10,
    );
  });

  it('refuses a non-numeric floor rather than writing NaN', async () => {
    const state = await updateMerchantAction(
      INITIAL,
      form({ merchantId, floorPctOfMenu: 'twenty-five' }),
    );

    expect(state.fieldErrors.floorPctOfMenu).toBeTruthy();
    expect(Number((await readMerchant(merchantId)).floorPctOfMenu)).toBeCloseTo(
      DEFAULT_FLOOR_PCT,
      10,
    );
  });
});

describe('updateMerchantAction — the pickup fields', () => {
  it('writes both fields when both are supplied', async () => {
    await updateMerchantAction(
      INITIAL,
      form({
        merchantId,
        floorPctOfMenu: '25',
        pickupAddress: '99 New Road',
        pickupInstructions: 'Use the side door',
      }),
    );

    const row = await readMerchant(merchantId);
    expect(row.pickupAddress).toBe('99 New Road');
    expect(row.pickupInstructions).toBe('Use the side door');
  });

  it('clears a field that was submitted empty, rather than leaving it', async () => {
    // This is the difference from `updateOwnPickup`. The admin form always submits
    // both inputs, so an empty string means the operator emptied the box.
    await updateMerchantAction(
      INITIAL,
      form({
        merchantId,
        floorPctOfMenu: '25',
        pickupAddress: '',
        pickupInstructions: 'Use the side door',
      }),
    );

    const row = await readMerchant(merchantId);
    expect(row.pickupAddress).toBeNull();
    expect(row.pickupInstructions).toBe('Use the side door');
  });

  it('trims whitespace that is only whitespace down to a clear', async () => {
    await updateMerchantAction(
      INITIAL,
      form({
        merchantId,
        floorPctOfMenu: '25',
        pickupAddress: '    ',
        pickupInstructions: '   ',
      }),
    );

    const row = await readMerchant(merchantId);
    expect(row.pickupAddress).toBeNull();
    expect(row.pickupInstructions).toBeNull();
  });

  it('accepts an address of exactly 300 characters', async () => {
    // The limit is "300 or fewer", so 300 must pass. Without this case a `>= 300`
    // rejection passes every other test in this file.
    const exactly300 = 'z'.repeat(300);

    const state = await updateMerchantAction(
      INITIAL,
      form({ merchantId, floorPctOfMenu: '25', pickupAddress: exactly300 }),
    );

    expect(state.fieldErrors).toEqual({});
    expect((await readMerchant(merchantId)).pickupAddress).toBe(exactly300);
  });

  it('refuses an address over 300 characters and writes nothing', async () => {
    const state = await updateMerchantAction(
      INITIAL,
      form({
        merchantId,
        floorPctOfMenu: '35',
        pickupAddress: 'x'.repeat(301),
      }),
    );

    expect(state.fieldErrors.pickupAddress).toMatch(/300 characters or fewer/i);

    const row = await readMerchant(merchantId);
    expect(row.pickupAddress).toBe('12 Example Ave');
    expect(Number(row.floorPctOfMenu)).toBeCloseTo(DEFAULT_FLOOR_PCT, 10);
  });

  it('refuses instructions over 300 characters', async () => {
    const state = await updateMerchantAction(
      INITIAL,
      form({
        merchantId,
        floorPctOfMenu: '25',
        pickupInstructions: 'y'.repeat(301),
      }),
    );

    expect(state.fieldErrors.pickupInstructions).toMatch(/300 characters or fewer/i);
    expect((await readMerchant(merchantId)).pickupInstructions).toBe('Ring the bell');
  });

  it('does not change the merchant status — a settings edit is not an activation', async () => {
    await updateMerchantAction(
      INITIAL,
      form({ merchantId, floorPctOfMenu: '25', pickupAddress: '1 Anywhere' }),
    );

    expect((await readMerchant(merchantId)).status).toBe('ACTIVE');
  });
});

describe('updateMerchantAction — refusal paths', () => {
  it('reports a merchant that no longer exists rather than throwing', async () => {
    const state = await updateMerchantAction(
      INITIAL,
      form({
        merchantId: '00000000-0000-0000-0000-000000000000',
        floorPctOfMenu: '25',
      }),
    );

    expect(state.error).toMatch(/no longer exists/i);
    expect(state.notice).toBeNull();
  });

  it('refuses when the caller is not an admin', async () => {
    SESSION.userId = '';

    const state = await updateMerchantAction(
      INITIAL,
      form({ merchantId, floorPctOfMenu: '80' }),
    );

    expect(state.error).toMatch(/do not have access/i);
    // Not just refused: the floor is untouched.
    expect(Number((await readMerchant(merchantId)).floorPctOfMenu)).toBeCloseTo(
      DEFAULT_FLOOR_PCT,
      10,
    );
  });
});

describe('addMerchantMemberAction', () => {
  async function makeMerchantAccount(tag: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: uniqueEmail(tag),
        role: 'MERCHANT',
        passwordHash: 'not-a-real-hash',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    return user.id;
  }

  it('attaches an existing MERCHANT account and names it in the notice', async () => {
    const email = uniqueEmail('staff');
    await makeMerchantAccount('staff');

    const state = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId, memberEmail: email, role: 'STAFF' }),
    );

    expect(state.error).toBeNull();
    expect(state.fieldErrors).toEqual({});
    expect(state.notice).toContain(email);

    const member = await prisma.merchantUser.findFirstOrThrow({
      where: { merchantId, user: { email } },
      select: { role: true },
    });
    expect(member.role).toBe('STAFF');
  });

  it('finds the account through surrounding space and mixed case', async () => {
    // End-to-end behaviour, not the action's own `.toLowerCase()`.
    //
    // Measured: deleting `.toLowerCase()` from the action does **not** fail this
    // test, and cannot — the action's normalised email is used only for
    // `EMAIL_PATTERN.test` (case-insensitive for this pattern) and as the argument to
    // `addMerchantMember`, which calls `normalizeEmail()` again. `text()` supplies the
    // trim. So the extra lowercase is a redundant belt, not a load-bearing line, and
    // a survivor there is an equivalent mutant rather than a missing test.
    //
    // What this case *does* pin is the thing an operator would notice: typing the
    // address in caps with a stray space still attaches the right account.
    const email = uniqueEmail('cased');
    await makeMerchantAccount('cased');

    const state = await addMerchantMemberAction(
      INITIAL,
      form({
        merchantId,
        memberEmail: `  ${email.toUpperCase()}  `,
        role: 'MANAGER',
      }),
    );

    expect(state.notice).toContain(email);
    expect(
      await prisma.merchantUser.count({ where: { merchantId, user: { email } } }),
    ).toBe(1);
  });

  it('refuses an email that belongs to no MERCHANT account, and says where to make one', async () => {
    // A person with an ADMIN or ORGANISER account must not become a merchant member:
    // that would widen a session into a surface it was never granted.
    const state = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId, memberEmail: uniqueEmail('nobody'), role: 'STAFF' }),
    );

    expect(state.error).toBeNull();
    expect(state.fieldErrors.memberEmail).toMatch(/create the account on the users page/i);
    expect(
      await prisma.merchantUser.count({ where: { user: { email: uniqueEmail('nobody') } } }),
    ).toBe(0);
  });

  it('refuses an admin account, not merely an unknown address', async () => {
    const email = uniqueEmail('admin-as-member');
    await prisma.user.create({
      data: {
        email,
        role: 'ADMIN',
        passwordHash: 'not-a-real-hash',
        mustChangePassword: false,
      },
    });

    const state = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId, memberEmail: email, role: 'OWNER' }),
    );

    expect(state.fieldErrors.memberEmail).toMatch(/no merchant account/i);
    expect(
      await prisma.merchantUser.count({ where: { merchantId, user: { email } } }),
    ).toBe(0);
  });

  it('refuses a second attachment of the same account to the same merchant', async () => {
    const email = uniqueEmail('twice');
    await makeMerchantAccount('twice');

    const first = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId, memberEmail: email, role: 'STAFF' }),
    );
    expect(first.notice).toContain(email);

    const second = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId, memberEmail: email, role: 'MANAGER' }),
    );

    expect(second.fieldErrors.memberEmail).toMatch(/already attached/i);
    // Still one row, and still STAFF: the refused second attempt did not overwrite.
    const rows = await prisma.merchantUser.findMany({
      where: { merchantId, user: { email } },
      select: { role: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('STAFF');
  });

  it('refuses a malformed email before touching the database', async () => {
    const state = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId, memberEmail: 'not-an-email', role: 'STAFF' }),
    );

    expect(state.fieldErrors.memberEmail).toMatch(/valid email/i);
  });

  it('refuses a role outside OWNER / MANAGER / STAFF', async () => {
    const email = uniqueEmail('bad-role');
    await makeMerchantAccount('bad-role');

    const state = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId, memberEmail: email, role: 'SUPERUSER' }),
    );

    expect(state.fieldErrors.role).toMatch(/OWNER, MANAGER or STAFF/);
    expect(
      await prisma.merchantUser.count({ where: { merchantId, user: { email } } }),
    ).toBe(0);
  });

  it('refuses an empty merchant id', async () => {
    const state = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId: '', memberEmail: uniqueEmail('no-merchant'), role: 'STAFF' }),
    );

    expect(state.fieldErrors.merchantId).toMatch(/no longer exists/i);
  });

  it('refuses when the caller is not an admin', async () => {
    const email = uniqueEmail('unauthorised');
    await makeMerchantAccount('unauthorised');
    SESSION.userId = '';

    const state = await addMerchantMemberAction(
      INITIAL,
      form({ merchantId, memberEmail: email, role: 'STAFF' }),
    );

    expect(state.error).toMatch(/do not have access/i);
    expect(
      await prisma.merchantUser.count({ where: { merchantId, user: { email } } }),
    ).toBe(0);
  });
});
