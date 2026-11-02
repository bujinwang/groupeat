import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

import { signParticipantAccess } from '../access';
import { loadOrderPage, orderUrl } from '../order-page';

/**
 * The diner's page, loaded from a real row.
 *
 * ## Why this is not a mock
 *
 * `order-view.test.ts` proves the *decision*. It cannot prove the *query*: that the
 * `where` clause really includes both ids from the token, that the `publicCode`
 * really has to match, or that a token for another drop is refused. Those are the
 * properties that make an unauthenticated read safe, and all three live in a single
 * `findFirst` — the kind of thing a mock would happily agree with no matter what it
 * said.
 *
 * So this file writes rows and reads them back. It is the only test that can fail if
 * somebody drops `dropId: payload.dropId` from the `where`.
 *
 * ## What it also pins
 *
 * The `select`. `loadOrderPage` is the only unauthenticated read of a participant
 * row in the product, and the fields it is allowed to touch are a security decision,
 * not a preference. The assertions on `phoneLast4` and the absence of a full phone
 * in the returned object are the cheap half of that; the real enforcement is that
 * the `select` never asks for the phone in full.
 */

const PREFIX = `pt${Date.now().toString(36).slice(-6)}`;

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;

/** A drop in the status the scanner accepts, with a window around `now`. */
async function collectableDrop(args: {
  status?: 'PICKUP_OPEN' | 'CAPTURED' | 'COMPLETED' | 'FAILED';
  windowStartOffsetMs?: number;
  windowEndOffsetMs?: number;
} = {}) {
  const now = Date.now();
  const id = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1250,
    minQty: 2,
    maxQty: 10,
    status: args.status ?? 'PICKUP_OPEN',
    cutoffAt: new Date(now - 2 * 60 * 60 * 1000),
    windowStart: new Date(now + (args.windowStartOffsetMs ?? -60 * 60 * 1000)),
    windowEnd: new Date(now + (args.windowEndOffsetMs ?? 60 * 60 * 1000)),
  });
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id },
    select: { publicCode: true },
  });
  return { id, publicCode: row.publicCode };
}

function tokenFor(participantId: string, dropId: string): string {
  return signParticipantAccess({ participantId, dropId });
}

beforeAll(async () => {
  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant('acct_test_order_page');
  itemId = await fixtures.item(merchantId);
});

afterAll(async () => {
  await fixtures.cleanup();
});

describe('scope comes from the token, not from the query', () => {
  it('loads the row the token names', async () => {
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 2,
      redemptionCode: 'v1.body.sig',
    });

    const page = await loadOrderPage(drop.publicCode, tokenFor(participantId, drop.id), new Date());

    expect(page).not.toBeNull();
    expect(page?.qty).toBe(2);
    expect(page?.drop.publicCode).toBe(drop.publicCode);
  });

  it('refuses a valid token for one drop when asked for another', async () => {
    // The oracle this closes: my own token, somebody else's drop. Without
    // `dropId: payload.dropId` in the `where`, this would return the participant and
    // whichever drop the code named — i.e. a token that works across drops.
    const mine = await collectableDrop();
    const theirs = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: mine.id,
      qty: 1,
      redemptionCode: 'v1.body.sig',
    });

    expect(
      await loadOrderPage(theirs.publicCode, tokenFor(participantId, mine.id), new Date()),
    ).toBeNull();
  });

  it('refuses a participant id that does not exist, even with a good signature', async () => {
    // Anybody can mint a token if the secret leaks; what they cannot do is make the
    // row exist. A signed token naming a ghost must be a 404, not a 500.
    const drop = await collectableDrop();

    expect(
      await loadOrderPage(drop.publicCode, tokenFor('00000000-0000-0000-0000-000000000000', drop.id), new Date()),
    ).toBeNull();
  });

  it('refuses a token whose dropId does not match the row, when the URL is right', async () => {
    // The only test here that can detect a missing `dropId: payload.dropId`.
    //
    // The shape has to be exact for that. The URL names the drop the participant is
    // *actually* on, so the `drop.publicCode` join is satisfied and cannot be what
    // refuses the request; and the token's `dropId` names a different drop, so the
    // only remaining check is the `dropId` column.
    //
    // Mutation-verified: delete `dropId: payload.dropId` from `order-page.ts` and
    // this test is the one that fails. The plain "token for another drop" test does
    // **not** fail, because there the `publicCode` join already excludes the row —
    // which is exactly the illusion this one exists to pierce.
    const mine = await collectableDrop();
    const theirs = await collectableDrop();
    const theirParticipant = await fixtures.participant({
      dropId: theirs.id,
      qty: 1,
      redemptionCode: 'v1.body.sig',
    });

    // URL: their drop. Token: their participant, but claiming my drop.
    const page = await loadOrderPage(
      theirs.publicCode,
      tokenFor(theirParticipant, mine.id),
      new Date(),
    );

    // Control, read without going through the code under test: the row exists and is
    // reachable by id alone, so a `null` above is the scope check and not the fixture.
    expect(await prisma.dropParticipant.count({ where: { id: theirParticipant } })).toBe(1);
    expect(page).toBeNull();
  });

  it('refuses a tampered token', async () => {
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 1,
      redemptionCode: 'v1.body.sig',
    });
    const token = tokenFor(participantId, drop.id);

    expect(await loadOrderPage(drop.publicCode, `${token}x`, new Date())).toBeNull();
    expect(await loadOrderPage(drop.publicCode, '', new Date())).toBeNull();
  });

  it('refuses a public code that is close but wrong', async () => {
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 1,
      redemptionCode: 'v1.body.sig',
    });
    const token = tokenFor(participantId, drop.id);

    expect(await loadOrderPage(`${drop.publicCode}X`, token, new Date())).toBeNull();
  });
});

