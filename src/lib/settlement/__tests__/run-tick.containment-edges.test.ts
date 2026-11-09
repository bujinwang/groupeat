import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import type { NotifyIntent, NotifyPort } from '@/lib/settlement/notify-port';
import { runCutoffTick } from '@/lib/settlement/run-tick';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * Three edge behaviours of §11.4 that its main files cannot express.
 *
 * `run-tick.integrity.test.ts` and `run-tick.integrity-phases.test.ts` cover the
 * containment rule itself: an integrity error stops one drop and the tick rolls on.
 * Both of them work from corrupted-but-legal rows, and that is right — the error is
 * raised by production code reading a production table.
 *
 * Three behaviours fall outside that shape and were left at zero executions:
 *
 *   1. **`noop`** (`run-tick.ts:154-155`). The counter the tick returns for "I was
 *      handed a due drop and there was nothing to do". It is not an error path and
 *      no fixture can produce it by being wrong — see the test for why, and for the
 *      two routes that were tried and measured first.
 *   2. **a drop nobody joined** (`run-tick.ts:250-251`). The `continue` that skips
 *      notification for a `FAILED` decision with an empty participant list. Carried a
 *      reachability note claiming it needs `minQty = 0`; the arithmetic was inverted,
 *      and it is in fact the ordinary failure. See the test.
 *   3. **a `notify` that throws** (`run-tick.ts:263-271`). The port's contract says
 *      this cannot happen (`notify-port.ts:13-18`), and the catch is the belt to
 *      that braces — the same shape as `deliver` in `settle.ts:1040-1046`. A belt
 *      nobody has ever buckled is a line of code, not a guarantee.
 *
 * The `throw error` halves of §11.4 — that an unrecognised error is **not** swallowed —
 * live in `run-tick.rethrow.test.ts`, because proving them needs a module mock and a
 * mock is file-scoped.
 */

