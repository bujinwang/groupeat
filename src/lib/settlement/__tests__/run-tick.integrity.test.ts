import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import { runCutoffTick } from '@/lib/settlement/run-tick';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * §11.4's containment rule: an integrity error stops **that** drop and the tick continues.
 *
 * ## Why this file exists
 *
 * Measured coverage on `run-tick.ts` showed the containment path at **0 executions**.
 * `isIntegrityFailure` and `logIntegrityError` were never called by any test, and the
 * four `catch` blocks that use them were never entered. The behaviour they implement is
 * the one §11.4 names explicitly — *"refusing to settle the other nineteen drops would
 * turn one bad row into an outage"* — so the guarantee that one corrupt drop cannot stop
 * the rest of the tick was, until now, only a comment.
 *
 * That is the failure this file is about. Not "does `settle` throw on bad data" (it
 * does, and `settle.test.ts` and `ledger.test.ts` prove it), but **what the orchestrator
 * does with the throw**: skip that drop, log it at `error` with the check name, and carry
 * on to the others in the same tick.
 *
 * ## The corruption is real, not mocked
 *
 * A participant with `authStatus: 'AUTHORIZED'` and `paymentIntentId: null` is the exact
 * row `toLockedParticipants` refuses (`cutoff-decision.ts:239`): a live authorisation
 * with nothing to capture against. The fixture can write it because the column is
 * nullable, so the error arrives from production code reading a production table —
 * nothing is stubbed to raise it. Mocking `decideFor` to throw would have proved that
 * `try/catch` catches, which is a property of JavaScript rather than of this tick.
 *
 * ## The two assertions that matter
 *
 *   1. **The healthy drop still settles.** This is the containment claim. A tick that
 *      aborted on the bad drop would settle zero, and the difference is a live drop that
 *      never charges its diners.
 *   2. **The bad drop is named in a log at `error`.** Stopping silently is the other way
 *      to fail: the drop stays `PUBLISHED` past its cutoff and nobody is paged, which is
 *      how a stalled drop becomes a support ticket instead of an incident.
 */

const PREFIX = `rti${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;

/**
 * Captures what the tick logs, so the integrity line can be asserted by name.
 *
 * `vi.hoisted` because the factory below runs before module imports: the array has to
 * exist by then. Only `info/warn/error` are needed — the tick logs through those three.
 */
const logLines = vi.hoisted(() => [] as { event: string; fields: Record<string, unknown> }[]);

vi.mock('@/lib/logging/logger', () => ({
  logger: {
    info: (event: string, fields: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    warn: (event: string, fields: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    error: (event: string, fields: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
  },
}));

/** A published drop past its cutoff whose minimum is met by one participant. */
async function dueDrop(qty: number): Promise<{ dropId: string; participantId: string }> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: qty,
  });
  const participantId = await fx.participant({ dropId, qty });
  return { dropId, participantId };
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('§11.4 — an integrity error stops one drop, not the tick', () => {
  it('settles the healthy drop and skips the corrupt one in the same tick', async () => {
    logLines.length = 0;

    // The corrupt drop: a live authorisation with no PaymentIntent. `toLockedParticipants`
    // throws `SettlementIntegrityError('MISSING_PAYMENT_INTENT')` on this row.
    const corrupt = await dueDrop(1);
    await prisma.dropParticipant.update({
      where: { id: corrupt.participantId },
      data: { paymentIntentId: null },
    });

    // The healthy drop, in the same tick. This is the one whose settlement proves
    // containment: if the throw escaped, nothing would be settled at all.
    const healthy = await dueDrop(2);

    const result = await runCutoffTick({ now: new Date(), port: fakeChargePort() });

    // The bad drop stops at the decision phase, so it never counts as settled.
    const corruptRow = await prisma.drop.findUniqueOrThrow({
      where: { id: corrupt.dropId },
      select: { status: true },
    });
    expect(corruptRow.status).toBe('PUBLISHED');

    // The healthy drop went all the way through, in the same tick that hit the error.
    const healthyRow = await prisma.drop.findUniqueOrThrow({
      where: { id: healthy.dropId },
      select: { status: true },
    });
    expect(healthyRow.status).toBe('CAPTURED');
    expect(result.settled).toBeGreaterThanOrEqual(1);

    // And it is reported as an error naming the check, not swallowed.
    const integrity = logLines.filter((line) => line.event === 'settlement.integrity_error');
    expect(integrity).toHaveLength(1);
    expect(integrity[0]?.fields.dropId).toBe(corrupt.dropId);
    expect(integrity[0]?.fields.check).toBe('MISSING_PAYMENT_INTENT');
  });

  it('returns a tick result rather than throwing out of runCutoffTick', async () => {
    logLines.length = 0;

    // Same corruption, alone, so a throw has nowhere to hide behind a healthy drop.
    const corrupt = await dueDrop(1);
    await prisma.dropParticipant.update({
      where: { id: corrupt.participantId },
      data: { paymentIntentId: null },
    });

    // If the catch were missing, this `await` would reject and the test would fail on
    // the throw. The point is that the orchestrator converts a per-drop terminal error
    // into a skipped drop, which is what lets one bad row coexist with nineteen good ones.
    const result = await runCutoffTick({ now: new Date(), port: fakeChargePort() });

    expect(result.due).toBeGreaterThanOrEqual(1);
    expect(result.settled).toBe(0);

    /**
     * Scoped to **this** drop, not to the log as a whole.
     *
     * The previous test left its corrupt drop `PUBLISHED` on purpose — that is the
     * behaviour §11.4 describes, a bad row waiting for a human — so it is still due on
     * the next tick and is reported again. Asserting a global count of one would be
     * asserting that the earlier drop had healed itself. What this test needs is that
     * *this* drop was contained and named, which is a per-drop fact.
     */
    const mine = logLines.filter(
      (line) => line.event === 'settlement.integrity_error' && line.fields.dropId === corrupt.dropId,
    );
    expect(mine).toHaveLength(1);
  });
});
