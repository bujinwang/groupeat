import 'dotenv/config';

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
 * `POST /api/public/drops/[code]/join` — the HTTP surface of the join flow.
 *
 * ## What is mocked and what is not
 *
 * Only the two modules that need real infrastructure: `@/lib/payments/stripe`
 * (which reads a key that does not exist here) and
 * `@/lib/join/real-payment-port` (which imports `server-only` and the Stripe SDK).
 * Both are reached by the route through `await import()`, which is exactly why they
 * can be replaced without touching the production code path.
 *
 * Everything else is real: the zod schema, the rules, the service, the transaction,
 * Postgres. A test that mocked the service would prove the route can call a function
 * and nothing else — not the least interesting of the claims here.
 *
 * ## Why the status codes get their own file
 *
 * A diner's phone branches on these. `402` for a decline and `409` for a full drop
 * are refusals a screen must distinguish, and getting one wrong means showing "check
 * your card" to somebody whose batch is simply sold out.
 */

/**
 * A short prefix on purpose.
 *
 * `settlement-fixtures.ts` builds `publicCode` as `${prefix}${seq}` and slices to 24
 * characters, so a long prefix pushes the sequence number off the end and every drop
 * in this file collides on the same code — which fails as a unique-constraint error
 * in a fixture, far from anything the test is about.
 */
const PREFIX = `jr${Date.now().toString(36).slice(-5)}`;

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;

/**
 * The phone numbers this file issues, recorded as they are issued.
 *
 * ## The drift this replaces
 *
 * `phone()` builds `780558…`, which the service normalises to `+1780558…`, and the
 * teardown deleted `phone: { startsWith: '+17805558' }`. One digit out:
 * `'+17805580001'.startsWith('+17805558')` is **false**, so the filter matched nothing
 * this file created and every `Customer` and `ConsentRecord` it made was left behind.
 * This is the third copy of the same defect — `service.test.ts` had it at `+17805559`
 * and `normalisePhone()` is what turns a ten-digit builder into a thirteen-character
 * string nobody re-reads.
 *
 * It was invisible for the usual reason: `customers` was non-zero from other suites,
 * so the residue gate could not see a file adding to a number that was already moving.
 *
 * A set cannot drift from itself, so the builder writes here and the teardown reads
 * here. Same mechanism as `join/__tests__/service.test.ts`.
 *
 * ## Phone block allocation
 *
 * The 780-555 exchange is carved up per file so two suites cannot mint the same diner.
 * Taken, as of this slice: `+17805550` (join/service), `+17805556` (funnel-wiring),
 * `+17805557` (quote), `+17805558` (confirmation-wiring), `+17805559` (attribution,
 * threshold-notify), `+17805571` (order-link), and `+17805580` — this file, which is
 * the block the builder below already implied. Adding a file? Take a free one and
 * write it down here; the registry protects this file, and the comment is what stops
 * the next one choosing a neighbour's.
 */
const issuedPhones = new Set<string>();

/** What `normalisePhone()` prepends to a ten-digit North American number. */
const E164_COUNTRY_PREFIX = '+1';

// --- The two infrastructure modules ----------------------------------------

let stripeConfigured = true;
vi.mock('@/lib/payments/stripe', () => ({
  isStripeConfigured: () => stripeConfigured,
}));

/**
 * The port the route will receive. Replaced per test where the outcome matters.
 *
 * Typed as the interface, not as `FakeJoinPaymentPort`: several tests replace it with
 * a one-method object to force a single outcome, and demanding the fake's
 * introspection helpers from those would be asking them to implement an API nobody
 * calls.
 */
let activePort: JoinPaymentPort = fakeJoinPaymentPort();
vi.mock('@/lib/join/real-payment-port', () => ({
  createJoinPaymentPort: async () => activePort,
}));

/**
 * The notification sender, replaced with a recorder.
 *
 * The route resolves this through `await import()` for the same reason it resolves
 * the payment port that way, so it can be replaced the same way. `twilio-sender.ts`
 * imports `server-only` and reaches the network, neither of which belongs in a route
 * test — and the messages it would carry are asserted in
 * `join/__tests__/confirmation-wiring.test.ts`, which drives the service directly.
 *
 * Without this mock every success case returns 500, because the dynamic import throws
 * inside the route's try block.
 */
