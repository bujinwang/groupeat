import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logging/logger';
import { prisma } from '@/lib/db/prisma';
import { platform } from '@/lib/payments/stripe';
import type { StripeAccountSnapshot } from '@/lib/payments/onboarding';

import { GET, POST, runtime } from '../route';

/**
 * `POST /api/webhooks/stripe` — the one endpoint whose caller is not a user.
 *
 * ## Why this route, out of eighteen without a suite
 *
 * Every other untested handler sits behind `requireMerchant`/`requireSession`, so a
 * bug there produces a wrong answer to a signed-in person who can complain. This one
 * has **no session check at all** — the signature is the authentication — and its
 * job is to decide whether a merchant can take money. A handler that accepted an
 * unsigned body would let anyone who can reach the URL set `Merchant.status` to
 * `ACTIVE`, which is the precondition M3's publish check reads.
 *
 * ## The real SDK, not a stub
 *
 * `Stripe.webhooks.generateTestHeaderString` and `constructEvent` are pure HMAC —
 * no network, no key, no clock beyond the tolerance window. So these tests sign a
 * payload the way Stripe does and let the production code verify it with the same
 * `stripe@23` code path Stripe's real deliveries take. The alternative — mocking
 * `platform().webhooks.constructEvent` — would have tested a stub that agrees with
 * itself, and every assertion below about rejection would be an assertion about my
 * own `vi.fn`.
 *
 * `STRIPE_SECRET_KEY` is absent from `.env`, so the suite supplies a syntactically
 * valid `sk_test_…` value. `platform()` therefore builds a genuine client; nothing
 * in this file causes it to make a request.
 *
 * ## What is faked, and what that leaves real
 *
 * Only `@/lib/payments/real-connect-port` is replaced. It is the one module in the
 * onboarding path that imports `server-only` *and* reaches `api.stripe.com`, and
 * `onboarding-service.ts` loads it through a deliberate dynamic import precisely so
 * a suite can stand behind it. Everything above the port stays production code:
 * `syncOnboarding`, `assessOnboarding`, and the `prisma.merchant.update` that is the
 * whole point of the endpoint. So "the webhook keeps `Merchant.status` honest" is
 * verified against real Postgres rows, not against a mocked write.
 *
 * ## The two rules in the route's header comment, and how each is falsified
 *
 * 1. **Verify against the raw body.** The payload in the raw-body test is
 *    deliberately *non-canonical*: it contains a space after a colon and a
 *    `\u00e9` escape, so `JSON.stringify(JSON.parse(raw)) !== raw`. That property is
 *    asserted rather than assumed — if it ever stopped holding, the test would go
 *    green for the wrong reason and say so. Replacing `await request.text()` with
 *    `JSON.stringify(await request.json())` re-serialises to the canonical form, the
 *    HMAC no longer matches, and the event becomes a 400.
 * 2. **Always 2xx on an event we do not care about.** An `invoice.paid` returns 200,
 *    and — the half that matters — does no work on the way: the port is never
 *    called. A `default:` arm that answered 400 would make Stripe retry forever; one
 *    that fell through to the sync would rewrite merchant state from an event that
 *    says nothing about onboarding.
 *
 * ## Not tested because it does not exist
 *
 * There is **no event-id deduplication**. Stripe re-delivers on any non-2xx and
 * occasionally on its own schedule; the route handles that by being *idempotent*
 * rather than by remembering ids — re-reading the account and writing only when the
 * assessment changed. The redelivery test pins that: the same event twice reaches
 * the port twice and leaves the row in one state. If a future reader adds a dedupe
 * table, that test is the one that will need rewriting, and it says so.
 *
 * ## The probe sweep, and the four times a probe survived before I got the fixture right
 *
 * Nineteen mutants were run against this suite; all nineteen now fail it. Getting
 * there took four rounds, and every round was a fixture defect rather than a gap in
 * the assertions. Recorded because the pattern will recur on the next route.
 *
 *   - **`capability.updated` could not catch a prefix mutant.** A `switch (true)` on
 *     `event.type.startsWith('account.')` survived, because `capability.updated` does
 *     not start with `account.` — the mutant took the *unhandled* arm, same as
 *     production. A prefix mutant needs a prefix collision; the fixture now uses
 *     `account.external_account.updated`.
 *   - **And the collision had to be about a merchant that exists.** The handled branch
 *     reads `event.data.object.id`; the first collision fixture put our account id only
 *     in the top-level `account` field, so the loosened match found no merchant and
 *     took the same `break`. Third equivalent mutant in a row from the same cause: a
 *     mutant that cannot reach the code under test looks exactly like one that was
 *     caught.
 *   - **A write with no port call.** Two `did-nothing` tests asserted `port.calls` was
 *     empty, which is blind to `prisma.merchant.update` in the `default:` arm. They now
 *     diff the whole merchant table, and assert no `stripe.webhook_processed` line —
 *     the log net catches a sync that changed no state.
 *   - **A probe harness that polluted the database.** The mutant for the first case
 *     wrote `SUSPENDED` onto a real seeded merchant (`sl1793738360169`), and because
 *     the harness ran the next mutant without restoring it, that merchant was already
 *     `SUSPENDED` when the following probe took its baseline — so a load-bearing probe
 *     reported a survivor. The row was restored by hand and the harness now snapshots
 *     and restores it between probes. Worth remembering: a mutation run that can write
 *     to shared fixtures can manufacture false survivors as easily as false kills.
 */

