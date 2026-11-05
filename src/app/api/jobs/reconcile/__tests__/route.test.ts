import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST|GET /api/jobs/reconcile` — auth and wiring for ADR-004's L5 job.
 *
 * The arithmetic is `l5.test.ts`; the drop selection and provider failure handling are
 * `l5-run`'s. This file proves the four refusals and that the 200 branch hands the run
 * a real port and an optional `since`, because those are the parts a hand-run `curl`
 * would otherwise discover in production.
 */

const FIXED = {
  since: '2026-11-04T09:00:00.000Z',
  dropsChecked: 3,
  dropsSkipped: 0,
  ok: true,
  mismatches: [],
};

type RunArgs = { now: Date; port: unknown; since?: Date };
const runMock = vi.fn(async (_args: RunArgs) => FIXED);
vi.mock('@/lib/settlement/l5-run', () => ({
  runL5Reconciliation: (args: RunArgs) => runMock(args),
}));

const stripeState = vi.hoisted(() => ({ configured: true }));
vi.mock('@/lib/payments/stripe', () => ({
  isStripeConfigured: () => stripeState.configured,
}));

const port = {
  read: vi.fn(async () => ({ connected: [], platform: [] })),
};
vi.mock('@/lib/settlement/l5-real-port', () => ({
  realL5Port: () => port,
}));

const URL = 'http://localhost/api/jobs/reconcile';
const SECRET = 'a-cron-secret-long-enough-to-be-plausible';

async function loadRoute() {
  return import('@/app/api/jobs/reconcile/route');
}

function request(method: 'GET' | 'POST', headers: Record<string, string> = {}, query = ''): NextRequest {
  return new NextRequest(`${URL}${query}`, { method, headers });
}

beforeEach(() => {
  vi.resetModules();
  runMock.mockClear();
  port.read.mockClear();
  stripeState.configured = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the refusals', () => {
  it('503s without CRON_SECRET and does not run', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const { POST } = await loadRoute();

    const response = await POST(request('POST'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'NOT_CONFIGURED' });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('401s without a bearer token', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { POST } = await loadRoute();

    const response = await POST(request('POST'));

    expect(response.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('401s on a wrong-length token without throwing', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { POST } = await loadRoute();

    expect((await POST(request('POST', { authorization: 'Bearer short' }))).status).toBe(401);
  });

  it('503s when Stripe is not configured', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    stripeState.configured = false;
    const { POST } = await loadRoute();

    const response = await POST(request('POST', { authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(503);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('422s a malformed since rather than silently using the default window', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { POST } = await loadRoute();

    const response = await POST(
      request('POST', { authorization: `Bearer ${SECRET}` }, '?since=last-tuesday'),
    );

    expect(response.status).toBe(422);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('the run', () => {
  it('runs once with the real port and returns the report', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { POST } = await loadRoute();

    const response = await POST(request('POST', { authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FIXED);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(runMock).toHaveBeenCalledTimes(1);

    const args = runMock.mock.calls[0]?.[0];
    if (!args) throw new Error('the reconciliation run was not called');
    expect(args.now).toBeInstanceOf(Date);
    expect(args.port).toBe(port);
    expect(args.since).toBeUndefined();
  });

  it('passes a valid since through, for a manual recovery run', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { GET } = await loadRoute();

    const response = await GET(
      request('GET', { authorization: `Bearer ${SECRET}` }, '?since=2026-11-01T00:00:00.000Z'),
    );

    expect(response.status).toBe(200);
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.since?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});
