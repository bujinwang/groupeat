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
 * §11.4's containment rule, for the two tick phases that can actually reach it.
 *
 * ## The gap this closes
 *
 * `run-tick.ts` has four `catch` blocks implementing §11.4 — one per phase that can
 * touch a drop. `run-tick.integrity.test.ts` covers the decision phase only, by
 * corrupting a participant so `toLockedParticipants` throws. The other three were
 * still never entered by any test, so three quarters of the orchestrator's stated
 * guarantee was a comment.
 *
 * ## These phases are not interchangeable, and the reachability decides the tests
 *
 * Whether a `catch` is worth a test is not a matter of taste; it is whether production
 * code can throw into it. Reading the call graph:
 *
 * | Phase | Thrower | Reachable? |
 * |---|---|---|
 * | decide (156-165) | `decideFor` → `toLockedParticipants`, `MISSING_STRIPE_ACCOUNT` | yes, covered in `run-tick.integrity.test.ts` |
 * | settle (180-186) | `settle` → `assertAmountsMatchTheDeal`, `assertDropReconciles` | **yes — covered here** |
 * | pickup (214-220) | `applyPickupTransition` | **no — see below** |
 * | void (229-235) | `voidRemainingAuthorisations`, `MISSING_STRIPE_ACCOUNT` | **yes — covered here** |
 *
 * `applyPickupTransition` (`pickup-window.ts:175`) contains **zero `throw` statements**
 * and does not import `SettlementIntegrityError`; its only awaits are a `findMany`, an
 * `updateMany` and a `logger.info`. So `isIntegrityFailure(error)` in the pickup `catch`
 * cannot be true for any input, and asserting that it fires would need `vi.mock` on the
 * module — which proves that `try/catch` catches, a property of JavaScript. That branch
 * is deliberately left uncovered. The `catch` stays: it is harmless defensive symmetry,
 * and the phase may grow integrity checks.
 *
 * ## The corruption is real data, not a stub
 *
 * Both errors are raised by production code reading production rows, exactly as the
 * decision-phase test does with `paymentIntentId: null`:
 *
 *   - `AMOUNT_MISMATCH` from a participant whose `amountCents` is not
 *     `qty × dealPriceCents` — the column is writable by the fixture, and
 *     `assertAmountsMatchTheDeal` (`settle.ts:387`) reads it back;
 *   - `MISSING_STRIPE_ACCOUNT` from a drop whose merchant has a null
 *     `stripeAccountId` — `voidRemainingAuthorisations` (`settle.ts:856`) refuses to
 *     void without the connected account.
 *
 * Nothing here mocks a settlement module to throw.
 */

