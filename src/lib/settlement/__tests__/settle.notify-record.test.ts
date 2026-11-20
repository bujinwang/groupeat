/**
 * The settle layer's notification record, on the **shipped** port shape.
 *
 * ## The hole this closes
 *
 * `notification.intent` was emitted only by a port: `noopNotifyPort` counts for its own
 * reasons, and `composingNotifyPort` logs one line per batch **in dry run only**
 * (`compose-port.ts:113-121`). Production wires `composingNotifyPort` with a live sender
 * and `dryRun` off — which sends the messages and logs nothing. Measured on that shape,
 * before the fix:
 *
 *   | path                          | real port | noop port |
 *   |-------------------------------|-----------|-----------|
 *   | `settle` capture               | **0**     | 1         |
 *   | `settle` fail (tolerance)      | **0**     | 1         |
 *   | `run-tick` phase 8 (threshold) | 1         | **2**     |
 *
 * Every existing test passed a recording port or the noop, so the shipped configuration
 * was never measured: a real refund/capture batch produced messages and left no record
 * that it had, while a threshold miss was recorded twice.
 *
 * ## What is asserted
 *
 * With a silent port — the honest stand-in for "delivered, wrote no log", which is
 * exactly what a configured `composingNotifyPort` does — `settle` must still emit one
 * `notification.intent` line per (kind, drop), with the real drop id and the real count.
 * The port cannot be the place that guarantees this, because the port is deployment
 * configuration and the record is not.
 */
import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import type { NotifyIntent, NotifyPort } from '@/lib/settlement/notify-port';
import { settle } from '@/lib/settlement/settle';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * The log capture, `vi.hoisted` because the mock factory runs before module imports.
 * Same shape as `run-tick.integrity.test.ts`.
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

type IntentLine = { kind: string; dropId: string; count: number };

/** The `notification.intent` lines the settle layer wrote for one drop. */
function intentLinesFor(dropId: string): IntentLine[] {
  return logLines
    .filter((line) => line.event === 'notification.intent' && line.fields.dropId === dropId)
    .map((line) => ({
      kind: line.fields.kind as string,
      dropId: line.fields.dropId as string,
      count: line.fields.count as number,
    }));
}

/**
 * A port that delivers and writes no log — the shipped shape.
 *
 * `composingNotifyPort` with a real sender and `dryRun` off behaves exactly like this
 * from the log's point of view: it composes, hands the messages to the provider, and
 * returns. It is not a mock of the port's *contract* (that is `notify-port.ts`'s
 * business); it is a stand-in for the one property that matters here, which is silence.
 */
function silentPort(delivered: NotifyIntent[][]): NotifyPort {
  return {
    async notify(intents: readonly NotifyIntent[]) {
      delivered.push([...intents]);
    },
  };
}

const PREFIX = `nr${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;

let fx: SettlementFixtures;
let merchantId = '';
let itemId = '';

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('settle records what it notified, even when the port is silent', () => {
  it('a FAILED (below capture tolerance) drop logs one DROP_FAILED_* line naming its real participants', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    // Below capture tolerance: `captureToleranceOf(5) = ceil(4.5) = 5`, and this diner
    // holds 2. The capture still happens — tolerance decides the *drop's* fate, not
    // whether a card is charged — and `finaliseFailed` refunds it. So the batch this
    // test reads is `DROP_FAILED_REFUNDED`, not a never-charged one.
    const participantId = await fx.participant({ dropId, qty: 2, platformFeeCents: 0 });

    const delivered: NotifyIntent[][] = [];
    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort(),
      notify: silentPort(delivered),
    });

    expect(outcome.kind).toBe('FAILED');

    // The port was handed the message — the diner is told either way.
    const batch = delivered.find((candidate) =>
      candidate.some((intent) => intent.dropId === dropId),
    );
    expect(batch, 'the failed batch must reach the port').toBeDefined();
    expect(batch!.map((intent) => intent.participantId)).toContain(participantId);

    // And the settle layer recorded it, which the port does not do on the shipped shape.
    const lines = intentLinesFor(dropId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.kind).toMatch(/^DROP_FAILED_/);
    // The real drop id, never a fabricated one — see `run-tick.ts:272-275`.
    expect(lines[0]!.dropId).toBe(dropId);
    expect(lines[0]!.count).toBe(1);
  });

  it('a CAPTURED drop logs one DROP_CONFIRMED_CHARGED line for its diners', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 5 });

    const delivered: NotifyIntent[][] = [];
    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort(),
      notify: silentPort(delivered),
      baseUrl: 'https://groupeat.test',
    });

    expect(outcome.kind).toBe('CAPTURED');

    const lines = intentLinesFor(dropId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.kind).toBe('DROP_CONFIRMED_CHARGED');
    expect(lines[0]!.dropId).toBe(dropId);
    expect(lines[0]!.count).toBe(1);
  });

  it('reports one line per (kind, drop) when a failed drop splits charge and refund', async () => {
    // A drop that both captured some participants and failed gets two kinds in one
    // batch — `DROP_FAILED_REFUNDED` for the charged diners and `DROP_FAILED_NO_CHARGE`
    // for the rest. Grouping must not merge them into one line, and must not emit one
    // per participant either.
    //
    // The arithmetic has to be deliberate: `captureToleranceOf(minQty) = ceil(0.9 ×
    // minQty)`, so `minQty: 10` sets the bar at **9**. One diner holding 2 is captured
    // (2 < 9, so the drop fails) and then refunded; one diner's card is *declined*, so
    // its charge is `FAILED` and it is never charged at all.
    //
    // The declined diner is the only way to get the second kind. `readParticipants`
    // (cutoff-decision.ts) admits `authStatus = 'AUTHORIZED'` **or** rows with charge
    // activity, so a diner whose authorisation simply failed is not in the locked set
    // at all and no intent can be built for them.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 10,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 2 });
    const declinedId = await fx.participant({ dropId, qty: 1 });

    const delivered: NotifyIntent[][] = [];
    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort({ declineParticipantIds: [declinedId] }),
      notify: silentPort(delivered),
    });

    expect(outcome.kind).toBe('FAILED');

    const lines = intentLinesFor(dropId);
    // One line per kind, not one per participant. Asserted exactly rather than
    // "≤ 2", so a batch that lost the refunded half would fail here.
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.kind).sort()).toEqual([
      'DROP_FAILED_NO_CHARGE',
      'DROP_FAILED_REFUNDED',
    ]);
    // Each line's count adds up to the number of diners told.
    const totalReported = lines.reduce((sum, line) => sum + line.count, 0);
    const totalDelivered = delivered
      .flat()
      .filter((intent) => intent.dropId === dropId).length;
    expect(totalReported).toBe(totalDelivered);
    expect(totalDelivered).toBe(2);
  });

  it('writes no report line when the port throws — a message that was not sent is not reported', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 5,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    await fx.participant({ dropId, qty: 5 });

    const throwing: NotifyPort = {
      async notify() {
        throw new Error('sender exploded');
      },
    };

    // Notification must never fail settlement (§3.5).
    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort(),
      notify: throwing,
    });
    expect(outcome.kind).toBe('CAPTURED');

    // The throw skipped the report line: claiming a message was sent when it was not is
    // the defect `run-tick`'s phase-8 test pins with its own `continue`.
    expect(intentLinesFor(dropId)).toHaveLength(0);
    // And the failure itself is still visible.
    expect(
      logLines.some(
        (line) => line.event === 'notification.failed' && line.fields.reason === 'Error',
      ),
    ).toBe(true);
  });
});
