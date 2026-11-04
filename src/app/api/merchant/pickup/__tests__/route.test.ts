import 'dotenv/config';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { newImpersonationSession } from '@/lib/auth/jwt';

import { GET, PATCH } from '../route';

/**
 * `GET`/`PATCH /api/merchant/pickup` — FR-103, and the body that erases a field.
 *
 * > `FR-103 | Set pickup address and instructions | …`
 *
 * ## The defect this file reproduces
 *
 * `pickupSchema` marks both fields `.nullish()`, and `parsePickupInput` turns a
 * missing field into `null` by the same path it turns a blank one into `null`:
 *
 *     const clean = (value) => { const trimmed = value?.trim() ?? ''; … };
 *
 * So `{"pickupAddress": "123 Main St"}` — a body that says nothing at all about
 * instructions — is parsed to `{ pickupAddress: '123 Main St', pickupInstructions:
 * null }`, and `updateOwnPickup` writes both columns. **An update touching one
 * field silently erases the other**, and answers `200` with the erased value, so
 * the client reports success.
 *
 * That is not a theoretical hazard. `PATCH` means partial update everywhere else
 * in this codebase, and the route is a `PATCH`. The current client
 * (`PickupForm`) sends both fields from state initialised off the server's
 * `GET`, so the shipped UI cannot trigger it — which is precisely why removing
 * the `.nullish()` from one field, or adding a second client that PATCHes only
 * the address, would do the damage in silence. The docblock describes the
 * all-whitespace case ("an empty instruction and a blank instruction are the same
 * thing") and says nothing about the absent case, so this is a gap between what
 * the code does and what the code says.
 *
 * **It is pinned here as current behaviour, not endorsed.** The tests that
 * reproduce it are named so that a future fix fails them and has to update them.
 *
 * ## What is real
 *
 * `getSession` (the seam `authorize.ts` reads through) is the only replacement,
 * plus the analytics `emit` that this route does not use. `requireMerchant`,
 * `refuseIfImpersonating`, `primaryMerchantId`, `updateOwnPickup`'s in-memory
 * scope check, the Zod schema and the `clean` normalisation are all production
 * code against real rows.
 */

type MockSessionInput = {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword: boolean;
  absoluteExpiresAt: number;
  expiresAt: number;
  impersonation?: { actorUserId: string; auditId: string; expiresAt: number };
};

let currentSession: MockSessionInput | null = null;

vi.mock('server-only', () => ({}));

vi.mock('@/lib/auth/session', async () => {
  const jwt = await import('@/lib/auth/jwt');
  return {
    getSession: async () => currentSession,
    roleHome: jwt.roleHome,
    newSession: jwt.newSession,
  };
});

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const PREFIX = `pick${Date.now().toString(36).slice(-5)}`;
const URL = 'http://localhost:3000/api/merchant/pickup';

const merchantIds: string[] = [];
const userIds: string[] = [];

let merchantId = '';
let ownerUserId = '';

/** A second tenant, so the scope check and the 404-not-403 rule are real. */
let otherMerchantId = '';
let otherOwnerUserId = '';

const ADDRESS = '2915 10 Ave NE, Calgary';
const INSTRUCTIONS = 'Side door, ring the bell twice.';

/**
 * The second tenant's own values, distinct from the first's.
 *
 * The first version of this file reused `reset()` for both merchants, so
 * `beforeEach` overwrote the other tenant with the primary tenant's address —
 * and the isolation assertions then compared two identical strings and failed.
 * The lesson is the ordinary one: a fixture helper that takes no arguments is a
 * fixture helper that assumes there is one fixture.
 */
const OTHER_ADDRESS = '999 Other St';
const OTHER_INSTRUCTIONS = 'Back alley.';

function sessionFor(userId: string): MockSessionInput {
  return {
    userId,
    role: 'MERCHANT',
    mustChangePassword: false,
    absoluteExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function patchRequest(raw: string | null): NextRequest {
  return new NextRequest(URL, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    ...(raw === null ? {} : { body: raw }),
  });
}

type PickupBody = { pickupAddress: string | null; pickupInstructions: string | null };

/** The stored row, read directly — never through the route under test. */
async function stored(merchant = merchantId): Promise<PickupBody> {
  const row = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchant },
    select: { pickupAddress: true, pickupInstructions: true },
  });
  return row;
}

