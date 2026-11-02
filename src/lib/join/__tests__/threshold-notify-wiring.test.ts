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
function phone(): string {
  phoneSeq += 1;
  return `+17805559${String(phoneSeq).padStart(3, '0')}`;
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant('acct_test_threshold');
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await prisma.consentRecord
    .deleteMany({ where: { phone: { startsWith: '+17805559' } } })
    .catch(() => undefined);
  await fx.cleanup();
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
