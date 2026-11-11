/**
 * `noopNotifyPort` is the default `NotifyPort` in three production paths
 * (`settle.ts`, `run-tick.ts`, `join/service.ts`). Its only job is to log
 * `notification.intent` lines `{ kind, dropId, count }` — counts only, never a
 * phone or code — so a tick that settles 40 participants writes a handful of
 * lines, not forty.
 *
 * The grouping key is `${kind}:${dropId}`. That key is a *decision*: a regression
 * that drops `dropId` would merge two different drops' intents under one line and
 * misattribute the count. Measured before this test existed: mutating the key to
 * `${kind}` alone left the full settlement suite (208 tests) green — the grouping
 * was a dark line. These cases pin it.
 *
 * No database: `noopNotifyPort` is pure, so we capture its log lines by spying on
 * `logger.info` and inspecting `notification.intent` calls.
 */
import { vi, describe, it, expect, beforeEach, afterEach, type MockInstance } from 'vitest';
import { logger } from '@/lib/logging/logger';
import { noopNotifyPort, type NotifyIntent } from '@/lib/settlement/notify-port';

let spy: MockInstance;

type IntentLine = { kind: string; dropId: string; count: number };

function lines(): IntentLine[] {
  return spy.mock.calls
    .filter((call) => call[0] === 'notification.intent')
    .map((call) => {
      const fields = call[1] as Record<string, unknown>;
      return {
        kind: fields.kind as string,
        dropId: fields.dropId as string,
        count: fields.count as number,
      };
    });
}

function noCharge(dropId: string, participantId: string): NotifyIntent {
  return {
    kind: 'DROP_FAILED_NO_CHARGE',
    dropId,
    participantId,
    phone: '+15550000000',
    qty: 1,
  };
}

function cancelledNoCharge(dropId: string, participantId: string): NotifyIntent {
  return {
    kind: 'DROP_CANCELLED_NO_CHARGE',
    dropId,
    participantId,
    phone: '+15550000000',
    qty: 1,
  };
}

beforeEach(() => {
  spy = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('noopNotifyPort grouping', () => {
  it('keeps intents for different drops in separate lines under the same kind', async () => {
    const port = noopNotifyPort();
    const dropA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const dropB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    await port.notify([
      noCharge(dropA, 'p1'),
      noCharge(dropB, 'p2'),
      noCharge(dropA, 'p3'),
    ]);

    const out = lines();
    expect(out).toHaveLength(2);
    const a = out.find((l) => l.dropId === dropA);
    const b = out.find((l) => l.dropId === dropB);
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
    expect(a?.kind).toBe('DROP_FAILED_NO_CHARGE');
    expect(b?.kind).toBe('DROP_FAILED_NO_CHARGE');
  });

  it('merges same-kind, same-drop intents into one line carrying the right count', async () => {
    const port = noopNotifyPort();
    const drop = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    await port.notify([
      noCharge(drop, 'p1'),
      noCharge(drop, 'p2'),
      noCharge(drop, 'p3'),
      noCharge(drop, 'p4'),
    ]);

    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: 'DROP_FAILED_NO_CHARGE',
      dropId: drop,
      count: 4,
    });
  });

  it('keeps different kinds separate even when they share a dropId', async () => {
    const port = noopNotifyPort();
    const drop = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

    await port.notify([
      noCharge(drop, 'p1'),
      cancelledNoCharge(drop, 'p2'),
    ]);

    const out = lines();
    expect(out).toHaveLength(2);
    const kinds = out.map((l) => l.kind).sort();
    expect(kinds).toEqual(['DROP_CANCELLED_NO_CHARGE', 'DROP_FAILED_NO_CHARGE']);
    for (const line of out) {
      expect(line.dropId).toBe(drop);
      expect(line.count).toBe(1);
    }
  });
});