export const sentMessages: { kind: string; body: string; phone: string }[] = [];
vi.mock('@/lib/notify/twilio-sender', () => ({
  resolveSender: () => ({
    name: 'recording',
    async send(messages: readonly { kind: string; body: string; phone: string }[]) {
      sentMessages.push(...messages);
      return { outcomes: [], sentCount: messages.length, failedCount: 0 };
    },
  }),
}));

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant('acct_test_join_route');
  itemId = await fixtures.item(merchantId);
});

afterAll(async () => {
  // Every step attempted, and the run still fails if any did — the previous version
  // ended with `.catch(() => undefined)`, which is a step that cannot fail. That is how
  // a filter matching nothing survived here undetected.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // `ConsentRecord` has no foreign key to anything — deliberately, so it outlives the
  // join it records — so nothing cascades to it.
  await step(() =>
    prisma.consentRecord.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  // The fixtures next: this is what removes the drops and cascades to the participants,
  // and `DropParticipant.customer` has no `onDelete` so it defaults to Restrict.
  await step(() => fixtures.cleanup());

  // Then the customers.
  //
  // These are NOT covered by `fixtures.cleanup()`, which is worth stating because it is
  // the obvious assumption and it is false: the fixtures only track customers they
  // created themselves, through `fixtures.participant()` pushing `customerIds`. Every
  // diner in this file is created by the route under test, via the service's
  // `tx.customer.upsert`, which the fixtures never see. So if this step is missing, the
  // customers leak — which is exactly what was happening.
  await step(() =>
    prisma.customer.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  if (failures.length > 0) {
    throw new AggregateError(failures, `teardown left the database dirty (${failures.length} step(s) failed)`);
  }
});

beforeEach(() => {
  stripeConfigured = true;
  activePort = fakeJoinPaymentPort();
  sentMessages.length = 0;
  vi.resetModules();
});

/** Loads the route fresh, so the module-level mocks are re-bound each time. */
async function loadRoute() {
  return import('@/app/api/public/drops/[code]/join/route');
}

function post(code: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/public/drops/${code}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callPost(code: string, body: unknown): Promise<Response> {
  const route = await loadRoute();
  return route.POST(post(code, body), { params: Promise.resolve({ code }) });
}

async function publishedDrop(
  overrides: {
    minQty?: number;
    maxQty?: number;
    maxPerCustomer?: number;
    cutoffAt?: Date;
  } = {},
): Promise<string> {
  const id = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1112,
    minQty: overrides.minQty ?? 2,
    maxQty: overrides.maxQty ?? 10,
    status: 'PUBLISHED',
    cutoffAt: overrides.cutoffAt ?? new Date(Date.now() + 2 * 60 * 60 * 1000),
    windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
    windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });

  if (overrides.maxPerCustomer !== undefined) {
    await prisma.drop.update({
      where: { id },
      data: { maxPerCustomer: overrides.maxPerCustomer },
    });
  }

  const row = await prisma.drop.findUniqueOrThrow({
    where: { id },
    select: { publicCode: true },
  });
  return row.publicCode;
}

function phone(seq: number): string {
  const national = `780558${String(seq).padStart(4, '0')}`;
  // Recorded in the form the database stores, at the moment of issue, so the teardown
  // deletes exactly what this run created.
  issuedPhones.add(`${E164_COUNTRY_PREFIX}${national}`);
  return national;
}

describe('POST /join — success', () => {
  it('answers 200 with the money formatted once and no card data', async () => {
    const code = await publishedDrop();

    const response = await callPost(code, { phone: phone(1), qty: 2, consented: true });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe('AUTHORIZED');
    expect(body.qty).toBe(2);
    // 2 × 1112.
    expect(body.amountCents).toBe(2224);
    expect(body.amountLabel).toBe('$22.24');
    expect(body.alreadyJoined).toBe(false);

    // The full phone number must never come back. Only the last four, so a diner
    // can spot their own typo.
    expect(body.phoneLast4).toBe('0001');
    expect(JSON.stringify(body)).not.toContain('7805580001');

    // Nothing cacheable: a quantity that just moved is not a resource.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns the diner a link to their own order, and it is not the code', async () => {
    // The wire contract the confirmation renders. It was missing entirely until now:
    // the response carried `participantId` and no component ever read it, so a diner
    // who closed the tab had no route back to the page holding their redemption code.
    const code = await publishedDrop();

    const response = await callPost(code, { phone: phone(20), qty: 2 });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(typeof body.orderPath).toBe('string');
    expect(body.orderPath.startsWith(`/d/${code}/mine?t=`)).toBe(true);

    // A path, not an absolute URL: the browser is already on this origin, so a
    // relative link cannot be wrong about the host or the scheme.
    expect(body.orderPath.startsWith('http')).toBe(false);

    // And the token is the read-only participant token, not the redemption code.
    // If these ever became the same value, whoever holds the link holds the food.
    const token = new URL(body.orderPath, 'https://example.test').searchParams.get('t') ?? '';
    expect(token.startsWith('p1.')).toBe(true);
  });

  it('carries a finished cutoff label, not just the instant', async () => {
    // The bug: the confirmation printed "people join by **undefined**" because this
    // body sent only `cutoffAt` while the component read `cutoffLabel`.
    //
    // The `satisfies JoinSuccessBody` in the route makes that a compile error now —
    // which is the real fix. This test exists because a type is not a runtime check
    // and a route test that never inspects the key would let the field go missing
    // again behind a cast.
    const code = await publishedDrop();

    const response = await callPost(code, { phone: phone(22), qty: 1 });
    const body = await response.json();

    expect(typeof body.cutoffLabel).toBe('string');
    expect(body.cutoffLabel).not.toContain('undefined');
    // A weekday and a clock time — what a diner reads — rather than the ISO string.
    expect(body.cutoffLabel).toMatch(
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) \d{1,2}:\d{2}\s(AM|PM)$/,
    );
    // The instant stays on the wire: a caller that needs to compute should not have
    // to parse a human sentence back into a date.
    expect(typeof body.cutoffAt).toBe('string');
    expect(new Date(body.cutoffAt).toString()).not.toBe('Invalid Date');
  });

  it('returns a link on a repeated submit too', async () => {
    // A diner who refreshes has the same need to get back. `alreadyJoined` must not
    // be a branch that silently drops the one thing that makes the page reachable.
    const code = await publishedDrop();

    await callPost(code, { phone: phone(21), qty: 1 });
    const second = await callPost(code, { phone: phone(21), qty: 1 });

    const body = await second.json();
    expect(body.alreadyJoined).toBe(true);
    expect(body.orderPath.startsWith(`/d/${code}/mine?t=`)).toBe(true);
  });

  it('answers 200 and alreadyJoined on a second submit', async () => {
    const code = await publishedDrop();

    const first = await callPost(code, { phone: phone(2), qty: 1 });
    const second = await callPost(code, { phone: phone(2), qty: 1 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const body = await second.json();
    expect(body.alreadyJoined).toBe(true);
  });

  it('hands FR-408’s confirmation to the sender, once per real join', async () => {
    // The assertion that closes the gap this whole slice was about. Every other test
    // above proves the HTTP surface; this one proves the route actually *wires* the
    // notification seam, which is the thing four earlier slices built and never
    // connected. A route that resolved a sender and forgot to pass it would still
    // answer 200 everywhere else.
    const code = await publishedDrop();

    const response = await callPost(code, { phone: phone(31), qty: 2, consented: true });
    expect(response.status).toBe(200);

    const confirmations = sentMessages.filter((message) => message.kind === 'JOIN_CONFIRMATION');
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.body).toContain('2 plates');
    // The recipient is the number that joined, normalised to E.164 by the service.
    // Built from the same helper the request used rather than retyped — the first
    // version of this line retyped the digits and lost one, which is the same class of
    // mistake as asserting an amount you have not computed.
    expect(confirmations[0]?.phone).toBe(`+1${phone(31)}`);

    // A replay does not send a second "you're in".
    await callPost(code, { phone: phone(31), qty: 2, consented: true });
    expect(sentMessages.filter((message) => message.kind === 'JOIN_CONFIRMATION')).toHaveLength(1);
  });

  it('sends no confirmation when the diner did not consent', async () => {
    const code = await publishedDrop();

    const response = await callPost(code, { phone: phone(32), qty: 1, consented: false });
    expect(response.status).toBe(200);
    expect(sentMessages.filter((message) => message.kind === 'JOIN_CONFIRMATION')).toHaveLength(0);
  });
});

describe('POST /join — refusals carry the status a phone branches on', () => {
  it('404 for a code that does not exist', async () => {
    const response = await callPost('NOSUCH', { phone: phone(10), qty: 1 });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.reason).toBe('NOT_FOUND');
    // Finished copy, so the screen has one thing to render.
    expect(body.copy.title).toBeTruthy();
    expect(body.copy.detail).toBeTruthy();
  });

  it('422 for a phone number that is not one', async () => {
    const code = await publishedDrop();

    const response = await callPost(code, { phone: 'call me', qty: 1 });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.reason).toBe('BAD_PHONE');
    // The field is named so a form can highlight it.
    expect(body.fieldErrors.phone).toBeTruthy();
  });

  it('422 for a quantity above the hard ceiling, before any database work', async () => {
    const code = await publishedDrop();

    // 21 is above MAX_JOIN_QTY, so zod refuses it. The message must not claim to
    // know this drop's limit, which it has not read.
    const response = await callPost(code, { phone: phone(11), qty: 21 });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.fieldErrors.qty).toContain('20');
  });

  it('422 for a quantity above the drop’s own cap', async () => {
    const code = await publishedDrop({ maxPerCustomer: 2 });

    const response = await callPost(code, { phone: phone(12), qty: 3 });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.reason).toBe('BAD_QTY');
  });

  it('409 for a drop that is already full', async () => {
    const code = await publishedDrop({ minQty: 1, maxQty: 1 });

    const winner = await callPost(code, { phone: phone(13), qty: 1 });
    const loser = await callPost(code, { phone: phone(14), qty: 1 });

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(409);
    const body = await loser.json();
    expect(['SOLD_OUT', 'NOT_ENOUGH_LEFT']).toContain(body.reason);
  });

  it('409 for a drop past its cutoff', async () => {
    const code = await publishedDrop({
      minQty: 2,
      cutoffAt: new Date(Date.now() - 60 * 1000),
    });

    const response = await callPost(code, { phone: phone(15), qty: 1 });

    expect(response.status).toBe(409);
    const body = await response.json();
    // Below its minimum with the cutoff gone: it failed, and the copy says nobody
    // was charged. That is the sentence FR-306 requires.
    expect(body.reason).toBe('FAILED');
    expect(body.copy.detail).toContain('nobody was charged');
  });

  it('402 for a declined card', async () => {
    const code = await publishedDrop();
    activePort = {
      async createJoinAuthorisation() {
        return { status: 'DECLINED' as const, declineCode: 'insufficient_funds' };
      },
    };

    const response = await callPost(code, { phone: phone(16), qty: 1 });

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.reason).toBe('PAYMENT_DECLINED');
    expect(body.copy.detail).toContain('Nothing has been charged');
  });

  it('503 when payments are not configured, and never reaches the port', async () => {
    stripeConfigured = false;
    const code = await publishedDrop();
    let portCalls = 0;
    activePort = {
      async createJoinAuthorisation() {
        portCalls += 1;
        return { status: 'DECLINED' as const, declineCode: 'should_not_happen' };
      },
    };

    const response = await callPost(code, { phone: phone(17), qty: 1 });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.reason).toBe('PAYMENTS_NOT_CONFIGURED');
    // The refusal happens before the port: a fake port in a keyless environment
    // must never be the thing that takes a join.
    expect(portCalls).toBe(0);

    // And no row was written at all.
    const rows = await prisma.customer.count({ where: { phone: `+1${phone(17)}` } });
    expect(rows).toBe(0);
  });

  it('422 for a body that is not JSON', async () => {
    const code = await publishedDrop();
    const route = await loadRoute();
    const request = new NextRequest(`http://localhost/api/public/drops/${code}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json{',
    });

    const response = await route.POST(request, { params: Promise.resolve({ code }) });

    expect(response.status).toBe(422);
  });

  it('422 when qty is missing entirely', async () => {
    const code = await publishedDrop();

    const response = await callPost(code, { phone: phone(18) });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.fieldErrors.qty).toBeTruthy();
  });
});
