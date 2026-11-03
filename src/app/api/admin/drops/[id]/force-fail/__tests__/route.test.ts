import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';
import { fakeChargePort, type FakeChargePort } from '@/lib/settlement/fake-charge-port';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

import { POST } from '../route';

/**
 * `POST /api/admin/drops/:id/force-fail` — FR-902's endpoint.
 *
 * ## What the route owns, and therefore what these test
 *
 * The money is `forceFailDrop`'s and is covered there. This file covers the four
 * things that only exist at the HTTP edge:
 *
 *   1. **Authorisation.** `requireAdmin` is the gate, and `mustChangePassword` must
 *      not be a way through it. A temporary password is the same privilege question
 *      wherever it is presented.
 *   2. **Validation.** A force-fail with no reason is not auditable, so the body
 *      refuses it with a 422 rather than writing a row that says nothing.
 *   3. **The actor's email comes from the database**, not from the token. A first
 *      draft read `session.email`, which does not exist on `SessionClaims`, and the
 *      audit row would have been written with `undefined`.
 *   4. **A missing Stripe configuration is a 503 with a sentence**, not a 500.
 */

const PREFIX = `ffr${Date.now().toString(36).slice(-5)}`;

let fixtures: SettlementFixtures;
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1250;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

// --- Infrastructure ---------------------------------------------------------

type MockSession = { userId: string; role: string; mustChangePassword: boolean };
let currentSession: MockSession | null = null;
let adminUserId = '';

/**
 * `@/lib/auth/authorize` is replaced, not `@/lib/auth/session`.
 *
 * Same reason as the refund route test: `authorize.ts` imports `server-only` and
 * throws at module load, so mocking the getter beneath it does not help.
 *
 * The real `AppError` is imported inside the factory rather than re-created, so
 * `isAppError`'s `instanceof` in `errorResponse` still recognises it. A second copy
 * of the class turns every refusal into a 500 — which is what happened on the first
 * draft of the refund test, and what the 401/403 assertions exist to catch.
 */
vi.mock('@/lib/auth/authorize', async () => {
  const { AppError } = await import('@/lib/errors');
  return {
    requireAdmin: async () => {
      if (!currentSession) throw AppError.unauthorized();
      if (currentSession.role !== 'ADMIN') throw AppError.forbidden();
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

/**
 * The sender, replaced so nothing reaches Twilio.
 *
 * `composingNotifyPort` is the real one on purpose — this route's job includes
 * choosing it, and a mocked compose port would hide a wrong factory call. Only the
 * transport is faked.
 */
vi.mock('@/lib/notify/twilio-sender', () => ({
  resolveSender: () => ({
    async send() {
      return { status: 'SENT' as const, providerId: 'fake' };
    },
  }),
}));

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant(`acct_${PREFIX}`);
  itemId = await fixtures.item(merchantId);

  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@groupeat.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ADMIN',
    },
    select: { id: true },
  });
  adminUserId = user.id;
  currentSession = { userId: adminUserId, role: 'ADMIN', mustChangePassword: false };
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: adminUserId } });
  await fixtures.cleanup();
});

beforeEach(() => {
  currentSession = { userId: adminUserId, role: 'ADMIN', mustChangePassword: false };
  stripeConfigured = true;
  activePort = fakeChargePort();
  // No `vi.resetModules()`: it would hand the route a fresh `@/lib/errors`, so the
  // `AppError` the mock throws would be a different class and every refusal would
  // arrive as a 500. All the varying state above is closure-held.
});

/** One captured drop with one captured participant, plus the ledger rows. */
async function capturedDrop(): Promise<{ dropId: string; publicCode: string; chargeId: string; subtotalCents: number; feeCents: number }> {
  const dropId = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'CAPTURED',
  });
  const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { publicCode: true } });

  const subtotalCents = DEAL_PRICE;
  const feeCents = FEE_PER_UNIT;
  const chargeId = `ch_${PREFIX}_${Math.random().toString(36).slice(2, 8)}`;

  const participantId = await fixtures.participant({
    dropId,
    qty: 1,
    platformFeeCents: feeCents,
    chargeStatus: 'CAPTURED',
    redemptionCode: 'v1.test.test',
  });

  const order = await prisma.order.create({
    data: {
      dropId,
      participantId,
      qty: 1,
      unitPriceCents: DEAL_PRICE,
      subtotalCents,
      platformFeeCents: feeCents,
      stripeChargeId: chargeId,
    },
    select: { id: true },
  });

  await prisma.ledgerEntry.createMany({
    data: [
      { orderId: order.id, dropId, type: 'CHARGE', amountCents: subtotalCents, stripeRef: chargeId, note: 'capture' },
      { orderId: order.id, dropId, type: 'PLATFORM_FEE', amountCents: feeCents, stripeRef: chargeId, note: 'capture' },
    ],
  });

  activePort = fakeChargePort({
    chargesByChargeId: { [chargeId]: { chargeCents: subtotalCents, feeCents } },
  });

  return { dropId, publicCode: drop.publicCode, chargeId, subtotalCents, feeCents };
}

function request(dropId: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/drops/${dropId}/force-fail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function context(dropId: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: dropId }) };
}

