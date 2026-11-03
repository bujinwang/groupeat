import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * `POST /api/organiser/drops/:id/share` — FR-802, and the claim that makes it safe.
 *
 * > `POST   /api/organiser/drops/:id/share` — PRD-v1.md:874
 *
 * ## The one test this file exists for
 *
 * `it('returns the same token the server action returns for the same organiser and drop')`.
 * Everything else is the vocabulary around it.
 *
 * The gap this slice closes is that the capability shipped as a server action and the
 * declared route was never built. Building the route is the easy half. The failure mode
 * is a *second entry point that is not the same product*: a different token for the same
 * organiser and drop would split `clicks` across two rows and pay commission off one of
 * them; a different URL would drop `?src=organiser_link` and make every view classify as
 * `direct`; a different message would state numbers the page does not show. None of those
 * raises an error, and no test of either entry point alone can see them — so the test is
 * explicitly a *comparison* of the two.
 *
 * Both entry points are driven for real: the real `getShareLinkAction` with a real
 * `FormData`, and the real `POST` handler with a real `NextRequest`, against real
 * Postgres.
 *
 * ## What is mocked
 *
 *   - `server-only`, as in the sibling route test — its throw is a React-graph
 *     constraint, not behaviour.
 *   - `@/lib/auth/session`, because `getSession` reads a cookie jar that does not exist
 *     here. Everything above it (`requireOrganiserWrite`, `refuseIfImpersonating`, the
 *     `mustChangePassword` refusal) is the real module.
 *   - `next/cache`, because `revalidatePath` outside a request scope is a no-op that
 *     warns. Its absence from the route is itself asserted below.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

type MockSession = {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword: boolean;
  impersonation?: { actorUserId: string; auditId: string; expiresAt: number };
};

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { shareMessageFor, shareUrlFor } = await import('@/lib/organisers/share-link');

const PREFIX = `os${Date.now().toString(36).slice(-6)}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

const HOUR = 60 * 60 * 1000;
const DEAL_PRICE = 1350;

let merchantId = '';
let itemId = '';
let organiserUserId = '';
let organiserProfileId = '';
let profilelessUserId = '';
let liveDropId = '';
let livePublicCode = '';

type SharePayload = {
  token: string;
  url: string | null;
  message: string | null;
  composed: boolean;
  reason?: string;
  drop: { id: string; publicCode: string; title: string; cutoffAt: string; timeZone: string };
};

async function callShare(dropId: string): Promise<Response> {
  const route = await import('@/app/api/organiser/drops/[id]/share/route');
  return route.POST(new NextRequest(`http://localhost/api/organiser/drops/${dropId}/share`, { method: 'POST' }), {
    params: Promise.resolve({ id: dropId }),
  });
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

/** The server action, driven exactly as `ShareLinkControl` drives it. */
async function callAction(dropId: string): Promise<{ error: string | null; token: string | null }> {
  const { getShareLinkAction } = await import('@/app/(organiser)/organiser/actions');
  return getShareLinkAction({ error: null, token: null }, form({ dropId }));
}

/** A drop in a state the route must refuse to share. */
async function dropIn(
  status: 'DRAFT' | 'PUBLISHED' | 'LOCKED',
  cutoffOffsetHours: number,
): Promise<string> {
  return fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 3,
    status,
    cutoffAt: new Date(Date.now() + cutoffOffsetHours * HOUR),
  });
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);

  const organiser = await prisma.user.create({
    data: {
      email: `${PREFIX}-sam@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  organiserUserId = organiser.id;

  const profile = await prisma.organiserProfile.create({
    data: { userId: organiserUserId, displayName: `${PREFIX} Sam`, commissionPct: 5 },
    select: { id: true },
  });
  organiserProfileId = profile.id;

  const bare = await prisma.user.create({
    data: {
      email: `${PREFIX}-bare@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ORGANISER',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  profilelessUserId = bare.id;

  liveDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 4,
    maxQty: 20,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 8 * HOUR),
  });
  const drop = await prisma.drop.findUniqueOrThrow({
    where: { id: liveDropId },
    select: { publicCode: true },
  });
  livePublicCode = drop.publicCode;

  await fx.participant({ dropId: liveDropId, qty: 2, authStatus: 'AUTHORIZED' });
});

beforeEach(() => {
  sessionState.session = {
    userId: organiserUserId,
    role: 'ORGANISER',
    mustChangePassword: false,
  };
});