const PREFIX = `rce${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;

/**
 * The log capture, identical in shape to `run-tick.integrity.test.ts:62-76` and for
 * the same reason: `vi.hoisted` because the mock factory runs before module imports,
 * and the array has to exist by then. The tick logs through exactly `info/warn/error`.
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

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

/**
 * Wait until a backend of this database is blocked acquiring a row lock **while
 * running the tick's locking select**.
 *
 * Polled from `pg_stat_activity` rather than slept on for a fixed interval. A sleep
 * would be a guess about how long the other side needs to reach its `SELECT … FOR
 * UPDATE`, and the guess is wrong in both directions on a loaded host: too short and
 * the barrier is not built, too long and every run pays for it. The wait event is the
 * fact itself — `Lock` means somebody is queued behind a row lock, which is exactly
 * the ordering this test needs to establish.
 *
 * `query ILIKE '%FOR UPDATE%'` keeps the observation attributable to the tick. This is
 * a shared development database, and an unrelated transaction queueing on some other
 * row would otherwise satisfy the condition and the barrier would be reported as built
 * when the tick had not reached its lock at all. A spurious observation cannot make
 * this test pass silently — the competitor would then race the tick and `locked` would
 * be 1 — but a faithful one is what makes the assertion mean something.
 *
 * The 3-second cap is deliberate: the tick is blocked inside `decideFor`'s
 * `prisma.$transaction`, whose default interactive-transaction timeout is 5 seconds. A
 * wait long enough to approach that would surface as a `P2028` out of the tick rather
 * than as a clean assertion. The observation normally lands in single-digit
 * milliseconds; the cap only bounds the failure mode.
 */
async function waitForLockWait(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%FOR UPDATE%'
    `;
    if (Number(rows[0]?.n ?? 0) > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

describe('the noop counter — a drop that is no longer decidable', () => {
  /**
   * Lines 154-155 increment `noop` when `decideFor` returns `NO_OP`, which
   * `cutoff-decision.ts:310-313` returns when the locking select matches no row.
   *
   * ## Why the two obvious routes do not work, measured before writing this
   *
   * **(a) `maxDrops` ordering.** `findDueDrops` orders by `cutoffAt asc` and takes
   * `limit`, so shrinking the bound only decides *which* drops are attempted. Every
   * drop it returns satisfied `status = 'PUBLISHED' AND cutoffAt <= now` a moment
   * earlier, and nothing between the two queries changes that. Closed.
   *
   * **(b) A boundary mismatch.** This would have been the clean one: if
   * `findDueDrops` used `cutoffAt < now` and the locking select used `<=`, a drop
   * whose cutoff is exactly `now` would be returned and then refused — a real
   * `NO_OP`. **It does not exist.** `findDueDrops` filters with Prisma's `lte`
   * (`cutoff-decision.ts:518`) and `decideFor` uses `"cutoffAt" <= …`
   * (`cutoff-decision.ts:306`); they are the same comparison. Measured directly: a
   * drop with `cutoffAt` equal to the tick's `now` is returned by `findDueDrops` and
   * comes back `LOCKED`. Closed.
   *
   * **(c) A drop another writer takes first.** This is the route that works, and it
   * is not synthetic: it is the race the counter's own docblock describes — *"a race
   * another tick won"* (`run-tick.ts:91`).
   *
   * ## Why this is a barrier and not `Promise.all` of two ticks
   *
   * Two overlapping `runCutoffTick` calls also produce `NO_OP` — measured 10/10
   * rounds on this host, so it is not flaky in practice — but nothing in the test
   * *orders* the two. It passes because the first tick's `findDueDrops` usually
   * commits before the second's `decideFor`, which is a property of the scheduler.
   * The competitor below instead holds the row lock and only releases it after
   * `pg_stat_activity` reports the tick queued behind it, so the tick is guaranteed
   * to read the row as `PUBLISHED`, block, and then find the winner's `LOCKED`
   * version when Postgres re-evaluates the predicate (EvalPlanQual — the mechanism
   * `cutoff-decision.ts:38-44` relies on).
   *
   * The competitor is a hand-written `LOCKED` write, not a second tick. That is the
   * one thing that differs from a real race, and it is deliberate: the claim under
   * test is "a `NO_OP` from `decideFor` becomes `noop += 1`", and a second tick adds
   * a settlement that would make the assertion below ambiguous about which tick did
   * what. `cutoff-decision.concurrency.test.ts` already proves the two-worker case at
   * the `decideFor` level.
   */
  it('counts a drop the tick found due but lost the row lock on', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 1,
    });
    await fx.participant({ dropId, qty: 1 });

    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let sawLockWait = false;

    const competitor = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Drop" WHERE id = ${dropId} FOR UPDATE`;
        releaseLock();
        // Only proceed once the tick is actually queued behind this transaction.
        sawLockWait = await waitForLockWait(3_000);
        await tx.$executeRaw`UPDATE "Drop" SET status = 'LOCKED', "lockedAt" = now() WHERE id = ${dropId}`;
      },
      // This transaction deliberately outlives the tick's, so its budget is raised
      // from Prisma's 5-second default. The tick's own transaction is *not* given a
      // longer budget — it sits blocked inside `decideFor` for as long as this one
      // holds the row, and `waitForLockWait`'s 3-second cap exists to keep that well
      // inside the tick's default rather than surfacing as a `P2028` timeout.
      { timeout: 20_000, maxWait: 20_000 },
    );

    await lockHeld;
    const [result] = await Promise.all([
      runCutoffTick({ now: new Date(), port: fakeChargePort() }),
      competitor,
    ]);

    // The barrier: if this is false the race did not happen and the assertion below
    // would be asserting nothing. It is a precondition, not a convenience.
    expect(sawLockWait).toBe(true);

    expect(result.due).toBeGreaterThanOrEqual(1);
    expect(result.noop).toBeGreaterThanOrEqual(1);
    // The tick did not lock it — the competitor did. A `locked` count here would mean
    // the barrier let the tick through first.
    expect(result.locked).toBe(0);

    // And nothing was captured for it: `NO_OP` means the drop was never decided by
    // this tick, so it never reached `settle`.
    expect(await prisma.order.count({ where: { dropId } })).toBe(0);

    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('LOCKED');
  });
});

