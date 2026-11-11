import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * What `l5-real-port.ts` actually asks Stripe — and on which account.
 *
 * ## Why this file exists
 *
 * L5 is the nightly reconciliation that decides whether the money balanced:
 *
 * > `Σ CHARGE + Σ REFUND + Σ card fees == connected-account balance delta`
 * > `Σ PLATFORM_FEE + Σ ADJUSTMENT == Σ application_fee`
 *
 * The arithmetic (`l5.ts`) is pure and well covered. The **provider read** was covered
 * by nothing: `l5-real-port.ts` is never imported for real by any test — every
 * reference mocks it out, because `l5-run.test.ts` supplies a `fakeL5Port`. So the
 * layer that fetches the numbers the reconciliation trusts had zero executed
 * statements in the gate.
 *
 * That matters more here than in most adapters, because L5's whole job is to
 * *disagree* when something is wrong. A read that silently returns nothing produces an
 * empty-but-matching reconciliation — a green L5 on a drop that lost money. There is no
 * crash, no mismatch, no page.
 *
 * ## The specific failure this file was written to catch
 *
 * The docblock of `l5-real-port.ts` states the platform fee *must* be fetched with the
 * platform client, never `forMerchant`:
 *
 * > "The fee's own `balance_transaction` is retrieved on the platform client; it must
 * > not be fetched through `forMerchant`, which would look on the wrong account and
 * > find nothing."
 *
 * "Find nothing" is the dangerous part: Stripe would return an empty list, the code
 * would skip the fee, and `Σ application_fee` would come back short with no error. The
 * assertion that catches it is the `Stripe-Account` header — absent on platform calls,
 * present on connected ones — which is exactly what this recording server can see and
 * what a fake port cannot.
 *
 * ## What this proves, and what it does not
 *
 * **Proves:** the paths, query parameters, and — critically — which of the two clients
 * each request is made with, plus the mapping from Stripe's balance-transaction shape
 * to `ConnectedBalanceLine` / `PlatformBalanceLine`.
 *
 * **Does not prove:** that real Stripe returns these shapes or that its figures agree
 * with ours. The live proof is `scripts/verify-stripe.ts`; a green run here is not it.
 */

type Recorded = {
  method: string;
  path: string;
  search: string;
  /** Absent means the platform account; present means a connected account. */
  stripeAccount: string | undefined;
  searchParams: URLSearchParams;
};

const recorded: Recorded[] = [];

type Route = {
  match: (url: URL, method: string) => boolean;
  body: unknown;
};

let routes: Route[] = [];

function balanceTransaction(input: {
  id: string;
  amount: number;
  fee: number;
  source: string;
  type: string;
}) {
  return {
    id: input.id,
    object: 'balance_transaction',
    amount: input.amount,
    fee: input.fee,
    net: input.amount - input.fee,
    currency: 'cad',
    source: input.source,
    type: input.type,
    status: 'available',
    created: 1794193200,
  };
}

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const header = request.headers['stripe-account'];

      recorded.push({
        method: request.method ?? '',
        path: url.pathname,
        search: url.search,
        stripeAccount: typeof header === 'string' ? header : undefined,
        searchParams: url.searchParams,
      });

      // Stripe's list envelope. `has_more: false` so the SDK does not try to page.
      const envelope = (data: unknown[]) => ({ object: 'list', url: url.pathname, has_more: false, data });

      const hit = routes.find((candidate) => candidate.match(url, request.method ?? ''));
      const body = hit ? hit.body : envelope([]);

      response.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_l5' });
      response.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(async () => {
  recorded.length = 0;
  routes = [];
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = 'sk_test_l5_recording';

  const { __setStripeClientForTests } = await import('@/lib/payments/stripe');
  __setStripeClientForTests({
    host: '127.0.0.1',
    port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeout: 5_000,
    typescript: true,
  });
});

afterEach(async () => {
  const { __setStripeClientForTests } = await import('@/lib/payments/stripe');
  __setStripeClientForTests(null);
  delete process.env.STRIPE_SECRET_KEY;
});

async function loadPort() {
  const { realL5Port } = await import('../l5-real-port');
  return realL5Port();
}

const ACCOUNT = 'acct_l5_connected';

function args(overrides: Record<string, unknown> = {}) {
  return {
    stripeAccountId: ACCOUNT,
    chargeIds: [],
    refundIds: [],
    ...overrides,
  } as Parameters<Awaited<ReturnType<typeof loadPort>>['read']>[0];
}

/** Every request the port made for the given path prefix. */
function hits(pathPrefix: string): Recorded[] {
  return recorded.filter((entry) => entry.path.startsWith(pathPrefix));
}