afterAll(async () => {
  await prisma.shareLink.deleteMany({ where: { organiserId: organiserProfileId } }).catch(() => undefined);
  await prisma.organiserProfile.deleteMany({ where: { userId: organiserUserId } }).catch(() => undefined);
  await fx.cleanup();
  await prisma.user
    .deleteMany({ where: { id: { in: [organiserUserId, profilelessUserId] } } })
    .catch(() => undefined);
  vi.resetModules();
});

describe('POST /api/organiser/drops/:id/share — equivalence with the server action', () => {
  it('returns the same token the server action returns for the same organiser and drop', async () => {
    // The assertion this slice exists for. Order matters: whichever entry point runs
    // second must find the row the first one made, not mint a second.
    const viaRoute = await callShare(liveDropId);
    const routeBody = (await viaRoute.json()) as SharePayload;

    const viaAction = await callAction(liveDropId);

    expect(viaRoute.status).toBe(200);
    expect(viaAction.error).toBeNull();
    expect(routeBody.token).toBe(viaAction.token);

    // And the property behind the equality: one row, because the unique index is what
    // makes "two taps" one link rather than two rows whose `clicks` split.
    const rows = await prisma.shareLink.count({
      where: { organiserId: organiserProfileId, dropId: liveDropId },
    });
    expect(rows).toBe(1);
  });

  it('is stable in the other direction too — the action finds the route’s link', async () => {
    // The reverse order, on a drop of its own. If either path had its own idea of the
    // key, one direction would pass and the other would mint a second row.
    const drop = await dropIn('PUBLISHED', 7);

    const viaAction = await callAction(drop);
    const viaRoute = await callShare(drop);
    const routeBody = (await viaRoute.json()) as SharePayload;

    expect(viaAction.token).toBe(routeBody.token);
    expect(await prisma.shareLink.count({ where: { dropId: drop } })).toBe(1);
  });

  it('composes the identical URL the pure formatter produces from the shared token', async () => {
    // `?src=organiser_link` is the parameter that makes an organiser view count as
    // `organiser_link` rather than `direct`. A route returning a bare token would push
    // that assembly onto the client, and the plausible mistake is to omit it — silently.
    const body = (await (await callShare(liveDropId)).json()) as SharePayload;

    expect(body.url).toBe(
      shareUrlFor({ publicCode: livePublicCode, token: body.token, origin: undefined }),
    );
    // The deployment here has no APP_URL, so the link is relative — which `shareUrlFor`
    // is allowed to return and the page says out loud.
    expect(body.url).toContain('/d/');
    expect(body.url).toContain('src=organiser_link');
    expect(body.url).toContain(`o=${body.token}`);
  });

  it('composes the identical message the page composes', async () => {
    const body = (await (await callShare(liveDropId)).json()) as SharePayload;
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: liveDropId },
      select: {
        title: true,
        dealPriceCents: true,
        minQty: true,
        cutoffAt: true,
        merchant: { select: { name: true, timezone: true } },
        menuItem: { select: { menuPriceCents: true } },
        participants: { select: { qty: true } },
      },
    });

    // Composed from the same pure formatter the client component calls, with the numbers
    // from the same row. If the route had its own four-line format, this is where it
    // would show: the text still looks right, it just stops matching the page.
    const expected = shareMessageFor({
      title: row.title,
      merchantName: row.merchant.name,
      dealPriceCents: row.dealPriceCents,
      menuPriceCents: row.menuItem.menuPriceCents,
      minQty: row.minQty,
      joinedQty: row.participants.reduce((sum, p) => sum + p.qty, 0),
      cutoffAt: row.cutoffAt,
      timeZone: row.merchant.timezone,
      url: body.url ?? '',
    });

    expect(body.message).toBe(expected);
    // Four lines, and the link is the last of them.
    expect(body.message?.split('\n')).toHaveLength(4);
    expect(body.message?.split('\n')[3]).toBe(body.url);
    expect(body.composed).toBe(true);
  });
});

