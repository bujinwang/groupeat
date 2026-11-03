import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeJoinPaymentPort } from '@/lib/join/fake-payment-port';
import type { JoinPaymentPort } from '@/lib/join/payment-port';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * FR-802 — the organiser's token, from the URL to the participant row.
 *
 * ## Why this file exists separately from the join route tests
 *
 * Because the defect it guards is invisible to both `tsc` and every other test in the
 * suite. `organiserToken` is optional on `JoinRequest`, so a route that parses it and
 * then forgets to pass it to `joinDrop` compiles cleanly, validates the body, returns
 * 200, and writes a participant with `shareLinkId: null` — forever. Every join works,
 * the drop fills, and no organiser is ever credited.
 *
 * That is not hypothetical. It is precisely what `paymentMethodId` did in slice 2b,
 * and the comment above that line in the route says so. So the assertion here is on
 * the **database row**, not on the parsed body: the parsed body would be correct in
 * the broken version too.
 *
 * ## What is mocked
 *
 * The same two modules as the sibling route test — the Stripe key and the real payment
 * port — and nothing else. The zod schema, the service, the transaction and Postgres
 * are real, because the question is what ends up stored.
 */

const PREFIX = `at${Date.now().toString(36).slice(-5)}`;

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;
let organiserProfileId = '';
let organiserUserId = '';

vi.mock('@/lib/payments/stripe', () => ({
  isStripeConfigured: () => true,
}));

let activePort: JoinPaymentPort = fakeJoinPaymentPort();
vi.mock('@/lib/join/real-payment-port', () => ({
  createJoinPaymentPort: async () => activePort,
}));

vi.mock('@/lib/notify/twilio-sender', () => ({
  resolveSender: () => ({
    name: 'recording',
    async send() {
      return { outcomes: [], sentCount: 0, failedCount: 0 };
    },
  }),
}));

let phoneSeq = 0;

/** A number per test, so `DropParticipant`'s per-customer cap never fires across them. */
function nextPhone(): string {
  phoneSeq += 1;
  return `+17805559${String(phoneSeq).padStart(4, '0')}`;
}

function post(code: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/public/drops/${code}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callPost(code: string, body: unknown): Promise<Response> {
  const route = await import('@/app/api/public/drops/[code]/join/route');
  return route.POST(post(code, body), { params: Promise.resolve({ code }) });
}

/** A published, open drop with room for several plates. */
async function openDrop(): Promise<{ id: string; publicCode: string }> {
  const id = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1200,
    minQty: 1,
    maxQty: 40,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
  });
  const drop = await prisma.drop.findUniqueOrThrow({
    where: { id },
    select: { publicCode: true },
  });
  return { id, publicCode: drop.publicCode };
}

/** A share link for that drop, created the way the organiser page creates one. */
async function shareLinkFor(dropId: string): Promise<string> {
  const link = await prisma.shareLink.create({
    data: {
      // A real 22-character base64url token. The first version of this fixture built one
      // by concatenating base36 fragments and came out 20 characters long — which
      // `isShareToken` correctly rejects, so the "records the share link" test failed
      // for a reason that had nothing to do with the route. Generating it the way
      // production does removes the chance of writing a fixture that cannot exist.
      token: randomBytes(16).toString('base64url'),
      dropId,
      merchantId,
      organiserId: organiserProfileId,
    },
    select: { token: true },
  });
  return link.token;
}

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant('acct_test_attribution');
  itemId = await fixtures.item(merchantId);

  const organiser = await prisma.user.create({
    data: {
      email: `${PREFIX}-organiser@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  organiserUserId = organiser.id;

  const profile = await prisma.organiserProfile.create({
    data: { userId: organiserUserId, displayName: 'Attribution Organiser' },
    select: { id: true },
  });
  organiserProfileId = profile.id;
});

beforeEach(() => {
  activePort = fakeJoinPaymentPort();
  vi.resetModules();
});

afterAll(async () => {
  await prisma.consentRecord
    .deleteMany({ where: { phone: { startsWith: '+17805559' } } })
    .catch(() => undefined);
  await prisma.shareLink
    .deleteMany({ where: { organiserId: organiserProfileId } })
    .catch(() => undefined);
  await prisma.organiserProfile
    .deleteMany({ where: { userId: organiserUserId } })
    .catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: organiserUserId } }).catch(() => undefined);
  await fixtures.cleanup();
});

describe('a join that arrived through an organiser link', () => {
  it('records the share link on the participant row', async () => {
    const drop = await openDrop();
    const token = await shareLinkFor(drop.id);

    const response = await callPost(drop.publicCode, {
      phone: nextPhone(),
      qty: 2,
      consented: true,
      organiserToken: token,
    });
    expect(response.status).toBe(200);

    const participant = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: drop.id },
      select: { shareLinkId: true },
    });

    // The assertion the whole file exists for. It fails if the route parses
    // `organiserToken` and forgets to hand it to `joinDrop` — a version in which every
    // other test in the repository still passes.
    expect(participant.shareLinkId).not.toBeNull();

    const link = await prisma.shareLink.findUniqueOrThrow({
      where: { token },
      select: { id: true, organiserId: true },
    });
    expect(participant.shareLinkId).toBe(link.id);
    expect(link.organiserId).toBe(organiserProfileId);
  });

  it('still joins, with no attribution, when the token is junk', async () => {
    // Attribution must never cost the merchant a sale. A stale link, a hand-typed
    // token, a token from a drop that has since been deleted — the diner did nothing
    // wrong and cannot fix it, so the join proceeds.
    const drop = await openDrop();

    const response = await callPost(drop.publicCode, {
      phone: nextPhone(),
      qty: 1,
      organiserToken: 'not-a-real-token-at-all',
    });
    expect(response.status).toBe(200);

    const participant = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: drop.id },
      select: { shareLinkId: true },
    });
    expect(participant.shareLinkId).toBeNull();
  });

  it('does not credit an organiser from a different drop', async () => {
    // Commission is paid on this number (FR-804), so a token that works on any drop
    // would let one shared link be pasted onto every drop in the corridor.
    const dropA = await openDrop();
    const dropB = await openDrop();
    const tokenForA = await shareLinkFor(dropA.id);

    const response = await callPost(dropB.publicCode, {
      phone: nextPhone(),
      qty: 1,
      organiserToken: tokenForA,
    });
    expect(response.status).toBe(200);

    const participant = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: dropB.id },
      select: { shareLinkId: true },
    });
    expect(participant.shareLinkId).toBeNull();
  });

  it('joins normally when no token is sent at all', async () => {
    // The ordinary case: a plain link, a group chat, no organiser.
    const drop = await openDrop();

    const response = await callPost(drop.publicCode, {
      phone: nextPhone(),
      qty: 1,
    });
    expect(response.status).toBe(200);

    const participant = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId: drop.id },
      select: { shareLinkId: true },
    });
    expect(participant.shareLinkId).toBeNull();
  });
});
