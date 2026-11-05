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
  dealPageViewed,
  dropCancelled,
  dropCreated,
  dropDecided,
  dropPublished,
  type FunnelEvent,
  joinAuthorised,
  joinFailed,
  joinStarted,
  redemptionCompleted,
  redemptionScanned,
  reportViewed,
  thresholdReached,
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
 *
 * The arguments are hoisted into named fixtures so `BUILDERS` below can reuse
 * them: one description of "a plausible `drop_created`", not two that drift.
 */
const DROP_CREATED_ARGS = {
  dropId: 'd-1',
  merchantId: 'm-1',
  menuItemId: 'i-1',
  dealPriceCents: 1250,
  minQty: 4,
  maxQty: 20,
} as const;

const DROP_CANCELLED_ARGS = {
  dropId: 'd-2',
  merchantId: 'm-1',
  participants: 3,
  voidedAuthorisations: 3,
  pendingVoids: 0,
} as const;

const CAPTURE_SUCCEEDED_ARGS = {
  dropId: 'd-3',
  merchantId: 'm-1',
  participantId: 'p-1',
  qty: 2,
  amountCents: 2500,
} as const;

const CAPTURE_FAILED_ARGS = {
  dropId: 'd-4',
  merchantId: 'm-1',
  participantId: 'p-2',
  qty: 1,
  reason: 'card_declined',
} as const;

const REDEMPTION_SCANNED_ARGS = { merchantId: 'm-1' } as const;

const REDEMPTION_COMPLETED_ARGS = {
  dropId: 'd-5',
  merchantId: 'm-1',
  participantId: 'p-3',
  taken: 2,
  redeemedQty: 2,
  partial: false,
} as const;

const REPORT_VIEWED_ARGS = { merchantId: 'm-1', dropCount: 6, withheldDropCount: 1 } as const;

const AI_DRAFT_GENERATED_ARGS = {
  merchantId: 'm-1',
  itemId: 'i-1',
  aiDraftId: 'a-1',
  surface: 'merchant_builder',
  guardrailPassed: true,
  proposalCount: 3,
  copyRejectedCount: 1,
  source: 'planner',
} as const;

// The eight the diner funnel already emitted, before the lifecycle builders
// existed. §10.1 is a list of sixteen, so the guard below has to enumerate the
// whole list rather than only the half this slice added.
const DEAL_PAGE_VIEWED_ARGS = { dropId: 'd-6', merchantId: 'm-1', source: 'direct' } as const;
const JOIN_STARTED_ARGS = { dropId: 'd-7', merchantId: 'm-1', qty: 2 } as const;
const JOIN_AUTHORISED_ARGS = {
  dropId: 'd-8',
  merchantId: 'm-1',
  participantId: 'p-4',
  qty: 2,
  amountCents: 2500,
} as const;
const JOIN_FAILED_ARGS = { dropId: 'd-9', merchantId: 'm-1', reason: 'card_declined' } as const;
const THRESHOLD_REACHED_ARGS = {
  dropId: 'd-10',
  merchantId: 'm-1',
  minQty: 4,
  previousQty: 3,
  currentQty: 5,
} as const;
const DROP_PUBLISHED_ARGS = {
  dropId: 'd-11',
  merchantId: 'm-1',
  dealPriceCents: 1250,
  minQty: 4,
  maxQty: 20,
} as const;
const DROP_DECIDED_ARGS = {
  dropId: 'd-12',
  merchantId: 'm-1',
  joinedQty: 5,
  minQty: 4,
} as const;

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
    dropCreated(DROP_CREATED_ARGS),
    dropCancelled(DROP_CANCELLED_ARGS),
    captureSucceeded(CAPTURE_SUCCEEDED_ARGS),
    captureFailed(CAPTURE_FAILED_ARGS),
    redemptionScanned(REDEMPTION_SCANNED_ARGS),
    redemptionCompleted(REDEMPTION_COMPLETED_ARGS),
    reportViewed(REPORT_VIEWED_ARGS),
    aiDraftGenerated(AI_DRAFT_GENERATED_ARGS),
  ];
}

/**
 * Two of the sixteen builders can decline to produce an event at all.
 * `thresholdReached` returns `null` when the crossing did not happen, and
 * `dealPageViewEvent` — not used here — filters fetchers. A builder that returns
 * `null` for the arguments below is a defect in the builder, so this turns it
 * into a test failure with the event's name in the message rather than a
 * `Cannot read properties of null`.
 */
function requireEvent(event: FunnelEvent | null, name: string): FunnelEvent {
  if (event === null) {
    throw new Error(`the builder for ${name} returned null for these arguments`);
  }
  return event;
}

