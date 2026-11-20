/**
 * In-app /join — app-route probe (server layer).
 *
 * Drives the REAL public HTTP join route,
 * `src/app/api/public/drops/[code]/join/route.ts`, end-to-end against Stripe
 * test mode: the route parses the body, resolves the real join payment port
 * (`createJoinPaymentPort` → `realJoinPaymentPort`), creates a REAL
 * manual-capture hold on the drop's connected account, writes the real DB rows
 * (Customer + ConsentRecord + DropParticipant(AUTHORIZED)), and composes the
 * confirmation message (orderPath + cutoffLabel + amountLabel). Then it cancels
 * the hold and tears down every row it created, leaving zero residue.
 *
 * This is the sanctioned "server-layer app-route" slice: it proves the app route
 * writes a real app DB row and renders a real confirmation through the money
 * seam. It is deliberately NOT a browser diner tap — there is no Stripe.js
 * `JoinForm`, no `paymentMethodId` minted in a browser, no device walkthrough —
 * so `JOIN_FLOW_PROVEN_LIVE` must stay `false`. See docs/PROGRESS.md.
 *
 * Run: `npm run join:verify`  (== `tsx --conditions=react-server scripts/verify-join-app.ts`)
 * Requires: `STRIPE_SECRET_KEY` (sk_test_…) and `DATABASE_URL` in `.env`.
 * The connected account is set on the fixture merchant (`STRIPE_CONNECTED_ACCOUNT_ID`
 * is NOT read here — the route reads it from `merchant.stripeAccountId`).
 * `resolveSender()` returns a no-op `loggingSender()` because `TWILIO_AUTH_TOKEN` /
 * `TWILIO_FROM_NUMBER` are absent, so no SMS is sent and no network call is made
 * to Twilio.
 */

import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

import { prisma } from '../src/lib/db/prisma';
import { forMerchant, isTestMode } from '../src/lib/payments/stripe';
import { normalisePhone } from '../src/lib/join/rules';
import { settlementFixtures } from '../src/lib/settlement/__tests__/settlement-fixtures';

const CONNECTED_ACCOUNT = 'acct_1UYwu06TRDhMU3fu'; // existing test-mode connected account
const PAYMENT_METHOD = 'pm_card_visa'; // public test PaymentMethod id, not a secret
const QTY = 2;
const DEAL_PRICE_CENTS = 1600;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

type State = {
  dropId: string | null;
  itemId: string | null;
  merchantId: string | null;
  customerId: string | null;
  participantId: string | null;
  paymentIntentId: string | null;
  e164: string | null;
};

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`);
  throw new Error(message);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}

async function main(state: State): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  const prefix = `joinapp-${tag}`;

  // Parity with verify-stripe.ts: refuse to run against a live (non-test) key.
  // This script creates a real Stripe hold, so it must never touch production.
  if (!isTestMode()) {
    fail(
      'STRIPE_SECRET_KEY is present but is not a test-mode key (sk_test_… / rk_test_…).\n' +
        'This script creates a real Stripe hold. It refuses to run against live keys.',
    );
  }

  const fixtures = settlementFixtures(prefix);

  state.merchantId = await fixtures.merchant(CONNECTED_ACCOUNT);
  state.itemId = await fixtures.item(state.merchantId);

  const now = Date.now();
  state.dropId = await fixtures.drop({
    merchantId: state.merchantId,
    menuItemId: state.itemId,
    dealPriceCents: DEAL_PRICE_CENTS,
    minQty: 4,
    maxQty: 10,
    status: 'PUBLISHED',
    // Joinable window: published, cutoff safely in the future, pickup window after it.
    cutoffAt: new Date(now + 2 * 60 * 60 * 1000),
    windowStart: new Date(now + 3 * 60 * 60 * 1000),
    windowEnd: new Date(now + 5 * 60 * 60 * 1000),
  });

  const drop = await prisma.drop.findUniqueOrThrow({
    where: { id: state.dropId },
    select: { publicCode: true },
  });
  const publicCode = drop.publicCode;

  const phone = `780${String(Date.now()).slice(-7)}`;
  const norm = normalisePhone(phone);
  assert(norm.ok, `phone ${phone} did not normalise`);
  state.e164 = norm.e164;

  const routeUrl = pathToFileURL(
    join(REPO_ROOT, 'src/app/api/public/drops/[code]/join/route.ts'),
  ).href;
  const routeMod = await import(routeUrl);
  const POST = (routeMod as { POST?: unknown }).POST;
  assert(typeof POST === 'function', 'route module did not export POST');

  const body = {
    phone,
    qty: QTY,
    paymentMethodId: PAYMENT_METHOD,
    consented: true,
    name: 'Join App Probe',
  };

  const req = new NextRequest(
    `http://localhost:3001/api/public/drops/${publicCode}/join`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  const res = await (POST as (r: unknown, ctx: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>)(
    req,
    { params: Promise.resolve({ code: publicCode }) },
  );
  const status = res.status;
  const json = (await res.json()) as Record<string, unknown>;

  assert(status === 200, `route returned ${status} (expected 200): ${JSON.stringify(json)}`);
  assert(json.ok === true, `body.ok was not true: ${JSON.stringify(json)}`);
  assert(
    json.status === 'AUTHORIZED',
    `body.status was ${String(json.status)} (expected AUTHORIZED)`,
  );
  assert(
    json.amountCents === QTY * DEAL_PRICE_CENTS,
    `amountCents ${String(json.amountCents)} != ${QTY * DEAL_PRICE_CENTS}`,
  );
  assert(
    typeof json.amountLabel === 'string' && (json.amountLabel as string).length > 0,
    'amountLabel missing',
  );
  assert(
    typeof json.phoneLast4 === 'string' && (json.phoneLast4 as string).length === 4,
    'phoneLast4 missing',
  );
  assert(
    typeof json.orderPath === 'string' && (json.orderPath as string).length > 0,
    'orderPath (confirmation link) missing',
  );
  assert(
    typeof json.cutoffLabel === 'string' && (json.cutoffLabel as string).length > 0,
    'cutoffLabel (confirmation copy) missing',
  );

  state.participantId = json.participantId as string;
  assert(
    typeof state.participantId === 'string' && state.participantId.length > 0,
    'participantId missing',
  );

  // Verify the DB rows the app route actually wrote.
  const participant = await prisma.dropParticipant.findUniqueOrThrow({
    where: { id: state.participantId },
    select: { authStatus: true, paymentIntentId: true, amountCents: true, qty: true },
  });
  assert(
    participant.authStatus === 'AUTHORIZED',
    `DB participant authStatus=${participant.authStatus}`,
  );
  assert(
    typeof participant.paymentIntentId === 'string' &&
      participant.paymentIntentId.startsWith('pi_'),
    `DB paymentIntentId=${participant.paymentIntentId}`,
  );
  state.paymentIntentId = participant.paymentIntentId;

  const customer = await prisma.customer.findUniqueOrThrow({
    where: { phone: state.e164 },
    select: { id: true },
  });
  state.customerId = customer.id;
  assert(state.customerId.length > 0, 'customer row missing');

  const consentCount = await prisma.consentRecord.count({ where: { phone: state.e164 } });
  assert(
    consentCount === 1,
    `expected exactly 1 consentRecord for ${state.e164}, got ${consentCount}`,
  );

  const authorizedForDrop = await prisma.dropParticipant.count({
    where: { dropId: state.dropId, authStatus: 'AUTHORIZED' },
  });
  assert(authorizedForDrop >= 1, 'no AUTHORIZED participant persisted for the drop');

  process.stdout.write(
    `JOIN APP ROUTE PROVED: code=${publicCode} pi=${state.paymentIntentId} ` +
      `participant=${state.participantId} customer=${state.customerId} ` +
      `amountCents=${json.amountCents} label=${json.amountLabel} ` +
      `phoneLast4=${json.phoneLast4} orderPath=${json.orderPath}\n`,
  );
}

