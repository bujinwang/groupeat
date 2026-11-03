import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

import {
  ADMIN_DROP_STATUSES,
  listAdminDrops,
  parseAdminDropStatus,
} from '../admin-drops';

/**
 * FR-901 — the admin drops list, against real Postgres.
 *
 * ## What these tests protect
 *
 *   1. **`capturedCents` is money still out there, not money ever charged.** It is the
 *      figure the force-fail dialog shows back to an operator before they refund a
 *      drop. If it counted an already-refunded order at its original total, the dialog
 *      would promise a number the refund loop would not deliver, and the operator would
 *      have no way to know which was right.
 *   2. **The counts are global, not filtered.** A filter bar whose chips count the
 *      visible rows shows `1` next to every status — the classic bug, and it looks
 *      plausible. It is only detectable by asking for a filtered list and checking the
 *      counts still describe the whole set.
 *   3. **The filter actually filters.** Trivial to write, easy to break: `where` getting
 *      a status it ignores would make the page silently show everything.
 *   4. **A bogus `?status=` parses to `null`, not to a crash or a silent empty list.**
 *
 * ## Why the drops are built directly
 *
 * `publishDrop` needs Stripe and a frozen snapshot; this module reads what settlement
 * leaves behind. The fixture writes the states under test, including `Order` rows,
 * which is what `capturedCents` is computed from.
 */

const PREFIX = `ad${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

let merchantA = '';
let merchantB = '';
let itemA = '';
let itemB = '';

const DEAL_PRICE = 1000;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  merchantA = await fx.merchant(`acct_${PREFIX}_a`);
  merchantB = await fx.merchant(`acct_${PREFIX}_b`);
  itemA = await fx.item(merchantA);
  itemB = await fx.item(merchantB);
});

afterAll(async () => {
  await fx.cleanup();
});

/**
 * A drop with `captured` orders, each optionally partly refunded, and `holds` orders
 * that never captured.
 */
async function buildDrop(args: {
  merchantId: string;
  menuItemId: string;
  status: string;
  joinedQty?: number;
  capturedOrders?: number;
  /** Refunded cents per captured order. Default 0. */
  refundedPerOrder?: number;
  title?: string;
  cutoffAt?: Date;
}): Promise<string> {
  const joinedQty = args.joinedQty ?? 2;
  const dropId = await fx.drop({
    merchantId: args.merchantId,
    menuItemId: args.menuItemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 5,
    maxQty: 40,
    // The fixture types `status` as the full enum union; these tests pass literals from
    // the same list the module exports, so the cast is narrowing, not escaping.
    status: args.status as never,
    cutoffAt: args.cutoffAt ?? new Date(Date.now() + 2 * HOUR),
  });

  if (args.title) {
    // Titles are what the operator reads on the row, so a test that distinguishes rows
    // needs distinguishable titles. Set after creation to avoid widening the fixture.
    await prisma.drop.update({ where: { id: dropId }, data: { title: args.title } });
  }

  const participantId = await fx.participant({
    dropId,
    qty: joinedQty,
    chargeStatus: 'NONE',
    authStatus: 'AUTHORIZED',
    redemptionCode: null,
  });

  const capturedOrders = args.capturedOrders ?? 0;
  for (let index = 0; index < capturedOrders; index += 1) {
    const subtotalCents = joinedQty * DEAL_PRICE;
    const order = await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty: joinedQty,
        unitPriceCents: DEAL_PRICE,
        subtotalCents,
        platformFeeCents: 0,
        stripeChargeId: `ch_${PREFIX}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        refundedCents: args.refundedPerOrder ?? 0,
      },
      select: { id: true },
    });
    await prisma.ledgerEntry.createMany({
      data: [
        {
          orderId: order.id,
          dropId,
          type: 'CHARGE',
          amountCents: subtotalCents,
          stripeRef: `ch_${PREFIX}_${index}`,
          note: 'capture',
        },
      ],
    });
  }

  return dropId;
}

describe('parseAdminDropStatus', () => {
  it('accepts every status the enum declares', () => {
    for (const status of ADMIN_DROP_STATUSES) {
      expect(parseAdminDropStatus(status)).toBe(status);
    }
  });

  it('returns null for a missing value, meaning "no filter"', () => {
    expect(parseAdminDropStatus(undefined)).toBeNull();
    expect(parseAdminDropStatus('')).toBeNull();
  });

  /**
   * The value of this behaviour is in the page: an operator who mistypes a filter must
   * see the full list plus a sentence, because a filter that silently matches nothing is
   * indistinguishable from a filter that found nothing.
   */
  it('returns null for an unknown status rather than throwing or passing it through', () => {
    expect(parseAdminDropStatus('WHATEVER')).toBeNull();
    expect(parseAdminDropStatus('published')).toBeNull();
    expect(parseAdminDropStatus('PUBLISHED ')).toBeNull();
  });
});