describe('a drop that nobody joined', () => {
  /**
   * `run-tick.ts:250-251` — the `continue` when `participants.length === 0`.
   *
   * ## The reachability claim this used to carry, and why it was wrong
   *
   * The coverage work started from a note saying this branch is defensive and
   * unreachable, reasoning that `decideFor` maps `participants` from rows it already
   * read, and "a `FAILED` decision requires `joinedQty < minQty`, so with `minQty >= 1`
   * a drop can only fail with zero participants if `minQty = 0`". The arithmetic is
   * backwards: `joinedQty = 0` and `minQty = 5` **is** `0 < 5`. Zero participants is
   * not the impossible case, it is the ordinary one — a published drop that nobody
   * signed up for. `minQty = 0` is what would make a zero-participant drop *pass*, and
   * that is the configuration `validateDropQuantities` refuses (`drops/rules.ts:121`).
   *
   * So this is the most common way a drop fails, and the guard it protects matters:
   * `notify.notify([])` is a call the port would have to tolerate, and the log line at
   * 276-280 would claim a `DROP_FAILED_NO_CHARGE` batch of zero was sent.
   *
   * Measured, not argued: a `PUBLISHED` drop at `minQty: 5` with no participants, one
   * tick, and lines 250-251 go from uncovered to covered.
   */
  it('fails a drop with a minimum and no participants, without notifying anybody', async () => {
    logLines.length = 0;

    // No `fx.participant` call at all. `minQty` is a legal 5.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
    });

    const batches: (readonly NotifyIntent[])[] = [];
    const recording: NotifyPort = {
      async notify(intents) {
        batches.push(intents);
      },
    };

    const result = await runCutoffTick({ now: new Date(), port: fakeChargePort(), notify: recording });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { status: true },
    });
    expect(row.status).toBe('FAILED');
    expect(await prisma.dropParticipant.count({ where: { dropId } })).toBe(0);

    // The guard's whole point: no empty batch is handed to the port, and no
    // `notification.intent` line claims a message was sent for this drop. Both would be
    // true if the `continue` at 250 were removed — the intent array would be `[]`, the
    // port would be called with it, and the log would report `count: 0`.
    expect(batches.some((batch) => batch.some((intent) => intent.dropId === dropId))).toBe(false);
    const intentsForDrop = logLines.filter(
      (line) => line.event === 'notification.intent' && line.fields.dropId === dropId,
    );
    expect(intentsForDrop).toHaveLength(0);
  });
});

