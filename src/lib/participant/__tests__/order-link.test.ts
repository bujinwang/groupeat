import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeJoinPaymentPort } from '@/lib/join/fake-payment-port';
import { joinDrop } from '@/lib/join/service';
import { verifyParticipantAccess } from '@/lib/participant/access';
import { orderPath, orderUrl } from '@/lib/participant/order-link';
import { loadOrderPage } from '@/lib/participant/order-page';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * The link a diner is handed the moment they join — and the fact that it works.
 *
 * ## The gap this closes, stated as a user story
 *
 * A diner joins a drop on their phone, in a group chat, and closes the tab. Later
 * they want to know: did my card get charged, when is pickup, what is my code?
 *
 * Before this slice the answer was: there is no way to find out. The redemption code
 * is minted at capture and rendered on `/d/:code/mine`, which requires a bearer token
 * in the query string. That token was composed in exactly one place — inside the
 * settlement job, for a `DROP_CONFIRMED_CHARGED` text message that no sender
 * delivers. So the link existed, verified correctly, and reached nobody. The
 * confirmation screen returned `participantId`, and no component ever read it.
 *
 * ## Why these tests are structural as well as behavioural
 *
 * The interesting failure is not "the token is wrong" — that is covered. It is "the
 * link was never rendered", which no unit test of `orderPath` can see. So the last
 * block reads the component's source and asserts it renders the field, because that
 * is the half of the bug that was invisible.
 */

const PREFIX = `jol${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;
let phoneSeq = 0;

/**
 * The phone numbers this file issues, recorded as they are issued.
 *
 * Added because the teardown below deleted `ConsentRecord` rows by prefix and **never
 * touched `Customer` at all**, leaving three customers per run (`+17805571001`–`003`).
 * The leak was invisible while it lasted because the residue gate compared counts
 * around a run that started from a database already holding them: three rows created
 * every run and deleted never is a delta of zero, which the gate reported as
 * `no residue`. Measured from a wiped database, the suite leaked 27 customers across
 * four files: 16 in `threshold-notify-wiring`, 4 in `quote`, 4 in `attribution` and 3
 * here. (`funnel-wiring` and `confirmation-wiring` had the same defect and were fixed
 * earlier, which is why the count is 27 and not 46.)
 *
 * A set cannot drift from itself, so the builder writes here and the teardown reads
 * here — the same mechanism as `join/__tests__/service.test.ts`.
 */
const issuedPhones = new Set<string>();

/**
 * `+17805571` is this file's block. `+17805550` is `join/service`'s, `+17805556` is
 * `funnel-wiring`'s, `+17805557` is `quote`'s, `+17805558` is `confirmation-wiring`'s,
 * `+17805559` is `attribution`/`threshold-notify`'s and `+17805580` is the join route's.
 * Adding a file? Grep for a free block before choosing one, and record it here.
 */
function phone(): string {
  phoneSeq += 1;
  const national = `+17805571${String(phoneSeq).padStart(3, '0')}`;
  // Recorded at the moment of issue, so the teardown deletes exactly what this run
  // created and nothing a neighbour owns.
  issuedPhones.add(national);
  return national;
}

async function publishedDrop(minQty = 2, maxQty = 10): Promise<{ id: string; publicCode: string }> {
  const id = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty,
    maxQty,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
    windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });
  const row = await prisma.drop.findUniqueOrThrow({ where: { id }, select: { publicCode: true } });
  return { id, publicCode: row.publicCode };
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant('acct_test_order_link');
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  // Every step attempted, and the run still fails if any did. The previous version
  // ended `.catch(() => undefined)` on the only statement that could fail, which is how
  // a teardown that never deleted `Customer` kept passing review.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // `ConsentRecord` has no foreign key to anything, so nothing cascades to it.
  await step(() =>
    prisma.consentRecord.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  // The fixtures next: this removes the drops and cascades to the participants, and
  // `DropParticipant.customer` has no `onDelete` so it defaults to Restrict.
  await step(() => fx.cleanup());

  // Then the customers, which `fx.cleanup()` does NOT reach: it only deletes customers
  // whose ids it minted itself through `fx.participant()`. Every diner here is created
  // by `joinDrop` under test via `tx.customer.upsert`, which the fixtures never see.
  await step(() =>
    prisma.customer.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `teardown left the database dirty (${failures.length} step(s) failed)`,
    );
  }
});

describe('orderPath', () => {
  it('is a path, so it cannot be wrong about the origin', () => {
    // The browser is already on the deployment's host. A relative path cannot say
    // `localhost` and cannot disagree with `APP_URL`, which is why the confirmation
    // uses this and the SMS uses `orderUrl`.
    const path = orderPath({ publicCode: 'ABC123', participantId: 'p1', dropId: 'd1' });
    expect(path.startsWith('/d/ABC123/mine?t=')).toBe(true);
    expect(path).not.toContain('http');
  });

  it('carries a token that verifies to the participant it names', () => {
    const path = orderPath({ publicCode: 'ABC123', participantId: 'p1', dropId: 'd1' });
    const token = new URL(path, 'https://example.test').searchParams.get('t') ?? '';
    expect(verifyParticipantAccess(token)).toEqual({ participantId: 'p1', dropId: 'd1' });
  });

  it('percent-encodes the code and the token', () => {
    // Neither can contain a dangerous character today — the code is [A-Z0-9] and the
    // token is base64url — but encoding is the difference between "cannot happen" and
    // "cannot break the URL if it does".
    const path = orderPath({ publicCode: 'A B/C', participantId: 'p1', dropId: 'd1' });
    expect(path).toContain('/d/A%20B%2FC/mine');
    // The raw space must not survive into the URL.
    expect(path.split('?')[0]).not.toContain(' ');
  });

  it('never contains the redemption code — they are different keys', () => {
    // Not a formatting assertion: if a future change signed the *redemption* code
    // into this URL, whoever holds the link holds the food.
    const path = orderPath({ publicCode: 'ABC123', participantId: 'p1', dropId: 'd1' });
    const token = new URL(path, 'https://example.test').searchParams.get('t') ?? '';
    // `p1.` is the participant-access version tag; `v1.` is the redemption code's.
    expect(token.startsWith('p1.')).toBe(true);
    expect(token.startsWith('v1.')).toBe(false);
  });
});

describe('orderUrl', () => {
  it('is the path with an origin in front, and they cannot disagree', () => {
    const args = { publicCode: 'ABC123', participantId: 'p1', dropId: 'd1' };
    const url = orderUrl({ baseUrl: 'https://groupeat.example', ...args });
    // Same path portion, byte for byte — the property that stops the SMS link and the
    // on-screen link drifting apart after one of them is edited.
    expect(url).toBe(`https://groupeat.example${orderPath(args)}`);
  });

  it('trims a trailing slash rather than producing /d//d/', () => {
    // `APP_URL` is operator-supplied and `https://x.example/` is what half of them
    // will write. A double slash is a 404 from a link that looks correct.
    expect(orderUrl({ baseUrl: 'https://x.example/', publicCode: 'C', participantId: 'p', dropId: 'd' })).toContain(
      'https://x.example/d/C/mine',
    );
    expect(orderUrl({ baseUrl: 'https://x.example///', publicCode: 'C', participantId: 'p', dropId: 'd' })).toContain(
      'https://x.example/d/C/mine',
    );
  });
});

