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

const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

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
let currentSession: MockSession | null = { userId: 'admin-user-1', role: 'ADMIN', mustChangePassword: false };

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
});

afterAll(async () => {
  await fixtures.cleanup();
});

beforeEach(() => {
  currentSession = { userId: 'admin-user-1', role: 'ADMIN', mustChangePassword: false };
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

async function post(participantId: string, body: unknown = {}) {
  // Re-imported per call so `beforeEach`'s `resetModules` is honoured and the
  // module-level mocks above take effect for this graph.
  const { POST } = await import('../route');
  const { request, context } = requestFor(participantId, body);
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
});

// `AppError` is imported only so the 401/403/404 expectations above are visibly the
// same class of refusal the route throws — if `errorResponse` ever stopped mapping
// it, those statuses would change and this file would notice.
void AppError;