describe('a notify port that throws', () => {
  /**
   * `notify-port.ts:13-18` puts the rule on the implementation: **`notify()` must
   * never throw into the settlement path**, because "failure to notify is not failure
   * to charge" and conflating them strands a settled drop.
   *
   * `run-tick.ts:263-271` catches anyway. Both are untested, and this test is the
   * half that matters here — the phase that notifies a drop which *failed*.
   *
   * ## What is actually at stake
   *
   * The throw would arrive **after** the settle and void phases have committed. If it
   * escaped, the tick would reject with drops already `CAPTURED` and authorisations
   * already released — so the work is done, but the route returns a failure and the
   * next run re-enters the same path and fails at the same line. That is a job that
   * never reports success again while everything it did was correct.
   *
   * ## Why the corrupted data cannot express this
   *
   * Every other catch in this file is reached by making a row wrong. This one is
   * different: the thrower is a **seam the application is handed**, not a query
   * result, and the contract says it will not happen. There is no property of the
   * database that makes `notify` throw, so the failure has to be installed. The port
   * is constructed inline rather than mocked as a module so the rest of the tick —
   * the fixture rows, the decision, the capture, the void — all stay real.
   */
  it('resolves instead of rejecting, logs the reason, and still settles the healthy drop', async () => {
    logLines.length = 0;

    // Below its minimum, so this tick decides `FAILED` and puts it in
    // `failedParticipants` — the only map the phase at 247-282 reads.
    const failedDropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
    });
    await fx.participant({ dropId: failedDropId, qty: 1 });

    // Healthy and due in the same tick. Its capture is the "the throw did not roll
    // back committed work" half: notify runs after every drop has been settled and
    // swept, so if the exception propagated, this drop would already be CAPTURED but
    // the assertion on the `await` below would never be reached.
    const healthyDropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 2,
    });
    await fx.participant({ dropId: healthyDropId, qty: 2 });

    /**
     * Typed from the real interface rather than a hand-written signature.
     *
     * `NotifyPort` is imported as a type, so assigning this object to it is checked
     * against the port `runCutoffTick` actually accepts — a local `{ notify(i:
     * SomeLocalType[]) }` would compile even after the interface changed, which is the
     * blind spot `notify-port.ts` exists to avoid. The error carries a distinctive
     * `name` because the log line records `error.name`, not the message.
     *
     * ## Why it throws selectively, and why that is not a weaker test
     *
     * `notify` is called from **two** places: this phase (once per failed drop) and
     * `settle`'s `deliver` (once per settled drop). A port that threw on every call
     * would log `notification.failed` for each settled drop too — measured: **three**
     * lines on the first run of this test, because the healthy drop and test 1's
     * leftover LOCKED drop both settle and both hit `deliver`. `notification.failed`
     * carries no `dropId` (`run-tick.ts:267-269` — the port is called per drop and the
     * caller's `continue` is the scope), so those three lines are indistinguishable and
     * "exactly one" would be asserting how many other drops happened to be due.
     *
     * Throwing only for the failed drop's batch keeps the assertion attributable. The
     * property under test is unchanged: an exception out of `notify`, wherever it
     * comes from, must not fail the tick.
     */
    class ThrowingNotifyError extends Error {
      override readonly name = 'SyntheticNotifyFailure';
    }
    const batches: (readonly NotifyIntent[])[] = [];
    const throwing: NotifyPort = {
      async notify(intents) {
        batches.push(intents);
        if (intents.some((intent) => intent.dropId === failedDropId)) {
          throw new ThrowingNotifyError('synthetic notify failure');
        }
      },
    };

    // Awaited without a `rejects` wrapper. If the catch at 263-271 were absent the
    // error would escape here and the test would fail on the throw itself, which is
    // the point: the tick must resolve.
    const result = await runCutoffTick({ now: new Date(), port: fakeChargePort(), notify: throwing });

    // The failed drop counts as failed and stays that way.
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const failedRow = await prisma.drop.findUniqueOrThrow({
      where: { id: failedDropId },
      select: { status: true },
    });
    expect(failedRow.status).toBe('FAILED');

    // The healthy drop in the same tick settled and was charged regardless.
    const healthyRow = await prisma.drop.findUniqueOrThrow({
      where: { id: healthyDropId },
      select: { status: true },
    });
    expect(healthyRow.status).toBe('CAPTURED');
    expect(await prisma.order.count({ where: { dropId: healthyDropId } })).toBe(1);

    /**
     * The log line.
     *
     * `notification.failed` carries no `dropId` — it names a reason and nothing else,
     * because the port is called once per drop and the caller's `continue` is the only
     * scope. So the assertion is: exactly one line, and its reason is the thrown
     * error's `name`.
     *
     * The count is global only because the port throws for exactly one batch; the
     * comment on the port explains why that selectivity is load-bearing. Test 1's
     * leftover LOCKED drop is still due on this tick, so a blanket-throwing port would
     * add its own line and the count would be measuring the fixture, not the rule.
     */
    const notifyFailures = logLines.filter((line) => line.event === 'notification.failed');
    expect(notifyFailures).toHaveLength(1);
    expect(notifyFailures[0]?.fields.reason).toBe('SyntheticNotifyFailure');

    // The port was called with the right intent before it threw — without this the test
    // would pass on a port that threw before being handed anything.
    const failedBatch = batches.find((batch) => batch.some((i) => i.dropId === failedDropId));
    expect(failedBatch?.map((intent) => intent.kind)).toEqual(['DROP_FAILED_NO_CHARGE']);

    // The intent is **not** logged as emitted, because the throw skipped the
    // `notification.intent` line at 276-280. That pins the `continue` at 270: without
    // it, the loop would fall through and report a message as sent that was not.
    const failedIntents = logLines.filter(
      (line) => line.event === 'notification.intent' && line.fields.dropId === failedDropId,
    );
    expect(failedIntents).toHaveLength(0);
  });
});