vi.mock('server-only', () => ({}));

/**
 * The logger, replaced so the *reason* is observable.
 *
 * Three of this route's five outcomes differ only in what they log: `503
 * NOT_CONFIGURED` is returned by two distinct branches, and `400 BAD_SIGNATURE`
 * covers a wrong secret, a tampered payload, a stale timestamp and a malformed
 * header. The response body cannot tell ops which one happened, so the log line is
 * the operator-facing output of this endpoint and belongs under test.
 */
vi.mock('@/lib/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * The Connect port, hoisted so the mock factory above can reach it.
 *
 * `vi.hoisted` because `vi.mock` calls are lifted above the `const`s in this file;
 * a factory closing over a plain `const` would throw "Cannot access before
 * initialization" the moment the module graph is built.
 */
const port = vi.hoisted(() => ({
  /** What Stripe would report for each connected account, keyed by id. */
  snapshots: new Map<string, unknown>(),
  /** Every call the code under test made, in order. */
  calls: [] as Array<{ method: string; accountId?: string }>,
}));

vi.mock('@/lib/payments/real-connect-port', () => ({
  realConnectPort: () => ({
    // The webhook is not an onboarding entry point. If it ever creates an account,
    // something has gone badly wrong and the throw is the assertion.
    async createAccount() {
      port.calls.push({ method: 'createAccount' });
      throw new Error('the webhook must never create a connected account');
    },
    async createAccountLink() {
      port.calls.push({ method: 'createAccountLink' });
      throw new Error('the webhook must never mint an account link');
    },
    async getAccount(accountId: string) {
      port.calls.push({ method: 'getAccount', accountId });
      const found = port.snapshots.get(accountId);
      if (!found) {
        // A missing snapshot is a fixture defect, not a Stripe error. Throwing
        // loudly keeps it from being read as a legitimate "account not found".
        throw new Error(`the fake port has no snapshot for ${accountId}`);
      }
      return found;
    },
  }),
  findMerchantByAccountId: async () => {
    throw new Error('not reachable from the webhook');
  },
}));

const SECRET = 'whsec_test_5f4d3c2b1a0f9e8d7c6b5a4938271605';
const KEY = 'sk_test_51ProbeKeyForTheWebhookSuite';

const PREFIX = `wh${Date.now().toString(36).slice(-6)}`;

/** Connected account ids. `acct_` because `forMerchant` and Stripe both require it. */
const acct = (suffix: string): string => `acct_test_${PREFIX}_${suffix}`;

const merchantIds: string[] = [];
let readyMerchantId = '';
let halfMerchantId = '';
let restrictedMerchantId = '';

/** A snapshot that `assessOnboarding()` calls READY. Overridden per test. */
function snapshot(overrides: Partial<StripeAccountSnapshot> = {}): StripeAccountSnapshot {
  return {
    id: acct('ready'),
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    disabled_reason: null,
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
    ...overrides,
  };
}

function webhookRequest(raw: string, signature?: string): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== undefined) {
    headers.set('stripe-signature', signature);
  }
  return new NextRequest('http://localhost:3000/api/webhooks/stripe', {
    method: 'POST',
    headers,
    body: raw,
  });
}