async function reset(
  merchant = merchantId,
  values: { pickupAddress: string | null; pickupInstructions: string | null } = {
    pickupAddress: ADDRESS,
    pickupInstructions: INSTRUCTIONS,
  },
): Promise<void> {
  await prisma.merchant.update({
    where: { id: merchant },
    data: values,
  });
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `${PREFIX}-owner@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  ownerUserId = owner.id;
  userIds.push(owner.id);

  const merchant = await prisma.merchant.create({
    data: {
      name: `${PREFIX} kitchen`,
      slug: `${PREFIX}-slug`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      pickupAddress: ADDRESS,
      pickupInstructions: INSTRUCTIONS,
      users: { create: { userId: owner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  merchantId = merchant.id;
  merchantIds.push(merchant.id);

  const otherOwner = await prisma.user.create({
    data: {
      email: `${PREFIX}-other@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  otherOwnerUserId = otherOwner.id;
  userIds.push(otherOwner.id);

  const other = await prisma.merchant.create({
    data: {
      name: `${PREFIX} other kitchen`,
      slug: `${PREFIX}-other-slug`,
      status: 'ACTIVE',
      floorPctOfMenu: 0.25,
      pickupAddress: '999 Other St',
      pickupInstructions: 'Back alley.',
      users: { create: { userId: otherOwner.id, role: 'OWNER' } },
    },
    select: { id: true },
  });
  otherMerchantId = other.id;
  merchantIds.push(other.id);
});

beforeEach(async () => {
  currentSession = sessionFor(ownerUserId);
  await reset();
  await reset(otherMerchantId, {
    pickupAddress: OTHER_ADDRESS,
    pickupInstructions: OTHER_INSTRUCTIONS,
  });
});

afterAll(async () => {
  if (merchantIds.length > 0) {
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('GET — the merchant reads their own details', () => {
  it('returns both fields, and only those two', async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as PickupBody;
    expect(body).toEqual({ pickupAddress: ADDRESS, pickupInstructions: INSTRUCTIONS });
    // Not a spot-check: `Merchant` has ~15 columns including `floorPctOfMenu`,
    // and `getMerchant` returns a `MerchantSummary` that carries most of them.
    // The route narrows to two on purpose.
    expect(Object.keys(body).sort()).toEqual(['pickupAddress', 'pickupInstructions']);
  });

  it('does not leak the floor, which is the governed field', async () => {
    // The route's docblock explains why pickup is a separate endpoint: the floor
    // has its own audit-trailed path. A read that returned `floorPctOfMenu` here
    // would be harmless in isolation but would make the next person put the
    // *write* on this route too, which is the ungoverned write the docblock is
    // written to prevent.
    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('floorPctOfMenu');
    expect(body).not.toHaveProperty('minimumMarginPct');
  });

  it('is scoped to the caller, not to a body or a query', async () => {
    // The other tenant's merchant is reachable by nobody in this test; the GET
    // has no parameters at all, so the only way it can answer is from the
    // session's `MerchantUser` rows.
    currentSession = sessionFor(otherOwnerUserId);
    const body = (await (await GET()).json()) as PickupBody;
    expect(body.pickupAddress).toBe('999 Other St');
  });
});

describe('PATCH — the happy path', () => {
  it('writes both fields and answers with what it stored', async () => {
    const response = await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: '1 New Rd', pickupInstructions: 'Door 3.' })),
    );
    expect(response.status).toBe(200);

    expect((await response.json()) as PickupBody).toEqual({
      pickupAddress: '1 New Rd',
      pickupInstructions: 'Door 3.',
    });
    expect(await stored()).toEqual({ pickupAddress: '1 New Rd', pickupInstructions: 'Door 3.' });
  });

  it('trims whitespace and stores the trimmed value', async () => {
    await PATCH(
      patchRequest(
        JSON.stringify({ pickupAddress: `  ${ADDRESS}  `, pickupInstructions: `\t${INSTRUCTIONS} ` }),
      ),
    );
    // Stored trimmed, not merely displayed trimmed: the address feeds the OG
    // preview card and the instructions render on a 360px phone, so leading
    // spaces are a layout bug rather than a cosmetic one.
    expect(await stored()).toEqual({
      pickupAddress: ADDRESS,
      pickupInstructions: INSTRUCTIONS,
    });
  });

  it('clears a field when it is sent as an empty string', async () => {
    const response = await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: '', pickupInstructions: INSTRUCTIONS })),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as PickupBody).toEqual({
      pickupAddress: null,
      pickupInstructions: INSTRUCTIONS,
    });
    expect((await stored()).pickupAddress).toBeNull();
  });

  it('treats an all-whitespace field as null, not as three spaces', async () => {
    // The docblock's stated rule: "`null` is the one empty". Two representations
    // of empty would mean the deal page has to check both.
    await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: '   ', pickupInstructions: INSTRUCTIONS })),
    );
    expect((await stored()).pickupAddress).toBeNull();
  });
});

