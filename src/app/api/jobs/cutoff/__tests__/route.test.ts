import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/jobs/cutoff` — the entry point that moves money.
 *
 * The engineer's `run-tick.test.ts` covers the three refusals (503 unset, 401
 * wrong token, 503 no provider). It does **not** cover the fourth branch: the
 * `200` that actually runs the tick. That is the branch that reaches the charge
 * port, so it is the one worth proving, and it is proved here by replacing the two
 * modules that need real infrastructure — `real-charge-port` (which imports
 * `server-only` and the Stripe SDK) and `run-tick` (which owns the DB scan) — with
 * spies. Everything else — the auth comparison, the status codes, the body — is
 * the production code.
 *
 * The token comparisons are the other half. `timingSafeEqual` throws on buffers of
 * unequal length, so a route that calls it before comparing lengths is a route that
 * returns 500 instead of 401 to anyone who sends a token of the wrong size. The
 * cases below walk the length boundary from both sides.
 */

const FIXED_RESULT = {
  due: 3,
  locked: 2,
  failed: 1,
  settled: 2,
  inProgress: 0,
  noop: 0,
  voided: 4,
  truncated: false,
};

type TickArgs = {
  now: Date;
  port: unknown;
  notify: { notify: (intents: readonly unknown[]) => Promise<void> };
};

const runCutoffTickMock = vi.fn(async (_args: TickArgs) => FIXED_RESULT);

vi.mock('@/lib/settlement/run-tick', () => ({
  runCutoffTick: (args: TickArgs) => runCutoffTickMock(args),
  STALL_THRESHOLD_MS: 600_000,
}));

const realChargePortMock = vi.fn(() => ({
  capture: vi.fn(),
  voidAuthorization: vi.fn(),
  refund: vi.fn(),
}));

vi.mock('@/lib/settlement/real-charge-port', () => ({
  realChargePort: () => realChargePortMock(),
}));

const URL = 'http://localhost/api/jobs/cutoff';
const SECRET = 'a-cron-secret-long-enough-to-be-plausible';

async function loadRoute() {
  return import('@/app/api/jobs/cutoff/route');
}

function post(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(URL, { method: 'POST', headers });
}

beforeEach(() => {
  vi.resetModules();
  runCutoffTickMock.mockClear();
  realChargePortMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the 200 branch', () => {
  it('runs the tick with the real port and returns its result as the body', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_qa_not_a_real_key');
    const { POST } = await loadRoute();

    const response = await POST(post({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FIXED_RESULT);

    // The tick ran exactly once, with a port from the real port factory and a
    // single `now` (design §11.2: one instant per tick).
    expect(runCutoffTickMock).toHaveBeenCalledTimes(1);
    expect(realChargePortMock).toHaveBeenCalledTimes(1);

    const call = runCutoffTickMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error('the tick was not called');
    }
    expect(call.now).toBeInstanceOf(Date);
    expect(Math.abs(call.now.getTime() - Date.now())).toBeLessThan(5_000);
    expect(call.port).toBeDefined();
    expect(typeof call.notify.notify).toBe('function');
  });

  it('refuses to run the tick when the token is right but there is no provider', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const { POST } = await loadRoute();

    const response = await POST(post({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'NOT_CONFIGURED' });
    // The decision phase must not have run: writing LOCKED with no way to charge
    // is the one state with no automated exit.
    expect(runCutoffTickMock).not.toHaveBeenCalled();
  });
});

describe('the bearer comparison', () => {
  it('accepts the exact token and nothing adjacent to it', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_qa_not_a_real_key');
    const { POST } = await loadRoute();

    const cases: { label: string; header?: string }[] = [
      { label: 'no header at all' },
      { label: 'empty header', header: '' },
      { label: 'the secret with no scheme', header: SECRET },
      { label: 'the wrong scheme', header: `Basic ${SECRET}` },
      { label: 'the right scheme in the wrong case', header: `bearer ${SECRET}` },
      { label: 'no space after the scheme', header: `Bearer${SECRET}` },
      { label: 'a prefix of the secret', header: `Bearer ${SECRET.slice(0, -1)}` },
      { label: 'the secret plus one character', header: `Bearer ${SECRET}x` },
      // (A trailing space is not tested: `Headers` strips optional whitespace per
      // RFC 9110, so the route never sees it. That is the HTTP layer, not this one.)
      // Same length, one character different: this is the case that reaches
      // `timingSafeEqual` with two equal-length buffers.
      { label: 'same length, different content', header: `Bearer ${'z'.repeat(SECRET.length)}` },
    ];

    for (const testCase of cases) {
      const response = await POST(post(testCase.header === undefined ? {} : { authorization: testCase.header }));
      expect(response.status, `${testCase.label} must be refused`).toBe(401);
      expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
    }

    expect(runCutoffTickMock).not.toHaveBeenCalled();
  });

  it('never throws out of timingSafeEqual for a token of any size', async () => {
    // `timingSafeEqual` throws `RangeError` on unequal lengths. If the length guard
    // were missing, these would surface as an unhandled 500 rather than a 401 —
    // and a 500 from an auth check is an oracle.
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_qa_not_a_real_key');
    const { POST } = await loadRoute();

    for (const size of [0, 1, 2, SECRET.length - 1, SECRET.length + 1, 4096]) {
      const token = 'q'.repeat(size);
      const response = await POST(post({ authorization: `Bearer ${token}` }));
      expect(response.status, `token of length ${size}`).toBe(401);
    }
  });

  it('is unreachable without a configured secret, even with a plausible token', async () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_qa_not_a_real_key');
    const { POST } = await loadRoute();

    const response = await POST(post({ authorization: 'Bearer anything' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'NOT_CONFIGURED' });
    expect(runCutoffTickMock).not.toHaveBeenCalled();
  });
});
