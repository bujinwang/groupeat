/**
 * The notification record at the **cancel**, **force-fail** and **join** seams, on the
 * shipped port shape.
 *
 * ## The hole this closes
 *
 * `notification.intent` was emitted only by a port, and the shipped configuration —
 * `composingNotifyPort` with a live sender and `dryRun` off — sends its messages and
 * logs nothing. Settlement's two finalise paths were fixed first, in a private
 * `deliver`. That fix did **not** reach these two, and the defect was still live here:
 * measured against a real drop with a silent-but-delivering port,
 *
 *   | site | delivered | `notification.intent` lines |
 *   |---|---|---|
 *   | `cancelDrop` | 1 | **0** |
 *   | `forceFailDrop` | 1 | **0** |
 *
 * A merchant cancelled a drop, every diner's hold was released, every diner was texted,
 * and the log carried no record that anyone had been told. `cancelDrop`'s own
 * `CancelOutcome` even reports `notifiedParticipants: 1` — the number was known and
 * never recorded.
 *
 * ## What is asserted
 *
 * Against a silent port — the honest stand-in for "delivered, wrote no log" — each path
 * must log exactly one line per (kind, drop), naming the real drop id and the real
 * count, and the batch must actually reach the port. The second half matters: an
 * assertion that only reads the log passes on a build that logs and sends nothing.
 */
import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { forceFailDrop } from '@/lib/admin/force-fail';
import { prisma } from '@/lib/db/prisma';
import { cancelDrop } from '@/lib/drops/cancel';
import { fakeJoinPaymentPort } from '@/lib/join/fake-payment-port';
import { joinDrop } from '@/lib/join/service';
import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import type { NotifyIntent, NotifyPort } from '@/lib/settlement/notify-port';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/** The log capture, `vi.hoisted` because the mock factory runs before module imports. */
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

type Recorded = { intents: NotifyIntent[][]; count: number };

/**
 * A port that delivers and writes no log — the shipped shape.
 *
 * `composingNotifyPort` with a real sender and `dryRun` off does exactly this from the
 * log's point of view. It is not a mock of the port's contract; it is a stand-in for the
 * one property that matters here, which is silence.
 */
function silentPort(recorded: Recorded): NotifyPort {
  return {
    async notify(intents: readonly NotifyIntent[]) {
      recorded.intents.push([...intents]);
      recorded.count += intents.length;
    },
  };
}

function fresh(): Recorded {
  return { intents: [], count: 0 };
}

const PREFIX = `nx${Date.now().toString(36).slice(-6)}`;

let fx: SettlementFixtures;
let merchantId = '';
let itemId = '';
let actor: { userId: string; email: string };

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
  // A real `User` row: `AuditLog.actorUserId` is a foreign key, so a made-up id would
  // fail on the audit write rather than on the notification this test is about.
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-actor@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ADMIN',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  actor = { userId: user.id, email: `${PREFIX}-actor@example.test` };
});

afterAll(async () => {
  await fx.cleanup();
  if (actor) await prisma.user.deleteMany({ where: { id: actor.userId } });
});

/** A `PUBLISHED`, still-filling drop with one held diner, and its confirmation code. */
async function publishedDropWithOneDiner(): Promise<{ dropId: string; publicCode: string }> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1112,
    minQty: 3,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 3_600_000),
  });
  await fx.participant({ dropId, qty: 1 });
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: { publicCode: true },
  });
  return { dropId, publicCode: row.publicCode };
}

function intentLinesFor(dropId: string): { kind: string; dropId: string; count: number }[] {
  return logLines
    .filter((line) => line.event === 'notification.intent' && line.fields.dropId === dropId)
    .map((line) => ({
      kind: line.fields.kind as string,
      dropId: line.fields.dropId as string,
      count: line.fields.count as number,
    }));
}