describe('PATCH — what it refuses', () => {
  it('refuses a 301-character field and names it', async () => {
    const response = await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: 'a'.repeat(301), pickupInstructions: null })),
    );
    expect(response.status).toBe(422);

    const body = (await response.json()) as {
      error: string;
      message: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe('VALIDATION');
    expect(body.fieldErrors.pickupAddress).toContain('300');
    // The other field is not named, because it was not the problem.
    expect(Object.keys(body.fieldErrors)).toEqual(['pickupAddress']);
  });

  it('accepts exactly 300 characters', async () => {
    // The boundary in the other direction. Without this, a `.max(299)` typo
    // would pass the refusal test above.
    const response = await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: 'a'.repeat(300), pickupInstructions: null })),
    );
    expect(response.status).toBe(200);
    expect((await stored()).pickupAddress).toHaveLength(300);
  });

  it('measures the cap after trimming, so one stray space does not push it over', async () => {
    /**
     * This is the only test that distinguishes the schema's `.trim()` from
     * `parsePickupInput`'s `clean()`.
     *
     * A 300-character address with a leading space is 301 characters on the
     * wire. Because `pickupSchema.pickupAddress` is `.trim()`-ed *before*
     * `.max(300)`, Zod measures 300 and accepts it; `clean()` then trims again
     * and stores 300. Removing the `.trim()` from the schema makes the value 301
     * at the `.max()` and this request becomes a 422.
     *
     * Without this test, `.trim()` in the schema is unobservable: `clean()` trims
     * again downstream, so every other fixture in this file — including the
     * plain "trims whitespace" one — passes with or without it. Two independent
     * trims where only the second is tested is a mutation that survives.
     */
    const padded = ` ${'a'.repeat(300)}`;
    const response = await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: padded, pickupInstructions: null })),
    );
    expect(response.status).toBe(200);
    expect((await stored()).pickupAddress).toHaveLength(300);
  });

  it('refuses a non-string, naming the right field', async () => {
    // The `fieldErrors.pickupAddress` key above could be produced by a schema
    // with one field; here both are wrong and both must be named.
    const response = await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: 42, pickupInstructions: { a: 1 } })),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(Object.keys(body.fieldErrors).sort()).toEqual([
      'pickupAddress',
      'pickupInstructions',
    ]);
  });

  it('refuses a body that is not JSON at all', async () => {
    const response = await PATCH(patchRequest('not json'));
    expect(response.status).toBe(422);
    // `request.json()` rejects and the route substitutes `null`; `null` fails
    // the object schema, so the answer is the same 422 a `{}` would get.
  });

  it('writes nothing when it refuses', async () => {
    // A 422 that still wrote would be worse than a 200, because the client
    // shows the error and the merchant retries a state they are already in.
    await PATCH(patchRequest(JSON.stringify({ pickupAddress: 'a'.repeat(301) })));
    expect(await stored()).toEqual({
      pickupAddress: ADDRESS,
      pickupInstructions: INSTRUCTIONS,
    });
  });
});