/**
 * §10.1's sixteen names, each mapped to the builder that is supposed to produce it.
 *
 * ## Why this map exists at all
 *
 * The assertions above it check that the *list* has sixteen entries, that it has
 * no duplicates, and that it contains the eight names this slice was about. All
 * three can be true while nothing in `src/` can produce one of them — which is
 * exactly the defect that let eight names go missing: a union cannot be
 * enumerated, so "is every name emitted somewhere" was not a question the old
 * test could ask. This map is the missing question, asked in a form TypeScript
 * can check.
 *
 * ## Why the `satisfies` and not a plain annotation
 *
 * `satisfies Record<(typeof PRD_10_1_EVENTS)[number], () => FunnelEvent>` makes
 * the compiler reject a **missing** key (a name with no builder) and an **extra**
 * key (a builder for a name the PRD does not require). An annotation of the same
 * type would widen each value to `() => FunnelEvent` and lose the excess-property
 * check; `satisfies` keeps the literal object type alongside the constraint.
 *
 * ## Why the loop below is still needed
 *
 * `satisfies` proves the *keys* are complete and legal. It cannot prove a key
 * points at the right builder: the keys are author-declared, so
 * `drop_created: () => dropCancelled(DROP_CANCELLED_ARGS)` type-checks — both
 * return `FunnelEvent`. Only calling each builder and comparing the event it
 * produced against the key it was filed under catches that swap, which is what
 * `for (const [name, build] of …) expect(build().event).toBe(name)` does.
 *
 * What this does **not** prove is that each builder is *called* at a seam. That
 * is `lifecycle-wiring.test.ts`, which drives the real code paths and reads the
 * sink — a separate file precisely because it can fail for a different reason.
 */
const BUILDERS = {
  drop_created: () => dropCreated(DROP_CREATED_ARGS),
  drop_published: () => dropPublished(DROP_PUBLISHED_ARGS),
  drop_cancelled: () => dropCancelled(DROP_CANCELLED_ARGS),
  deal_page_viewed: () => dealPageViewed(DEAL_PAGE_VIEWED_ARGS),
  join_started: () => joinStarted(JOIN_STARTED_ARGS),
  join_authorised: () => joinAuthorised(JOIN_AUTHORISED_ARGS),
  join_failed: () => joinFailed(JOIN_FAILED_ARGS),
  threshold_reached: () =>
    requireEvent(thresholdReached(THRESHOLD_REACHED_ARGS), 'threshold_reached'),
  // One builder, two names: `dropDecided` picks the event from the outcome, so
  // both names need their own entry or one of the two would be unrepresented.
  drop_locked: () => dropDecided({ ...DROP_DECIDED_ARGS, outcome: 'LOCKED' }),
  drop_failed: () => dropDecided({ ...DROP_DECIDED_ARGS, outcome: 'FAILED' }),
  capture_succeeded: () => captureSucceeded(CAPTURE_SUCCEEDED_ARGS),
  capture_failed: () => captureFailed(CAPTURE_FAILED_ARGS),
  redemption_scanned: () => redemptionScanned(REDEMPTION_SCANNED_ARGS),
  redemption_completed: () => redemptionCompleted(REDEMPTION_COMPLETED_ARGS),
  report_viewed: () => reportViewed(REPORT_VIEWED_ARGS),
  ai_draft_generated: () => aiDraftGenerated(AI_DRAFT_GENERATED_ARGS),
} satisfies Record<(typeof PRD_10_1_EVENTS)[number], () => FunnelEvent>;

describe('every §10.1 name has a builder, and the builder produces that name', () => {
  it('the builder map is exactly the sixteen names, so a name cannot exist without one', () => {
    // Set equality in both directions: a name in the PRD list but not in the map
    // is an event nothing can emit (the original defect); a key in the map but
    // not in the list means this file is testing a name §10.1 no longer requires.
    expect(new Set(Object.keys(BUILDERS))).toEqual(new Set(PRD_10_1_EVENTS));
  });

  it('each builder produces the event it is filed under', () => {
    // Keys are author-declared, so a copy-pasted builder body still compiles.
    // Calling each one is the only way to see that `report_viewed` is not, in
    // fact, emitting `ai_draft_generated`.
    for (const [name, build] of Object.entries(BUILDERS)) {
      expect(build().event).toBe(name);
    }
  });

  it('and produces it with a non-empty payload', () => {
    // A builder that returned `{ event, payload: {} }` would pass the loop above
    // while carrying no metrics at all. §10.1's payloads are all non-empty by
    // design — every one of them is at least an id or a count.
    for (const [name, build] of Object.entries(BUILDERS)) {
      expect(Object.keys(build().payload).length, name).toBeGreaterThan(0);
    }
  });
});

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
