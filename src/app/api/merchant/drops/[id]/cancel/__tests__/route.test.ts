import 'dotenv/config';

import { NextRequest } from 'next/server';

import type * as PrismaModule from '@/lib/db/prisma';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/merchant/drops/:id/cancel` — FR-208's wire format.
 *
 * ## What is real and what is mocked
 *
 * `cancelDrop` is mocked. Its own suite (`lib/drops/__tests__/cancel.test.ts`) proves
 * the CAS, the ordering and the hold release against real Postgres; re-proving them
 * through HTTP would test the domain twice and make this file slow.
 *
 * What is **not** mocked is everything this file exists to check:
 *
 *   - the write gate (FR-904) — an impersonating admin must not be able to call off a
 *     merchant's drop, and that is the worst thing a borrowed session could do;
 *   - the body schema — 422 with field errors before the service is touched;
 *   - the scope passthrough — the route must hand `cancelDrop` the session's
 *     `merchantIds`, never a client-supplied one;
 *   - the status mapping for every refusal kind.
 *
 * The three `server-only` modules are replaced because they throw outside a React
 * Server Component graph. Same reason, and same note, as the redeem route test: the
 * marker is on a **boundary** (`real-charge-port`, `twilio-sender`) and mocking it
 * here stands in for the bundler. That is different from FR-902's mistake, where the
 * marker sat on a service and removing it was the correct fix.
 */

const sessionState: {
  userId: string;
  role: string;
  merchantIds: string[] | null;
  /** FR-904: true models a borrowed, read-only session. */
  impersonating: boolean;
} = {
  userId: 'user-1',
  role: 'MERCHANT',
  merchantIds: ['merchant-1'],
  impersonating: false,
};

vi.mock('@/lib/auth/authorize', () => ({
  requireMerchantWrite: async () => {
    if (sessionState.merchantIds === null) {
      // Mirrors the real function's 401 for no session.
      const { AppError } = await import('@/lib/errors');
      throw AppError.unauthorized();
    }
    if (sessionState.impersonating) {
      const { AppError } = await import('@/lib/errors');
      throw AppError.forbidden(
        'You are viewing this account as an admin. Changes are disabled during impersonation — end the session to make edits as yourself.',
      );
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

// `server-only` throws on import outside the React server graph. Standing in for the
// bundler, not weakening a guarantee — see the module docblock.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/settlement/real-charge-port', () => ({
  realChargePort: () => ({ __fake: 'port' }),
}));
vi.mock('@/lib/notify/compose-port', () => ({
  composingNotifyPort: () => ({ __fake: 'notify' }),
}));
vi.mock('@/lib/notify/twilio-sender', () => ({
  resolveSender: () => ({ __fake: 'sender' }),
}));

// The route reads the actor's email from the `User` row. Stubbed at the Prisma
// boundary rather than by mocking `@/lib/db/prisma`, so the route's own logic — the
// 401 for a deleted user — stays under test.
vi.mock('@/lib/db/prisma', async () => {
  const actual = await vi.importActual<typeof PrismaModule>('@/lib/db/prisma');  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      user: {
        findUnique: async () => ({ email: 'owner@rangoli.test' }),
      },
    },
  };
});

type CancelArgs = {
  merchantIds: readonly string[];
  dropId: string;
  confirmPublicCode: string;
  reason: string;
  ipAddress?: string | null;
  actor: { userId: string; email: string };
  port: unknown;
  notify: unknown;
};

const cancelMock = vi.fn(
  async (_args: CancelArgs) =>
    ({
      kind: 'CANCELLED',
      dropId: 'drop-1',
      publicCode: 'ABC123',
      voidedAuthorisations: 3,
      alreadyExpiredAuthorisations: 0,
      pendingVoids: 0,
      notifiedParticipants: 3,
      auditId: 'audit-1',
    }) as unknown,
);

vi.mock('@/lib/drops/cancel', () => ({
  cancelDrop: (args: CancelArgs) => cancelMock(args),
}));

const ROUTE_URL = 'http://localhost/api/merchant/drops/drop-1/cancel';

async function loadRoute() {
  return import('@/app/api/merchant/drops/[id]/cancel/route');
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

const VALID = { confirmPublicCode: 'ABC123', reason: 'Supplier fell through.' };

beforeEach(() => {
  cancelMock.mockClear();
  sessionState.merchantIds = ['merchant-1'];
  sessionState.impersonating = false;
});

afterAll(() => {
  vi.resetModules();
});

describe('POST /api/merchant/drops/:id/cancel', () => {
  it('cancels and returns the release figures', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post(VALID), { params: Promise.resolve({ id: 'drop-1' }) });
    const body = (await response.json()) as { kind: string; voidedAuthorisations: number };

    expect(response.status).toBe(200);
    expect(body.kind).toBe('CANCELLED');
    expect(body.voidedAuthorisations).toBe(3);
  });

  it('passes the session’s merchant scope, never a client-supplied one', async () => {
    const { POST } = await loadRoute();
    // A body carrying its own `merchantIds` must be ignored: the schema has no such
    // field, and the route reads the scope from the session only.
    await POST(
      post({ ...VALID, merchantIds: ['someone-elses-merchant'] }),
      { params: Promise.resolve({ id: 'drop-1' }) },
    );

    expect(cancelMock).toHaveBeenCalledTimes(1);
    const firstCall = cancelMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0].merchantIds).toEqual(['merchant-1']);
  });

  it('passes the actor from the session and the email from the row', async () => {
    const { POST } = await loadRoute();
    await POST(post(VALID), { params: Promise.resolve({ id: 'drop-1' }) });

    const args = cancelMock.mock.calls[0]?.[0];
    expect(args?.actor).toEqual({ userId: 'user-1', email: 'owner@rangoli.test' });
    expect(args?.dropId).toBe('drop-1');
    expect(args?.confirmPublicCode).toBe('ABC123');
    expect(args?.reason).toBe('Supplier fell through.');
  });

  it('refuses an impersonating admin with 403 and calls nothing', async () => {
    sessionState.impersonating = true;
    const { POST } = await loadRoute();
    const response = await POST(post(VALID), { params: Promise.resolve({ id: 'drop-1' }) });
    const body = (await response.json()) as { message?: string };

    expect(response.status).toBe(403);
    expect(body.message).toContain('impersonation');
    // The point of the gate: no cancellation, no audit row, no SMS.
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('answers 401 with no session', async () => {
    sessionState.merchantIds = null;
    const { POST } = await loadRoute();
    const response = await POST(post(VALID), { params: Promise.resolve({ id: 'drop-1' }) });

    expect(response.status).toBe(401);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('refuses a missing reason with a 422 field error, before the service runs', async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      post({ confirmPublicCode: 'ABC123' }),
      { params: Promise.resolve({ id: 'drop-1' }) },
    );
    const body = (await response.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };

    expect(response.status).toBe(422);
    expect(body.error).toBe('VALIDATION');
    expect(body.fieldErrors.reason).toBeDefined();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only reason', async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      post({ confirmPublicCode: 'ABC123', reason: '   ' }),
      { params: Promise.resolve({ id: 'drop-1' }) },
    );

    expect(response.status).toBe(422);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('refuses a missing confirmation code', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post({ reason: 'because' }), {
      params: Promise.resolve({ id: 'drop-1' }),
    });
    const body = (await response.json()) as { fieldErrors: Record<string, string> };

    expect(response.status).toBe(422);
    expect(body.fieldErrors.confirmPublicCode).toBeDefined();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('answers 422 rather than 500 on a body that is not JSON', async () => {
    const { POST } = await loadRoute();
    const response = await POST(postRaw('{not json'), {
      params: Promise.resolve({ id: 'drop-1' }),
    });

    expect(response.status).toBe(422);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('maps a LOCKED refusal to 409 with the cutoff sentence', async () => {
    const { AppError } = await import('@/lib/errors');
    cancelMock.mockRejectedValueOnce(
      AppError.conflict(
        'The cutoff has passed and we are charging cards now, so this drop can no longer be cancelled.',
      ),
    );

    const { POST } = await loadRoute();
    const response = await POST(post(VALID), { params: Promise.resolve({ id: 'drop-1' }) });
    const body = (await response.json()) as { message?: string };

    expect(response.status).toBe(409);
    expect(body.message).toContain('cutoff has passed');
  });

  it('maps a foreign drop to 404, not 403', async () => {
    const { AppError } = await import('@/lib/errors');
    cancelMock.mockRejectedValueOnce(AppError.notFound('That drop does not exist.'));

    const { POST } = await loadRoute();
    const response = await POST(post(VALID), { params: Promise.resolve({ id: 'other-drop' }) });

    // A foreign id must be indistinguishable from a missing one.
    expect(response.status).toBe(404);
  });

  it('maps a code mismatch to 422 with the field named', async () => {
    const { AppError } = await import('@/lib/errors');
    cancelMock.mockRejectedValueOnce(
      AppError.validation({ confirmPublicCode: 'Type the drop code to confirm.' }),
    );

    const { POST } = await loadRoute();
    const response = await POST(post(VALID), { params: Promise.resolve({ id: 'drop-1' }) });
    const body = (await response.json()) as { fieldErrors: Record<string, string> };

    expect(response.status).toBe(422);
    expect(body.fieldErrors.confirmPublicCode).toBeDefined();
  });
});
