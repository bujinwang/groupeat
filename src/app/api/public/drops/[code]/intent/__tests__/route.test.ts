import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logging/logger';
import { prisma } from '@/lib/db/prisma';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * `POST /api/public/drops/[code]/intent` — the client secret behind the card form.
 *
 * ## Why this route, after the Stripe webhook
 *
 * It is the only **anonymous** endpoint in the app that creates a real
 * `PaymentIntent` on a merchant's connected account. No session, no phone number, no
 * cookie — anyone holding a public code can make it mint an intent, and the diner's
 * card is later authorised against whatever amount it carries. Two things follow that
 * no other route in this repo has:
 *
 *   - the **amount** must come from the server's own snapshot, never from the body
 *     (ADR-002). `quoteJoin` is covered by `quote.test.ts`; what is not covered is
 *     that this route passes the body's *quantity* through and nothing else;
 *   - the **account** the intent is created on must be the merchant's
 *     (`forMerchant(quote.stripeAccountId)`). Calling `platform()` here — or
 *     `forMerchant` with an account read from the request — would put a diner's hold
 *     on the wrong account, which Stripe accepts.
 *
 * Neither is visible to `quote.test.ts`, because both are statements about how the
 * route talks to the SDK rather than about the quote.
 *
 * ## What is mocked, and what that leaves real
 *
 * Only `@/lib/payments/stripe`, replaced with a recorder, for the same reason the
 * join suite does it: there is no key in `.env`, and the module is reached through
 * `await import()` precisely so a suite can stand behind it. `quoteJoin`,
 * `platformFeeCentsForOrder`, `resolveJoinMoney` and the Prisma reads all run for
 * real against real rows, so the amounts asserted below are computed by production
 * code rather than restated by a fixture.
 *
 * The recorder captures the **create arguments**, which is the whole point: an
 * assertion on the returned body would pass for an intent created with any amount,
 * on any account, with any capture method.
 *
 * ## What a mock cannot prove
 *
 * No card has ever been held against this route — the same limitation as the join
 * slice. `quote.test.ts` proves the quote and the join authorise the same cents; this
 * file proves the *intent* is created for those cents. Whether Stripe accepts the
 * request is a live question, and `JOIN_FLOW_PROVEN_LIVE` remains `false`.
 */

vi.mock('server-only', () => ({}));

/**
 * The logger, replaced so the reason is observable — and to keep the suite quiet.
 *
 * Three of this route's five outcomes carry no distinguishing body: a
 * `PAYMENTS_NOT_CONFIGURED` refusal is the same JSON whether the key is missing or
 * the merchant has no Connect account, and `PRICE_UNAVAILABLE` is a 500 for both a
 * missing client secret and unusable pricing data. The log line is the only place
 * the difference exists.
 */
