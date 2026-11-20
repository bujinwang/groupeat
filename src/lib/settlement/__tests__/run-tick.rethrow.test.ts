import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The three modules whose single exports are replaced below.
 *
 * All are `import type`, aliased at the top because the repo forbids inline
 * `typeof import('…')` annotations (`@typescript-eslint/consistent-type-imports`) and
 * the `vi.mock` factories need the module type to keep `importOriginal` typed. Same
 * idiom, same reason, as `src/lib/auth/__tests__/credentials.test.ts:15`.
 */
import type * as cutoffDecisionModule from '@/lib/settlement/cutoff-decision';
import type * as orphanSweepModule from '@/lib/settlement/orphan-sweep';
import type * as pickupWindowModule from '@/lib/settlement/pickup-window';
import type * as settleModule from '@/lib/settlement/settle';

/**
 * §11.4's other half: the containment rule must not become a blanket swallow.
 *
 * ## Why this is a separate file
 *
 * `run-tick.ts` has **five** catch blocks with two arms each — an integrity error is
 * contained, and **everything else is rethrown**: decision, settle, pickup, void, and
 * the orphan sweep. The first four are per-drop loops; the fifth is a single sweep call
 * that has no loop of its own. The integrity arm is covered twice over by
 * `run-tick.integrity.test.ts` and `run-tick.integrity-phases.test.ts`, from real
 * corrupted rows.
 *
 * The rethrow arm cannot be reached that way, and that is not a gap in the fixtures —
 * it is the nature of the rule. Every error production code raises from bad data is a
 * `SettlementIntegrityError` **by construction**; that is what the class is for. A
 * database outage, a bug in `settle`, a `TypeError` from a bad deploy: none of these
 * can be produced by writing a row. So the only way to exercise the arm is to install
 * a failure, and `vi.mock` is file-scoped in Vitest.
 *
 * All five are covered here, one test each, because they are five separate `throw`
 * statements: a regression that turned one into a `continue` would not touch the
 * others, and the phases fail differently (the decision one writes nothing, the settle
 * one leaves a LOCKED drop, the pickup one leaves a drop that should have become
 * collectable still CAPTURED, the void one leaves an authorisation held, and the
 * orphan sweep one leaves a `PENDING` row unreconciled).
 *
 * Putting the mock in the containment file and trying to scope it per test with
 * `vi.doMock` + dynamic import was the alternative. Rejected: `run-tick` and `settle`
 * are already imported by the top-level `import` statements there, so a `doMock` after
 * that point would not apply to them without a `vi.resetModules()` dance that makes the
 * other tests' module identity depend on their order. Two small files that each state
 * one property is the cheaper and more honest arrangement — which is also why this
 * suite already has five `run-tick.*.test.ts` files.
 *
 * ## What the mock does and does not replace
 *
 * `importOriginal` keeps every other export — `findDueDrops`, `findLockedDrops`,
 * `findDropsAwaitingVoid`, `loadLockedDrop`, and whichever of `settle` /
 * `voidRemainingAuthorisations` is not currently throwing — as the shipped functions,
 * so the tick still reads the real database and a real drop still has to be created for
 * the mocked function to be called at all. Each seam is replaced only while its control
 * flag is set, so the tests here can share one file without one's stub leaking into
 * the next.
 */

const control = vi.hoisted(() => ({
  /** When set, the mocked `decideFor` throws this instead of deciding. */
  decideError: null as Error | null,
  /** When set, the mocked `settle` throws this. */
  settleError: null as Error | null,
  /** When set, the mocked `applyPickupTransition` throws this. */
  pickupError: null as Error | null,
  /** When set, the mocked `voidRemainingAuthorisations` throws this. */
  voidError: null as Error | null,
  /** When set, the mocked `resolveOrphanedPendingJoins` throws this. */
  orphanSweepError: null as Error | null,
}));

vi.mock('@/lib/settlement/cutoff-decision', async (importOriginal) => {
  const actual = await importOriginal<typeof cutoffDecisionModule>();
  return {
    ...actual,
    decideFor: async (args: Parameters<typeof actual.decideFor>[0]) => {
      if (control.decideError) {
        throw control.decideError;
      }
      return actual.decideFor(args);
    },
  };
});