/** Signs exactly as Stripe does, with the SDK the route verifies with. */
function sign(raw: string, options: { secret?: string; timestamp?: number } = {}): string {
  return platform().webhooks.generateTestHeaderString({
    payload: raw,
    secret: options.secret ?? SECRET,
    timestamp: options.timestamp,
  });
}

/** A canonical event body. Canonical so that only the raw-body test is about bytes. */
function eventBody(type: string, object: Record<string, unknown>): string {
  return JSON.stringify({
    id: `evt_${PREFIX}_${type.replace(/\W/g, '_')}`,
    object: 'event',
    api_version: '2026-01-01',
    type,
    data: { object },
  });
}

type MerchantState = { status: string; onboardingComplete: boolean };

async function statusOf(merchantId: string): Promise<MerchantState> {
  return prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { status: true, onboardingComplete: true },
  });
}

/**
 * **Every** merchant's state, which is what it takes to prove "did nothing".
 *
 * ## Why the whole table, and not the three fixtures
 *
 * The claim under test is "an event we do not handle writes nothing". Asserting it
 * against our own rows is cheaper and was wrong: `prisma.merchant.findFirst()` has no
 * ORDER BY, so a mutant that syncs *some* merchant picks an arbitrary victim, and the
 * write lands on a row this suite never looks at.
 *
 * ## Why not the fixtures *plus* `port.calls`
 *
 * Also tried, also insufficient in a specific way: a write can happen without the port
 * being called at all — `prisma.merchant.update({ data: { status: 'SUSPENDED' } })` in
 * the `default:` arm never consults Stripe. That is the mutant the table diff exists
 * for, and it is the one that would matter in production, because it would demote
 * merchants based on an event that says nothing about them.
 *
 * ## What this cannot see, stated plainly
 *
 * A write to a row whose `status` and `onboardingComplete` the event would not change
 * — say, an `ACTIVE` merchant whose assessment is also `ACTIVE` — is invisible here.
 * The `logger.info` assertion in the unhandled-event test is the second net for that
 * class: the route emits `stripe.webhook_processed` on every sync it performs, so a
 * sync that changed no state still cannot be silent.
 *
 * A single read is enough. An earlier version polled until the table was stable,
 * to catch a non-awaited write landing after the response; every mutant that actually
 * produced such a write turned out to be caught by `port.calls` first, so the polling
 * was machinery with no probe behind it.
 */
async function allMerchantStates(): Promise<Map<string, MerchantState>> {
  const rows = await prisma.merchant.findMany({
    select: { id: true, status: true, onboardingComplete: true },
  });
  return new Map(
    rows.map(({ id, status, onboardingComplete }) => [id, { status, onboardingComplete }]),
  );
}

/** Ids whose state differs between two snapshots. Empty means nothing was written. */
function changedBetween(
  before: Map<string, MerchantState>,
  after: Map<string, MerchantState>,
): string[] {
  const changed: string[] = [];
  for (const [id, state] of before) {
    const next = after.get(id);
    if (!next || next.status !== state.status || next.onboardingComplete !== state.onboardingComplete) {
      changed.push(id);
    }
  }
  // A row that appeared during the request would be a write too.
  for (const id of after.keys()) {
    if (!before.has(id)) {
      changed.push(id);
    }
  }
  return changed;
}

beforeAll(async () => {
  const created = await Promise.all(
    (
      [
        ['ready', acct('ready')],
        ['half', acct('half')],
        ['restricted', acct('restricted')],
      ] as const
    ).map(([label, accountId]) =>
      prisma.merchant.create({
        data: {
          name: `${PREFIX} ${label} kitchen`,
          slug: `${PREFIX}-${label}`,
          status: 'PENDING',
          onboardingComplete: false,
          stripeAccountId: accountId,
        },
        select: { id: true },
      }),
    ),
  );

  readyMerchantId = created[0]!.id;
  halfMerchantId = created[1]!.id;
  restrictedMerchantId = created[2]!.id;
  merchantIds.push(...created.map((row) => row.id));
});

