import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeJoinPaymentPort } from '@/lib/join/fake-payment-port';
import { joinDrop } from '@/lib/join/service';
import { JoinProviderUnavailableError } from '@/lib/join/payment-port';
import type { NotifyIntent, NotifyPort } from '@/lib/settlement/notify-port';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * ADR-003's copy obligation, actually emitted — from a real join.
 *
 * ## Why this file exists
 *
 * `notify-port.ts` declared `THRESHOLD_REACHED_STILL_FILLING` in an earlier slice and
 * deliberately gave it no emitter, on the stated grounds that the declaration would be
 * visible to whoever wrote the join path. This is the test that the join path now does
 * the thing it was told about — and, just as importantly, does it **once**.
 *
 * ## The property that matters
 *
 * A drop with a 2-plate minimum and 20 people joining it must produce one message, not
 * nineteen. Repeats are not a cosmetic problem: "you're in, still filling" sent after
 * every subsequent join is an SMS channel the diner mutes, which destroys the one
 * channel FR-408 depends on. So the assertion is not "a message was sent" but "a
 * message was sent exactly once, on the join that crossed".
 *
 * ## And the one that is easy to lose
 *
 * Notification must never fail a join. A provider timeout after the card is held would
 * otherwise 503 a diner whose authorisation succeeded — the worst of both answers. The
 * last test makes the port throw and requires the join to still return `ok`.
 */

const PREFIX = `th${Date.now().toString(36).slice(-6)}`;

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;

type Recorder = NotifyPort & { readonly intents: NotifyIntent[]; failNext?: boolean };

function recordingNotify(): Recorder {
  const recorder: Recorder = {
    intents: [],
    async notify(batch) {
      if (recorder.failNext) {
        throw new Error('provider unavailable');
      }
      recorder.intents.push(...batch);
    },
  };
  return recorder;
}

function stillFilling(notify: Recorder, dropId: string) {
  return notify.intents.filter(
    (intent) =>
      intent.kind === 'THRESHOLD_REACHED_STILL_FILLING' && intent.dropId === dropId,
  );
}

