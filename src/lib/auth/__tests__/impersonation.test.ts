import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { isAppError } from '@/lib/errors';
import { IMPERSONATION_MAX_MINUTES, isImpersonating, verifySession, signSession } from '@/lib/auth/jwt';

import {
  endImpersonation,
  impersonationBanner,
  impersonationRefusal,
  startImpersonation,
} from '../impersonation';

/**
 * FR-904 — impersonating a merchant owner, against real Postgres.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## What these tests protect, in descending order
 *
 *   1. **The audit row exists before the session does.** `writeAuditEntry` throws, and
 *      the ordering is what makes that a guarantee rather than an intention: a failure
 *      to record means no borrowed session is ever minted. The requirement's second
 *      half — "session flagged in audit log" — is not satisfied by a row written
 *      afterwards on a best-effort basis.
 *   2. **The session really is read-only.** Not because a field says so, but because
 *      the claim is on the token that comes out of `signSession` and
 *      `refuseIfImpersonating` keys off exactly that claim. Asserted here by verifying
 *      the minted token the way middleware would.
 *   3. **The session cannot outlive the window.** `absoluteExpiresAt` equals the
 *      impersonation expiry, so the existing clamp in `signSession` does the work and
 *      no refresh extends it.
 *   4. **The two halves of the record are one hop apart.** The `ENDED` row names the
 *      `STARTED` row's id, so a session can be read end to end without a timestamp
 *      search that might match somebody else's.
 *   5. **A support call that lands on the wrong account is refused.** Not an owner, not
 *      active, not this merchant — three different mistakes an admin can make from a
 *      stale tab, each with its own sentence.
 *
 * ## Why the fixtures are hand-built
 *
 * `settlementFixtures` creates a merchant *with* an owner, which covers the happy path
 * and nothing else. Half of these tests need a merchant that is `SUSPENDED`, an account
 * that is a `MANAGER`, or a merchant-user id from a different merchant — states the
 * fixture helper deliberately cannot produce, because it exists to build valid data.
 */

const PREFIX = `imp${Date.now().toString(36).slice(-6)}`;

const merchantIds: string[] = [];
const userIds: string[] = [];

async function makeUser(role: 'ADMIN' | 'MERCHANT', tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}-${userIds.length}@example.test`,
      passwordHash: 'not-a-real-hash',
      role,
      mustChangePassword: false,
    },
    select: { id: true, email: true },
  });
  userIds.push(user.id);
  return user.id;
}

async function makeMerchant(
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED',
  tag: string,
): Promise<string> {
  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} ${tag}`,
      slug: `${PREFIX}-${tag}-${Date.now()}`,
      status,
      floorPctOfMenu: 0.25,
    },
    select: { id: true },
  });
  merchantIds.push(merchant.id);
  return merchant.id;
}

async function attach(
  merchantId: string,
  userId: string,
  role: 'OWNER' | 'MANAGER' | 'STAFF',
): Promise<string> {
  const link = await prisma.merchantUser.create({
    data: { merchantId, userId, role },
    select: { id: true },
  });
  return link.id;
}

/** The audit rows this file created. Read only — see the cleanup note in `afterAll`. */
async function auditRowsFor(targetId: string) {
  return prisma.auditLog.findMany({
    where: { action: 'session.impersonate', targetId },
    orderBy: { createdAt: 'asc' },
  });
}

let adminId = '';
let adminEmail = '';
let merchantId = '';
let ownerUserId = '';
let ownerLinkId = '';

beforeAll(async () => {
  adminId = await makeUser('ADMIN', 'admin');
  const admin = await prisma.user.findUniqueOrThrow({
    where: { id: adminId },
    select: { email: true },
  });
  adminEmail = admin.email;

  merchantId = await makeMerchant('ACTIVE', 'active');
  ownerUserId = await makeUser('MERCHANT', 'owner');
  ownerLinkId = await attach(merchantId, ownerUserId, 'OWNER');
});