describe('POST /api/organiser/drops/:id/share — authorisation', () => {
  it('answers 401 with no session and mints nothing', async () => {
    sessionState.session = null;
    const before = await prisma.shareLink.count();

    const response = await callShare(liveDropId);

    expect(response.status).toBe(401);
    expect(await prisma.shareLink.count()).toBe(before);
  });

  it('answers 403 for a MERCHANT session', async () => {
    sessionState.session = { userId: organiserUserId, role: 'MERCHANT', mustChangePassword: false };
    expect((await callShare(liveDropId)).status).toBe(403);
  });

  it('answers 403 for an ADMIN session, so an admin cannot mint attribution rows', async () => {
    sessionState.session = { userId: organiserUserId, role: 'ADMIN', mustChangePassword: false };
    expect((await callShare(liveDropId)).status).toBe(403);
  });

  it('answers 403, not 404, for an organiser whose account has no profile', async () => {
    sessionState.session = { userId: profilelessUserId, role: 'ORGANISER', mustChangePassword: false };
    const response = await callShare(liveDropId);
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(403);
    expect(body.message).toMatch(/organiser profile/i);
  });

  it('refuses a borrowed session, which the server action cannot be asked about', async () => {
    // Unreachable through the app today — impersonation is merchant-only, so the role
    // check answers first — but a signed claim can carry the marker, so this guard can
    // break and therefore can be tested. If organiser impersonation is ever added, the
    // write path is already shut.
    sessionState.session = {
      userId: organiserUserId,
      role: 'ORGANISER',
      mustChangePassword: false,
      impersonation: { actorUserId: 'admin-1', auditId: 'audit-1', expiresAt: 0 },
    };
    const before = await prisma.shareLink.count();

    const response = await callShare(liveDropId);
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(403);
    expect(body.message).toMatch(/impersonat/i);
    expect(await prisma.shareLink.count()).toBe(before);
  });

  it('refuses a temporary password, exactly as the server action does', async () => {
    // The action's own sentence is "a temporary password is not a person yet". An API
    // that minted attribution rows anyway would let a new organiser farm links before
    // ever choosing a password — so the route refuses, and the token is not created.
    sessionState.session = { userId: organiserUserId, role: 'ORGANISER', mustChangePassword: true };
    const drop = await dropIn('PUBLISHED', 5);

    const before = await prisma.shareLink.count({ where: { dropId: drop } });
    const response = await callShare(drop);

    expect(response.status).toBe(403);
    expect(await prisma.shareLink.count({ where: { dropId: drop } })).toBe(before);
  });
});

describe('POST /api/organiser/drops/:id/share — the states a drop can be in', () => {
  it('refuses a locked drop with 409, not 404 and not 400', async () => {
    const drop = await dropIn('LOCKED', 4);

    const response = await callShare(drop);
    const body = (await response.json()) as { message: string };

    // The request was well formed and no different body would help: the drop is in a
    // state that forbids the action. That is `AppError.conflict`'s definition, and it is
    // the distinction that tells a client "stop, nothing to retry" rather than "you
    // typed something wrong".
    expect(response.status).toBe(409);
    expect(body.message).toMatch(/not taking shares|still open/i);
    expect(await prisma.shareLink.count({ where: { dropId: drop } })).toBe(0);
  });

  it('refuses a PUBLISHED drop whose cutoff has passed, which the status alone would allow', async () => {
    const drop = await dropIn('PUBLISHED', -1);

    expect((await callShare(drop)).status).toBe(409);
    expect(await prisma.shareLink.count({ where: { dropId: drop } })).toBe(0);
  });

  it('refuses a DRAFT drop, which nobody outside the merchant has seen', async () => {
    const drop = await dropIn('DRAFT', 6);
    expect((await callShare(drop)).status).toBe(409);
  });

  it('refuses an id that does not exist, and does not say whether it exists', async () => {
    const response = await callShare('00000000-0000-0000-0000-000000000000');
    const body = (await response.json()) as { message: string };

    // Same 409 as a closed drop: `ensureShareLink` collapses the three cases on purpose,
    // and splitting them here would tell a guesser which drop ids are real.
    expect(response.status).toBe(409);
    expect(body.message).not.toMatch(/not found|does not exist/i);
  });

  it('refuses a malformed id with the same 409 rather than a 400', async () => {
    // Probed rather than assumed: Prisma answers `findUnique` with `null` for a string
    // that is not a uuid instead of throwing, so a hand-edited URL reaches the state
    // check. A 400 "not a uuid" would leak that the id space is uuid-typed and would be
    // a second, differently-worded refusal for the same user situation.
    const response = await callShare('not-a-uuid');
    expect(response.status).toBe(409);
  });

  it('shows the minted link on the list afterwards, so the page and the API agree', async () => {
    const drop = await dropIn('PUBLISHED', 9);
    const body = (await (await callShare(drop)).json()) as SharePayload;

    const { listShareableDrops } = await import('@/lib/db/share-links');
    const [row] = await listShareableDrops({ organiserProfileId, dropId: drop });

    // The property that makes a second client usable: the token it just received is the
    // token the page would render, so "Get share link" is already done.
    expect(row?.existingToken).toBe(body.token);
  });
});

