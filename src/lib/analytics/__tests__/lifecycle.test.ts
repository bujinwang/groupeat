import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PRD_10_1_EVENTS } from '@/lib/analytics/events';
import {
  aiDraftGenerated,
  assertNoPii,
  captureFailed,
  captureSucceeded,
  dropCancelled,
  dropCreated,
  type FunnelEvent,
  redemptionCompleted,
  redemptionScanned,
  reportViewed,
} from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';

/**
 * §10.1's other eight events — the pure half.
 *
 * `funnel.test.ts` proves the diner funnel's arithmetic. This file proves the
 * eight names that were missing from `src/` entirely: that each builder decides
 * the right event with the right payload, and that none of them smuggles PII into
 * an append-only file nobody can un-write.
 *
 * The assertions are literals, not comparisons against another function in this
 * module. A builder test that asks the builder twice and compares the answers
 * agrees with itself no matter what the event is called.
 *
 * The *wiring* — whether a builder is ever called at the seam — is deliberately
 * not tested here. That is `lifecycle-wiring.test.ts`, which reads the sink after
 * driving the real code paths. These two files fail for different reasons, which
 * is the point of the split.
 */

const PREVIOUSLY_MISSING = [
  'drop_created',
  'drop_cancelled',
  'capture_succeeded',
  'capture_failed',
  'redemption_scanned',
  'redemption_completed',
  'report_viewed',
  'ai_draft_generated',
] as const;

describe('§10.1 is a list of sixteen, and the registry says so', () => {
  it('names all sixteen events exactly once', () => {
    expect(PRD_10_1_EVENTS).toHaveLength(16);
    expect(new Set(PRD_10_1_EVENTS).size).toBe(16);
  });

  it('includes the eight that used to be absent from src/ entirely', () => {
    expect(PREVIOUSLY_MISSING).toHaveLength(8);
    for (const name of PREVIOUSLY_MISSING) {
      expect(PRD_10_1_EVENTS).toContain(name);
    }
  });

  it('still includes the eight the funnel was already emitting', () => {
    for (const name of [
      'drop_published',
      'deal_page_viewed',
      'join_started',
      'join_authorised',
      'join_failed',
      'threshold_reached',
      'drop_locked',
      'drop_failed',
    ]) {
      expect(PRD_10_1_EVENTS).toContain(name);
    }
  });
});

/**
 * Every lifecycle event, built once, so the PII guard can be run over all of them.
 *
 * A tuple rather than `FunnelEvent[]`: this project has `noUncheckedIndexedAccess`,
 * and an array return would make every `allLifecycleEvents()[n]` below a
 * `FunnelEvent | undefined`. The arity is also the assertion — adding a ninth
 * builder without adding it here is a compile error.
 */
function allLifecycleEvents(): readonly [
  FunnelEvent,
  FunnelEvent,
  FunnelEvent,
  FunnelEvent,
  FunnelEvent,
  FunnelEvent,
  FunnelEvent,
  FunnelEvent,
] {
  return [
    dropCreated({
      dropId: 'd-1',
      merchantId: 'm-1',
      menuItemId: 'i-1',
      dealPriceCents: 1250,
      minQty: 4,
      maxQty: 20,
    }),
    dropCancelled({
      dropId: 'd-2',
      merchantId: 'm-1',
      participants: 3,
      voidedAuthorisations: 3,
      pendingVoids: 0,
    }),
    captureSucceeded({
      dropId: 'd-3',
      merchantId: 'm-1',
      participantId: 'p-1',
      qty: 2,
      amountCents: 2500,
    }),
    captureFailed({
      dropId: 'd-4',
      merchantId: 'm-1',
      participantId: 'p-2',
      qty: 1,
      reason: 'card_declined',
    }),
    redemptionScanned({ merchantId: 'm-1' }),
    redemptionCompleted({
      dropId: 'd-5',
      merchantId: 'm-1',
      participantId: 'p-3',
      taken: 2,
      redeemedQty: 2,
      partial: false,
    }),
    reportViewed({ merchantId: 'm-1', dropCount: 6, withheldDropCount: 1 }),
    aiDraftGenerated({
      merchantId: 'm-1',
      itemId: 'i-1',
      aiDraftId: 'a-1',
      surface: 'merchant_builder',
      guardrailPassed: true,
      proposalCount: 3,
      copyRejectedCount: 1,
      source: 'planner',
    }),
  ];
}