async function publishedDrop(minQty: number, maxQty: number) {
  const id = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1112,
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

let phoneSeq = 0;

/**
 * The numbers this file issues, recorded as they are issued.
 *
 * Added because the teardown deleted `ConsentRecord` by prefix and **never deleted
 * `Customer` at all** — sixteen of them per run. That made this file the largest single
 * contributor to the suite's residue, and the reason the leak survived review: a teardown
 * that deletes one table looks like a teardown.
 *
 * Sixteen, not fourteen, and the gap is worth writing down because I counted it wrong
 * first. There are fourteen `phone()` call sites here, but one sits inside the
 * three-iteration loop at "nineteen more joins must not produce nineteen more texts" —
 * so the source reads as fourteen joins and the run performs sixteen. The residue was
 * `+17805559001`–`016`: sixteen rows. A grep told me fourteen, the database told me
 * sixteen, and the loop was the difference. Counting call sites is not counting rows.
 *
 * A set cannot drift from itself, so the builder writes here and the teardown reads
 * here. Do not go back to a `startsWith` filter — see the block note below.
 */
const issuedPhones = new Set<string>();

/**
 * ## Why a prefix filter here deletes another file's rows
 *
 * `attribution.test.ts` mints `+17805559` + **four** digits (`+178055590001`…) and this
 * file mints `+17805559` + **three** (`+17805559001`…). Both start with the same nine
 * characters, so `startsWith('+17805559')` matches both files' rows. Only the pad width
 * distinguishes them, and only if you look at the tail rather than the head.
 *
 * Writing this down because I got the ownership backwards first. When the gate reported
 * sixteen leftover customers in this block I attributed them to `attribution`, reasoning
 * that the shared block belonged to whichever file claimed more of it. The pad width
 * settled it: all sixteen were three digits, so all sixteen were mine, and the fix
 * belonged in this file. There is now a registry in both files, so the shared block is no
 * longer load-bearing — but the next person to reach for a prefix will hit exactly this.
 *
 * If you add a file to this block or a neighbouring one, take a block of your own or
 * match the pad width, and record the choice next to the builder.
 */
function phone(): string {
  phoneSeq += 1;
  const number = `+17805559${String(phoneSeq).padStart(3, '0')}`;
  // Recorded at the moment of issue, not reconstructed at teardown, so a change to the
  // format cannot leave the teardown deleting a range the tests no longer write.
  issuedPhones.add(number);
  return number;
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant('acct_test_threshold');
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  // Every step attempted, and the run still fails if any did. The previous version
  // ended each step `.catch(() => undefined)` and had no `Customer` step at all, which
  // is how a teardown that leaked sixteen rows per run kept passing review.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // `ConsentRecord` has no foreign key to anything, so nothing cascades to it and it
  // must be named. `joinDrop` writes one per consented join.
  await step(() =>
    prisma.consentRecord.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  // The fixtures next: this deletes the drops (cascading participants) and the merchant
  // and item. The order inside `cleanup()` matters for the same reason it does here.
  await step(() => fx.cleanup());

  // Then the customers, which `fx.cleanup()` does NOT reach. It only deletes customers
  // whose ids it minted itself, through `fx.participant()`. Every diner in this file is
  // created by `joinDrop` calling the service's own `tx.customer.upsert`, which the
  // fixtures never see — so this step is the whole fix, and its absence was the leak.
  //
  // It runs after `cleanup()` because `DropParticipant.customer` has no `onDelete`, so
  // it defaults to Restrict: deleting a customer a live participant still references
  // raises `DropParticipant_customerId_fkey`. Verified by attempting it in that order.
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

describe('the still-filling message', () => {
  it('fires once, on the join that crosses, and never again', async () => {
    const drop = await publishedDrop(2, 10);
    const port = fakeJoinPaymentPort();
    const notify = recordingNotify();

    // 1 of 2 — below the minimum, so nothing to say yet.
    const first = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone() },
      { paymentPort: port, notify },
    );
    expect(first.ok).toBe(true);
    expect(stillFilling(notify, drop.id)).toHaveLength(0);

    // 2 of 2 — this is the crossing.
    const second = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone() },
      { paymentPort: port, notify },
    );
    expect(second.ok).toBe(true);
    expect(stillFilling(notify, drop.id)).toHaveLength(1);

    // Past the minimum. Nineteen more joins must not produce nineteen more texts.
    for (let i = 0; i < 3; i += 1) {
      const more = await joinDrop(
        { publicCode: drop.publicCode, qty: 1, phone: phone() },
        { paymentPort: port, notify },
      );
      expect(more.ok).toBe(true);
    }
    expect(stillFilling(notify, drop.id)).toHaveLength(1);
  });

  it('addresses the diner who crossed, with their own quantity and the real cutoff', async () => {
    const drop = await publishedDrop(3, 10);
    const port = fakeJoinPaymentPort();
    const notify = recordingNotify();

    await joinDrop({ publicCode: drop.publicCode, qty: 2, phone: phone() }, { paymentPort: port, notify });
    const crossing = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone() },
      { paymentPort: port, notify },
    );
    expect(crossing.ok).toBe(true);

    const [intent] = stillFilling(notify, drop.id);
    expect(intent).toBeDefined();

    // The recipient is the diner whose join crossed — not the first joiner, and not
    // everybody. Sending it to all participants would be the same repeat problem
    // spread across people.
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: drop.id },
      select: { cutoffAt: true },
    });
    expect(intent).toMatchObject({
      kind: 'THRESHOLD_REACHED_STILL_FILLING',
      dropId: drop.id,
      participantId: crossing.ok ? crossing.participantId : 'unreachable',
      qty: 1,
    });
    expect(intent && 'cutoffAt' in intent ? intent.cutoffAt : null).toEqual(row.cutoffAt);
  });

  it('addresses the crossing diner at their own phone, not the first joiner\'s', async () => {
    /**
     * `join/service.ts:877-884` builds `THRESHOLD_REACHED_STILL_FILLING` with
     * `phone: phone.e164`. The test above pins `kind`, `dropId`, `participantId`,
     * `qty` and `cutoffAt` via `toMatchObject` — **but never `phone`**. A field-class
     * full-suite sweep (200 files / 2654 tests) replaced `phone` with
     * `'+15550000000'` in all four remaining constructors at once and the whole suite
     * stayed green (`EXIT=0`). The recipient of the only message ADR-003 obliges us to
     * send was therefore not asserted anywhere.
     *
     * Two diners, ground truth from the participant row the crossing join created, so
     * a constant, the first joiner's number, and an empty value all fail.
     */
    const drop = await publishedDrop(3, 10);
    const port = fakeJoinPaymentPort();
    const notify = recordingNotify();

    const firstPhone = phone();
    await joinDrop({ publicCode: drop.publicCode, qty: 2, phone: firstPhone }, { paymentPort: port, notify });
    const crossingPhone = phone();
    const crossing = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: crossingPhone },
      { paymentPort: port, notify },
    );
    expect(crossing.ok).toBe(true);
    if (!crossing.ok) {
      throw new Error('the crossing join must succeed for this assertion to mean anything');
    }

    const [intent] = stillFilling(notify, drop.id);
    expect(intent, 'the crossing join must emit exactly one still-filling intent').toBeDefined();

    const participant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: crossing.participantId },
      select: { id: true, customer: { select: { phone: true } } },
    });
    expect(participant.customer.phone).toBe(crossingPhone);
    expect(crossingPhone).not.toBe(firstPhone);
    expect(intent?.phone, 'the message must go to the diner who crossed').toBe(participant.customer.phone);
    expect(intent?.phone).not.toBe(firstPhone);
    expect(intent?.phone).not.toBe('+15550000000');
  });

  it('does not fire when the drop was already over its minimum', async () => {
    // Someone joining a drop that already has 5 of 3 plates is not a crossing, and
    // telling them "this needs 3 people" would be false on its face.
    const drop = await publishedDrop(1, 10);
    const port = fakeJoinPaymentPort();
    const notify = recordingNotify();

    // minQty 1, so the very first join crosses.
    await joinDrop({ publicCode: drop.publicCode, qty: 1, phone: phone() }, { paymentPort: port, notify });
    expect(stillFilling(notify, drop.id)).toHaveLength(1);

    await joinDrop({ publicCode: drop.publicCode, qty: 2, phone: phone() }, { paymentPort: port, notify });
    expect(stillFilling(notify, drop.id)).toHaveLength(1);
  });

  it('does not fire for a join whose authorisation never resolved', async () => {
    // The plate is held but nobody knows whether it is paid. `thresholdReached` counts
    // AUTHORIZED plates only, so a crossing cannot be claimed on a card that has not
    // answered — and the diner must not be told the drop is going ahead.
    const drop = await publishedDrop(2, 10);
    const notify = recordingNotify();

    const ok = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone() },
      { paymentPort: fakeJoinPaymentPort(), notify },
    );
    expect(ok.ok).toBe(true);

    const unavailable = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone() },
      {
        notify,
        paymentPort: {
          async createJoinAuthorisation() {
            throw new JoinProviderUnavailableError('timeout', 'the provider did not answer');
          },
        },
      },
    );
    expect(unavailable.ok).toBe(false);
    expect(stillFilling(notify, drop.id)).toHaveLength(0);
  });

  it('does not fire for a replayed join', async () => {
    // The same diner submitting twice is `alreadyJoined`. It must not produce a second
    // courtesy message, even in the rare case where it is the call that happens to
    // observe the crossing.
    const drop = await publishedDrop(2, 10);
    const port = fakeJoinPaymentPort();
    const notify = recordingNotify();
    const number = phone();

    await joinDrop({ publicCode: drop.publicCode, qty: 1, phone: number }, { paymentPort: port, notify });
    await joinDrop({ publicCode: drop.publicCode, qty: 1, phone: phone() }, { paymentPort: port, notify });
    const before = stillFilling(notify, drop.id).length;

    const replay = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: number },
      { paymentPort: port, notify },
    );
    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.alreadyJoined).toBe(true);
    expect(stillFilling(notify, drop.id)).toHaveLength(before);
  });

  it('still completes the join when the notifier throws', async () => {
    // FR-404's whole point is that the hold is the product. A courtesy SMS that fails
    // must not turn a successful authorisation into an error the diner sees — their
    // card is held either way, and a 503 here would be a lie about the money.
    const drop = await publishedDrop(2, 10);
    const port = fakeJoinPaymentPort();
    const notify = recordingNotify();
    notify.failNext = true;

    await joinDrop({ publicCode: drop.publicCode, qty: 1, phone: phone() }, { paymentPort: port, notify });

    const crossing = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone() },
      { paymentPort: port, notify },
    );

    expect(crossing.ok).toBe(true);

    // And the money side really did happen: the row is AUTHORIZED with a hold at the
    // provider, not merely a row that says so.
    expect(
      await prisma.dropParticipant.count({
        where: { dropId: drop.id, authStatus: 'AUTHORIZED' },
      }),
    ).toBe(2);
    expect(port.authorisedCount()).toBe(2);
  });

  it('defaults to a no-op port when none is supplied', async () => {
    // Every existing caller — the route, the tests, a future job — omits `notify`. The
    // default must not throw and must not require a provider to be configured.
    const drop = await publishedDrop(1, 10);

    const result = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone() },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(true);
  });
});
