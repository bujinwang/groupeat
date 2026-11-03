import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AdminDropsModule from '@/lib/db/admin-drops';

/**
 * `GET /api/admin/drops` — FR-901's wire format.
 *
 * ## What is mocked and what is not
 *
 * `listAdminDrops` is mocked: its own suite proves the query against real Postgres.
 * What is under test here is the route's own decisions —
 *
 *   - `requireAdmin` runs **before** any data is read;
 *   - a bogus `?status=` is reported rather than silently ignored, with the applied
 *     filter named in the response;
 *   - dates leave as ISO-8601 with an offset, per PRD §11;
 *   - a database fault is a 500 with no row data leaking into the body.
 *
 * `requireAdmin` is replaced rather than exercised because `authorize.ts` imports
 * `server-only`, which throws outside a React Server Component graph. Same note as
 * every other route test in this repo.
 */

const sessionState: { signedIn: boolean } = { signedIn: true };

vi.mock('@/lib/auth/authorize', () => ({
  requireAdmin: async () => {
    if (!sessionState.signedIn) {
      const { AppError } = await import('@/lib/errors');
      throw AppError.unauthorized();
    }
    return { userId: 'admin-1', role: 'ADMIN', mustChangePassword: false };
  },
}));

type ListArgs = { status?: string | null; limit?: number };

const listMock = vi.fn(async (_args: ListArgs = {}) => ({
  rows: [
    {
      id: 'drop-1',
      publicCode: 'ABC123',
      title: 'Butter chicken',
      status: 'CAPTURED',
      merchantId: 'merchant-1',
      merchantName: 'Rangoli',
      merchantTimezone: 'America/Edmonton',
      dealPriceCents: 1250,
      minQty: 5,
      maxQty: 40,
      joinedQty: 12,
      participantCount: 7,
      capturedCents: 15000,
      refundedCents: 0,
      cutoffAt: new Date('2026-11-03T19:00:00.000Z'),
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
    },
  ],
  countsByStatus: {
    DRAFT: 0,
    PUBLISHED: 2,
    LOCKED: 0,
    CAPTURED: 1,
    PICKUP_OPEN: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELLED: 0,
  },
  totalCents: 15000,
  totalDrops: 3,
}));

vi.mock('@/lib/db/admin-drops', async () => {
  // The real parser is kept: the route's handling of a bad `?status=` is exactly what
  // this file is checking, so stubbing the parser would test the mock.
  const actual = await vi.importActual<typeof AdminDropsModule>('@/lib/db/admin-drops');
  return {
    ...actual,
    listAdminDrops: (args: ListArgs) => listMock(args),
  };
});

const ROUTE_URL = 'http://localhost/api/admin/drops';

async function loadRoute() {
  return import('@/app/api/admin/drops/route');
}

function get(url: string = ROUTE_URL): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

beforeEach(() => {
  listMock.mockClear();
  sessionState.signedIn = true;
});

afterAll(() => {
  vi.resetModules();
});

describe('GET /api/admin/drops', () => {
  it('returns the list with ISO timestamps', async () => {
    const { GET } = await loadRoute();
    const response = await GET(get());
    const body = (await response.json()) as {
      drops: { cutoffAt: string; createdAt: string; title: string }[];
      totalCents: number;
    };

    expect(response.status).toBe(200);
    expect(body.drops).toHaveLength(1);
    expect(body.totalCents).toBe(15000);

    // PRD §11: ISO-8601 with offset. A bare `Date` would serialise to the same string,
    // but the assertion is what stops somebody returning `cutoffAt` raw and losing the
    // contract silently.
    expect(body.drops[0]?.cutoffAt).toBe('2026-11-03T19:00:00.000Z');
    expect(body.drops[0]?.createdAt).toBe('2026-11-01T10:00:00.000Z');
  });

  it('answers 401 before reading any data', async () => {
    sessionState.signedIn = false;
    const { GET } = await loadRoute();
    const response = await GET(get());

    expect(response.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('passes a valid status through as a filter', async () => {
    const { GET } = await loadRoute();
    const response = await GET(get(`${ROUTE_URL}?status=FAILED`));
    const body = (await response.json()) as { appliedStatus: string | null; filterIgnored: boolean };

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0]?.[0]?.status).toBe('FAILED');
    expect(body.appliedStatus).toBe('FAILED');
    expect(body.filterIgnored).toBe(false);
  });

  it('names the ignored filter instead of failing or silently showing everything', async () => {
    const { GET } = await loadRoute();
    const response = await GET(get(`${ROUTE_URL}?status=NONSENSE`));
    const body = (await response.json()) as {
      appliedStatus: string | null;
      requestedStatus: string | null;
      filterIgnored: boolean;
      drops: unknown[];
    };

    // 200, not 422: an operator who mistypes should see the whole list plus a note. A
    // filter that silently matches nothing is indistinguishable from finding nothing.
    expect(response.status).toBe(200);
    expect(body.appliedStatus).toBeNull();
    expect(body.requestedStatus).toBe('NONSENSE');
    expect(body.filterIgnored).toBe(true);
    expect(body.drops).toHaveLength(1);
    expect(listMock.mock.calls[0]?.[0]?.status).toBeNull();
  });

  it('reports no filter when none was asked for', async () => {
    const { GET } = await loadRoute();
    const response = await GET(get());
    const body = (await response.json()) as { requestedStatus: null; filterIgnored: boolean };

    expect(body.requestedStatus).toBeNull();
    expect(body.filterIgnored).toBe(false);
  });

  it('includes the global counts so a caller sees the whole table, not the page', async () => {
    const { GET } = await loadRoute();
    const response = await GET(get(`${ROUTE_URL}?status=CAPTURED`));
    const body = (await response.json()) as {
      countsByStatus: Record<string, number>;
      totalDrops: number;
      drops: unknown[];
    };

    // The list is filtered; the counts are not. Same rule as the page's chips.
    expect(body.countsByStatus.PUBLISHED).toBe(2);

    // And the "whole table" figure must not be `drops.length` either: one row is
    // returned, three drops exist. Sending `drops.length` here would give a chip bar
    // built on this endpoint the same filtered-count bug the page had.
    expect(body.drops).toHaveLength(1);
    expect(body.totalDrops).toBe(3);
  });

  it('maps a database fault to a 500 without leaking rows', async () => {
    listMock.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    const { GET } = await loadRoute();
    const response = await GET(get());
    const body = (await response.json()) as { drops?: unknown };

    expect(response.status).toBe(500);
    expect(body.drops).toBeUndefined();
  });
});