vi.mock('@/lib/settlement/pickup-window', async (importOriginal) => {
  const actual = await importOriginal<typeof pickupWindowModule>();
  return {
    ...actual,
    applyPickupTransition: async (args: Parameters<typeof actual.applyPickupTransition>[0]) => {
      if (control.pickupError) {
        throw control.pickupError;
      }
      return actual.applyPickupTransition(args);
    },
  };
});

vi.mock('@/lib/settlement/settle', async (importOriginal) => {
  const actual = await importOriginal<typeof settleModule>();
  return {
    ...actual,
    settle: async (args: Parameters<typeof actual.settle>[0]) => {
      if (control.settleError) {
        throw control.settleError;
      }
      return actual.settle(args);
    },
    voidRemainingAuthorisations: async (args: Parameters<typeof actual.voidRemainingAuthorisations>[0]) => {
      if (control.voidError) {
        throw control.voidError;
      }
      return actual.voidRemainingAuthorisations(args);
    },
  };
});

vi.mock('@/lib/settlement/orphan-sweep', async (importOriginal) => {
  const actual = await importOriginal<typeof orphanSweepModule>();
  return {
    ...actual,
    resolveOrphanedPendingJoins: async (
      args: Parameters<typeof actual.resolveOrphanedPendingJoins>[0],
    ) => {
      if (control.orphanSweepError) {
        throw control.orphanSweepError;
      }
      return actual.resolveOrphanedPendingJoins(args);
    },
  };
});

const { prisma } = await import('@/lib/db/prisma');
const { fakeChargePort } = await import('@/lib/settlement/fake-charge-port');
const { runCutoffTick } = await import('@/lib/settlement/run-tick');
const { settlementFixtures } = await import('@/lib/settlement/__tests__/settlement-fixtures');