describe('a real join hands back a link that opens the diner\'s page', () => {
  it('succeeds and returns a path that loads that participant\'s order', async () => {
    // The whole story in one test: join, get a link, follow it, see your order. The
    // last step is what the diner actually needs and what nothing previously provided.
    const drop = await publishedDrop(2, 10);

    const result = await joinDrop(
      { publicCode: drop.publicCode, qty: 2, phone: phone() },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.orderPath).toBeTruthy();

    // Follow it exactly as the browser would: parse the query off the path.
    const token = new URL(result.orderPath, 'https://example.test').searchParams.get('t') ?? '';
    const page = await loadOrderPage(drop.publicCode, token, new Date());

    expect(page).not.toBeNull();
    expect(page?.qty).toBe(2);
    expect(page?.minQty).toBe(2);
    // The money the page shows is the money the join showed. Both come from
    // `formatCents`, and this is the assertion that would catch a second formatter.
    expect(page?.amountLabel).toBe(result.amountLabel);
  });

  it('returns the same path for an already-joined diner', async () => {
    // A diner who refreshes, or double-taps, has the same need to get back as one who
    // just joined. If only the fresh-join branch built the path, a refresh would
    // silently strip the link and strand them.
    const drop = await publishedDrop(2, 10);
    const port = fakeJoinPaymentPort();
    const one = phone();

    const first = await joinDrop({ publicCode: drop.publicCode, qty: 1, phone: one }, { paymentPort: port });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = await joinDrop({ publicCode: drop.publicCode, qty: 1, phone: one }, { paymentPort: port });
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    expect(again.alreadyJoined).toBe(true);
    expect(again.orderPath).toBeTruthy();

    // Same participant, so the same token and therefore the same link. A different
    // link for the same row would mean the path embedded something time-dependent.
    expect(again.orderPath).toBe(first.orderPath);
    expect(again.orderPath).toContain(`/d/${drop.publicCode}/mine`);
  });

  it('does not leak a token that works on a different drop', async () => {
    // The link is scoped by the token's `dropId`. A path naming drop A must not open
    // a participant on drop B, even if the codes were guessed.
    const a = await publishedDrop(2, 10);
    const b = await publishedDrop(2, 10);

    const joined = await joinDrop(
      { publicCode: a.publicCode, qty: 2, phone: phone() },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    const token = new URL(joined.orderPath, 'https://example.test').searchParams.get('t') ?? '';

    // The token is valid…
    expect(verifyParticipantAccess(token)).not.toBeNull();
    // …but not for drop B's URL.
    const crossed = await loadOrderPage(b.publicCode, token, new Date());
    expect(crossed).toBeNull();
  });
});

describe('the confirmation actually renders the link', () => {
  /**
   * The half of the bug a unit test cannot see.
   *
   * `orderPath` was always correct; nothing put it on screen. This reads the
   * component's source and requires it to render `joined.orderPath` as an `href`,
   * because "the server returns a link" and "the diner is given a link" are different
   * claims and only the first was ever tested.
   *
   * The path is derived from `process.cwd()` rather than from `import.meta.url`,
   * because a chain of `../` is silently wrong the moment the file moves — and a test
   * that reads the wrong file fails with ENOENT, or worse, reads nothing and passes.
   * Vitest runs with the repo root as cwd (the same assumption `no-inline-fee-
   * rounding.test.ts` makes when it walks `src/`).
   */
  const componentPath = join(process.cwd(), 'src/components/public/JoinForm.tsx');

  /** Blanks comments while preserving line numbers, so a hit still points at code. */
  function stripComments(source: string): string {
    const blank = (block: string): string => block.replace(/[^\n]/g, ' ');
    return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('binds orderPath to an anchor in the confirmation', () => {
    const source = stripComments(readFileSync(componentPath, 'utf8'));

    // It is on the response type. That type now lives in `join/wire.ts` and is
    // imported rather than redeclared — the redeclaration is what let the component
    // and the route disagree about `cutoffLabel` and print "undefined". So the guard
    // is that the component *consumes the shared declaration*, and the declaration
    // itself is checked where it lives.
    expect(source).toMatch(/import\s+type\s*\{\s*JoinSuccessBody\s*\}\s*from\s*'@\/lib\/join\/wire'/);
    // …and it reaches an href.
    expect(source).toMatch(/href=\{joined\.orderPath\}/);
  });

  it('declares the success body once, in wire.ts, with a label the server can fill', () => {
    // The bug this pins: `cutoffLabel` was declared in the component and produced by
    // nobody, so the confirmation read "people join by undefined". A shared type
    // turns that into a compile error; this is the test that notices if the shared
    // type quietly loses a field.
    const wire = stripComments(readFileSync(join(process.cwd(), 'src/lib/join/wire.ts'), 'utf8'));

    for (const field of ['cutoffLabel', 'orderPath', 'amountLabel', 'phoneLast4']) {
      expect(wire).toMatch(new RegExp(`${field}:\\s*string`));
    }
    // The component must not redeclare the shape.
    const component = stripComments(readFileSync(componentPath, 'utf8'));
    expect(component).not.toMatch(/type JoinSuccess = \{/);
  });

  it('no longer promises a text message that nothing sends', () => {
    // The old copy told the diner updates would arrive by text. No sender exists
    // (D-5), so that sentence caused the failure it was meant to prevent: a diner
    // waits for a message instead of keeping the link.
    //
    // Comments are stripped first. The docblock deliberately *quotes* the old
    // sentence to explain why it went, and a check that fires on its own
    // documentation is a check that gets deleted within a week — the same lesson
    // `no-inline-fee-rounding.test.ts` records.
    const source = stripComments(readFileSync(componentPath, 'utf8'));

    expect(source).not.toContain('Updates go to the number ending');
    // And the honest replacement is actually there, so this is not just an absence.
    expect(source).toContain('Bookmark this page');
  });

  it('makes no delivery promise on the order page either', () => {
    // The same sentence lived in a second place. Fixing the confirmation and leaving
    // `/mine` alone would have been worse than fixing neither: a diner who arrived
    // through the link would be told the updates come by text, and wait.
    const pagePath = join(process.cwd(), 'src/app/d/[publicCode]/mine/page.tsx');
    const source = stripComments(readFileSync(pagePath, 'utf8'));

    expect(source).not.toContain('Updates go to the number ending');
    // The number still appears — as an identification fact, which is all it is.
    expect(source).toContain('This order is under the number ending');
  });
});
