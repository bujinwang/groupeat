import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST|GET /api/jobs/digest` — auth and wiring only.
 *
 * The decisions the job makes are covered by `digest-run.test.ts` against a real
 * sender seam. What a route test can uniquely prove is the part that would otherwise
 * be a `curl` in production: the token comparison, the two methods, and the fact that
 * the handler hands the run a sender and an origin rather than constructing either in
 * a branch a test cannot see.
 *
 * `resend-sender.ts` imports `server-only`, which throws outside a React Server
 * Component graph, so it is mocked for the same reason the cutoff route test mocks
 * `twilio-sender.ts`: a real import would fail at module load.
 */

const FIXED_RESULT = {
  week: 'Oct 26 – Nov 1',
  weekStart: '2026-10-26T06:00:00.000Z',
  weekEnd: '2026-11-02T06:00:00.000Z',
  merchants: 2,
  recipients: 3,
  sent: 3,
  failed: 0,
  skippedAlreadySent: 0,
  skippedNoDrops: 1,
  notConfigured: 0,
  merchantsWithNothingToReport: 0,
};

const sender = {
  name: 'test',
  async send() {
    return { outcomes: [], sentCount: 0, failedCount: 0 };
  },
};

const resolveEmailSenderMock = vi.fn(() => sender);
vi.mock('@/lib/notify/resend-sender', () => ({
  resolveEmailSender: () => resolveEmailSenderMock(),
}));

vi.mock('@/lib/notify/public-origin', () => ({
  publicOrigin: () => 'https://groupeat.example',
}));

type RunArgs = { now: Date; sender: unknown; origin: string | undefined };
const runWeeklyDigestMock = vi.fn(async (_args: RunArgs) => FIXED_RESULT);

vi.mock('@/lib/reports/digest-run', () => ({
  runWeeklyDigest: (args: RunArgs) => runWeeklyDigestMock(args),
}));

const URL = 'http://localhost/api/jobs/digest';
const SECRET = 'a-cron-secret-long-enough-to-be-plausible';

async function loadRoute() {
  return import('@/app/api/jobs/digest/route');
}

function request(method: 'GET' | 'POST', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(URL, { method, headers });
}

beforeEach(() => {
  vi.resetModules();
  runWeeklyDigestMock.mockClear();
  resolveEmailSenderMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the refusals', () => {
  it('answers 503 when CRON_SECRET is unset, and does not run', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const { POST } = await loadRoute();

    const response = await POST(request('POST'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'NOT_CONFIGURED' });
    expect(runWeeklyDigestMock).not.toHaveBeenCalled();
  });

  it('answers 401 with no bearer token', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { POST } = await loadRoute();

    const response = await POST(request('POST'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
    expect(runWeeklyDigestMock).not.toHaveBeenCalled();
  });

  it('answers 401 to a token of the wrong length, not 500', async () => {
    // `timingSafeEqual` throws on unequal lengths, so a route that calls it before
    // comparing lengths is a 500 for anyone who sends a token of the wrong size.
    vi.stubEnv('CRON_SECRET', SECRET);
    const { POST } = await loadRoute();

    const response = await POST(request('POST', { authorization: 'Bearer short' }));

    expect(response.status).toBe(401);
  });

  it('answers 401 to the right length but the wrong value', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { POST } = await loadRoute();

    const wrong = 'x'.repeat(SECRET.length);
    const response = await POST(request('POST', { authorization: `Bearer ${wrong}` }));

    expect(response.status).toBe(401);
  });
});

describe('the run', () => {
  it('POST runs once with a sender and the public origin, and returns the result', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { POST } = await loadRoute();

    const response = await POST(request('POST', { authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FIXED_RESULT);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(resolveEmailSenderMock).toHaveBeenCalledTimes(1);
    expect(runWeeklyDigestMock).toHaveBeenCalledTimes(1);

    const call = runWeeklyDigestMock.mock.calls[0]?.[0];
    if (!call) {
      throw new Error('the digest run was not called');
    }
    expect(call.now).toBeInstanceOf(Date);
    expect(call.sender).toBe(sender);
    expect(call.origin).toBe('https://groupeat.example');
  });

  it('GET is the same handler, because the scheduler sends GET', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { GET } = await loadRoute();

    const response = await GET(request('GET', { authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FIXED_RESULT);
    expect(runWeeklyDigestMock).toHaveBeenCalledTimes(1);
  });
});
