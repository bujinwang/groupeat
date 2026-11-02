import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';
import { getPublicDrop } from '@/lib/public/public-drops';
import { headlineFor, resolveDropView } from '@/lib/public/drop-view';

import { decideFor } from '../cutoff-decision';
import { fakeChargePort } from '../fake-charge-port';
import { settle } from '../settle';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

/**
 * The sentence a diner reads, after the money actually moved.
 *
 * `drop-view.test.ts` proves the pure function branches. This proves the wire
 * between the `Order` table and that function, which is the part §7 actually
 * changed: `public-drops.ts` supplies `hadCaptures` from `orders: { take: 1 }`.
 *
 * Three drops, three sentences, all of them true:
 *
 *   - below the threshold            → no `Order` row → "nobody was charged";
 *   - below the capture tolerance    → captures refunded → "refunded in full";
 *   - captured                       → confirmed, and no refund sentence.
 *
 * The middle one is the case that used to lie. It is also the case §4.5's ordering
 * rule protects: `FAILED` is written only after every refund returned, so the
 * sentence is true the moment it becomes readable.
 */

const PREFIX = `qa-page${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

const DEAL_PRICE = 1112;
const FEE_PER_UNIT = roundHalfUp(platformFeeAt(DEAL_PRICE, DEFAULT_FEES));

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

/** The public page's own view of a drop, resolved at `now`. */
async function viewOf(dropId: string) {
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: { publicCode: true, minQty: true },
  });
  const drop = await getPublicDrop(row.publicCode);
  if (!drop) {
    throw new Error(`drop ${dropId} is not publicly visible`);
  }
  const view = resolveDropView({
    status: drop.status,
    minQty: drop.minQty,
    maxQty: drop.maxQty,
    cutoffAt: drop.cutoffAt,
    windowStart: drop.windowStart,
    windowEnd: drop.windowEnd,
    joinedQty: drop.joinedQty,
    now: new Date(),
    hadCaptures: drop.hadCaptures,
  });
  return { drop, view, headline: headlineFor(view, drop.minQty) };
}

describe('what the page says once settlement has run', () => {
  it('says nobody was charged when the threshold was missed', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 20,
      cutoffAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 7, platformFeeCents: 7 * FEE_PER_UNIT });

    const decision = await decideFor({ dropId, now: new Date() });
    expect(decision.kind).toBe('FAILED');

    const { drop, headline } = await viewOf(dropId);
    expect(drop.status).toBe('FAILED');
    expect(drop.hadCaptures).toBe(false);
    expect(headline).toContain('nobody was charged');
    expect(headline).not.toContain('refunded');
  });

  it('says everyone who paid was refunded when the capture tolerance was missed', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 3, platformFeeCents: 3 * FEE_PER_UNIT });
    await fx.participant({ dropId, qty: 2, platformFeeCents: 2 * FEE_PER_UNIT });
    const declinedId = await fx.participant({
      dropId,
      qty: 2,
      platformFeeCents: 2 * FEE_PER_UNIT,
    });

    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort({ declineParticipantIds: [declinedId] }),
    });
    expect(outcome.kind).toBe('FAILED');

    // The refunds are in the database before the status is readable — that is the
    // ordering rule §4.5 imposes so this sentence can be true.
    expect(await prisma.order.count({ where: { dropId } })).toBe(2);
    expect(
      await prisma.dropParticipant.count({ where: { dropId, chargeStatus: 'REFUNDED' } }),
    ).toBe(2);

    const { drop, headline } = await viewOf(dropId);
    expect(drop.status).toBe('FAILED');
    expect(drop.hadCaptures).toBe(true);
    expect(headline).toContain('refunded in full');
    expect(headline).not.toContain('nobody was charged');
  });

  it('says confirmed, with no refund sentence, when the drop captured', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });

    expect((await settle({ dropId, now: new Date(), port: fakeChargePort() })).kind).toBe('CAPTURED');

    const { drop, view, headline } = await viewOf(dropId);
    expect(drop.status).toBe('CAPTURED');
    expect(drop.hadCaptures).toBe(true);
    expect(view.offerPhase).toBe('CONFIRMED');
    // §2.4: `settling` is not extended to cover LOCKED/CAPTURED, and the confirmed
    // sentence must not claim money is still moving once it has.
    expect(view.settling).toBe(false);
    expect(headline).not.toContain('charging cards now');
    expect(headline).not.toContain('refunded');
    expect(headline).toContain('Confirmed');
  });

  it('leaves the authorisation row alone on the captured path, so the page count does not collapse', async () => {
    // `public-drops.ts` counts units where `authStatus = 'AUTHORIZED'` (FR-501).
    // A capture consumes the authorisation at the provider but the row keeps its
    // status — `voidRemainingAuthorisations` excludes `chargeStatus = 'CAPTURED'`
    // for exactly this reason. If someone "tidied up" authStatus on capture, every
    // confirmed drop's page would drop to "0 orders in" while the food was being
    // cooked. Pinned here so that change is visible.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 5, platformFeeCents: 5 * FEE_PER_UNIT });

    const before = await viewOf(dropId);
    expect(before.drop.joinedQty).toBe(5);

    await settle({ dropId, now: new Date(), port: fakeChargePort() });

    const after = await viewOf(dropId);
    expect(after.drop.hadCaptures).toBe(true);
    expect(
      await prisma.dropParticipant.count({ where: { dropId, authStatus: 'AUTHORIZED' } }),
    ).toBe(1);
    expect(after.drop.joinedQty).toBe(5);
    // And the capture itself was not undone by the sweep that follows it.
    expect(
      await prisma.dropParticipant.count({ where: { dropId, chargeStatus: 'CAPTURED' } }),
    ).toBe(1);
  });
});