describe('POST /api/organiser/drops/:id/share — the octet stream', () => {
  it('is not cacheable, because the body carries a credential', async () => {
    // A token is what FR-804 pays commission off. A cached response hands a proxy a link
    // that outlives the organiser's intent.
    expect((await callShare(liveDropId)).headers.get('cache-control')).toBe('no-store');
  });

  it('carries no participant PII', async () => {
    const response = await callShare(liveDropId);
    const text = await response.text();

    const customer = await prisma.customer.findFirstOrThrow({
      where: { participants: { some: { dropId: liveDropId } } },
      select: { phone: true },
    });

    expect(text).not.toContain(customer.phone);
    expect(text).not.toContain(customer.phone.slice(-4));
    expect(text).not.toContain('"customerId"');
  });

  it('writes exactly one ShareLink row and no audit row', async () => {
    // The write is the mint. A `shareLink` audit entry would be redundant — the row *is*
    // the record, with `createdAt` on it — and the action does not write one either.
    const drop = await dropIn('PUBLISHED', 3);
    const auditsBefore = await prisma.auditLog.count();

    await callShare(drop);

    expect(await prisma.shareLink.count({ where: { dropId: drop } })).toBe(1);
    expect(await prisma.auditLog.count()).toBe(auditsBefore);
  });

  it('does not purge the page cache from an API call', async () => {
    // `getShareLinkAction` calls `revalidatePath('/organiser')` because it *is* that page
    // refreshing. A route is not, and purging a cache as a side effect of an API call is
    // something the caller did not ask for. Asserted so nobody adds it for symmetry.
    const { revalidatePath } = await import('next/cache');
    const spy = vi.mocked(revalidatePath);
    spy.mockClear();

    await callShare(liveDropId);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /api/organiser/drops/:id/share — the log line tells the truth', () => {
  /**
   * The real logger writes one JSON object per line to stdout, so capturing stdout is
   * capturing the event stream — no mock, and `redact` still runs.
   */
  async function captureEvents<T>(run: () => Promise<T>): Promise<{ log: string[]; result: T }> {
    const lines: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });

    try {
      const result = await run();
      return { log: lines, result };
    } finally {
      spy.mockRestore();
    }
  }

  function shareEvents(lines: string[]): { event: string; dropId: string; source: string }[] {
    return lines
      .flatMap((line) => line.trim().split('\n'))
      .filter((line) => line.includes('organiser.share_link_'))
      .map((line) => JSON.parse(line) as { event: string; dropId: string; source: string });
  }

  it('emits `created` on the tap that inserts and `reused` on the tap that finds', async () => {
    // Before this slice the event was `organiser.share_link_created` on *every* tap, so
    // counting links counted taps. With a second entry point emitting it, the fiction
    // would have been twice as common — the reason `created` exists at all.
    const drop = await dropIn('PUBLISHED', 11);

    const first = await captureEvents(() => callShare(drop));
    const second = await captureEvents(() => callShare(drop));

    expect(shareEvents(first.log).map((entry) => entry.event)).toEqual([
      'organiser.share_link_created',
    ]);
    expect(shareEvents(second.log).map((entry) => entry.event)).toEqual([
      'organiser.share_link_reused',
    ]);
  });

  it('names its own entry point, so the two are distinguishable in the stream', async () => {
    const drop = await dropIn('PUBLISHED', 12);

    const viaRoute = await captureEvents(() => callShare(drop));
    const viaAction = await captureEvents(() => callAction(drop));

    expect(shareEvents(viaRoute.log)[0]?.source).toBe('api');
    expect(shareEvents(viaAction.log)[0]?.source).toBe('action');
    // And the action's tap was the reuse, because the route got there first.
    expect(shareEvents(viaAction.log)[0]?.event).toBe('organiser.share_link_reused');
  });

  it('logs no token, and no phone number', async () => {
    // The log map has no field that could carry either — this asserts the emit does not
    // smuggle one in through a free-text field.
    const { log, result } = await captureEvents(() => callShare(liveDropId));
    const body = (await result.json()) as SharePayload;

    const relevant = log.filter((line) => line.includes('organiser.share_link_'));
    expect(relevant.length).toBeGreaterThan(0);
    for (const line of relevant) {
      expect(line).not.toContain(body.token);
    }
  });
});