const PREFIX = `rtr${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;

const fx = settlementFixtures(PREFIX);
let merchantId = '';
let itemId = '';

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('§11.4 does not swallow an unrecognised error, in any phase', () => {
  /**
   * `run-tick.ts:164-165` — `throw error` in the decision phase.
   *
   * The property is "the orchestrator does not swallow unknown errors", and that
   * cannot be produced by real data: real data produces the *integrity* errors, which
   * are the ones the rule is written to contain. A non-integrity throw from
   * `decideFor` means the database is unreachable or the code is wrong, and §11.4's
   * containment is per-drop precisely because one bad **row** must not become an
   * outage — not because one bad **deploy** should be reported as a normal tick.
   *
   * If this arm were `continue`, the tick would return a result that looks like every
   * drop was undecidable, the route would answer 200, and the cron would report health
   * while nothing settled. The settle phase (185-186) and the void phase (234-235) carry
   * the same `throw error`, and each has its own test below rather than being inferred
   * from this one: they are separate statements in separate loops, and the two arms sit
   * beside each other in the same `if`.
   */
  it('rejects the tick when the decision phase fails for a reason that is not integrity', async () => {
    // A real due drop, so `decideFor` is actually reached. Without one the loop body
    // never runs and the tick would resolve no matter what the catch does.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 1,
    });
    await fx.participant({ dropId, qty: 1 });

    control.decideError = new Error('synthetic db failure');
    try {
      await expect(
        runCutoffTick({ now: new Date(), port: fakeChargePort() }),
      ).rejects.toThrow('synthetic db failure');
    } finally {
      control.decideError = null;
    }

    // Nothing was written by the failed phase — a throw out of `decideFor` rolls its
    // own transaction back, and the tick stops before the settle phase. The drop is
    // still `PUBLISHED`, which is the state a retry will find it in.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('PUBLISHED');
  });

  /**
   * The containment rule names a *class of error*, not a string on an error.
   *
   * `run-tick.ts` used a local `error.name === 'SettlementIntegrityError'` check
   * while the real type guard in `settlement-error.ts` had zero callers. That let
   * any throw from `decideFor` — a database error from another wrapper, a bad
   * deploy, even a typo in a dependency — borrow the terminal-error label and be
   * contained. The tick would answer 200, skip the drop, and the cron would
   * report health while nothing settled. This installs exactly that impostor at
   * the decision seam and requires the original error to escape.
   */
  it('rejects an error that only impersonates SettlementIntegrityError by name', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 1,
    });
    await fx.participant({ dropId, qty: 1 });

    const impostor = Object.assign(new Error('synthetic impostor'), {
      name: 'SettlementIntegrityError',
    });
    control.decideError = impostor;
    try {
      await expect(
        runCutoffTick({ now: new Date(), port: fakeChargePort() }),
      ).rejects.toBe(impostor);
    } finally {
      control.decideError = null;
    }

    // A contained impostor would leave the drop PUBLISHED for the next tick and
    // call it a paged integrity event. The rejection above is the load-bearing
    // assertion; this only records that nothing was silently progressed.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('PUBLISHED');
  });

  /**
   * `run-tick.ts:185-186` — `throw error` in the settle phase.
   *
   * The second of the five rethrow arms, and the one that matters most for money: the
   * settle phase is where cards are charged. A swallowed error here would leave a drop
   * `LOCKED` with captures already attempted, the tick would report success, and the
   * next run would meet the same row and the same bug. §11.4 contains an **integrity**
   * failure per drop; anything else means `settle` itself is broken, and the tick must
   * say so.
   *
   * This line was not in the coverage table the work started from, and measuring the
   * baseline showed it was equally dark: `run-tick.integrity-phases.test.ts` reaches
   * the integrity arm of this same `catch` with a real `AMOUNT_MISMATCH`, which leaves
   * the `throw error` beside it at zero. The two arms are one `if`, so covering the
   * first says nothing about the second.
   */
  it('rejects the tick when the settle phase fails for a reason that is not integrity', async () => {
    // `LOCKED` already, so `findLockedDrops` selects it and `settle` is called without
    // the decision phase having to run. That keeps this test about the settle `catch`
    // and nothing else.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 2 });

    control.settleError = new Error('synthetic settle failure');
    try {
      await expect(
        runCutoffTick({ now: new Date(), port: fakeChargePort() }),
      ).rejects.toThrow('synthetic settle failure');
    } finally {
      control.settleError = null;
    }

    // Untouched: the throw happened before `settle` wrote a status, so the drop is the
    // same LOCKED row the next tick will retry. A `CAPTURED` here would mean the tick
    // carried on after a failure it was supposed to report.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('LOCKED');
    expect(await prisma.order.count({ where: { dropId } })).toBe(0);
  });

  /**
   * `run-tick.ts:219` — `throw error` in the pickup phase.
   *
   * ## This one is reachable in production, and that is the point
   *
   * The other three phases raise integrity errors from production code, so their
   * `catch` has a live integrity arm. The pickup phase does not: `pickup-window.ts`
   * contains **zero `throw` statements** and imports only `prisma` and `logger`, so
   * `isSettlementIntegrityError` can never be true for anything `applyPickupTransition` itself
   * raises. That half of the block is dead code, kept as defensive symmetry.
   *
   * **But the `catch` itself is not dead.** `applyPickupTransition`'s `updateMany`
   * (`pickup-window.ts:185`) is a real database round trip; it rejects on connection
   * loss at the pooler, a query timeout, a serialisation failure. Control then reaches
   * this `throw error`, which aborts the whole tick.
   *
   * That is the behaviour worth pinning, and it is an asymmetry rather than a bug: a
   * transient database failure in the pickup phase kills the tick, while an integrity
   * failure in the other three is contained per drop. The reason is that this phase has
   * no drop-specific error to contain — if the database is unreachable, every remaining
   * drop in the tick would fail the same way, so continuing would be a loop of
   * guaranteed failures. Failing loudly is correct; it is the *containment* arm that is
   * unreachable, not this one.
   *
   * By external-trigger count the pickup phase is the plainest of the four, not the odd
   * one out: it has exactly one non-integrity trigger (Prisma). The void phase has two —
   * the `prisma.dropParticipant.updateMany` at `settle.ts:896` *and* the rethrow at
   * `settle.ts:907-910` for anything that is not `PaymentProviderUnavailableError`. The
   * settle phase's integrity checks raise integrity errors, which are contained, so its
   * rethrow arm is reached by the same Prisma-shaped class of failure.
   *
   * The mock is the only way in, because the failure is at the Prisma seam and this
   * suite's fixtures talk to a healthy database. Note the assertion is a rejection with
   * the original error — **not** an `settlement.integrity_error` log line, which this
   * path cannot produce.
   *
   * ## Which assertion carries the proof, for whoever edits this next
   *
   * `rejects.toThrow(...)` is the load-bearing one. The `status === 'CAPTURED'` check
   * after it is **not** sufficient on its own: it would pass just as well if
   * `applyPickupTransition` were never called at all, because a drop this suite never
   * touches is trivially still `CAPTURED`. So do not delete the mock and keep the
   * status assertion on the theory that it still tests something — it would become a
   * test that a row nobody wrote to still has its old value.
   *
   * The status check earns its place as the *other* half: it proves the throw happened
   * before the write committed, which is what makes the phase resumable. The proof that
   * the catch is entered is the rejection, and the proof of that is the mutation —
   * changing 219 to `continue` makes the tick resolve and this test fail.
   */
  it('rejects the tick when the pickup phase fails, rather than containing it', async () => {
    // `CAPTURED` with a window already open, so `findPickupDue` returns it and
    // `applyPickupTransition` is called. Nothing else is due: not PUBLISHED (so no
    // decision), not LOCKED (so no settle), and its participant is already CAPTURED (so
    // `findDropsAwaitingVoid` skips it). This isolates the pickup catch.
    const now = Date.now();
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'CAPTURED',
      cutoffAt: new Date(now - 4 * 60 * 60 * 1000),
      windowStart: new Date(now - 30 * 60 * 1000),
      windowEnd: new Date(now + 90 * 60 * 1000),
      lockedAt: new Date(now - 4 * 60 * 60 * 1000),
    });
    await fx.participant({ dropId, qty: 2, chargeStatus: 'CAPTURED' });

    control.pickupError = new Error('synthetic pickup db failure');
    try {
      await expect(
        runCutoffTick({ now: new Date(now), port: fakeChargePort() }),
      ).rejects.toThrow('synthetic pickup db failure');
    } finally {
      control.pickupError = null;
    }

    // Still `CAPTURED`: the transition never committed, so the drop the diner is
    // standing at a counter for is not yet collectable. The next tick retries it —
    // this transition is idempotent and guarded on the from-status.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('CAPTURED');
  });

  /**
   * `run-tick.ts:234-235` — `throw error` in the void phase.
   *
   * The same guarantee, one phase later, and it matters for a specific reason: the
   * void sweep runs **after** every drop in the tick has been settled and captured. A
   * swallowed error here would report a clean tick while a diner's authorisation
   * remained held — but a rethrown one is also not free, which is why §11.4 does not
   * contain it: an error that is not an integrity failure means the sweep itself is
   * broken, and pretending the tick succeeded would hide a held authorisation behind a
   * green run.
   *
   * `voidRemainingAuthorisations` really does throw non-integrity errors for provider
   * reasons (`settle.ts:907-910` rethrows anything that is not
   * `PaymentProviderUnavailableError`), so this arm has a production trigger even
   * though the mock is what installs it here.
   */
  it('rejects the tick when the void phase fails for a reason that is not integrity', async () => {
    // `FAILED` and holding a live authorisation, so `findDropsAwaitingVoid` selects it
    // and the sweep is called. Seeded rather than driven there by the tick: a drop the
    // tick itself fails enters the queue too, but via `failedNow`, and this test is
    // about the sweep, not the decision.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'FAILED',
    });
    await fx.participant({ dropId, qty: 1 });

    control.voidError = new Error('synthetic sweep failure');
    try {
      await expect(
        runCutoffTick({ now: new Date(), port: fakeChargePort() }),
      ).rejects.toThrow('synthetic sweep failure');
    } finally {
      control.voidError = null;
    }

    // The sweep never reached the provider, so the hold is still live. That is the
    // incident the throw is reporting; `settle.ts:915-919` logs `settlement.void_pending`
    // for the transient case, and this is the case it cannot absorb.
    const participant = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId },
      select: { authStatus: true },
    });
    expect(participant.authStatus).toBe('AUTHORIZED');
  });
});

/**
 * The impostor case, once per containment arm.
 *
 * ## Why these are separate from the four tests above
 *
 * The tests above install a plain `new Error(...)`, whose `name` is `'Error'`. Both
 * the old local `error.name === 'SettlementIntegrityError'` check and the real
 * `isSettlementIntegrityError` predicate return `false` for that, so those four
 * tests pass identically under either classifier — they pin the *rethrow* arm, not
 * the *classifier*. Measured, not assumed: reverting each of the five arms to the
 * name-string check one at a time left the settle, pickup, void and orphan arms
 * fully green (9/9 each), and only the decision arm failed.
 *
 * So before this block the diff "replace the name check with the class predicate in
 * five places" was one-fifth proven. Each test below installs an error that is a
 * real `Error` with the borrowed name — the exact shape the old check contained —
 * at one seam, and requires that seam to rethrow it.
 *
 * ## Why an impostor is contained and why that is a bug
 *
 * Containment means "this drop's numbers are wrong, skip it, page on-call, keep
 * going". That is a claim about *our data*. An error that merely shares the name
 * makes the same claim without the evidence: the tick answers 200, the drop is
 * skipped as already-explained, and the cron reports a healthy run over a failure
 * nobody investigated. A rejection is the honest outcome, and it is what makes the
 * route surface the failure instead of masking it.
 */
describe('§11.4 classifies by class, not by a borrowed name, in every arm', () => {
  /** Builds the impostor: a genuine `Error` wearing the integrity class's name. */
  function impostor(message: string): Error {
    return Object.assign(new Error(message), { name: 'SettlementIntegrityError' });
  }

  it('rejects an impostor raised by settle, and leaves the drop LOCKED', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 2 });

    const fake = impostor('impostor from settle');
    control.settleError = fake;
    try {
      await expect(runCutoffTick({ now: new Date(), port: fakeChargePort() })).rejects.toBe(fake);
    } finally {
      control.settleError = null;
    }

    // A contained impostor would have skipped this drop and reported a clean tick,
    // leaving a LOCKED row that no future run would ever be paged about.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('LOCKED');
  });

  it('rejects an impostor raised by the pickup transition, and leaves the drop CAPTURED', async () => {
    const now = Date.now();
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
      status: 'CAPTURED',
      cutoffAt: new Date(now - 4 * 60 * 60 * 1000),
      windowStart: new Date(now - 30 * 60 * 1000),
      windowEnd: new Date(now + 90 * 60 * 1000),
      lockedAt: new Date(now - 4 * 60 * 60 * 1000),
    });
    await fx.participant({ dropId, qty: 2, chargeStatus: 'CAPTURED' });

    const fake = impostor('impostor from pickup');
    control.pickupError = fake;
    try {
      await expect(
        runCutoffTick({ now: new Date(now), port: fakeChargePort() }),
      ).rejects.toBe(fake);
    } finally {
      control.pickupError = null;
    }

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('CAPTURED');
  });

  it('rejects an impostor raised by the void sweep, and leaves the hold AUTHORIZED', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'FAILED',
    });
    await fx.participant({ dropId, qty: 1 });

    const fake = impostor('impostor from void sweep');
    control.voidError = fake;
    try {
      await expect(runCutoffTick({ now: new Date(), port: fakeChargePort() })).rejects.toBe(fake);
    } finally {
      control.voidError = null;
    }

    // The whole point of the rethrow: a live authorisation must not be reported as
    // released by a tick that died before it reached the provider.
    const participant = await prisma.dropParticipant.findFirstOrThrow({
      where: { dropId },
      select: { authStatus: true },
    });
    expect(participant.authStatus).toBe('AUTHORIZED');
  });

  /**
   * The orphan-sweep arm is the newest of the five and had no mock at all before
   * this test, so it could not be probed by any existing suite. The sweep runs
   * unconditionally once per tick — it is not inside a per-drop loop — which is why
   * this test needs no orphan row to reach the catch.
   */
  it('rejects an impostor raised by the orphan sweep', async () => {
    const fake = impostor('impostor from orphan sweep');
    control.orphanSweepError = fake;
    try {
      await expect(runCutoffTick({ now: new Date(), port: fakeChargePort() })).rejects.toBe(fake);
    } finally {
      control.orphanSweepError = null;
    }
  });
});