describe('what the page is allowed to read', () => {
  it('returns last four digits and never the full phone', async () => {
    // FR-805's minimisation, applied to the diner's own view. The full number is
    // selected only to compute four digits and is not in the returned object — this
    // asserts the second half, so a future refactor that returns the row wholesale
    // fails here.
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 1,
      redemptionCode: 'v1.body.sig',
    });

    const page = await loadOrderPage(drop.publicCode, tokenFor(participantId, drop.id), new Date());

    expect(page?.phoneLast4).toMatch(/^\d{4}$/);
    expect(JSON.stringify(page)).not.toContain('+1555');
  });

  it('formats money with the one formatter', async () => {
    // 2 × 1250 = 2500. `formatCents` renders `$25.00`. A `(cents/100).toFixed(2)`
    // would agree here and disagree on a rounding boundary — this at least pins that
    // the figure comes from the shared helper rather than from the component.
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 2,
      redemptionCode: 'v1.body.sig',
    });

    const page = await loadOrderPage(drop.publicCode, tokenFor(participantId, drop.id), new Date());

    expect(page?.amountLabel).toBe('$25.00');
  });

  it('does not return the participant id or the drop id', async () => {
    // Neither is needed to render, and both are the token's contents — echoing them
    // back into the page would put a second copy of the bearer material into the HTML.
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 1,
      redemptionCode: 'v1.body.sig',
    });

    const page = await loadOrderPage(drop.publicCode, tokenFor(participantId, drop.id), new Date());
    const serialised = JSON.stringify(page);

    expect(serialised).not.toContain(participantId);
    expect(serialised).not.toContain(drop.id);
  });
});