beforeEach(async () => {
  vi.clearAllMocks();

  // A known-good environment. Individual tests break one thing at a time, which is
  // the only way to attribute a 503 to the branch that caused it.
  process.env.STRIPE_SECRET_KEY = KEY;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;

  port.calls.length = 0;
  port.snapshots.clear();
  port.snapshots.set(acct('ready'), snapshot({ id: acct('ready') }));

  // Every test starts from the state a merchant is in before they finish onboarding,
  // so an assertion that the row moved is meaningful, and one that it did not move
  // is not a leftover from the previous test.
  await prisma.merchant.updateMany({
    where: { id: { in: merchantIds } },
    data: { status: 'PENDING', onboardingComplete: false },
  });
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } });
  await prisma.$disconnect();
});

describe('the runtime the endpoint is pinned to', () => {
  it('is the Node runtime, because signature verification needs `node:crypto`', () => {
    // `constructEvent` computes an HMAC synchronously. On the Edge runtime that call
    // does not exist — the SDK throws `CryptoProviderOnlySupportsAsyncError` and the
    // route's `catch` would turn every genuine delivery into a 400. Pinning the
    // export is the cheap half of that guarantee.
    expect(runtime).toBe('nodejs');
  });
});

describe('the configuration gates', () => {
  it('answers 503, not 500, when there is no Stripe key at all', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    const response = await POST(webhookRequest(eventBody('account.updated', { id: acct('ready') })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'NOT_CONFIGURED' });
    // 503 rather than silently swallowing: Stripe shows a failing endpoint, which is
    // the only place a missing key in production becomes visible.
    expect(logger.warn).toHaveBeenCalledWith('stripe.webhook_rejected', {
      reason: 'not_configured',
    });
    expect(port.calls).toEqual([]);
  });

  it('answers 503 when the key is a publishable one', async () => {
    // `isStripeConfigured()` checks the *shape* of the key, not just its presence.
    // A `pk_…` here would build a client that fails with a 401 at Stripe, so the
    // route refuses before anyone can conclude the webhook is merely broken.
    process.env.STRIPE_SECRET_KEY = 'pk_test_51PublishableKeyInTheWrongVariable';

    const response = await POST(webhookRequest(eventBody('account.updated', { id: acct('ready') })));

    expect(response.status).toBe(503);
    expect(port.calls).toEqual([]);
  });

  it('answers 503 when the key is configured but no signing secret is', async () => {
    // The second gate, and the one that produces the misleading alternative: without
    // this branch, `secret` is `undefined`, `constructEvent` refuses a blank secret,
    // and every real delivery becomes `400 BAD_SIGNATURE` — sending whoever is on call
    // to hunt for a signing bug that does not exist.
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const response = await POST(webhookRequest(eventBody('account.updated', { id: acct('ready') })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'NOT_CONFIGURED' });
    expect(logger.warn).toHaveBeenCalledWith('stripe.webhook_rejected', {
      reason: 'not_configured',
    });
    expect(logger.warn).not.toHaveBeenCalledWith('stripe.webhook_rejected', {
      reason: 'bad_signature',
    });
  });
});

