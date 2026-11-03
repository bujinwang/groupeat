import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';
import { fakeChargePort, type FakeChargePort } from '@/lib/settlement/fake-charge-port';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * `POST /api/admin/participants/[id]/refund` — FR-903 over HTTP.
 *
 * ## What is mocked, and what is not
 *
 * Three modules, each because it needs infrastructure that does not exist here:
 *
 *   - `@/lib/auth/session`, because there is no cookie jar. The route calls
 *     `requireAdmin()`, which calls `getSession()`; mocking the session is the
 *     narrowest place to stand in for "somebody is signed in".
 *   - `@/lib/payments/stripe`, because there is no API key.
 *   - `@/lib/settlement/real-charge-port`, because it imports `server-only` and
 *     reaches the network. The route resolves it through `await import()`, which is
 *     exactly why it can be replaced without touching the production path.
 *
 * Everything else is real: the zod schema, the guards, the service, the transaction,
 * Postgres. A test that mocked the service would prove the route can call a
 * function — not the interesting claim.
 *
 * ## The two refusals that are security
 *
 * A route that moves money must not be reachable without an admin session, and must
 * not pretend to work when the provider is unconfigured. Both are single branches,
 * and a branch never executed is a branch never true in production either.
 */

const PREFIX = `rf${Date.now().toString(36).slice(-5)}`;

let fixtures: SettlementFixtures;
let merchantId = '';
let itemId = '';

/**
 * A real `User` row for the admin session, because gap 13 gave this route an audit row
 * and `AuditLog.actorUserId` is a foreign key.
 *
 * `currentSession.userId` has to be this id rather than a literal: the route reads the
 * actor's email from the `User` row before calling the service, and a fabricated id
 * would make every refund fail with a 401 for a user who does not exist. That is the
 * route working correctly — it is the same branch `requireAdmin`'s claim-only check
 * cannot see.
 */
let adminUserId = '';
let adminEmail = '';

/**
 * `fr…-admin` was created here and never deleted — `fixtures.cleanup()` handles the
 * drop, its participants and its customers, not a `User`. One leaked account per run,
 * found by counting `User` rows before and after the suite.
 */
const createdUserIds: string[] = [];

const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

/** Every mutating request needs a stated reason now — a refund with no reason is refused. */
const REASON = 'restaurant closed early';

// --- The three infrastructure modules --------------------------------------

/**
 * `@/lib/auth/authorize` is replaced, not `@/lib/auth/session`.
 *
 * It imports `server-only`, which throws on import outside a React Server Component
 * graph, so mocking the session getter underneath it does not help — the module still
 * loads and still throws. This is the same mock the redeem route test uses, and it
 * has a second benefit here: the refusal can be asserted as the *rule* (`only an
 * ADMIN may refund`) rather than as whatever `requireRole` happens to do today.
 */
type MockSession = { userId: string; role: string; mustChangePassword: boolean };
let currentSession: MockSession | null = { userId: '', role: 'ADMIN', mustChangePassword: false };

vi.mock('@/lib/auth/authorize', async () => {
  // The REAL `AppError`, imported rather than re-created. A second copy of the class
  // would fail `isAppError`'s `instanceof` in `errorResponse`, and every refusal
  // would arrive at the client as a 500 — which is exactly what this mock did on its
  // first draft, and what the 401/403 assertions now exist to catch.
  const { AppError } = await import('@/lib/errors');
  return {
    requireAdmin: async () => {
      if (!currentSession) throw AppError.unauthorized();
      if (currentSession.role !== 'ADMIN') throw AppError.forbidden();
      // `mustChangePassword` is enforced here rather than assumed: the admin server
      // actions refuse it, and a temporary password is the same privilege question
      // wherever it is presented.
      if (currentSession.mustChangePassword) throw AppError.forbidden();
      return currentSession;
    },
  };
});

let stripeConfigured = true;
vi.mock('@/lib/payments/stripe', () => ({
  isStripeConfigured: () => stripeConfigured,
}));

let activePort: FakeChargePort = fakeChargePort();
vi.mock('@/lib/settlement/real-charge-port', () => ({
  realChargePort: () => activePort,
}));

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant('acct_test_refund_route');
  itemId = await fixtures.item(merchantId);

  adminEmail = `${PREFIX}-admin@groupeat.test`;
  const admin = await prisma.user.create({
    data: { email: adminEmail, passwordHash: 'not-a-real-hash', role: 'ADMIN' },
    select: { id: true },
  });
  adminUserId = admin.id;
  createdUserIds.push(admin.id);
});

afterAll(async () => {
  // Every step attempted, and the run still fails if any of them did — a throw in step
  // one must not skip the rest, or a failing run leaks more than a passing one.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // Fixtures first: the audit rows here name the admin by `SetNull`, so the drop can go
  // before the account. Before this, the account was never deleted at all.
  await step(() => fixtures.cleanup());
  if (createdUserIds.length > 0) {
    await step(() => prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `teardown left the database dirty (${failures.length} step(s) failed)`);
  }
});