async function teardown(state: State): Promise<void> {
  try {
    if (state.paymentIntentId) {
      try {
        await forMerchant(CONNECTED_ACCOUNT).paymentIntents.cancel(state.paymentIntentId);
        process.stdout.write(`cancelled hold ${state.paymentIntentId}\n`);
      } catch (err) {
        process.stderr.write(
          `warn: could not cancel hold ${state.paymentIntentId}: ${String(err)}\n`,
        );
      }
    }

    if (state.dropId) {
      // Children first: participant (Restrict FK to Customer), then consent, then the
      // drop (cascades orders). Matches scripts/reset-residue.mjs ordering.
      await prisma.dropParticipant.deleteMany({ where: { dropId: state.dropId } });
      if (state.e164) {
        await prisma.consentRecord.deleteMany({ where: { phone: state.e164 } });
      }
      await prisma.drop.deleteMany({ where: { id: state.dropId } });
    }
    if (state.e164) {
      await prisma.customer.deleteMany({ where: { phone: state.e164 } });
    }
    if (state.itemId) {
      await prisma.menuItem.deleteMany({ where: { id: state.itemId } });
    }
    if (state.merchantId) {
      const mu = await prisma.merchantUser.findFirst({
        where: { merchantId: state.merchantId },
        select: { userId: true },
      });
      await prisma.merchant.deleteMany({ where: { id: state.merchantId } });
      if (mu?.userId) {
        await prisma.user.deleteMany({ where: { id: mu.userId } });
      }
    }
  } catch (err) {
    process.stderr.write(`teardown error: ${String(err)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

(async () => {
  const state: State = {
    dropId: null,
    itemId: null,
    merchantId: null,
    customerId: null,
    participantId: null,
    paymentIntentId: null,
    e164: null,
  };

  let ok = false;
  try {
    await main(state);
    ok = true;
  } catch (err) {
    process.stderr.write(
      `JOIN APP PROBE FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  } finally {
    await teardown(state);
  }

  if (ok) {
    process.stdout.write(
      '\nVERIFIED — in-app /join app-route probe (server layer):\n' +
        '  POST /api/public/drops/[code]/join drove the REAL join payment port,\n' +
        '  created a REAL Stripe manual-capture hold on the connected account,\n' +
        '  wrote Customer + ConsentRecord + DropParticipant(AUTHORIZED) rows,\n' +
        '  and composed the confirmation (orderPath + cutoffLabel + amountLabel).\n' +
        '  The hold was cancelled and every row torn down (zero residue).\n' +
        '  NOTE: this is NOT a browser diner tap — JOIN_FLOW_PROVEN_LIVE stays false.\n',
    );
    process.exit(0);
  }
  process.exit(1);
})();