describe('L5 · the connected-account side', () => {
  it('lists balance transactions by source, one call per charge and per refund', async () => {
    // The service supplies the ids from `Order.stripeChargeId` and the REFUND ledger
    // rows; the port must not guess which transactions belong to a drop.
    routes = [
      {
        match: (url) => url.pathname.endsWith('/balance_transactions'),
        body: {
          object: 'list',
          has_more: false,
          data: [balanceTransaction({ id: 'txn_1', amount: 1112, fee: -89, source: 'ch_1', type: 'charge' })],
        },
      },
    ];

    await (await loadPort()).read(args({ chargeIds: ['ch_1'], refundIds: ['re_1'] }));

    const list = hits('/v1/balance_transactions');
    expect(list).toHaveLength(2);
    expect(list.map((entry) => entry.searchParams.get('source')).sort()).toEqual(['ch_1', 're_1']);
    // Connected-account reads must be scoped. An unscoped read finds the platform's
    // transactions and reports them as the merchant's.
    for (const entry of list) expect(entry.stripeAccount).toBe(ACCOUNT);
  });

  it('maps amount and fee through unchanged, signed as Stripe reports them', async () => {
    // L5 compares against the fee Stripe charged, not a recomputation (ADR-004 §6.1).
    // A sign flip here would make the reconciliation fail loudly on correct data, or —
    // worse — balance by coincidence.
    routes = [
      {
        match: (url) => url.pathname.endsWith('/balance_transactions'),
        body: {
          object: 'list',
          has_more: false,
          data: [
            balanceTransaction({ id: 'txn_charge', amount: 1112, fee: -89, source: 'ch_1', type: 'charge' }),
            balanceTransaction({ id: 'txn_refund', amount: -1112, fee: 0, source: 're_1', type: 'refund' }),
          ],
        },
      },
    ];

    const result = await (await loadPort()).read(args({ chargeIds: ['ch_1'], refundIds: ['re_1'] }));

    expect(result.connected).toEqual([
      { id: 'txn_charge', kind: 'charge', amountCents: 1112, feeCents: -89 },
      { id: 'txn_refund', kind: 'refund', amountCents: -1112, feeCents: 0 },
    ]);
  });

  it('classifies by the sign of the amount, not by which list the id came from', async () => {
    // A source id can be either — a partial refund and a charge under one order, or a
    // mis-filed id. The `kind` field feeds L5's per-type totals, so it has to follow
    // the money, not the argument.
    routes = [
      {
        match: (url) => url.pathname.endsWith('/balance_transactions'),
        body: {
          object: 'list',
          has_more: false,
          // Passed in as a chargeId, but Stripe reports a negative amount.
          data: [balanceTransaction({ id: 'txn_neg', amount: -500, fee: 0, source: 'ch_1', type: 'refund' })],
        },
      },
    ];

    const result = await (await loadPort()).read(args({ chargeIds: ['ch_1'] }));

    expect(result.connected[0]?.kind).toBe('refund');
  });

  it('does not double-count a transaction that appears under two sources', async () => {
    // Stripe can return the same transaction for more than one `source` query. Counting
    // it twice inflates the expected delta by a full charge, which reads as a
    // reconciliation failure caused by the reader rather than by the ledger.
    routes = [
      {
        match: (url) => url.pathname.endsWith('/balance_transactions'),
        body: {
          object: 'list',
          has_more: false,
          data: [balanceTransaction({ id: 'txn_dup', amount: 1112, fee: -89, source: 'ch_1', type: 'charge' })],
        },
      },
    ];

    const result = await (await loadPort()).read(args({ chargeIds: ['ch_1', 'ch_2'] }));

    expect(result.connected).toHaveLength(1);
    expect(result.connected[0]?.id).toBe('txn_dup');
  });

  it('asks for nothing when there are no ids, rather than listing everything', async () => {
    // An unfiltered `balance_transactions.list()` returns the whole account. That would
    // make L5's expected figure a property of the merchant's history and always wrong
    // for this drop — and it would look like a real number, not an error.
    const result = await (await loadPort()).read(args());

    expect(result).toEqual({ connected: [], platform: [] });
    expect(hits('/v1/balance_transactions')).toHaveLength(0);
  });
});