afterAll(async () => {
  // ## Why the audit rows are left behind, and why that is not untidiness
  //
  // `audit-append-only.test.ts` scans every file under `src/` — including `__tests__`, and
  // deliberately — for anything that deletes or updates an audit row. A test that cleans
  // up after itself by deleting its own audit rows is that test's target: the rule is that
  // *nothing* in this codebase removes an audit row, and "it was only a test" is how the
  // habit starts.
  //
  // So the fixture teardown removes the users and the merchant, and the audit rows are
  // left as orphans. That is exactly the state the schema is built for:
  // `AuditLog.actorUserId` is `onDelete: SetNull` precisely so a row survives its actor,
  // which is also why `actorEmail` is denormalised onto it. Leftover test rows are the
  // append-only property working as designed, not a leak — and the earlier suites
  // (`force-fail.test.ts`) already leave theirs, so this is the established discipline
  // rather than a new exception.
  //
  // The rows are findable: every email is prefixed with `PREFIX`, which is derived from
  // the run's timestamp.
  if (merchantIds.length > 0) {
    // Cascades `MerchantUser`.
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
});

describe('FR-904 · the rules, as values', () => {
  it('allows an active owner who is somebody else', () => {
    expect(
      impersonationRefusal({
        actorUserId: adminId,
        found: {
          userId: ownerUserId,
          merchantId,
          merchantRole: 'OWNER',
          merchantStatus: 'ACTIVE',
        },
      }),
    ).toBeNull();
  });

  it('refuses an account that does not exist', () => {
    expect(impersonationRefusal({ actorUserId: adminId, found: null })).toEqual({
      kind: 'NOT_FOUND',
    });
  });

  it('refuses impersonating yourself', () => {
    // An admin who is also a merchant owner. Minting a read-only session for their own
    // account would lock them out of their own writes for half an hour and produce an
    // audit row that describes nothing.
    expect(
      impersonationRefusal({
        actorUserId: ownerUserId,
        found: {
          userId: ownerUserId,
          merchantId,
          merchantRole: 'OWNER',
          merchantStatus: 'ACTIVE',
        },
      }),
    ).toEqual({ kind: 'SELF' });
  });

  it('refuses a manager, even though the merchant is fine', () => {
    // FR-904 says "merchant owner". A manager's view is a different view, so answering
    // for one would answer a different question than the support call asked.
    expect(
      impersonationRefusal({
        actorUserId: adminId,
        found: {
          userId: 'someone',
          merchantId,
          merchantRole: 'MANAGER',
          merchantStatus: 'ACTIVE',
        },
      }),
    ).toEqual({ kind: 'NOT_AN_OWNER' });
  });

  it('refuses a suspended merchant, naming the status', () => {
    expect(
      impersonationRefusal({
        actorUserId: adminId,
        found: {
          userId: ownerUserId,
          merchantId,
          merchantRole: 'OWNER',
          merchantStatus: 'SUSPENDED',
        },
      }),
    ).toEqual({ kind: 'MERCHANT_NOT_ACTIVE', merchantStatus: 'SUSPENDED' });
  });

  it('refuses an account attached to a different merchant', () => {
    // The stale-tab case: the id is real and the role is right, but it belongs to
    // another merchant than the page the admin is on.
    expect(
      impersonationRefusal({
        actorUserId: adminId,
        expectMerchantId: merchantId,
        found: {
          userId: ownerUserId,
          merchantId: 'a-different-merchant',
          merchantRole: 'OWNER',
          merchantStatus: 'ACTIVE',
        },
      }),
    ).toEqual({ kind: 'NOT_IN_MERCHANT' });
  });

  it('puts the merchant check before the role check', () => {
    // Both conditions fail. The merchant mismatch is reported, because that is the
    // mistake the admin can actually fix — reloading the page — while "not an owner"
    // would send them looking for a different person.
    expect(
      impersonationRefusal({
        actorUserId: adminId,
        expectMerchantId: merchantId,
        found: {
          userId: 'someone',
          merchantId: 'a-different-merchant',
          merchantRole: 'MANAGER',
          merchantStatus: 'ACTIVE',
        },
      }),
    ).toEqual({ kind: 'NOT_IN_MERCHANT' });
  });
});

describe('FR-904 · starting a session', () => {
  it('writes the audit row, then mints a read-only session for the owner', async () => {
    const result = await startImpersonation({
      merchantUserId: ownerLinkId,
      expectMerchantId: merchantId,
      reason: 'Merchant called about a drop that will not publish.',
      actor: { userId: adminId, email: adminEmail },
    });

    // --- the record ---
    const rows = await auditRowsFor(ownerUserId);
    const row = rows.find((candidate) => candidate.id === result.auditId);
    expect(row).toBeDefined();
    expect(row?.actorUserId).toBe(adminId);
    expect(row?.actorEmail).toBe(adminEmail);
    expect(row?.targetType).toBe('user');
    // The reason is on the row, not only in a log line: the row is the record.
    expect(row?.detail).toMatchObject({
      stage: 'STARTED',
      reason: 'Merchant called about a drop that will not publish.',
      merchantId,
      readonly: true,
    });

    // --- the session ---
    const claims = result.session;
    expect(claims.userId).toBe(ownerUserId);
    expect(claims.role).toBe('MERCHANT');
    expect(claims.mustChangePassword).toBe(false);
    expect(isImpersonating(claims)).toBe(true);
    expect(claims.impersonation?.actorUserId).toBe(adminId);
    expect(claims.impersonation?.auditId).toBe(result.auditId);

    // --- the window ---
    const windowSeconds = IMPERSONATION_MAX_MINUTES * 60;
    const lifespan = claims.absoluteExpiresAt - Math.floor(Date.now() / 1000);
    expect(lifespan).toBeGreaterThan(windowSeconds - 5);
    expect(lifespan).toBeLessThanOrEqual(windowSeconds);

    // --- the token middleware will actually see ---
    const verified = await verifySession(await signSession(claims));
    expect(verified?.impersonation?.actorUserId).toBe(adminId);
    expect(verified?.impersonation?.auditId).toBe(result.auditId);
  });

  it('refuses a manager and writes no audit row', async () => {
    const managerUserId = await makeUser('MERCHANT', 'manager');
    const managerLinkId = await attach(merchantId, managerUserId, 'MANAGER');

    const before = await auditRowsFor(managerUserId);

    await expect(
      startImpersonation({
        merchantUserId: managerLinkId,
        expectMerchantId: merchantId,
        reason: 'Trying the manager.',
        actor: { userId: adminId, email: adminEmail },
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.status === 409);

    const after = await auditRowsFor(managerUserId);
    // A refused attempt leaves no row: nothing happened, and a `STARTED` with no session
    // would be a record of an event that did not occur.
    expect(after).toHaveLength(before.length);
  });

  it('refuses a suspended merchant with a 409 naming the status', async () => {
    const suspendedId = await makeMerchant('SUSPENDED', 'suspended');
    const suspendedOwner = await makeUser('MERCHANT', 'suspended-owner');
    const suspendedLink = await attach(suspendedId, suspendedOwner, 'OWNER');

    await expect(
      startImpersonation({
        merchantUserId: suspendedLink,
        expectMerchantId: suspendedId,
        reason: 'Checking a suspended account.',
        actor: { userId: adminId, email: adminEmail },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) && error.status === 409 && /suspended/i.test(error.publicMessage),
    );
  });

  it('refuses an account from another merchant with a 409', async () => {
    const otherId = await makeMerchant('ACTIVE', 'other');
    const otherOwner = await makeUser('MERCHANT', 'other-owner');
    const otherLink = await attach(otherId, otherOwner, 'OWNER');

    await expect(
      startImpersonation({
        merchantUserId: otherLink,
        // The URL says this page is about `merchantId`, not `otherId`.
        expectMerchantId: merchantId,
        reason: 'Stale tab.',
        actor: { userId: adminId, email: adminEmail },
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.status === 409);
  });

  it('refuses an unknown merchant-user id with a 404', async () => {
    await expect(
      startImpersonation({
        merchantUserId: '00000000-0000-0000-0000-000000000000',
        expectMerchantId: merchantId,
        reason: 'Typo.',
        actor: { userId: adminId, email: adminEmail },
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.status === 404);
  });
});

describe('FR-904 · ending a session', () => {
  it('restores the admin and links the two halves of the record', async () => {
    const started = await startImpersonation({
      merchantUserId: ownerLinkId,
      expectMerchantId: merchantId,
      reason: 'Second call about the same drop.',
      actor: { userId: adminId, email: adminEmail },
    });

    const ended = await endImpersonation({ session: started.session });

    // The restored session is the admin's own, with no claim — the exit must not leave
    // a borrowed-looking token behind, or the banner would never go away.
    expect(ended.session.userId).toBe(adminId);
    expect(ended.session.role).toBe('ADMIN');
    expect(isImpersonating(ended.session)).toBe(false);
    // ...and it is a full session, not another 30-minute window. Ending an
    // impersonation returns the admin to their own shift.
    expect(ended.session.absoluteExpiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60,
    );

    const rows = await auditRowsFor(ownerUserId);
    const endRow = rows.find((candidate) => candidate.id === ended.auditId);
    expect(endRow?.detail).toMatchObject({
      stage: 'ENDED',
      // One hop from the end to the start, with no timestamp search in between.
      startAuditId: started.auditId,
    });
    expect(endRow?.actorUserId).toBe(adminId);
  });

  it('refuses to end a session that is not impersonating', async () => {
    const plain = {
      userId: adminId,
      role: 'ADMIN' as const,
      mustChangePassword: false,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(endImpersonation({ session: plain })).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.status === 409,
    );
  });

  it('refuses when the admin has been demoted since the session was minted', async () => {
    // The claim is signed and cannot be forged, but it can be stale. A demotion must be
    // honoured on the way out rather than carried back in from the token.
    const demotedId = await makeUser('ADMIN', 'demoted');
    const demoted = await prisma.user.findUniqueOrThrow({
      where: { id: demotedId },
      select: { email: true },
    });

    const started = await startImpersonation({
      merchantUserId: ownerLinkId,
      expectMerchantId: merchantId,
      reason: 'Before the demotion.',
      actor: { userId: demotedId, email: demoted.email },
    });

    await prisma.user.update({ where: { id: demotedId }, data: { role: 'ORGANISER' } });

    await expect(endImpersonation({ session: started.session })).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.status === 401,
    );

    // Put it back so `afterAll` and any later test see a consistent world.
    await prisma.user.update({ where: { id: demotedId }, data: { role: 'ADMIN' } });
  });

  it('refuses when the admin row is gone', async () => {
    const doomedId = await makeUser('ADMIN', 'doomed');
    const doomed = await prisma.user.findUniqueOrThrow({
      where: { id: doomedId },
      select: { email: true },
    });

    const started = await startImpersonation({
      merchantUserId: ownerLinkId,
      expectMerchantId: merchantId,
      reason: 'Before the deletion.',
      actor: { userId: doomedId, email: doomed.email },
    });

    // `AuditLog.actorUserId` is `onDelete: SetNull`, so the row survives with a null
    // actor — which is exactly why `actorEmail` is denormalised onto it.
    await prisma.user.delete({ where: { id: doomedId } });

    await expect(endImpersonation({ session: started.session })).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.status === 401,
    );
  });
});

describe('FR-904 · the banner', () => {
  it('names both the borrowed account and the admin', async () => {
    const started = await startImpersonation({
      merchantUserId: ownerLinkId,
      expectMerchantId: merchantId,
      reason: 'Third call.',
      actor: { userId: adminId, email: adminEmail },
    });

    const banner = await impersonationBanner(started.session);

    expect(banner).not.toBeNull();
    // Two distinct names: "viewing X" is not actionable unless the admin also knows
    // who they will be signed back in as.
    expect(banner?.viewingEmail).not.toBe(banner?.actorEmail);
    expect(banner?.actorEmail).toBe(adminEmail);
    expect(banner?.auditId).toBe(started.auditId);
    expect(banner?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('is null for an ordinary session', async () => {
    const plain = {
      userId: adminId,
      role: 'ADMIN' as const,
      mustChangePassword: false,
      absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    expect(await impersonationBanner(plain)).toBeNull();
  });
});