vi.mock('@/lib/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * What the route asked Stripe to do.
 *
 * Hoisted because `vi.mock` factories are lifted above this file's `const`s, and a
 * factory closing over a plain `const` throws "Cannot access before initialization"
 * while the module graph is being built. Fourth time this repo has needed the note.
 */
const stripe = vi.hoisted(() => ({
  configured: true,
  /** Every `forMerchant(accountId)` call, in order. */
  accounts: [] as string[],
  /** Every `paymentIntents.create` payload, in order. */
  creates: [] as Record<string, unknown>[],
  /** Set to make `create` reject, as the SDK does on a bad request. */
  failWith: null as Error | null,
  /** Overrides the created intent. `null` secret exercises the defensive branch. */
  clientSecret: 'pi_test_secret_abc123' as string | null,
}));

vi.mock('@/lib/payments/stripe', () => ({
  isStripeConfigured: () => stripe.configured,
  forMerchant: (accountId: string) => {
    stripe.accounts.push(accountId);
    return {
      paymentIntents: {
        async create(payload: Record<string, unknown>) {
          stripe.creates.push(payload);
          if (stripe.failWith) {
            throw stripe.failWith;
          }
          return { id: 'pi_test_1', client_secret: stripe.clientSecret };
        },
      },
    };
  },
  // Reached only if the route ever takes the platform path, which would be the bug
  // this suite exists to catch. Throwing names it rather than returning a plausible
  // client.
  platform: () => {
    throw new Error('the intent endpoint must never use the platform client');
  },
}));

const PREFIX = `qi${Date.now().toString(36).slice(-5)}`;
const PUBLISHABLE = 'pk_test_51PublishableKeyForTheIntentSuite';

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;
let noAccountMerchantId: string;

/** `1112` is the repo's standard odd price: it keeps per-unit arithmetic visible. */
async function publishedDrop(
  overrides: {
    merchant?: string;
    menuItemId?: string;
    minQty?: number;
    maxQty?: number;
    maxPerCustomer?: number;
    dealPriceCents?: number;
    status?: 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | 'FAILED' | 'LOCKED';
    cutoffAt?: Date;
    /** Replaces the snapshot wholesale, to make pricing unreadable. */
    snapshot?: unknown;
  } = {},
): Promise<{ code: string; id: string }> {
  const id = await fixtures.drop({
    merchantId: overrides.merchant ?? merchantId,
    menuItemId: overrides.menuItemId ?? itemId,
    dealPriceCents: overrides.dealPriceCents ?? 1112,
    minQty: overrides.minQty ?? 2,
    maxQty: overrides.maxQty ?? 10,
    status: overrides.status ?? 'PUBLISHED',
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
  if (overrides.snapshot !== undefined) {
    // `guardrailSnapshot` is a Json column, so this writes exactly what a corrupted
    // row would contain rather than a value the fixture builder would have refused.
    await prisma.drop.update({
      where: { id },
      data: { guardrailSnapshot: overrides.snapshot as never },
    });
  }

  const row = await prisma.drop.findUniqueOrThrow({
    where: { id },
    select: { publicCode: true },
  });
  return { code: row.publicCode, id };
}

function post(code: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/public/drops/${code}/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Loads the route fresh, so the module-level mock bindings are rebuilt each time. */
async function callPost(code: string, body: unknown): Promise<Response> {
  const route = await import('@/app/api/public/drops/[code]/intent/route');
  return route.POST(post(code, body), { params: Promise.resolve({ code }) });
}

type RefusalBody = {
  error: string;
  reason: string;
  copy: { title: string; detail: string };
};

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant(`acct_test_intent_${PREFIX}`);
  noAccountMerchantId = await fixtures.merchant(null);
  const item = await fixtures.item(merchantId);
  itemId = item;
});

afterAll(async () => {
  await fixtures.cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  stripe.configured = true;
  stripe.accounts.length = 0;
  stripe.creates.length = 0;
  stripe.failWith = null;
  stripe.clientSecret = 'pi_test_secret_abc123';
  process.env.STRIPE_SECRET_KEY = 'sk_test_51IntentSuiteKey';
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = PUBLISHABLE;
});

describe('the quote endpoint is anonymous, and that is the point', () => {
  it('issues a secret with no session, no phone and no cookie', async () => {
    // Stated as a test rather than assumed, because the obvious way to harden this
    // endpoint later — require a session, or a phone number — would break the flow it
    // exists for. The Element mounts before the diner has typed anything.
    const { code } = await publishedDrop();

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(200);
    // No auth header was sent, and the response must not start asking for one.
    expect(response.headers.get('www-authenticate')).toBeNull();
    const body = await response.json();
    expect(body.clientSecret).toBe('pi_test_secret_abc123');
  });

  it('carries only the quantity, and rejects a body that tries to price itself', async () => {
    // ADR-002: the server authors money. Sending an amount is not honoured, and the
    // diner is charged what the drop says. This is the assertion `quote.test.ts`
    // cannot make, because the tampering happens in an HTTP body.
    const { code } = await publishedDrop({ dealPriceCents: 1112 });

    const response = await callPost(code, {
      qty: 2,
      amountCents: 1,
      unitPriceCents: 1,
      dealPriceCents: 1,
      platformFeeCents: 0,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    // 2 × 1112, computed by `resolveJoinMoney`, not echoed from the body.
    expect(body.amountCents).toBe(2224);
    expect(body.unitPriceCents).toBe(1112);
    expect(stripe.creates[0]?.amount).toBe(2224);
  });
});

describe('the intent is created on the merchant’s account, unconfirmed', () => {
  it('creates it against the drop’s connected account with a manual capture', async () => {
    const { code } = await publishedDrop();

    await callPost(code, { qty: 2 });

    // ADR-001: direct charges. The account here is read from the drop's merchant row,
    // not from the request.
    expect(stripe.accounts).toEqual([`acct_test_intent_${PREFIX}`]);
    expect(stripe.creates).toHaveLength(1);

    const create = stripe.creates[0]!;
    expect(create.amount).toBe(2224);
    expect(create.currency).toBe('cad');
    // FR-404: a quote that could capture is one argument away from charging a diner
    // the moment they open the page.
    expect(create.capture_method).toBe('manual');
    // No card exists yet. A confirmed intent here would need one.
    expect(create).not.toHaveProperty('confirm');
    expect(create).not.toHaveProperty('payment_method');
    // Redirect-based methods would leave the Element with nowhere to go in this flow.
    expect(create.automatic_payment_methods).toEqual({ enabled: true, allow_redirects: 'never' });
  });

  it('puts nothing but ids in metadata, because the dashboard is a log line', async () => {
    const { code, id } = await publishedDrop();

    await callPost(code, { qty: 2 });

    // A drop id is opaque. A phone number or an email here would be visible to
    // anyone with dashboard access, which is the rule `logger.ts` enforces for logs
    // and nothing enforces for Stripe metadata.
    expect(stripe.creates[0]?.metadata).toEqual({ dropId: id });
  });

  it('creates no participant, no customer and no order', async () => {
    // The claim `quoteJoin`'s own suite makes; repeated here because the route is
    // where an `intent` row or a `PENDING` participant would be added by someone
    // reading "the Element needs a secret" and reaching for a record to hang it on.
    // A `PENDING` participant counts toward capacity, so abandoned page views would
    // consume plates.
    const { code, id } = await publishedDrop();

    const before = await prisma.dropParticipant.count({ where: { dropId: id } });
    await callPost(code, { qty: 2 });
    const after = await prisma.dropParticipant.count({ where: { dropId: id } });

    expect(before).toBe(0);
    expect(after).toBe(0);
  });

  it('answers with the same cents it sent to Stripe', async () => {
    // The two halves of the response must not be able to disagree: the diner reads
    // `amountLabel` on the card form while Stripe holds `amount`. A route that
    // formatted the label from a different number would show one price and charge
    // another, and both halves would look right in isolation.
    const { code } = await publishedDrop({ dealPriceCents: 1234 });

    const response = await callPost(code, { qty: 3 });
    const body = await response.json();

    // 3 × 1234 = 3702.
    expect(body.amountCents).toBe(3702);
    expect(body.amountLabel).toBe('$37.02');
    expect(stripe.creates[0]?.amount).toBe(3702);
  });

  it('returns the publishable key so a deployment needs no rebuild', async () => {
    // The key is public by design. Returning it rather than baking it in is what lets
    // keys be added to a running deployment; the assertion also pins that the
    // *secret* never appears in the body.
    const { code } = await publishedDrop();

    const response = await callPost(code, { qty: 2 });
    const body = await response.json();

    expect(body.publishableKey).toBe(PUBLISHABLE);
    expect(JSON.stringify(body)).not.toContain('sk_test_51IntentSuiteKey');
  });

  it('is not cacheable, because a quantity just moved', async () => {
    const { code } = await publishedDrop();

    const response = await callPost(code, { qty: 2 });

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('quantity validation happens before anything is created', () => {
  const BAD = [
    ['a missing quantity', {}],
    ['a zero', { qty: 0 }],
    ['a negative', { qty: -2 }],
    ['a fraction', { qty: 1.5 }],
    ['a string', { qty: '2' }],
    ['a null', { qty: null }],
    ['an empty object', {}],
  ] as const;

  it.each(BAD)('refuses %s with 422 and creates nothing', async (_label, body) => {
    const { code } = await publishedDrop();

    const response = await callPost(code, body);
    expect(response.status).toBe(422);

    const parsed = (await response.json()) as RefusalBody;
    expect(parsed.reason).toBe('BAD_QTY');
    // The diner is told to check the quantity, not that the drop is gone.
    expect(parsed.copy.title).toBe('Check the quantity');
    // Nothing reached Stripe: a bad quantity must not cost a PaymentIntent.
    expect(stripe.creates).toEqual([]);
    expect(stripe.accounts).toEqual([]);
  });

  it('refuses a body that is not JSON at all', async () => {
    // `request.json()` throws on malformed input, and the route catches it into a
    // 422 rather than letting `errorResponse` turn it into a 500 — a diner whose
    // browser sent something odd should be told to retry, not shown an internal error.
    const { code } = await publishedDrop();

    const response = await callPost(code, 'not json{');

    expect(response.status).toBe(422);
    expect(((await response.json()) as RefusalBody).reason).toBe('BAD_QTY');
    expect(stripe.creates).toEqual([]);
  });

  it('refuses a bad quantity before it looks the drop up', async () => {
    // ## Why this test looks the way it does, after two wrong versions
    //
    // The claim is that the route's hand-written `qty` guard is load-bearing rather
    // than a second copy of `checkQty` inside `quoteJoin`. Three orderings look
    // interchangeable and only one of them can be observed:
    //
    //   - *Bad qty on a cancelled drop.* Tried first; the mutant survived. `quoteJoin`
    //     runs `checkQty` **before** `refusalFromBlocked`, so the diner gets `422
    //     BAD_QTY` whether or not the route checked first. Two guards, one outcome.
    //   - *Bad qty as a string or a fraction.* Same thing — every value the route
    //     rejects is also rejected by `checkQty`, with the same reason and status.
    //   - *Bad qty on a deployment with no Stripe key.* This one distinguishes them.
    //     The route checks the quantity **before** the configuration gate, so the
    //     diner is told to fix their quantity. Delete the guard and the order flips:
    //     the config gate answers `503 PAYMENTS_NOT_CONFIGURED` and the diner is told
    //     card payments are unavailable — a reason they cannot act on, for a problem
    //     that is not theirs.
    //
    // That is the difference the guard buys, and it is the only one, so the fixture
    // has to be the unconfigured deployment.
    stripe.configured = false;
    const { code } = await publishedDrop({ status: 'CANCELLED' });

    const response = await callPost(code, { qty: 0 });

    expect(response.status).toBe(422);
    // `BAD_QTY` rather than `PAYMENTS_NOT_CONFIGURED`: the more specific complaint
    // wins, and it is the one the diner can act on. Read once — a `Response` body
    // cannot be consumed twice, which is how the first version of these two lines
    // failed with "Body is unusable" instead of an assertion.
    const body = (await response.json()) as RefusalBody;
    expect(body.reason).toBe('BAD_QTY');
    expect(body.reason).not.toBe('PAYMENTS_NOT_CONFIGURED');
  });
});

describe('a draft is invisible, so a code cannot be probed', () => {
  it('answers 404 for a draft, identically to a code that does not exist', async () => {
    // The rule `NOT_FOUND` exists to enforce. It matters more now than it did: the
    // visibility filter was widened from `PUBLISHED` to `PUBLIC_VISIBLE_STATUSES` in
    // this same slice, so "does widening it leak anything" is a question this test has
    // to answer rather than assume. A `DRAFT` is the only status the public page also
    // hides, so it is the only one that can leak.
    const { code: draftCode } = await publishedDrop({ status: 'DRAFT' });
    const missingCode = `${PREFIX}NOSUCHCODE`;

    const draftResponse = await callPost(draftCode, { qty: 2 });
    const missingResponse = await callPost(missingCode, { qty: 2 });

    expect(draftResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);

    // Byte-identical bodies, because any difference at all lets a caller tell a
    // guessed-but-real code from a guessed-and-wrong one.
    expect(await draftResponse.json()).toEqual(await missingResponse.json());
    expect(stripe.creates).toEqual([]);
  });
});

describe('the configuration gates', () => {
  it('answers 503 when Stripe is not configured', async () => {
    stripe.configured = false;
    const { code } = await publishedDrop();

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(503);
    expect(((await response.json()) as RefusalBody).reason).toBe('PAYMENTS_NOT_CONFIGURED');
    expect(logger.info).toHaveBeenCalledWith('join.refused', {
      reason: 'PAYMENTS_NOT_CONFIGURED',
    });
    expect(stripe.creates).toEqual([]);
  });

  it('answers 503 when the publishable key is missing', async () => {
    // The mirror of the gate above, and not redundant: the Element cannot mount
    // without the publishable key, so answering 200 with `publishableKey: undefined`
    // would render a blank card form — the failure mode that looks like a network
    // problem to the diner and like a working endpoint to ops.
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    const { code } = await publishedDrop();

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(503);
    expect(((await response.json()) as RefusalBody).reason).toBe('PAYMENTS_NOT_CONFIGURED');
    expect(stripe.creates).toEqual([]);
  });

  it('answers 503 when the merchant has no Connect account', async () => {
    // A merchant mid-onboarding is `PENDING` with no account id. `quoteJoin` refuses
    // rather than returning a quote with a null account, which is what keeps
    // `forMerchant()` from being called with nothing.
    const { code } = await publishedDrop({ merchant: noAccountMerchantId });

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(503);
    expect(((await response.json()) as RefusalBody).reason).toBe('PAYMENTS_NOT_CONFIGURED');
    expect(stripe.accounts).toEqual([]);
  });
});

describe('drop-state refusals', () => {
  it('answers 404 for a code that does not exist', async () => {
    const response = await callPost(`${PREFIX}NOSUCHCODE`, { qty: 2 });

    expect(response.status).toBe(404);
    const body = (await response.json()) as RefusalBody;
    expect(body.reason).toBe('NOT_FOUND');
    // The copy must not distinguish "no such drop" from "not published".
    expect(body.copy.title).toBe('This offer is not available');
    expect(stripe.creates).toEqual([]);
  });

  it('answers 409 once the cutoff has passed', async () => {
    const { code } = await publishedDrop({
      cutoffAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(409);
    const body = (await response.json()) as RefusalBody;
    expect(body.reason).toBe('CLOSED');
    expect(body.copy.title).toBe('Ordering has closed');
    expect(stripe.creates).toEqual([]);
  });

  it('answers 409 when every plate is taken', async () => {
    const { code, id } = await publishedDrop({ minQty: 2, maxQty: 2 });
    await fixtures.participant({ dropId: id, qty: 2, authStatus: 'PENDING' });

    const response = await callPost(code, { qty: 1 });

    expect(response.status).toBe(409);
    const body = (await response.json()) as RefusalBody;
    expect(body.reason).toBe('SOLD_OUT');
    expect(stripe.creates).toEqual([]);
  });

  it('answers 409 when fewer plates are left than the quantity asked for', async () => {
    // Distinct from `SOLD_OUT` because the sentence is different: "try a smaller
    // quantity" is actionable, "sold out" is not. Getting this wrong tells a diner
    // there is nothing left when there are two plates.
    const { code, id } = await publishedDrop({ minQty: 2, maxQty: 4 });
    await fixtures.participant({ dropId: id, qty: 3, authStatus: 'AUTHORIZED' });

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(409);
    const body = (await response.json()) as RefusalBody;
    expect(body.reason).toBe('NOT_ENOUGH_LEFT');
    expect(body.copy.detail).toContain('smaller quantity');
    expect(stripe.creates).toEqual([]);
  });

  it('answers 409 for a cancelled drop, and names the cancellation', async () => {
    // FR-902 writes `CANCELLED`, and this route has a five-line comment explaining
    // why it maps to its own reason rather than to `CLOSED`. The reason it needs its
    // own sentence: a diner told "ordering has closed" about a drop the restaurant
    // called off goes looking for a deadline that never mattered.
    //
    // **This test failed on the code as written.** `quoteJoin` filters
    // `status: { in: ['PUBLISHED'] }`, so a `CANCELLED` drop answered `NOT_FOUND`
    // ("check the link — it may have been mistyped") and the `CANCELLED` arm, with
    // its comment, was unreachable. `joinDrop` locks the row without a status filter
    // and refuses with `CANCELLED` correctly, so the page and the API disagreed.
    const { code } = await publishedDrop({ status: 'CANCELLED' });

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(409);
    const body = (await response.json()) as RefusalBody;
    expect(body.reason).toBe('CANCELLED');
    expect(body.copy.title).toBe('This drop was cancelled');
    // The two facts a refunded diner needs: nobody was charged, and anyone who paid
    // has been made whole.
    expect(body.copy.detail).toMatch(/Nobody was charged/);
    expect(body.copy.detail).toMatch(/refunded/);
    expect(stripe.creates).toEqual([]);
  });

  it('answers 409 for a failed drop, which maps to CLOSED', async () => {
    // `FAILED` deliberately reuses `CLOSED` rather than earning a member: the honest
    // answer to "can I still get in" is no, and a diner who missed a failed drop has
    // nothing to act on. Pinned so that a future split of the vocabulary is a
    // decision rather than an accident.
    const { code } = await publishedDrop({ status: 'FAILED' });

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(409);
    expect(((await response.json()) as RefusalBody).reason).toBe('CLOSED');
    expect(stripe.creates).toEqual([]);
  });

  it('answers 409 for a drop that is published but already locked', async () => {
    // `LOCKED` is past the cutoff by definition, so it arrives as `CLOSED`. Covered
    // because `LOCKED` is a different status value than the cutoff test uses and
    // takes a different branch inside `resolveDropView`.
    const { code } = await publishedDrop({ status: 'LOCKED' });

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(409);
    expect(((await response.json()) as RefusalBody).reason).toBe('CLOSED');
  });
});

describe('pricing failures are 500s, not refusals about the diner', () => {
  it('answers 500 when the guardrail snapshot cannot be read', async () => {
    // A published drop carrying a snapshot this build cannot parse. The dish is fine
    // and the diner did nothing wrong, so a 4xx would be a lie; `feesFromSnapshot`
    // returns null rather than guessing, because charging a card on a guessed fee is
    // not the same act as displaying a guessed price.
    const { code, id } = await publishedDrop({ snapshot: { not: 'a guardrail snapshot' } });

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(500);
    expect(((await response.json()) as RefusalBody).reason).toBe('PRICE_UNAVAILABLE');
    // Logged with the drop id, so the data error is findable without waiting for a
    // diner to complain.
    expect(logger.error).toHaveBeenCalledWith('join.pricing_unavailable', { dropId: id });
    expect(stripe.creates).toEqual([]);
  });

  it('answers 500 rather than returning a null secret', async () => {
    // `client_secret` is always present on a real PaymentIntent, so this is the
    // "should be impossible" branch. Returning `null` would hand the Element an empty
    // string and render a blank card form with no message — the failure that costs
    // the most time to diagnose from a support ticket.
    stripe.clientSecret = null;
    const { code } = await publishedDrop();

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(500);
    expect(((await response.json()) as RefusalBody).reason).toBe('PRICE_UNAVAILABLE');
    expect(logger.error).toHaveBeenCalledWith('join.payment_unavailable', {
      reason: 'no_client_secret',
      operation: 'api/public/drops/intent',
    });
  });

  it('turns a Stripe failure into 500, not a leaked message', async () => {
    // A 502 from Stripe carries a message written for a developer, sometimes naming
    // the account. `errorResponse` maps anything unknown to a generic 500 and logs
    // only the error's name.
    stripe.failWith = new Error('No such destination: acct_test_leaky_message');
    const { code } = await publishedDrop();

    const response = await callPost(code, { qty: 2 });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('acct_test_leaky_message');
    expect(logger.error).toHaveBeenCalledWith('api.unhandled_error', {
      route: 'api/public/drops/intent',
      reason: 'Error',
    });
  });
});