describe('a request that is not from Stripe', () => {
  it('answers 400 when the signature header is absent, and reads nothing', async () => {
    const response = await POST(webhookRequest(eventBody('account.updated', { id: acct('ready') })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'NO_SIGNATURE' });
    // Distinct from BAD_SIGNATURE on purpose: "nobody signed this" and "somebody
    // signed it wrongly" are different incidents, and only the second suggests a
    // secret mismatch.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(port.calls).toEqual([]);
    expect(await statusOf(readyMerchantId)).toEqual({ status: 'PENDING', onboardingComplete: false });
  });

  it('answers 400 for a header that is not a signature at all', async () => {
    // `parseHeader` cannot find a `t=` or `v1=`, so `constructEvent` throws before any
    // HMAC is computed. The risk here is not acceptance, it is a 500 from an unhandled
    // parse error — which Stripe reads as "retry forever".
    const response = await POST(
      webhookRequest(eventBody('account.updated', { id: acct('ready') }), 'lol-not-a-signature'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'BAD_SIGNATURE' });
    expect(logger.warn).toHaveBeenCalledWith('stripe.webhook_rejected', {
      reason: 'bad_signature',
    });
  });

  it('answers 400 for a well-formed signature made with the wrong secret', async () => {
    const raw = eventBody('account.updated', { id: acct('ready') });
    const forged = sign(raw, { secret: 'whsec_thisIsNotOurSigningSecretAtAll00' });

    const response = await POST(webhookRequest(raw, forged));

    expect(response.status).toBe(400);
    // The shape of the header is perfect; only the HMAC differs. This is the attack
    // the whole endpoint rests on refusing.
    expect(await response.json()).toEqual({ error: 'BAD_SIGNATURE' });
    expect(port.calls).toEqual([]);
    expect(await statusOf(readyMerchantId)).toEqual({ status: 'PENDING', onboardingComplete: false });
  });

  it('answers 400 for a genuine signature over a different payload', async () => {
    // Signed with the right secret, but at bytes we were not sent: the "replay a
    // signature onto a body of my choosing" move.
    const signed = eventBody('account.updated', { id: acct('ready') });
    const delivered = eventBody('account.updated', { id: acct('half') });

    const response = await POST(webhookRequest(delivered, sign(signed)));

    expect(response.status).toBe(400);
    expect(port.calls).toEqual([]);
    expect(await statusOf(halfMerchantId)).toEqual({ status: 'PENDING', onboardingComplete: false });
  });

  it('answers 400 for a correctly signed delivery whose timestamp has expired', async () => {
    // The route calls `constructEvent(payload, signature, secret)` and does not pass a
    // tolerance, so the SDK's 300-second default applies. Ten minutes past is outside
    // it. Passing `0` would disable the window and make every captured delivery
    // replayable forever, which is the reason this is pinned rather than left implicit.
    const raw = eventBody('account.updated', { id: acct('ready') });
    const stale = sign(raw, { timestamp: Math.floor(Date.now() / 1000) - 600 });

    const response = await POST(webhookRequest(raw, stale));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'BAD_SIGNATURE' });
    expect(port.calls).toEqual([]);
    expect(await statusOf(readyMerchantId)).toEqual({ status: 'PENDING', onboardingComplete: false });
  });
});

describe('rule 1 — the signature covers the raw bytes', () => {
  it('accepts a signed body that re-serialising would change', async () => {
    const accountId = acct('ready');

    /**
     * Deliberately not what `JSON.stringify` would produce.
     *
     * Two independent non-canonical forms, either of which is enough: a space after
     * the first colon, and a `\u00e9` escape that a JSON parser folds into a single
     * character. Both survive `request.text()` untouched and neither survives
     * `JSON.stringify(await request.json())`.
     */
    const raw =
      `{"id": "evt_${PREFIX}_raw", "type":"account.updated",` +
      `"data":{"object":{"id":"${accountId}","description":"caf\\u00e9 \\u2014 kitchen"}}}`;

    // The premise, asserted rather than believed. If a future change made this
    // payload canonical this test would stop proving anything about raw bytes —
    // and it would keep passing. So it fails instead.
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);
    expect((JSON.parse(raw) as { data: { object: { description: string } } }).data.object.description).toBe(
      'café — kitchen',
    );

    await prisma.merchant.update({
      where: { id: readyMerchantId },
      data: { stripeAccountId: accountId },
    });

    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    // The event was not merely accepted, it was acted on — which is what a
    // re-serialising implementation cannot claim, because the HMAC fails first.
    expect(await statusOf(readyMerchantId)).toEqual({ status: 'ACTIVE', onboardingComplete: true });
  });
});