describe('PATCH — the absent-field defect, pinned', () => {
  /**
   * Four tests, one behaviour.
   *
   * Each one sends a body that omits a field entirely, and asserts that the field
   * it omitted was **erased**. They are written this way — asserting the damage
   * rather than the fix — because the damage is what the code does, and a test
   * that asserted the desirable behaviour would be a failing test committed to
   * the suite, which is not how a defect is recorded here. The names say
   * "erases", so whoever fixes it finds these four first.
   */
  it('erases pickupInstructions when the body omits it', async () => {
    const response = await PATCH(patchRequest(JSON.stringify({ pickupAddress: '1 New Rd' })));
    expect(response.status).toBe(200);

    // The route echoed back a `null` it invented from an absent key.
    expect((await response.json()) as PickupBody).toEqual({
      pickupAddress: '1 New Rd',
      pickupInstructions: null,
    });
    // And it is really gone from the database.
    expect(await stored()).toEqual({ pickupAddress: '1 New Rd', pickupInstructions: null });
  });

  it('erases pickupAddress when the body omits it', async () => {
    await PATCH(patchRequest(JSON.stringify({ pickupInstructions: 'Door 3.' })));
    expect(await stored()).toEqual({ pickupAddress: null, pickupInstructions: 'Door 3.' });
  });

  it('erases both when the body is an empty object', async () => {
    // `{}` is the sharpest form of the defect: a body carrying no information
    // at all is a successful request that deletes the merchant's address and
    // directions, and answers 200 describing the deletion as the new state.
    const response = await PATCH(patchRequest('{}'));
    expect(response.status).toBe(200);
    expect(await stored()).toEqual({ pickupAddress: null, pickupInstructions: null });
  });

  it('is NOT reached by the client that exists today, which is why it survived', async () => {
    /**
     * `PickupForm` posts both keys on every save, seeded from the server's `GET`
     * in `useState`. So through the shipped UI, "omitted" cannot happen.
     *
     * This test exists to record *why* the defect is unreachable rather than to
     * assert a property of the route — it is the difference between "no bug" and
     * "a bug with no caller", and only the second one is true here. A second
     * client that PATCHed a single field, or a `.nullish()` removed from one
     * field, would make it reachable.
     */
    const full = {
      pickupAddress: '1 New Rd',
      pickupInstructions: 'Door 3.',
    };
    const response = await PATCH(patchRequest(JSON.stringify(full)));
    expect(response.status).toBe(200);
    expect((await response.json()) as PickupBody).toEqual(full);
    expect(await stored()).toEqual(full);
  });
});