describe('listAdminDrops', () => {
  it('lists drops across merchants, because an admin list is not scoped', async () => {
    const dropA = await buildDrop({
      merchantId: merchantA,
      menuItemId: itemA,
      status: 'PUBLISHED',
      title: `${PREFIX} cross-tenant A`,
    });
    const dropB = await buildDrop({
      merchantId: merchantB,
      menuItemId: itemB,
      status: 'PUBLISHED',
      title: `${PREFIX} cross-tenant B`,
    });

    const list = await listAdminDrops();
    const ids = list.rows.map((row) => row.id);

    expect(ids).toContain(dropA);
    expect(ids).toContain(dropB);

    const rowA = list.rows.find((row) => row.id === dropA);
    const rowB = list.rows.find((row) => row.id === dropB);
    // The merchant name is on the row because the operator says it out loud.
    expect(rowA?.merchantId).toBe(merchantA);
    expect(rowB?.merchantId).toBe(merchantB);
    expect(rowA?.merchantTimezone).toBeTruthy();
  });

  it('filters by status and still reports global counts', async () => {
    const published = await buildDrop({
      merchantId: merchantA,
      menuItemId: itemA,
      status: 'PUBLISHED',
      title: `${PREFIX} filter published`,
    });
    const failed = await buildDrop({
      merchantId: merchantA,
      menuItemId: itemA,
      status: 'FAILED',
      title: `${PREFIX} filter failed`,
    });

    const all = await listAdminDrops();
    const onlyFailed = await listAdminDrops({ status: 'FAILED' });

    // The filter filters.
    const failedIds = onlyFailed.rows.map((row) => row.id);
    expect(failedIds).toContain(failed);
    expect(failedIds).not.toContain(published);
    for (const row of onlyFailed.rows) {
      expect(row.status).toBe('FAILED');
    }

    // The counts do not. A chip bar that counted the visible rows would report the
    // filtered total against the filter and zero elsewhere; these must be identical
    // between the two calls.
    expect(onlyFailed.countsByStatus).toEqual(all.countsByStatus);
    expect(onlyFailed.countsByStatus.FAILED).toBeGreaterThanOrEqual(1);
    expect(onlyFailed.countsByStatus.PUBLISHED).toBeGreaterThanOrEqual(1);

    // And `totalDrops` does not filter either — this is the "All" chip's number. It is
    // a separate field precisely because the obvious implementation, `rows.length`,
    // silently becomes the filtered count and makes the chip bar read "All 1" beside
    // "FAILED 1" for a table of eight.
    expect(onlyFailed.totalDrops).toBe(all.totalDrops);
    expect(onlyFailed.totalDrops).toBeGreaterThan(onlyFailed.rows.length);
    // Derived from the same unfiltered read, so it must agree with it.
    expect(onlyFailed.totalDrops).toBe(
      Object.values(onlyFailed.countsByStatus).reduce((sum, count) => sum + count, 0),
    );
  });

  it('reports captured money net of what was already refunded', async () => {
    const refunded = 400;
    const dropId = await buildDrop({
      merchantId: merchantA,
      menuItemId: itemA,
      status: 'CAPTURED',
      joinedQty: 3,
      capturedOrders: 1,
      refundedPerOrder: refunded,
      title: `${PREFIX} partly refunded`,
    });

    const list = await listAdminDrops({ status: 'CAPTURED' });
    const row = list.rows.find((candidate) => candidate.id === dropId);
    expect(row).toBeDefined();

    const gross = 3 * DEAL_PRICE;
    // Still out there, not ever charged. This is the number the force-fail dialog shows.
    expect(row?.capturedCents).toBe(gross - refunded);
    // And the refund is reported separately rather than absorbed, so the row can say
    // both "some is still out there" and "some was already returned".
    expect(row?.refundedCents).toBe(refunded);
  });

  it('reports zero captured for a published drop with live holds', async () => {
    const dropId = await buildDrop({
      merchantId: merchantA,
      menuItemId: itemA,
      status: 'PUBLISHED',
      joinedQty: 4,
      capturedOrders: 0,
      title: `${PREFIX} holds only`,
    });

    const list = await listAdminDrops({ status: 'PUBLISHED' });
    const row = list.rows.find((candidate) => candidate.id === dropId);

    // Nothing has been charged, so nothing is at risk. `—` on the page, not `$0.00`.
    expect(row?.capturedCents).toBe(0);
    expect(row?.refundedCents).toBe(0);
    expect(row?.joinedQty).toBe(4);
    expect(row?.participantCount).toBe(1);
  });

  it('sums totalCents over the rows it returned, not over the whole table', async () => {
    const all = await listAdminDrops();
    const sum = all.rows.reduce((total, row) => total + row.capturedCents, 0);
    expect(all.totalCents).toBe(sum);

    // A filtered list reports the filtered total. If it reported the global one, the
    // header's "at risk" figure would contradict the rows beneath it.
    const onlyFailed = await listAdminDrops({ status: 'FAILED' });
    const failedSum = onlyFailed.rows.reduce((total, row) => total + row.capturedCents, 0);
    expect(onlyFailed.totalCents).toBe(failedSum);
  });

  it('honours the limit', async () => {
    const limited = await listAdminDrops({ limit: 2 });
    expect(limited.rows.length).toBeLessThanOrEqual(2);
    // Counts stay global even when the page is capped — the chips describe the table.
    const all = await listAdminDrops();
    expect(limited.countsByStatus).toEqual(all.countsByStatus);
  });

  it('returns every status key even when a status has no drops', async () => {
    const list = await listAdminDrops({ status: 'DRAFT' });
    // The page indexes `countsByStatus[entry]` for every chip. A missing key would
    // render `undefined` in the badge.
    for (const status of ADMIN_DROP_STATUSES) {
      expect(list.countsByStatus[status]).toBeGreaterThanOrEqual(0);
      expect(typeof list.countsByStatus[status]).toBe('number');
    }
  });
});