describe('the notification.intent report line', () => {
  /**
   * `run-tick.ts:276-281` is the only assertion that a threshold miss actually told
   * anybody. Its docblock records a real bug it replaced: an earlier draft logged one
   * line for the whole tick under `dropId: 'tick'` — "a fabricated value in a field
   * every other consumer treats as a real identifier, which is exactly the sort of log
   * that sends somebody looking for a drop that does not exist".
   *
   * That bug is now **back** and nothing notices. Measured, each against the full
   * 199-test settlement suite with the tree otherwise clean:
   *
   *   | mutation | suite result |
   *   |---|---|
   *   | `dropId` → `'tick'` (the documented regression, restored verbatim) | **199 passed** |
   *   | `count: intents.length` → `count: 0` | **199 passed** |
   *
   * Why it was invisible: the two tests that mention this line elsewhere in this file
   * (`:281` and `:422`) both assert it is **absent**. Absence is what a skipped drop
   * and a broken report line have in common, so neither can tell them apart. Nothing
   * anywhere asserted the line is present and correct when it should be.
   *
   * ## The trap this test fell into on its first draft
   *
   * The first version used the default port and filtered for
   * `{ kind: 'DROP_FAILED_NO_CHARGE', count: 2 }`. It passed. Then `count: 0` was
   * installed in the tick and **it still passed** — because `noopNotifyPort` logs its
   * own `notification.intent` line per kind, and *that* line computed `count: 2`
   * correctly. A failed drop therefore produces **two** lines with the same `dropId`
   * and `kind` (measured), and a filter broad enough to catch the tick's line also
   * catches the port's, which will vouch for a count the tick got wrong.
   *
   * The fix is to make the tick's line the *only* line: a recording port that logs
   * nothing. The tick logs this line itself, outside `notify()`, so a silent port
   * changes nothing about what is under test and removes the second witness. The
   * duplication itself is not a production concern — the route passes
   * `composingNotifyPort` (`app/api/jobs/cutoff/route.ts`), which sends and does not
   * log here — so it is noted rather than fixed.
   *
   * ## What is at stake
   *
   * FR-506 says every participant hears the outcome; this line is the only per-drop
   * record that the message left. A wrong `dropId` makes the record unattributable —
   * the operator goes looking for a drop `tick`. A wrong `count` makes it a false
   * quantity: `0` says "a batch of nobody was sent", the exact sentence the `continue`
   * at 250-251 exists to prevent.
   */
  it('names the real drop and the real recipient count when a threshold miss is reported', async () => {
    logLines.length = 0;

    // Two diners, a minimum of ten: the drop fails, and the batch is exactly 2.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
    });
    await fx.participant({ dropId, qty: 1 });
    await fx.participant({ dropId, qty: 2 });

    // Logs nothing, so the only `notification.intent` line for this drop is the one
    // the tick writes. See the docblock: with the default port there are two, and the
    // port's own line masks a broken count.
    const silent: NotifyPort = {
      async notify() {
        /* deliberately silent — the assertion is about the caller's report */
      },
    };

    const result = await runCutoffTick({ now: new Date(), port: fakeChargePort(), notify: silent });

    expect(result.failed).toBeGreaterThanOrEqual(1);

    const reported = logLines.filter(
      (line) => line.event === 'notification.intent' && line.fields.dropId === dropId,
    );

    // Exactly one, because one drop failed and one port was handed one batch.
    expect(reported).toHaveLength(1);
    expect(reported[0]?.fields.kind).toBe('DROP_FAILED_NO_CHARGE');
    // The assertion `count: 0` fails.
    expect(reported[0]?.fields.count).toBe(2);

    // And nothing may claim the fabricated identifier. A `'tick'` drop is not a drop,
    // so a line naming one is the bug the docblock describes, whatever else it says.
    const fabricated = logLines.filter(
      (line) => line.event === 'notification.intent' && line.fields.dropId === 'tick',
    );
    expect(fabricated).toHaveLength(0);
  });
});