describe('PATCH — authorisation', () => {
  it('refuses an anonymous caller with 401', async () => {
    currentSession = null;
    const response = await PATCH(patchRequest(JSON.stringify({ pickupAddress: 'x' })));
    expect(response.status).toBe(401);
    // And nothing was written on the way to the refusal.
    expect((await stored()).pickupAddress).toBe(ADDRESS);
  });

  it('refuses a non-merchant role with 403', async () => {
    currentSession = { ...sessionFor(ownerUserId), role: 'ADMIN' };
    const response = await PATCH(patchRequest(JSON.stringify({ pickupAddress: 'x' })));
    expect(response.status).toBe(403);
  });

  it('refuses an impersonating admin with 403 and the sentence naming the reason', async () => {
    /**
     * FR-904. `impersonation-readonly.test.ts` proves this route *calls*
     * `requireMerchantWrite()`; this proves the call does something. It is the
     * same pairing the settings route already makes, for the same reason: a gate
     * that is present and inert is invisible to a source scan, because
     * `requireMerchantWrite()` is one identifier with one spelling.
     */
    currentSession = newImpersonationSession({
      merchantUserId: ownerUserId,
      actorUserId: '00000000-0000-4000-8000-000000000001',
      auditId: '00000000-0000-4000-8000-000000000002',
    }) as MockSessionInput;

    const response = await PATCH(patchRequest(JSON.stringify({ pickupAddress: '1 New Rd' })));
    expect(response.status).toBe(403);

    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('viewing this account as an admin');
    // The write did not happen, which is the only part that matters.
    expect((await stored()).pickupAddress).toBe(ADDRESS);
  });

  it('still lets an impersonating admin READ, because reading is what it is for', async () => {
    currentSession = newImpersonationSession({
      merchantUserId: ownerUserId,
      actorUserId: '00000000-0000-4000-8000-000000000001',
      auditId: '00000000-0000-4000-8000-000000000002',
    }) as MockSessionInput;

    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()) as PickupBody).toEqual({
      pickupAddress: ADDRESS,
      pickupInstructions: INSTRUCTIONS,
    });
  });

  it('answers 404 for a merchant account with no merchant row', async () => {
    // `primaryMerchantId([])` throws `AppError.notFound`, so the empty scope
    // becomes a 404 rather than an empty-object 200 that the form would render
    // as "you have no address".
    const loner = await prisma.user.create({
      data: {
        email: `${PREFIX}-loner@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    userIds.push(loner.id);

    currentSession = sessionFor(loner.id);
    const read = await GET();
    expect(read.status).toBe(404);

    const write = await PATCH(patchRequest(JSON.stringify({ pickupAddress: 'x' })));
    expect(write.status).toBe(404);
    // Neither tenant's row was touched.
    expect((await stored()).pickupAddress).toBe(ADDRESS);
    expect((await stored(otherMerchantId)).pickupAddress).toBe('999 Other St');
  });

  it('writes to the caller\'s merchant, never to the other tenant', async () => {
    await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: '1 New Rd', pickupInstructions: null })),
    );
    // This is the assertion that makes the scope check load-bearing: the route
    // has no id parameter, so the only thing separating the two rows is the
    // session.
    expect((await stored(otherMerchantId)).pickupAddress).toBe('999 Other St');
  });
});

describe('the two branches no fixture can reach, and why they are still right', () => {
  /**
   * Both of these are **unreachable through the route**, and both survived their
   * mutation probe. That is not a coverage gap to be papered over — it is a
   * consequence of the gate ordering, and the honest thing is to say so and to
   * pin the *reachability* rather than to invent a fixture that cannot exist.
   *
   * ### `if (!merchant)` (GET) and `if (!written)` (PATCH)
   *
   * `primaryMerchantId(merchantIds)` throws `AppError.notFound` whenever
   * `merchantIds` is empty, and `updateOwnPickup` returns `false` for an id that
   * is not in `merchantIds`. Both are called *after* `requireMerchant`, which
   * derives `merchantIds` from the caller's own `MerchantUser` rows. So by the
   * time either branch is evaluated, the merchant is in scope **by
   * construction**, and the only remaining way to reach them is a concurrent
   * delete of the `Merchant` row between the scope query and the read.
   *
   * Mutating `status: 404` to `status: 410` therefore changes nothing observable,
   * and neither does deleting the `!written` check — which is precisely why a
   * surviving probe here must be classified as *unreachable*, not as *untested*.
   *
   * The test below pins the property the branches depend on, which *is* testable:
   * a merchant account with no rows fails the gate, so the guard's own condition
   * never gets a chance to be what refuses.
   */

  it('refuses at primaryMerchantId, before getMerchant is ever called', async () => {
    const loner = await prisma.user.create({
      data: {
        email: `${PREFIX}-loner2@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'MERCHANT',
        mustChangePassword: false,
      },
      select: { id: true },
    });
    userIds.push(loner.id);
    currentSession = sessionFor(loner.id);

    const response = await GET();
    expect(response.status).toBe(404);

    // The message is `primaryMerchantId`'s, not the route's. That is the proof
    // the throw happened upstream of `if (!merchant)` — and it is asserted
    // against the constant the source actually contains, so if the two ever
    // diverge this fails and the "unreachable" claim above stops being true.
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe('No merchant is attached to this account.');
  });

  it('cannot be driven to `!written`, because scope comes from the session', async () => {
    // `merchantIds` is derived from `MerchantUser` rows, so the id written to is
    // always a member of that list. There is no request shape that makes
    // `updateOwnPickup` return `false` here: the route takes no id from the
    // body, and a body-supplied `merchantId` is not read at all.
    const adversarial = {
      pickupAddress: '1 New Rd',
      pickupInstructions: null,
      // Ignored: there is no field in `pickupSchema` for these, and Zod strips
      // unknown keys by default.
      merchantIds: [otherMerchantId],
      merchantId: otherMerchantId,
    };
    const response = await PATCH(patchRequest(JSON.stringify(adversarial)));
    expect(response.status).toBe(200);

    // The write landed on the caller's own merchant and not on the one named in
    // the body — the assertion that shows the scope is the session's.
    expect((await stored()).pickupAddress).toBe('1 New Rd');
    expect((await stored(otherMerchantId)).pickupAddress).toBe('999 Other St');
  });
});

describe('the second trim in the schema is genuinely redundant', () => {
  /**
   * `pickupSchema` trims and so does `parsePickupInput`'s `clean()`. Removing
   * the schema's `.trim()` **except** at the `.max()` boundary changes nothing
   * observable, so a probe that removes the trailing `.trim()` chain on
   * `pickupInstructions` survives — and should.
   *
   * The one place the first trim *is* observable is the length check on
   * `pickupAddress`, and the test above ("measures the cap after trimming")
   * already pins it. This test states the redundancy for the other field so a
   * future reader does not read the survival as an untested path.
   */
  it('normalises whitespace on pickupInstructions through clean() alone', async () => {
    // If only `clean()` were doing the work, this exact value would still be
    // stored trimmed — which it is.
    await PATCH(
      patchRequest(JSON.stringify({ pickupAddress: ADDRESS, pickupInstructions: '   Door 3.   ' })),
    );
    expect((await stored()).pickupInstructions).toBe('Door 3.');
  });
});
