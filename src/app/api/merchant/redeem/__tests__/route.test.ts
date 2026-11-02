import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/merchant/redeem` — the wire format and the status codes.
 *
 * ## What is real and what is mocked
 *
 * `redeemCode` is mocked. Its own suite (`lib/redemption/__tests__/redeem.test.ts`)
 * already proves the lock against real Postgres, and re-proving it through HTTP
 * would make this file slow and would test the domain twice.
 *
 * What is *not* mocked is everything this file exists to check: the session gate
 * (`requireMerchant`), the body parser, and the outcome→response mapping. Those are
 * the parts a change to this route can break, and they are exactly the parts a
 * domain test cannot see.
 *
 * `requireMerchant` is replaced rather than exercised because it imports
 * `server-only`, which throws outside a React Server Component graph. That is the
 * same reason `lib/auth` is not imported by any other test in this repo.
 *
 * ## Why the assertions are on status codes as well as bodies
 *
 * The interesting decision in this route is that a **refusal is a 200**. If someone
 * later "fixes" that to a 409, the screen starts showing an error path for a diner
 * who is simply at the wrong restaurant. These tests pin the choice, and the comment
 * in the route explains why it was made.
 */

const sessionState = {
  userId: 'user-1',
  role: 'MERCHANT' as string,
  merchantIds: ['merchant-1'] as string[],
};

vi.mock('@/lib/auth/authorize', () => ({
  requireMerchant: async () => {
    if (sessionState.merchantIds === null) {
      // Mirrors the real function's 401 for no session.
      const { AppError } = await import('@/lib/errors');
      throw AppError.unauthorized();
    }
    return {
      session: {
        userId: sessionState.userId,
        role: sessionState.role,
        mustChangePassword: false,
      },
      merchantIds: sessionState.merchantIds,
    };
  },
}));

type RedeemArgs = {
  code: string;
  merchantIds: readonly string[];
  userId: string;
  requested?: number;
};

const redeemMock = vi.fn(async (_args: RedeemArgs) => ({ kind: 'REDEEMED' }) as unknown);

vi.mock('@/lib/redemption/redeem', () => ({
  redeemCode: (args: RedeemArgs) => redeemMock(args),
}));

const ROUTE_URL = 'http://localhost/api/merchant/redeem';

async function loadRoute() {
  return import('@/app/api/merchant/redeem/route');
}

function post(body: unknown): NextRequest {
  return new NextRequest(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRaw(body: string): NextRequest {
  return new NextRequest(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

afterAll(() => {
  vi.resetModules();
});

beforeEach(() => {
  redeemMock.mockClear();
  sessionState.userId = 'user-1';
  sessionState.role = 'MERCHANT';
  sessionState.merchantIds = ['merchant-1'];
});

describe('POST /api/merchant/redeem — auth', () => {
  it('returns 401 and never touches the domain when there is no session', async () => {
    const { POST } = await loadRoute();
    sessionState.merchantIds = null as unknown as string[];

    const response = await POST(post({ code: 'v1.a.b' }));

    expect(response.status).toBe(401);
    // The membership of this assertion is the point: an unauthenticated request
    // must not reach `redeemCode` at all, so a bug in the gate cannot be a bug that
    // hands over food.
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it('passes the session user id as the audit actor', async () => {
    const { POST } = await loadRoute();
    sessionState.userId = 'staff-9';

    await POST(post({ code: 'v1.abc.def' }));

    expect(redeemMock).toHaveBeenCalledTimes(1);
    const args = redeemMock.mock.calls[0]?.[0];
    expect(args?.userId).toBe('staff-9');
  });

  it('passes the session merchant scope, never an id from the body', async () => {
    const { POST } = await loadRoute();
    sessionState.merchantIds = ['mine'];

    await POST(post({ code: 'v1.abc.def', merchantId: 'someone-elses' }));

    const args = redeemMock.mock.calls[0]?.[0];
    // The body field is ignored entirely — `RedeemArgs` has no place to put it.
    expect(args?.merchantIds).toEqual(['mine']);
  });
});

describe('POST /api/merchant/redeem — the body', () => {
  it('rejects a body with no code as a 422', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post({}));

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; fieldErrors: Record<string, string> };
    expect(body.error).toBe('VALIDATION');
    expect(Object.keys(body.fieldErrors)).toContain('code');
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it('rejects an empty string as a 422', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post({ code: '' }));
    expect(response.status).toBe(422);
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it('rejects unparseable JSON as a 422 rather than a 500', async () => {
    const { POST } = await loadRoute();
    const response = await POST(postRaw('{not json'));
    expect(response.status).toBe(422);
  });

  it('rejects an absurdly long code before it reaches an HMAC', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post({ code: 'x'.repeat(4096) }));

    expect(response.status).toBe(422);
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it('rejects a non-integer quantity', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post({ code: 'v1.a.b', requested: 1.5 }));
    expect(response.status).toBe(422);
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it('omits `requested` entirely when the scan did not ask for a quantity', async () => {
    const { POST } = await loadRoute();
    await POST(post({ code: 'v1.abc.def' }));

    const args = redeemMock.mock.calls[0]?.[0];
    // `undefined` means "all remaining". Passing `0` or `qty` here instead would
    // silently change how many plates a scan takes.
    expect(args?.requested).toBeUndefined();
    expect(Object.hasOwn(args ?? {}, 'requested')).toBe(false);
  });

  it('forwards an explicit quantity', async () => {
    const { POST } = await loadRoute();
    await POST(post({ code: 'v1.abc.def', requested: 2 }));
    expect(redeemMock.mock.calls[0]?.[0]?.requested).toBe(2);
  });
});

describe('POST /api/merchant/redeem — outcome to response', () => {
  it('200s a successful redemption with the plate arithmetic', async () => {
    const { POST } = await loadRoute();
    redeemMock.mockResolvedValueOnce({
      kind: 'REDEEMED',
      participantId: 'p1',
      dropId: 'd1',
      name: 'Wei Chen',
      qty: 3,
      taken: 3,
      redeemedQty: 3,
      remaining: 0,
    });

    const response = await POST(post({ code: 'v1.abc.def' }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('REDEEMED');
    expect(body.taken).toBe(3);
    expect(body.remaining).toBe(0);
  });

  it('200s a partial redemption and says why it was partial', async () => {
    const { POST } = await loadRoute();
    redeemMock.mockResolvedValueOnce({
      kind: 'PARTIAL',
      participantId: 'p1',
      dropId: 'd1',
      name: 'Wei Chen',
      qty: 4,
      taken: 1,
      redeemedQty: 4,
      remaining: 0,
      reason: 'ALREADY_PARTLY_REDEEMED',
    });

    const response = await POST(post({ code: 'v1.abc.def', requested: 2 }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.outcome).toBe('PARTIAL');
    expect(body.taken).toBe(1);
    // The screen needs both numbers to say "we gave you one, the other three were
    // already collected".
    expect(body.qty).toBe(4);
    expect(body.reason).toBe('ALREADY_PARTLY_REDEEMED');
  });

  it('200s a double scan with the time of the first collection (FR-605)', async () => {
    const { POST } = await loadRoute();
    const at = new Date('2026-11-01T19:30:00.000Z');
    redeemMock.mockResolvedValueOnce({
      kind: 'ALREADY_REDEEMED',
      participantId: 'p1',
      dropId: 'd1',
      name: 'Wei Chen',
      qty: 2,
      redeemedQty: 2,
      redeemedAt: at,
    });

    const response = await POST(post({ code: 'v1.abc.def' }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('ALREADY_REDEEMED');
    // Serialised as an ISO instant so the screen renders it in the merchant's
    // timezone rather than the server's.
    expect(body.redeemedAt).toBe(at.toISOString());
  });

  it('200s a refusal — a refusal is a processed scan, not a failed request', async () => {
    const { POST } = await loadRoute();
    redeemMock.mockResolvedValueOnce({ kind: 'REFUSED', reason: 'DROP_FAILED' });

    const response = await POST(post({ code: 'v1.abc.def' }));

    // This is the assertion that pins the design decision. A 4xx here would make
    // every fetch wrapper treat a diner at a counter as a program error.
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      outcome: string;
      reason: string;
      copy: { title: string; detail: string };
    };
    expect(body.ok).toBe(false);
    expect(body.outcome).toBe('REFUSED');
    expect(body.reason).toBe('DROP_FAILED');
    // The sentence travels with the reason, so the screen cannot invent its own.
    expect(body.copy.title).toBe('This drop did not run');
    expect(body.copy.detail.length).toBeGreaterThan(0);
  });

  it('gives an unreadable-order refusal the same copy as a foreign drop', async () => {
    const { POST } = await loadRoute();

    redeemMock.mockResolvedValueOnce({ kind: 'REFUSED', reason: 'NOT_YOUR_DROP' });
    const foreign = (await (await POST(post({ code: 'v1.a.b' }))).json()) as {
      copy: { title: string; detail: string };
    };

    redeemMock.mockResolvedValueOnce({ kind: 'REFUSED', reason: 'UNKNOWN_PARTICIPANT' });
    const unknown = (await (await POST(post({ code: 'v1.a.b' }))).json()) as {
      copy: { title: string; detail: string };
    };

    // Byte-identical, so a valid code cannot be used to probe for drop ids. Asserted
    // at the HTTP layer because that is where a client would read it.
    expect(foreign.copy).toEqual(unknown.copy);
  });

  it('500s when the domain throws, without leaking the message', async () => {
    const { POST } = await loadRoute();
    redeemMock.mockRejectedValueOnce(new Error('connection reset by peer at 10.0.0.4'));

    const response = await POST(post({ code: 'v1.abc.def' }));
    expect(response.status).toBe(500);

    const raw = await response.text();
    expect(raw).not.toContain('10.0.0.4');
    expect(raw).not.toContain('connection reset');
  });
});

describe('GET /api/merchant/redeem — the session probe', () => {
  it('200s with the role and scope for a signed-in staff member', async () => {
    const { GET } = await loadRoute();
    sessionState.role = 'MERCHANT';

    const response = await GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { role: string; merchantIds: string[] };
    expect(body.role).toBe('MERCHANT');
    expect(body.merchantIds).toEqual(['merchant-1']);
  });

  it('401s without a session, so the screen can redirect before nine scans', async () => {
    const { GET } = await loadRoute();
    sessionState.merchantIds = null as unknown as string[];

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('never redeems anything', async () => {
    const { GET } = await loadRoute();
    await GET();
    expect(redeemMock).not.toHaveBeenCalled();
  });
});