beforeEach(() => {
  currentSession = { userId: adminUserId, role: 'ADMIN', mustChangePassword: false };
  stripeConfigured = true;
  activePort = fakeChargePort();
  // NO `vi.resetModules()` here, deliberately.
  //
  // It was in the first draft, and it broke every refusal: a reset gives the route a
  // fresh `@/lib/errors`, so the `AppError` this mock throws is a different class
  // object from the one `isAppError` checks with `instanceof`, and every 401/403
  // arrived as a 500. All state these tests vary lives in closure variables above,
  // so re-importing the module graph buys nothing and costs the class identity that
  // makes an error an error.
});

/** A settled, captured participant with its Order and two capture ledger rows. */
async function capturedOrder(qty = 1): Promise<{
  participantId: string;
  orderId: string;
  chargeId: string;
  subtotalCents: number;
  platformFeeCents: number;
}> {
  const subtotalCents = qty * DEAL_PRICE;
  const platformFeeCents = qty * FEE_PER_UNIT;
  const chargeId = `ch_${PREFIX}_${Math.random().toString(36).slice(2, 10)}`;

  const dropId = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'CAPTURED',
  });
  const participantId = await fixtures.participant({
    dropId,
    qty,
    platformFeeCents,
    chargeStatus: 'CAPTURED',
    redemptionCode: 'v1.test.test',
  });
  const order = await prisma.order.create({
    data: {
      dropId,
      participantId,
      qty,
      unitPriceCents: DEAL_PRICE,
      subtotalCents,
      platformFeeCents,
      stripeChargeId: chargeId,
    },
    select: { id: true },
  });
  await prisma.ledgerEntry.createMany({
    data: [
      { orderId: order.id, dropId, type: 'CHARGE', amountCents: subtotalCents, stripeRef: chargeId, note: 'capture' },
      { orderId: order.id, dropId, type: 'PLATFORM_FEE', amountCents: platformFeeCents, stripeRef: chargeId, note: 'capture' },
    ],
  });

  activePort = fakeChargePort({
    chargesByChargeId: { [chargeId]: { chargeCents: subtotalCents, feeCents: platformFeeCents } },
  });

  return { participantId, orderId: order.id, chargeId, subtotalCents, platformFeeCents };
}