const PREFIX = `rtp${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;

let fx: SettlementFixtures;
/** A merchant with a connected account, so the void path is not what fires. */
let merchantId: string;
let itemId: string;
/** A merchant whose account was detached, so the void sweep cannot act. */
let detachedMerchantId: string;
let detachedItemId: string;

/**
 * The same log capture as `run-tick.integrity.test.ts:62-76`, and the same reason:
 * `vi.hoisted` because the mock factory runs before module imports, and the array has
 * to exist by then. The tick logs through exactly `info/warn/error`.
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

/**
 * Every `settlement.integrity_error` naming **this** drop.
 *
 * Scoped per drop, never by global count. Both tests in this file leave a corrupt row
 * behind on purpose — a LOCKED drop that cannot settle is the behaviour §11.4
 * describes, a row waiting for a human — so on the next test's tick it is reported
 * again. A global `toHaveLength(1)` would be asserting that the earlier drop healed
 * itself, which is the opposite of what the rule says should happen.
 */
function integrityErrorsFor(dropId: string) {
  return logLines.filter(
    (line) => line.event === 'settlement.integrity_error' && line.fields.dropId === dropId,
  );
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant('acct_test_integrity_phases');
  itemId = await fx.item(merchantId);
  detachedMerchantId = await fx.merchant(null);
  detachedItemId = await fx.item(detachedMerchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('§11.4 in the settle phase', () => {
  it('contains an AMOUNT_MISMATCH and still captures the other drop in the same tick', async () => {
    logLines.length = 0;

    // The corrupt drop: a participant whose stored amount is one cent off
    // `qty × dealPriceCents`. `assertAmountsMatchTheDeal` refuses this before any
    // charge is attempted, because the diner was shown a different number.
    const corruptDropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
    });
    await fx.participant({
      dropId: corruptDropId,
      qty: 2,
      amountCents: 2 * DEAL_PRICE + 1,
    });

    // The healthy drop, due in the same tick. Its capture is the containment claim:
    // if the throw escaped the loop, nothing would settle at all.
    const healthyDropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
    });
    await fx.participant({ dropId: healthyDropId, qty: 2 });

    // Awaited without a `rejects` wrapper: if the catch were gone, this line throws
    // out of `runCutoffTick` and the test fails on the throw itself.
    const result = await runCutoffTick({ now: new Date(), port: fakeChargePort() });

    const healthy = await prisma.drop.findUniqueOrThrow({
      where: { id: healthyDropId },
      select: { status: true },
    });
    expect(healthy.status).toBe('CAPTURED');
    expect(result.settled).toBeGreaterThanOrEqual(1);

    /**
     * The corrupt drop is still `LOCKED` after the tick, and the phase interaction is
     * why that is the *only* possible answer rather than a detail of this fixture.
     *
     * `settle` throws before it writes anything, so the row stays `LOCKED` — its own
     * test (`settle.test.ts:441`) asserts the same thing one level down. It is then
     * **not** swept by the void phase, even though the tick still runs that phase for
     * every other drop: `findDropsAwaitingVoid` selects `VOID_SWEEP_STATUSES`, and
     * `LOCKED` is deliberately absent from that list (`drop-status.ts:76-82`) because a
     * locked drop's authorisations are about to be captured, not released.
     *
     * So containment here is a drop that stays locked until a human fixes the amount.
     * It is also why the next tick in this file meets it again in `resume` and logs the
     * same check a second time — the per-drop log filter exists for that.
     */
    const corrupt = await prisma.drop.findUniqueOrThrow({
      where: { id: corruptDropId },
      select: { status: true },
    });
    expect(corrupt.status).toBe('LOCKED');

    const mine = integrityErrorsFor(corruptDropId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.fields.check).toBe('AMOUNT_MISMATCH');
  });
});

describe('§11.4 in the void phase', () => {
  it('contains a MISSING_STRIPE_ACCOUNT and still settles the other drop in the same tick', async () => {
    logLines.length = 0;

    /**
     * The unreleasable drop: `FAILED`, holding an authorisation, on a merchant with no
     * connected account.
     *
     * It is seeded `FAILED` rather than driven there by this tick, and that is not a
     * convenience — it is the only shape that reaches this phase. `decideFor` refuses
     * to decide a drop whose merchant lacks a connected account
     * (`cutoff-decision.ts:334`, the Q6 posture), so a `PUBLISHED` drop on such a
     * merchant throws in the **decision** phase and stays `PUBLISHED`; it never becomes
     * `FAILED` and never enters the void queue. A drop can therefore only be `FAILED`
     * with a null account if the account went away *after* the failure — a detached
     * account, or a data repair — which is precisely the row a sweep must survive.
     */
    const orphanDropId = await fx.drop({
      merchantId: detachedMerchantId,
      menuItemId: detachedItemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'FAILED',
    });
    const orphanParticipantId = await fx.participant({ dropId: orphanDropId, qty: 2 });

    // Healthy in every way, and due: the drop whose settlement proves the tick ran on
    // past the failure above.
    const healthyDropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
    });
    await fx.participant({ dropId: healthyDropId, qty: 2 });

    const result = await runCutoffTick({ now: new Date(), port: fakeChargePort() });

    const healthy = await prisma.drop.findUniqueOrThrow({
      where: { id: healthyDropId },
      select: { status: true },
    });
    expect(healthy.status).toBe('CAPTURED');
    expect(result.settled).toBeGreaterThanOrEqual(1);

    // The orphan is untouched: the sweep never reached the provider, so the hold is
    // still live. That is the incident, and it is why the error is logged at `error`
    // rather than retried — the next tick will read the same null account.
    const orphan = await prisma.drop.findUniqueOrThrow({
      where: { id: orphanDropId },
      select: { status: true },
    });
    expect(orphan.status).toBe('FAILED');
    const orphanParticipant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: orphanParticipantId },
      select: { authStatus: true },
    });
    expect(orphanParticipant.authStatus).toBe('AUTHORIZED');

    const mine = integrityErrorsFor(orphanDropId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.fields.check).toBe('MISSING_STRIPE_ACCOUNT');
  });
});
