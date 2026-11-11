/**
 * M5 — the CAS-loser branch of `repairFromExistingOrder` (settle.ts).
 *
 *   if (claimed !== 1) {
 *     return redemptionCode;   // a second overlapping tick already moved NONE->CAPTURED
 *   }
 *
 * This branch is correct: a loser still returns the code, because the participant is
 * CAPTURED either way and returning `null` would send the caller back to the provider
 * to charge again. But it is only reachable when two ticks repair the same already-
 * charged row concurrently — the row flips NONE->CAPTURED between one tick's state
 * read and its CAS. A single `settle` test never reaches it, so mutating the branch
 * to `return null` left the full suite green. This test makes the branch causally
 * exercised.
 *
 * Why call `repairFromExistingOrder` directly (not two `settle` calls): `settle` reads
 * `loadLockedDrop` first, and the drop moves LOCKED->CAPTURED outside the repair CAS,
 * so whichever of two `settle` ticks reads second sees a non-LOCKED drop and bails —
 * the race is timing-dependent and flaky. Calling the repair function directly skips
 * that unguarded step; both invocations block at their NONE->CAPTURED `updateMany`
 * under a held `FOR UPDATE` row lock, so one wins (count 1) and one loses (count 0 ->
 * this branch), deterministically.
 */
import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, platformFeeAt, roundHalfUp } from '@/lib/guardrail';
import { deriveRedemptionSecret, verifyRedemptionCode } from '../redemption-code';
import { loadLockedDrop } from '../cutoff-decision';
import { repairFromExistingOrder } from '../settle';
import { type SettlementFixtures, settlementFixtures } from './settlement-fixtures';

const PREFIX = `qa-repairrace${Date.now()}`;
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

describe('the CAS-loser repair branch still returns the diner a code', () => {
  it('returns a code when two ticks race on the same already-charged row', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const participantId = await fx.participant({
      dropId,
      qty: 5,
      platformFeeCents: 5 * FEE_PER_UNIT,
    });
    // The crash window §4.2 describes: the charge happened and its `Order` row was
    // written, but `chargeStatus` never moved off `NONE` — so there is no code yet.
    await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty: 5,
        unitPriceCents: DEAL_PRICE,
        subtotalCents: 5 * DEAL_PRICE,
        platformFeeCents: 5 * FEE_PER_UNIT,
        stripeChargeId: 'ch_qa_repair_race',
      },
      select: { id: true },
    });

    const locked = await loadLockedDrop({ dropId });
    expect(locked, 'the drop must be LOCKED for loadLockedDrop').not.toBeNull();
    const participant = locked!.participants.find((p) => p.participantId === participantId);
    expect(participant, 'the participant must be in the locked roster').toBeDefined();

    // Hold a `FOR UPDATE` row lock on the participant so both repair calls must block
    // at their NONE->CAPTURED CAS (each having read `NONE`). On release one wins
    // (count 1) and one loses (count 0 -> the `claimed !== 1` branch), deterministically.
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    let releaseLock!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const lockPromise = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT * FROM "DropParticipant" WHERE id = ${participantId} FOR UPDATE`;
      lockAcquired();
      await release;
    });

    // Acquire the lock before starting either repair, so neither can complete its CAS.
    await acquired;

    const r1 = repairFromExistingOrder(locked!, participant!);
    const r2 = repairFromExistingOrder(locked!, participant!);

    // Both repairs are now blocked at their `updateMany`. Hold briefly so both have
    // definitely reached the blocked state, then release so they race.
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseLock();

    const [code1, code2] = await Promise.all([r1, r2, lockPromise]);

    // Both ticks saw a non-null repair code (the code is deterministic in the payload,
    // so they are identical). Under the M5 mutant the loser returns `null` and would
    // re-charge the diner, so exactly one code becomes null — the count catches it.
    expect(code1, 'winner must return a code').toBeTruthy();
    expect(code2, 'loser must still return a code').toBeTruthy();
    expect(typeof code1).toBe('string');
    expect(typeof code2).toBe('string');
    expect(code1).toBe(code2);

    // Ground truth, read back rather than reconstructed from fixtures.
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { chargeStatus: true, redemptionCode: true, qty: true },
    });
    expect(row.chargeStatus).toBe('CAPTURED');
    expect(row.redemptionCode, 'FR-505: the repaired diner must hold a code').toBeTruthy();
    expect(
      verifyRedemptionCode(
        row.redemptionCode as string,
        deriveRedemptionSecret(process.env.JWT_SECRET as string),
      ),
    ).toEqual({ participantId, dropId, qty: 5 });
  });
});