describe('a cancelled drop records what it told its diners', () => {
  it('writes one DROP_CANCELLED_NO_CHARGE line naming the real drop and count', async () => {
    logLines.length = 0;
    const { dropId, publicCode } = await publishedDropWithOneDiner();
    const recorded = fresh();

    const outcome = await cancelDrop({
      merchantIds: [merchantId],
      dropId,
      confirmPublicCode: publicCode,
      reason: 'kitchen closed',
      port: fakeChargePort(),
      notify: silentPort(recorded),
      actor,
    });

    expect(outcome.kind).toBe('CANCELLED');

    // The message reached the port — without this the assertions below would pass on a
    // build that logged a line and sent nothing at all.
    expect(recorded.count).toBe(1);
    expect(recorded.intents.flat().map((intent) => intent.dropId)).toContain(dropId);

    const lines = intentLinesFor(dropId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.kind).toBe('DROP_CANCELLED_NO_CHARGE');
    expect(lines[0]!.dropId).toBe(dropId);
    expect(lines[0]!.count).toBe(1);
    // `CancelOutcome` already reported this number; the log now agrees with it.
    expect(outcome.notifiedParticipants).toBe(1);
  });

  it('writes no report line when the port throws, and still cancels the drop', async () => {
    logLines.length = 0;
    const { dropId, publicCode } = await publishedDropWithOneDiner();

    const throwing: NotifyPort = {
      async notify() {
        throw new Error('sender exploded');
      },
    };

    // Notification must never fail the cancellation (§3.5).
    const outcome = await cancelDrop({
      merchantIds: [merchantId],
      dropId,
      confirmPublicCode: publicCode,
      reason: 'kitchen closed',
      port: fakeChargePort(),
      notify: throwing,
      actor,
    });

    expect(outcome.kind).toBe('CANCELLED');
    expect(intentLinesFor(dropId)).toHaveLength(0);
    expect(
      logLines.some(
        (line) => line.event === 'notification.failed' && line.fields.reason === 'Error',
      ),
    ).toBe(true);
  });
});

describe('a force-failed drop records what it told its diners', () => {
  it('writes one DROP_CANCELLED_NO_CHARGE line naming the real drop and count', async () => {
    logLines.length = 0;
    const { dropId, publicCode } = await publishedDropWithOneDiner();
    const recorded = fresh();

    const outcome = await forceFailDrop({
      dropId,
      confirmPublicCode: publicCode,
      reason: 'supplier cancelled',
      port: fakeChargePort(),
      notify: silentPort(recorded),
      actor,
    });

    expect(outcome.kind).toBe('CANCELLED');

    expect(recorded.count).toBe(1);
    expect(recorded.intents.flat().map((intent) => intent.dropId)).toContain(dropId);

    const lines = intentLinesFor(dropId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.kind).toBe('DROP_CANCELLED_NO_CHARGE');
    expect(lines[0]!.dropId).toBe(dropId);
    expect(lines[0]!.count).toBe(1);
  });

  it('writes no report line when the port throws, and still force-fails the drop', async () => {
    logLines.length = 0;
    const { dropId, publicCode } = await publishedDropWithOneDiner();

    const throwing: NotifyPort = {
      async notify() {
        throw new Error('sender exploded');
      },
    };

    const outcome = await forceFailDrop({
      dropId,
      confirmPublicCode: publicCode,
      reason: 'supplier cancelled',
      port: fakeChargePort(),
      notify: throwing,
      actor,
    });

    expect(outcome.kind).toBe('CANCELLED');
    expect(intentLinesFor(dropId)).toHaveLength(0);
    expect(
      logLines.some(
        (line) => line.event === 'notification.failed' && line.fields.reason === 'Error',
      ),
    ).toBe(true);
  });
});

describe('a threshold-crossing join records what it told the diner', () => {
  it('writes one THRESHOLD_REACHED_STILL_FILLING line naming the real drop', async () => {
    logLines.length = 0;
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1112,
      minQty: 2,
      maxQty: 10,
      status: 'PUBLISHED',
      cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
      windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
    });
    const publicCode = (
      await prisma.drop.findUniqueOrThrow({ where: { id: dropId }, select: { publicCode: true } })
    ).publicCode;

    const recorded = fresh();
    const port = fakeJoinPaymentPort();

    // 1 of 2 — nothing to say.
    const first = await joinDrop(
      { publicCode, qty: 1, phone: '+17807776001' },
      { paymentPort: port, notify: silentPort(recorded) },
    );
    expect(first.ok).toBe(true);
    expect(intentLinesFor(dropId)).toHaveLength(0);

    // 2 of 2 — the crossing.
    const second = await joinDrop(
      { publicCode, qty: 1, phone: '+17807776002' },
      { paymentPort: port, notify: silentPort(recorded) },
    );
    expect(second.ok).toBe(true);

    // The message reached the port.
    expect(recorded.intents.flat().map((i) => i.kind)).toContain(
      'THRESHOLD_REACHED_STILL_FILLING',
    );

    const lines = intentLinesFor(dropId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.kind).toBe('THRESHOLD_REACHED_STILL_FILLING');
    expect(lines[0]!.dropId).toBe(dropId);
    expect(lines[0]!.count).toBe(1);
  });
});