describe('rule 2 — an event we do not handle is still a 200', () => {
  it('answers 200 to `invoice.paid` and writes nothing anywhere', async () => {
    const before = await allMerchantStates();
    const raw = eventBody('invoice.paid', { id: 'in_test_123', amount_paid: 4200 });

    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    // Anything other than 2xx makes Stripe retry a delivery that will never be
    // interesting, so 400 here would be a retry storm; falling through to the sync
    // would rewrite `Merchant.status` from an event that says nothing about
    // onboarding. The second failure mode is the quieter one and is what this reads.
    expect(port.calls).toEqual([]);
    expect(changedBetween(before, await allMerchantStates())).toEqual([]);
    // The log assertion is the one that survives an arbitrary victim. A mutant that
    // syncs *some* merchant — the plausible version being a `findUnique({ where:
    // { stripeAccountId } })` whose `where` gets dropped — resolves whatever row
    // Postgres returns first, and that row has no connected account, so nothing is
    // written and the table diff stays empty. What it *does* produce is a
    // `webhook_processed` line naming a merchant this event has nothing to do with.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('answers 200 to a type that shares the handled one’s prefix', async () => {
    // `account.external_account.updated` is a genuine Connect event that a platform
    // receives, and it is the closest neighbour `account.updated` has: it starts with
    // the same seven characters and describes a change to the same account. The route
    // matches the exact string, so this must do nothing.
    //
    // ## Why not `capability.updated`, which is the more obvious choice
    //
    // I tried that first and a `switch (true)` on `type.startsWith('account.')` passed
    // the suite. Not because the fixture was too weak in the usual sense — because
    // `capability.updated` does not start with `account.`, so under that mutant it took
    // the unhandled `default:` arm. Same behaviour as production, from a different line.
    // A prefix mutant can only be caught by a *prefix collision*, and this is the event
    // that supplies one.
    //
    // ## Why the body carries our account in `data.object.id`
    //
    // The handled branch reads `event.data.object.id`. Without a merchant to resolve,
    // a loosened match finds nothing and takes the same `break` — an equivalent mutant
    // again, for a third time. Setting `data.object.id` to the connected account gives
    // the loosened match something to sync, which is the only way this fixture can
    // distinguish the two branches. The realistic field for this event type is
    // `data.object.account` (`acct_…`) with a bank account id in `data.object.id`; the
    // substitution is deliberate and is the fixture's whole purpose.
    const handle = acct('ready');
    const before = await allMerchantStates();

    const raw = eventBody('account.external_account.updated', {
      id: handle,
      object: 'bank_account',
      account: handle,
    });
    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(port.calls).toEqual([]);
    expect(changedBetween(before, await allMerchantStates())).toEqual([]);
    // The net that does not depend on which row a looser match would have reached.
    expect(logger.info).not.toHaveBeenCalled();
    expect(await statusOf(readyMerchantId)).toEqual({ status: 'PENDING', onboardingComplete: false });
  });
});