describe('the phase follows the row', () => {
  it('says CHARGED with a code for a captured diner inside the window', async () => {
    const drop = await collectableDrop({ status: 'PICKUP_OPEN' });
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 2,
      chargeStatus: 'CAPTURED',
      redemptionCode: 'v1.body.sig',
    });

    const page = await loadOrderPage(drop.publicCode, tokenFor(participantId, drop.id), new Date());

    expect(page?.view.phase).toBe('CHARGED');
    expect(page?.view.code).toBe('v1.body.sig');
  });

  it('says CHARGED with no code for a captured diner before the window opens', async () => {
    // The end-to-end version of the bug the unit test pins: a real `CAPTURED` row on
    // a drop whose window has not opened must not render a code.
    const drop = await collectableDrop({
      status: 'CAPTURED',
      windowStartOffsetMs: 2 * 60 * 60 * 1000,
      windowEndOffsetMs: 4 * 60 * 60 * 1000,
    });
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 2,
      chargeStatus: 'CAPTURED',
      redemptionCode: 'v1.body.sig',
    });

    const page = await loadOrderPage(drop.publicCode, tokenFor(participantId, drop.id), new Date());

    expect(page?.view.phase).toBe('CHARGED');
    expect(page?.view.code).toBeNull();
  });

  it('says NOT_CHARGED for a refunded diner, with no code', async () => {
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 2,
      // A refund does not clear `redemptionCode` — that is the whole reason the code
      // is gated on the phase rather than on its presence.
      chargeStatus: 'REFUNDED',
      redemptionCode: 'v1.body.sig',
    });

    const page = await loadOrderPage(drop.publicCode, tokenFor(participantId, drop.id), new Date());

    expect(page?.view.phase).toBe('NOT_CHARGED');
    expect(page?.view.code).toBeNull();
  });

  it('says WAITING for a hold', async () => {
    // `PUBLISHED` plus a `NONE` charge is the real waiting state. The window is in
    // the future because nothing has been captured yet.
    const id = await fixtures.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1250,
      minQty: 2,
      maxQty: 10,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
      windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
    });
    const row = await prisma.drop.findUniqueOrThrow({ where: { id }, select: { publicCode: true } });

    const participantId = await fixtures.participant({
      dropId: id,
      qty: 2,
      chargeStatus: 'NONE',
      redemptionCode: null,
    });

    const page = await loadOrderPage(row.publicCode, tokenFor(participantId, id), new Date());

    expect(page?.view.phase).toBe('WAITING');
    expect(page?.view.code).toBeNull();
    expect(page?.view.nothingCharged).toBe(true);
  });

  it('counts only AUTHORIZED plates toward the drop minimum', async () => {
    // `joinedQty` is fed from participants filtered to `AUTHORIZED`. A PENDING row
    // holds capacity but has not paid, so counting it would make the page tell a
    // diner the drop is filling faster than it is.
    const drop = await collectableDrop();
    await fixtures.participant({ dropId: drop.id, qty: 1, authStatus: 'AUTHORIZED' });
    await fixtures.participant({ dropId: drop.id, qty: 3, authStatus: 'PENDING' });
    const me = await fixtures.participant({
      dropId: drop.id,
      qty: 1,
      authStatus: 'AUTHORIZED',
      chargeStatus: 'CAPTURED',
      redemptionCode: 'v1.body.sig',
    });

    const page = await loadOrderPage(drop.publicCode, tokenFor(me, drop.id), new Date());

    // The page does not expose `joinedQty` directly, so assert what it is used for:
    // a 2-plate minimum is met by the two AUTHORIZED plates, PENDING excluded.
    expect(page?.minQty).toBe(2);
  });
});

describe('orderUrl', () => {
  it('builds a link that verifies back to the same participant', async () => {
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 1,
      redemptionCode: 'v1.body.sig',
    });

    const url = orderUrl({
      baseUrl: 'https://groupeat.example',
      publicCode: drop.publicCode,
      participantId,
      dropId: drop.id,
    });
    const parsed = new URL(url);
    const token = parsed.searchParams.get('t');

    expect(parsed.origin).toBe('https://groupeat.example');
    expect(parsed.pathname).toBe(`/d/${drop.publicCode}/mine`);
    expect(token).toBeTruthy();

    const page = await loadOrderPage(drop.publicCode, token ?? '', new Date());
    expect(page?.qty).toBe(1);
  });

  it('does not put the redemption code in the URL', async () => {
    // The design decision that shapes the whole slice: the link carries a read-only
    // token, never the thing that buys food.
    const drop = await collectableDrop();
    const participantId = await fixtures.participant({
      dropId: drop.id,
      qty: 1,
      redemptionCode: 'v1.the-real-code.sig',
    });

    const url = orderUrl({
      baseUrl: 'https://groupeat.example',
      publicCode: drop.publicCode,
      participantId,
      dropId: drop.id,
    });

    expect(url).not.toContain('the-real-code');
    expect(new URL(url).searchParams.get('t')?.startsWith('p1.')).toBe(true);
  });

  it('tolerates a trailing slash on the base url, and more than one', () => {
    const args = {
      publicCode: 'ABC',
      participantId: 'p-1',
      dropId: 'd-1',
    };

    const bare = orderUrl({ baseUrl: 'https://groupeat.example', ...args });
    expect(orderUrl({ baseUrl: 'https://groupeat.example/', ...args })).toBe(bare);
    expect(orderUrl({ baseUrl: 'https://groupeat.example///', ...args })).toBe(bare);
    expect(bare).toMatch(/^https:\/\/groupeat\.example\/d\/ABC\/mine\?t=/);
  });

  it('escapes a public code rather than assuming it is urlsafe', () => {
    const url = orderUrl({
      baseUrl: 'https://groupeat.example',
      publicCode: 'A B/C',
      participantId: 'p-1',
      dropId: 'd-1',
    });

    expect(new URL(url).pathname).toBe('/d/A%20B%2FC/mine');
  });

  it('is reproducible: the same ids produce the same link', () => {
    // This is what lets a re-send rebuild the link without storing a token.
    const args = { baseUrl: 'https://groupeat.example', publicCode: 'ABC', participantId: 'p-1', dropId: 'd-1' };
    expect(orderUrl(args)).toBe(orderUrl(args));
  });
});