function requestFor(participantId: string, body: unknown = {}): {
  request: NextRequest;
  context: { params: Promise<{ id: string }> };
} {
  return {
    request: new NextRequest(`http://localhost/api/admin/participants/${participantId}/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    context: { params: Promise.resolve({ id: participantId }) },
  };
}

/**
 * Posts a refund, with a reason by default.
 *
 * `reason` is required by the route since gap 13 — a refund writes an audit row and a
 * money movement with no stated justification is the thing that trail exists to
 * prevent. Callers that pass a body get this reason merged underneath, so a test about
 * the *amount* does not have to restate why; a test about the reason passes its own.
 */
async function post(participantId: string, body: unknown = {}) {
  // Re-imported per call so `beforeEach`'s `resetModules` is honoured and the
  // module-level mocks above take effect for this graph.
  const { POST } = await import('../route');
  const merged =
    body && typeof body === 'object' ? { reason: REASON, ...(body as object) } : body;
  const { request, context } = requestFor(participantId, merged);
  return POST(request, context);
}

describe('POST /api/admin/participants/:id/refund', () => {
  it('refunds the whole order when no amount is given', async () => {
    const fixture = await capturedOrder(2);

    const response = await post(fixture.participantId);
    const body = (await response.json()) as { kind: string; refundedCents: number };

    expect(response.status).toBe(200);
    expect(body.kind).toBe('REFUNDED');
    expect(body.refundedCents).toBe(fixture.subtotalCents);
  });

  it('refunds the requested partial amount', async () => {
    const fixture = await capturedOrder(2);
    const half = fixture.subtotalCents / 2;

    const response = await post(fixture.participantId, { amountCents: half });
    const body = (await response.json()) as { refundedCents: number; platformFeeReversedCents: number };

    expect(response.status).toBe(200);
    expect(body.refundedCents).toBe(half);
    // Less than the whole fee, because this was a partial refund.
    expect(body.platformFeeReversedCents).toBeLessThan(fixture.platformFeeCents);
  });

  it('401s without a session, and refunds nothing', async () => {
    const fixture = await capturedOrder(1);
    currentSession = null;

    const response = await post(fixture.participantId);

    expect(response.status).toBe(401);
    expect(
      await prisma.ledgerEntry.count({ where: { orderId: fixture.orderId, type: 'REFUND' } }),
    ).toBe(0);
  });

  it('403s a merchant session — only an admin may refund', async () => {
    const fixture = await capturedOrder(1);
    currentSession = { userId: 'merchant-user-1', role: 'MERCHANT', mustChangePassword: false };

    const response = await post(fixture.participantId);

    expect(response.status).toBe(403);
    expect(
      await prisma.ledgerEntry.count({ where: { orderId: fixture.orderId, type: 'REFUND' } }),
    ).toBe(0);
  });

  it('403s an admin who must still change their password', async () => {
    // A first-login admin holding a temporary password is the same privilege
    // question as a merchant's, and `admin/actions.ts` already refuses it for the
    // admin forms. This route must not be the weaker door.
    const fixture = await capturedOrder(1);
    currentSession = { userId: 'admin-user-1', role: 'ADMIN', mustChangePassword: true };

    const response = await post(fixture.participantId);

    expect(response.status).toBe(403);
    expect(
      await prisma.ledgerEntry.count({ where: { orderId: fixture.orderId, type: 'REFUND' } }),
    ).toBe(0);
  });

  it('503s when Stripe is not configured, and says which knob is missing', async () => {
    const fixture = await capturedOrder(1);
    stripeConfigured = false;

    const response = await post(fixture.participantId);
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(503);
    expect(body.message).toMatch(/Stripe is not configured/i);
    expect(
      await prisma.ledgerEntry.count({ where: { orderId: fixture.orderId, type: 'REFUND' } }),
    ).toBe(0);
  });

  it('422s a body that is not a positive whole number of cents', async () => {
    const fixture = await capturedOrder(1);

    const response = await post(fixture.participantId, { amountCents: -5 });

    expect(response.status).toBe(422);
  });

  it('409s a second refund with a sentence the operator can act on', async () => {
    const fixture = await capturedOrder(1);

    expect((await post(fixture.participantId)).status).toBe(200);

    const second = await post(fixture.participantId);
    const body = (await second.json()) as { message: string };

    expect(second.status).toBe(409);
    expect(body.message).toMatch(/already been refunded/i);
  });

  it('404s an unknown participant', async () => {
    const response = await post('00000000-0000-0000-0000-000000000000');

    expect(response.status).toBe(404);
  });

  it('422s a missing reason, and refunds nothing', async () => {
    // Gap 13 made the reason load-bearing: it is stored on the audit row, so a refund
    // without one is a money movement with no stated justification. This is the branch
    // that keeps the requirement from being a convention callers can forget.
    const fixture = await capturedOrder(1);

    const response = await post(fixture.participantId, { reason: '' });
    const body = (await response.json()) as { fieldErrors: Record<string, string> };

    expect(response.status).toBe(422);
    expect(body.fieldErrors.reason).toMatch(/why/i);
    expect(
      await prisma.ledgerEntry.count({ where: { orderId: fixture.orderId, type: 'REFUND' } }),
    ).toBe(0);
  });

  it('writes the audit row with the actor read from the User row, not the session', async () => {
    const fixture = await capturedOrder(1);

    expect((await post(fixture.participantId)).status).toBe(200);

    const rows = await prisma.auditLog.findMany({
      where: { action: 'participant.refund', targetId: fixture.participantId },
      orderBy: { createdAt: 'asc' },
      select: { actorEmail: true, actorUserId: true, detail: true },
    });

    expect(rows).toHaveLength(2);
    // The email is read from the row inside the route. `SessionClaims` holds no email
    // on purpose — a token carrying one would go stale — so this assertion is what
    // proves the route looked it up rather than passing something through.
    expect(rows[0]?.actorEmail).toBe(adminEmail);
    expect(rows[0]?.actorUserId).toBe(adminUserId);

    const requested = rows[0]?.detail as Record<string, unknown>;
    expect(requested.reason).toBe(REASON);
    expect(requested.requestedCents).toBe(fixture.subtotalCents);
  });

  it('401s a token whose User row has been deleted, before touching any money', async () => {
    // `requireAdmin` validates the *claim*, not the row, so a token for a deleted admin
    // passes it. The route catches this at the email lookup. Worth a test because the
    // alternative is a refund with an audit row naming nobody.
    const fixture = await capturedOrder(1);
    const doomed = await prisma.user.create({
      data: { email: `${PREFIX}-doomed@groupeat.test`, passwordHash: 'x', role: 'ADMIN' },
      select: { id: true },
    });
    currentSession = { userId: doomed.id, role: 'ADMIN', mustChangePassword: false };
    await prisma.user.delete({ where: { id: doomed.id } });

    const response = await post(fixture.participantId);

    expect(response.status).toBe(401);
    expect(
      await prisma.ledgerEntry.count({ where: { orderId: fixture.orderId, type: 'REFUND' } }),
    ).toBe(0);
  });
});

// `AppError` is imported only so the 401/403/404 expectations above are visibly the
// same class of refusal the route throws — if `errorResponse` ever stopped mapping
// it, those statuses would change and this file would notice.
void AppError;