describe('`account.updated` — the one event that writes', () => {
  it('flips the merchant to ACTIVE when Stripe reports it is fully enabled', async () => {
    const raw = eventBody('account.updated', { id: acct('ready') });

    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(port.calls).toEqual([{ method: 'getAccount', accountId: acct('ready') }]);
    expect(await statusOf(readyMerchantId)).toEqual({ status: 'ACTIVE', onboardingComplete: true });

    // What ops reads afterwards. `state` is the assessment's word, not the event's.
    expect(logger.info).toHaveBeenCalledWith('stripe.webhook_processed', {
      eventType: 'account.updated',
      merchantId: readyMerchantId,
      state: 'READY',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves the merchant PENDING when the body claims enabled and Stripe does not', async () => {
    // The body is the lie here: it says charges and payouts are on. The account the
    // port reports is half-finished. Trusting the payload — which is a one-line
    // simplification nobody would notice in review — turns this into ACTIVE.
    port.snapshots.set(
      acct('ready'),
      snapshot({ id: acct('ready'), payouts_enabled: false }),
    );
    const raw = eventBody('account.updated', {
      id: acct('ready'),
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });

    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(await statusOf(readyMerchantId)).toEqual({ status: 'PENDING', onboardingComplete: false });
    expect(logger.info).toHaveBeenCalledWith('stripe.webhook_processed', {
      eventType: 'account.updated',
      merchantId: readyMerchantId,
      state: 'INCOMPLETE',
    });
  });

  it('flips the merchant to ACTIVE when the body is pessimistic and Stripe is not', async () => {
    // The mirror. Stripe delivers events out of order, so an `account.updated` minted
    // before the merchant finished the form can land after they did. This is the case
    // the header comment's "the event can arrive out of order" is about, and it is
    // the one a payload-trusting implementation gets wrong in the *safe* direction —
    // which is exactly why it would never be reported as a bug.
    const raw = eventBody('account.updated', {
      id: acct('ready'),
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: { currently_due: ['individual.verification.document'], past_due: [] },
    });

    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(await statusOf(readyMerchantId)).toEqual({ status: 'ACTIVE', onboardingComplete: true });
  });

  it('demotes a merchant Stripe has restricted, rather than leaving it ACTIVE', async () => {
    // "Keeps `Merchant.status` honest" has to work in both directions. A merchant who
    // was READY and then had a document rejected is reported by Stripe with everything
    // still enabled *plus* a `disabled_reason`; `assessOnboarding` reads that as
    // RESTRICTED. Missing this direction means a drop can be published for an account
    // that cannot be paid out, and the money strands after capture.
    port.snapshots.set(
      acct('restricted'),
      snapshot({
        id: acct('restricted'),
        disabled_reason: 'requirements.past_due',
        requirements: {
          currently_due: [],
          past_due: ['individual.verification.document'],
          disabled_reason: 'requirements.past_due',
        },
      }),
    );
    await prisma.merchant.update({
      where: { id: restrictedMerchantId },
      data: { status: 'ACTIVE', onboardingComplete: true },
    });

    const raw = eventBody('account.updated', { id: acct('restricted') });
    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(await statusOf(restrictedMerchantId)).toEqual({
      status: 'PENDING',
      onboardingComplete: false,
    });
    expect(logger.info).toHaveBeenCalledWith('stripe.webhook_processed', {
      eventType: 'account.updated',
      merchantId: restrictedMerchantId,
      state: 'RESTRICTED',
    });
  });

  it('answers 200 for an account we do not know, without asking Stripe about it', async () => {
    // Not an error. A platform can host several integrations, and Stripe will deliver
    // events for accounts created by another one. Answering 4xx or 500 here makes
    // Stripe retry a delivery we can never action.
    const before = await allMerchantStates();
    const raw = eventBody('account.updated', { id: 'acct_test_belongsToSomebodyElse' });

    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    // The `break` is before the sync, not after a wasted round-trip to Stripe — and
    // `port.calls` alone cannot see the difference, because a mutant can reach the
    // same `break` having decided to ignore a merchant it did find. Hence the
    // table-wide diff and the log net.
    expect(port.calls).toEqual([]);
    expect(changedBetween(before, await allMerchantStates())).toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('stripe.webhook_rejected', {
      reason: 'unknown_account',
    });
  });

  it('re-runs the sync on a redelivery, and lands the row in the same state', async () => {
    // Pinned rather than prevented: there is no event-id dedupe, and this is what that
    // costs — a second read of the account. It is safe because the write is derived
    // from the account rather than from the delivery count, which is the property the
    // assertion is really about. A future dedupe table should change this test.
    const raw = eventBody('account.updated', { id: acct('ready') });
    const signature = sign(raw);

    const first = await POST(webhookRequest(raw, signature));
    const afterFirst = await statusOf(readyMerchantId);
    const second = await POST(webhookRequest(raw, signature));
    const afterSecond = await statusOf(readyMerchantId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(port.calls).toEqual([
      { method: 'getAccount', accountId: acct('ready') },
      { method: 'getAccount', accountId: acct('ready') },
    ]);
    expect(afterFirst).toEqual({ status: 'ACTIVE', onboardingComplete: true });
    expect(afterSecond).toEqual(afterFirst);
  });
});

describe('malformed but correctly signed', () => {
  it('answers 400 for a v2 thin event notification, which is not a webhook body', async () => {
    // Stripe Event Destinations can send `v2.core.event` thin notifications to the same
    // URL. `constructEvent` refuses them by name — "use the corresponding
    // EventNotification method instead" — and that throw has to land in the same
    // `catch` as a bad signature rather than escaping as a 500.
    const raw = JSON.stringify({ object: 'v2.core.event', id: 'evt_v2', type: 'account.updated' });

    const response = await POST(webhookRequest(raw, sign(raw)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'BAD_SIGNATURE' });
    expect(port.calls).toEqual([]);
  });
});

describe('the probe Stripe sends before it trusts the endpoint', () => {
  it('answers 405 with an Allow header on GET', async () => {
    const response = await GET();

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    // A bare 405 with no `Allow` leaves the reader guessing which verb to use.
    expect(await response.json()).toEqual({ error: 'POST_ONLY' });
  });
});