describe('the eight builders, as decisions', () => {
  it('drop_created — ids and the deal shape, no title or description', () => {
    const event = allLifecycleEvents()[0];
    expect(event).toEqual({
      event: 'drop_created',
      payload: {
        dropId: 'd-1',
        merchantId: 'm-1',
        menuItemId: 'i-1',
        dealPriceCents: 1250,
        minQty: 4,
        maxQty: 20,
      },
    });
  });

  it('drop_cancelled — counts only, never the merchant reason or the actor', () => {
    const event = allLifecycleEvents()[1];
    expect(event).toEqual({
      event: 'drop_cancelled',
      payload: {
        dropId: 'd-2',
        merchantId: 'm-1',
        participants: 3,
        voidedAuthorisations: 3,
        pendingVoids: 0,
      },
    });
  });

  it('capture_succeeded — no paymentIntentId and no chargeId', () => {
    const event = allLifecycleEvents()[2];
    expect(event).toEqual({
      event: 'capture_succeeded',
      payload: {
        dropId: 'd-3',
        merchantId: 'm-1',
        participantId: 'p-1',
        qty: 2,
        amountCents: 2500,
      },
    });
    expect(Object.keys(event.payload)).not.toContain('paymentIntentId');
  });

  it('capture_failed — the bounded decline code, not a message', () => {
    expect(allLifecycleEvents()[3]).toEqual({
      event: 'capture_failed',
      payload: {
        dropId: 'd-4',
        merchantId: 'm-1',
        participantId: 'p-2',
        qty: 1,
        reason: 'card_declined',
      },
    });
  });

  it('capture_failed — provider text cannot break the request through the PII guard', () => {
    // `assertNoPii` throws on any value containing `@`, and `build()` runs while
    // `record()`'s argument is being evaluated — outside the try/catch that
    // makes `emit()` unable to fail a request. `declineCode` is external text
    // typed as plain `string`, so a provider returning an email-shaped code
    // must not abort settlement's money loop.
    const args = {
      dropId: 'd-4',
      merchantId: 'm-1',
      participantId: 'p-2',
      qty: 1,
      reason: 'declined for diner@example.test — call the bank',
    };
    const make = (): FunnelEvent => captureFailed(args);
    expect(make).not.toThrow();

    const event = make();
    expect(String(event.payload.reason)).not.toContain('@');
    expect(String(event.payload.reason).length).toBeLessThanOrEqual(64);
    expect(() => assertNoPii(event.payload)).not.toThrow();
    // A well-formed code still arrives verbatim.
    expect(captureFailed({ ...args, reason: 'card_declined' }).payload.reason).toBe(
      'card_declined',
    );
  });

  it('redemption_scanned — the merchant, and nothing that looks like a code', () => {
    const event = allLifecycleEvents()[4];
    expect(event).toEqual({ event: 'redemption_scanned', payload: { merchantId: 'm-1' } });
    expect(JSON.stringify(event)).not.toContain('v1.');
  });

  it('redemption_completed — units claimed, with PARTIAL carried as a field', () => {
    expect(allLifecycleEvents()[5]).toEqual({
      event: 'redemption_completed',
      payload: {
        dropId: 'd-5',
        merchantId: 'm-1',
        participantId: 'p-3',
        taken: 2,
        redeemedQty: 2,
        partial: false,
      },
    });
  });

  it('report_viewed — withheld drops are counted, not silently dropped', () => {
    expect(allLifecycleEvents()[6]).toEqual({
      event: 'report_viewed',
      payload: { merchantId: 'm-1', dropCount: 6, withheldDropCount: 1 },
    });
  });

  it('ai_draft_generated — surface and guardrailPassed, in the repo key style', () => {
    const event = allLifecycleEvents()[7];
    expect(event.event).toBe('ai_draft_generated');
    expect(event.payload).toEqual({
      merchantId: 'm-1',
      itemId: 'i-1',
      aiDraftId: 'a-1',
      surface: 'merchant_builder',
      guardrailPassed: true,
      proposalCount: 3,
      copyRejectedCount: 1,
      source: 'planner',
    });
    // §10.1 writes `guardrail_passed` in prose; every other payload key in this
    // sink is camelCase, so this one is too.
    expect(Object.keys(event.payload)).not.toContain('guardrail_passed');
  });
});

describe('PII guard on the whole §10.1 list', () => {
  it('accepts every lifecycle payload', () => {
    for (const event of allLifecycleEvents()) {
      expect(() => assertNoPii(event.payload)).not.toThrow();
    }
  });

  it('still refuses the obvious mistake, and still allows ids', () => {
    expect(() => assertNoPii({ actorEmail: 'someone@example.test' })).toThrow(/PII/);
    expect(() => assertNoPii({ phoneLast4: '1234' })).toThrow(/PII/);
    expect(() => assertNoPii({ participantId: 'p-1', amountCents: 2500 })).not.toThrow();
  });

  it('no payload value looks like an email address', () => {
    for (const event of allLifecycleEvents()) {
      for (const value of Object.values(event.payload)) {
        if (typeof value === 'string') expect(value).not.toContain('@');
      }
    }
  });
});

describe('the sink', () => {
  let dir: string;
  let logPath: string;
  let previousPath: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'groupeat-lifecycle-'));
    logPath = join(dir, 'events.jsonl');
    previousPath = process.env.ANALYTICS_LOG_PATH;
    process.env.ANALYTICS_LOG_PATH = logPath;
  });

  afterAll(() => {
    if (previousPath === undefined) {
      delete process.env.ANALYTICS_LOG_PATH;
    } else {
      process.env.ANALYTICS_LOG_PATH = previousPath;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes each lifecycle event as exactly one JSON line', () => {
    const events = allLifecycleEvents();
    for (const event of events) {
      record(event);
    }

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(events.length);
    const written = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(written.map((row) => row.event)).toEqual(events.map((event) => event.event));
    expect(written[0]).toMatchObject({ event: 'drop_created', dropId: 'd-1' });
    expect(written.every((row) => typeof row.ts === 'string')).toBe(true);
  });
});