describe('authorisation', () => {
  it('refuses with 401 when there is no session', async () => {
    currentSession = null;
    const drop = await capturedDrop();

    const response = await POST(
      request(drop.dropId, { confirmPublicCode: drop.publicCode, reason: 'test' }),
      context(drop.dropId),
    );

    expect(response.status).toBe(401);
    const after = await prisma.drop.findUniqueOrThrow({ where: { id: drop.dropId } });
    expect(after.status).toBe('CAPTURED');
  });

  it('refuses a temporary password with 403 — this is not the weaker door', async () => {
    // `mustChangePassword` is enforced inside the mock's `requireAdmin`, mirroring
    // what the real one does. A force-fail is the most destructive action in the
    // product; a temporary credential must not reach it.
    currentSession = { userId: adminUserId, role: 'ADMIN', mustChangePassword: true };
    const drop = await capturedDrop();

    const response = await POST(
      request(drop.dropId, { confirmPublicCode: drop.publicCode, reason: 'test' }),
      context(drop.dropId),
    );

    expect(response.status).toBe(403);
  });

  it('refuses a non-admin with 403', async () => {
    currentSession = { userId: adminUserId, role: 'MERCHANT', mustChangePassword: false };
    const drop = await capturedDrop();

    const response = await POST(
      request(drop.dropId, { confirmPublicCode: drop.publicCode, reason: 'test' }),
      context(drop.dropId),
    );

    expect(response.status).toBe(403);
  });
});

describe('validation', () => {
  it('refuses a body with no reason, with a 422 naming the field', async () => {
    const drop = await capturedDrop();

    const response = await POST(request(drop.dropId, { confirmPublicCode: drop.publicCode }), context(drop.dropId));

    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors).toHaveProperty('reason');

    // Nothing moved and nothing was recorded.
    const after = await prisma.drop.findUniqueOrThrow({ where: { id: drop.dropId } });
    expect(after.status).toBe('CAPTURED');
    expect(await prisma.auditLog.count({ where: { targetId: drop.dropId } })).toBe(0);
  });

  it('refuses a body with no confirmation code', async () => {
    const drop = await capturedDrop();

    const response = await POST(request(drop.dropId, { reason: 'power cut' }), context(drop.dropId));

    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors).toHaveProperty('confirmPublicCode');
  });

  it('refuses a confirmation code for a different drop', async () => {
    const drop = await capturedDrop();

    const response = await POST(
      request(drop.dropId, { confirmPublicCode: 'SOME-OTHER-CODE', reason: 'wrong drop' }),
      context(drop.dropId),
    );

    // `AppError.validation` is a 422, and the sentence is in `fieldErrors`.
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.confirmPublicCode).toMatch(/does not match/i);

    expect(await prisma.ledgerEntry.count({ where: { dropId: drop.dropId, type: 'REFUND' } })).toBe(0);
  });
});

describe('environment', () => {
  it('answers 503 with a sentence when Stripe is not configured', async () => {
    stripeConfigured = false;
    const drop = await capturedDrop();

    const response = await POST(
      request(drop.dropId, { confirmPublicCode: drop.publicCode, reason: 'power cut' }),
      context(drop.dropId),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/Stripe is not configured/i);
  });
});

describe('the happy path', () => {
  it('cancels the drop, refunds it, and returns the totals', async () => {
    const drop = await capturedDrop();

    const response = await POST(
      request(drop.dropId, { confirmPublicCode: drop.publicCode, reason: 'kitchen flooded' }),
      context(drop.dropId),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind: string;
      refundedParticipants: number;
      refundedCents: number;
      alreadyCancelled: boolean;
    };
    expect(body.kind).toBe('CANCELLED');
    expect(body.refundedParticipants).toBe(1);
    expect(body.refundedCents).toBe(drop.subtotalCents);
    expect(body.alreadyCancelled).toBe(false);

    const after = await prisma.drop.findUniqueOrThrow({ where: { id: drop.dropId } });
    expect(after.status).toBe('CANCELLED');
  });

  it('records the actor email from the database, not from the token', async () => {
    // `SessionClaims` has no `email`. A first draft of the route read one and the
    // audit row would have carried `undefined` — which is the one field that has to
    // be right, since it is what survives the user being deleted.
    const drop = await capturedDrop();

    await POST(
      request(drop.dropId, { confirmPublicCode: drop.publicCode, reason: 'power cut' }),
      context(drop.dropId),
    );

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: drop.dropId, action: 'drop.force_fail' },
      orderBy: { createdAt: 'asc' },
    });
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminUserId }, select: { email: true } });

    expect(row.actorEmail).toBe(admin.email);
    expect(row.actorUserId).toBe(adminUserId);
    expect(row.actorEmail).not.toBe('undefined');
  });

  it('is safe to call twice — the second call reports alreadyCancelled and moves no money', async () => {
    const drop = await capturedDrop();
    const body = { confirmPublicCode: drop.publicCode, reason: 'called off' };

    const first = await POST(request(drop.dropId, body), context(drop.dropId));
    expect(first.status).toBe(200);

    const second = await POST(request(drop.dropId, body), context(drop.dropId));
    expect(second.status).toBe(200);
    const parsed = (await second.json()) as { alreadyCancelled: boolean; refundedCents: number };
    expect(parsed.alreadyCancelled).toBe(true);
    expect(parsed.refundedCents).toBe(0);

    expect(await prisma.ledgerEntry.count({ where: { dropId: drop.dropId, type: 'REFUND' } })).toBe(1);
  });

  it('answers 404 for a drop that does not exist, and never 403', async () => {
    // `authorize.ts`'s rule applied to a resource id: a foreign id must not be
    // distinguishable from a missing one.
    const response = await POST(
      request('00000000-0000-0000-0000-000000000000', { confirmPublicCode: 'X', reason: 'test' }),
      context('00000000-0000-0000-0000-000000000000'),
    );

    expect(response.status).toBe(404);
  });
});