describe('L5 · the platform side, where the fee must not be looked for on the merchant', () => {
  it('lists application fees on the PLATFORM client, with no Stripe-Account header', async () => {
    // The docblock's warning, asserted: `applicationFees.list` through `forMerchant`
    // returns an empty list rather than an error, so `Σ application_fee` comes back
    // short and the only symptom is a mismatch somebody has to interpret. The header is
    // the difference, and only a recorder can see it.
    routes = [
      {
        match: (url) => url.pathname === '/v1/application_fees',
        body: {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'fee_1',
              object: 'application_fee',
              amount: 89,
              currency: 'cad',
              charge: 'ch_1',
              // Unexpanded: the port must then retrieve it, still on the platform.
              balance_transaction: 'txn_fee_1',
            },
          ],
        },
      },
      {
        match: (url) => url.pathname === '/v1/balance_transactions/txn_fee_1',
        body: balanceTransaction({ id: 'txn_fee_1', amount: 89, fee: 0, source: 'fee_1', type: 'application_fee' }),
      },
    ];

    const result = await (await loadPort()).read(args({ chargeIds: ['ch_1'] }));

    const feeList = hits('/v1/application_fees');
    expect(feeList).toHaveLength(1);
    expect(feeList[0]?.stripeAccount, 'applicationFees.list must run on the platform account').toBeUndefined();
    expect(feeList[0]?.searchParams.get('charge')).toBe('ch_1');

    const feeTxn = hits('/v1/balance_transactions/txn_fee_1');
    expect(feeTxn, 'the fee transaction must also be read on the platform').toHaveLength(1);
    expect(feeTxn[0]?.stripeAccount).toBeUndefined();

    expect(result.platform).toEqual([{ id: 'txn_fee_1', kind: 'application_fee', amountCents: 89 }]);
  });

  it('uses an already-expanded balance_transaction instead of fetching it again', async () => {
    // The expansion is optional in Stripe's response. When it is present the port must
    // not spend a round trip — and, more importantly, must not fail because it tried to
    // retrieve an object it already had.
    routes = [
      {
        match: (url) => url.pathname === '/v1/application_fees',
        body: {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'fee_1',
              object: 'application_fee',
              amount: 89,
              currency: 'cad',
              charge: 'ch_1',
              balance_transaction: balanceTransaction({
                id: 'txn_fee_inline',
                amount: 89,
                fee: 0,
                source: 'fee_1',
                type: 'application_fee',
              }),
            },
          ],
        },
      },
    ];

    const result = await (await loadPort()).read(args({ chargeIds: ['ch_1'] }));

    expect(hits('/v1/balance_transactions/txn_fee_inline')).toHaveLength(0);
    expect(result.platform).toEqual([
      { id: 'txn_fee_inline', kind: 'application_fee', amountCents: 89 },
    ]);
  });

  it('reports the fee gross from the balance transaction, not from application_fee.amount', async () => {
    // Under a direct charge the platform's fee transaction carries no card fee, so the
    // balance-transaction amount and the fee's own `amount` coincide — but the port
    // reads the transaction, deliberately. Asserted by making the two differ: the
    // ledger's expected figure must follow the transaction, because that is what
    // actually moved.
    routes = [
      {
        match: (url) => url.pathname === '/v1/application_fees',
        body: {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'fee_1',
              object: 'application_fee',
              amount: 89,
              currency: 'cad',
              charge: 'ch_1',
              balance_transaction: 'txn_fee_1',
            },
          ],
        },
      },
      {
        match: (url) => url.pathname === '/v1/balance_transactions/txn_fee_1',
        body: balanceTransaction({ id: 'txn_fee_1', amount: 91, fee: 0, source: 'fee_1', type: 'application_fee' }),
      },
    ];

    const result = await (await loadPort()).read(args({ chargeIds: ['ch_1'] }));

    expect(result.platform[0]?.amountCents).toBe(91);
  });

  it('does not double-count a fee seen under two charge ids', async () => {
    // Same guard as the connected side. A doubled fee makes the platform check fail on
    // correct data, which is how an operator learns to ignore L5.
    routes = [
      {
        match: (url) => url.pathname === '/v1/application_fees',
        body: {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'fee_1',
              object: 'application_fee',
              amount: 89,
              currency: 'cad',
              charge: 'ch_1',
              balance_transaction: 'txn_fee_1',
            },
          ],
        },
      },
      {
        match: (url) => url.pathname === '/v1/balance_transactions/txn_fee_1',
        body: balanceTransaction({ id: 'txn_fee_1', amount: 89, fee: 0, source: 'fee_1', type: 'application_fee' }),
      },
    ];

    const result = await (await loadPort()).read(args({ chargeIds: ['ch_1', 'ch_2'] }));

    expect(result.platform).toHaveLength(1);
  });

  it('asks for no application fees when there are no charge ids', async () => {
    // `applicationFees.list({})` without a charge returns the platform's whole fee
    // history. Same failure shape as the connected side: a plausible number that is
    // wrong for every drop.
    const result = await (await loadPort()).read(args({ refundIds: ['re_1'] }));

    expect(result.platform).toEqual([]);
    expect(hits('/v1/application_fees')).toHaveLength(0);
  });
});
