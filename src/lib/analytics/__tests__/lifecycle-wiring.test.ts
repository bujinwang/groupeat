import 'dotenv/config';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildDealProposals } from '@/lib/ai/deal-builder';
import { createUnavailablePort } from '@/lib/ai/port';
import { createDraft } from '@/lib/db/drops';
import { prisma } from '@/lib/db/prisma';
import { cancelDrop } from '@/lib/drops/cancel';
import { redeemCode } from '@/lib/redemption/redeem';
import type { ChargePort } from '@/lib/settlement/charge-port';
import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import { noopNotifyPort } from '@/lib/settlement/notify-port';
import { signRedemptionCode } from '@/lib/settlement/redemption-code';
import { settle } from '@/lib/settlement/settle';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * Do the eight §10.1 events actually fire? Driven through the real seams.
 *
 * ## Why this file exists when `lifecycle.test.ts` is green
 *
 * That file proves each builder produces the right payload. It cannot prove the
 * builder is ever *called*. A `record(...)` line deleted from `createDraft`,
 * placed after an early return in `cancelDrop`, or put inside a retry loop in
 * `settle` would leave every unit test green and the sink empty. This is the same
 * gap `join/__tests__/funnel-wiring.test.ts` was written for, and the same
 * method: redirect `ANALYTICS_LOG_PATH` to a temp file and read the lines back,
 * rather than asserting against a counter in memory.
 *
 * ## The property each test is really about
 *
 * These are state-transition events. A duplicated one does not add noise, it
 * makes a rate exceed 100%. So every test also drives the path a second time —
 * a second cancellation, a second settle tick, a double scan, a second draft —
 * and asserts the count stayed where it should. Deleting an emission and
 * moving one into a retry loop are two different defects; both should fail here.
 *
 * `report_viewed` is the one exception: its seam is a Server Component with a
 * mocked session, so it is wired in the reports page's own render suite.
 */

const PREFIX = `aw${Date.now().toString(36).slice(-6)}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

let merchantId = '';
let itemId = '';
let ownerUserId = '';
let ownerEmail = '';

let dir = '';
let logPath = '';
let previousPath: string | undefined;

/** Drops `createDraft` wrote itself. `fx.cleanup()` only knows its own ids. */
const extraDropIds: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'groupeat-analytics-wiring-'));
  logPath = join(dir, 'events.jsonl');
  previousPath = process.env.ANALYTICS_LOG_PATH;
  process.env.ANALYTICS_LOG_PATH = logPath;

  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);

  const owner = await prisma.merchantUser.findFirstOrThrow({
    where: { merchantId },
    select: { userId: true, user: { select: { email: true } } },
  });
  ownerUserId = owner.userId;
  ownerEmail = owner.user.email;
});

afterAll(async () => {
  // Restore rather than delete: the harness may have set it, and clearing it
  // would make a later file in the same run write to the repo's default path.
  if (previousPath === undefined) {
    delete process.env.ANALYTICS_LOG_PATH;
  } else {
    process.env.ANALYTICS_LOG_PATH = previousPath;
  }
  rmSync(dir, { recursive: true, force: true });

  // `AiDraft.merchantId` is `SetNull`, so deleting the merchant leaves the row
  // behind — and `check-residue.mjs` counts `aiDrafts`. The drafts written by
  // `createDraft` are likewise outside the fixture's id list. All of these must
  // run before `fx.cleanup()`, which deletes the merchant and disconnects.
  //
  // **No `auditLog` delete here, deliberately.** FR-902/FR-904 makes the trail
  // append-only, and `lib/audit/__tests__/audit-append-only.test.ts` scans
  // `__tests__` too: a test that deletes its own audit rows to be repeatable is
  // the exact violation that guard exists to catch. The rows are allowed to
  // accumulate — `check-residue.mjs` lists `auditLogs` as expected-to-grow, and
  // `AuditLog.actorUserId` is `onDelete: SetNull`, so they outlive the fixture's
  // user teardown without blocking it. `cancelDrop` legitimately wrote them.
  //
  // No swallowed delete either: one FK error used to abort the rest of a
  // teardown and leak rows. Run every step, then throw everything that failed.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  await step(() => prisma.aiDraft.deleteMany({ where: { merchantId } }));
  if (extraDropIds.length > 0) {
    await step(() =>
      prisma.ledgerEntry.deleteMany({ where: { dropId: { in: extraDropIds } } }),
    );
    await step(() => prisma.drop.deleteMany({ where: { id: { in: extraDropIds } } }));
  }
  await step(() => fx.cleanup());

  if (failures.length > 0) {
    throw new AggregateError(failures, 'lifecycle-wiring teardown failed');
  }
});

type Row = Record<string, unknown>;

function events(): Row[] {
  try {
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row);
  } catch {
    return [];
  }
}

function named(event: string): Row[] {
  return events().filter((row) => row.event === event);
}

function forDrop(event: string, dropId: string): Row[] {
  return named(event).filter((row) => row.dropId === dropId);
}

describe('drop creation and cancellation', () => {
  it('drop_created fires once per draft, on the attempt that wrote the row', async () => {
    const input = {
      menuItemId: itemId,
      title: `${PREFIX} draft`,
      description: null,
      heroImageUrl: null,
      dealPriceCents: 1250,
      minQty: 4,
      maxQty: 20,
      maxPerCustomer: 4,
      windowStart: new Date(Date.now() + 3 * 60 * 60 * 1000),
      windowEnd: new Date(Date.now() + 5 * 60 * 60 * 1000),
      cutoffAt: new Date(Date.now() + 60 * 60 * 1000),
      aiRationale: null,
    };

    const first = await createDraft([merchantId], input);
    const second = await createDraft([merchantId], { ...input, title: `${PREFIX} draft 2` });
    extraDropIds.push(first.id, second.id);

    expect(named('drop_created')).toHaveLength(2);
    expect(forDrop('drop_created', first.id)).toHaveLength(1);
    expect(forDrop('drop_created', second.id)).toHaveLength(1);
    expect(forDrop('drop_created', first.id)[0]).toMatchObject({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1250,
      minQty: 4,
      maxQty: 20,
    });
  });

  it('drop_cancelled fires once; a refused second cancellation does not fire again', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 2,
      status: 'PUBLISHED',
    });
    const row = await prisma.drop.findUniqueOrThrow({
      where: { id: dropId },
      select: { publicCode: true },
    });

    const args = {
      merchantIds: [merchantId],
      dropId,
      confirmPublicCode: row.publicCode,
      reason: 'Kitchen closed',
      port: fakeChargePort(),
      notify: noopNotifyPort(),
      actor: { userId: ownerUserId, email: ownerEmail },
    };

    const outcome = await cancelDrop(args);
    expect(outcome.kind).toBe('CANCELLED');
    await expect(cancelDrop(args)).rejects.toThrow();

    const rows = forDrop('drop_cancelled', dropId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      merchantId,
      participants: 0,
      voidedAuthorisations: 0,
      pendingVoids: 0,
    });
    // The free-text reason and the actor's email are audit-row material, not
    // analytics material. Asserting their absence is the PII contract.
    expect(rows[0]).not.toHaveProperty('reason');
    expect(rows[0]).not.toHaveProperty('actorEmail');
    expect(rows[0]).not.toHaveProperty('ipAddress');
  });
});

describe('capture outcomes', () => {
  it('capture_succeeded and capture_failed fire per participant, not per tick', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const p1 = await fx.participant({ dropId, qty: 1 });
    const p2 = await fx.participant({ dropId, qty: 1 });
    const p3 = await fx.participant({ dropId, qty: 1 });

    const port = fakeChargePort({ declineParticipantIds: [p3] });
    const outcome = await settle({ dropId, now: new Date(), port });
    expect(outcome.kind).toBe('CAPTURED');

    const succeeded = forDrop('capture_succeeded', dropId);
    const failed = forDrop('capture_failed', dropId);
    expect(succeeded).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect(succeeded.map((row) => row.participantId).sort()).toEqual([p1, p2].sort());
    expect(failed[0]).toMatchObject({
      participantId: p3,
      qty: 1,
      reason: 'card_declined',
      merchantId,
    });
    expect(succeeded[0]).not.toHaveProperty('paymentIntentId');
    expect(succeeded[0]).not.toHaveProperty('chargeId');

    // A settled drop is NOT_LOCKED on the next tick. Money that moved once must
    // not be measured a second time.
    const again = await settle({ dropId, now: new Date(), port });
    expect(again.kind).toBe('NOT_LOCKED');
    expect(forDrop('capture_succeeded', dropId)).toHaveLength(2);
    expect(forDrop('capture_failed', dropId)).toHaveLength(1);
  });

  it('capture_succeeded also fires when a lost write is repaired from an existing Order', async () => {
    // §4.2's lost-write state, built directly: an `Order` exists while the
    // participant is still `NONE`. `recordCapture` writes both in one
    // transaction, so a real crash cannot produce this shape — the fixture is
    // for the defensive repair branch, not a crash replay. `settle.ts` logs the
    // repair as a capture, so analytics must measure it as one too.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const participantId = await fx.participant({ dropId, qty: 2 });
    const participant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { amountCents: true, platformFeeCents: true },
    });

    await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty: 2,
        unitPriceCents: 1000,
        subtotalCents: participant.amountCents,
        platformFeeCents: participant.platformFeeCents,
        stripeChargeId: 'ch_from_the_crash',
      },
    });

    const port = fakeChargePort();
    const outcome = await settle({ dropId, now: new Date(), port });
    expect(outcome.kind).toBe('CAPTURED');
    expect(port.calls.filter((call) => call.kind === 'capture')).toHaveLength(0);

    const rows = forDrop('capture_succeeded', dropId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      participantId,
      qty: 2,
      amountCents: participant.amountCents,
      merchantId,
    });
  });
});

/**
 * Two overlapping cutoff ticks, one charge. Both workers read `chargeStatus =
 * 'NONE'` before either writes, so the database CAS is the only thing that
 * decides which of them owns the fact. An emission outside that CAS makes a
 * §10.2 rate exceed 100% for money that moved once — a defect no single-worker
 * test can see, and the one an independent review of this slice found.
 *
 * Both fixtures are deterministic stand-ins for the winning worker. A
 * `Promise.all` of two real `settle()` calls is not: the loser can finish before
 * the winner starts, in which case it never reaches the code under test and the
 * test passes with the bug present.
 */
describe('capture outcomes when another worker wins the CAS', () => {
  it('a worker that loses NONE→FAILED does not report a second decline', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const participantId = await fx.participant({ dropId, qty: 1 });
    const base = fakeChargePort({ declineParticipantIds: [participantId] });

    // While we wait on the provider, the other tick commits NONE→FAILED.
    const port: ChargePort = {
      ...base,
      async capture(request) {
        await prisma.dropParticipant.updateMany({
          where: { id: request.participantId, chargeStatus: 'NONE' },
          data: { chargeStatus: 'FAILED' },
        });
        return base.capture(request);
      },
    };

    await settle({ dropId, now: new Date(), port });

    // The winning tick reports the decline; this one must not. There is no
    // winner emitter in this fixture, so the honest expectation is zero lines.
    expect(forDrop('capture_failed', dropId)).toHaveLength(0);
  });

  it('a worker that loses the repair CAS does not report a second capture', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const participantId = await fx.participant({ dropId, qty: 2 });
    const participant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { amountCents: true, platformFeeCents: true },
    });
    await prisma.order.create({
      data: {
        dropId,
        participantId,
        qty: 2,
        unitPriceCents: 1000,
        subtotalCents: participant.amountCents,
        platformFeeCents: participant.platformFeeCents,
        stripeChargeId: 'ch_from_the_other_tick',
      },
    });

    // `repairFromExistingOrder` reads the Order before it runs its CAS. Inject
    // the winning tick's commit at exactly that read: deterministic, and the
    // only point where both workers can be known to be in the repair path.
    const original = prisma.order.findUnique.bind(prisma.order);
    let injected = false;
    const spy = vi.spyOn(prisma.order, 'findUnique');
    spy.mockImplementation((async (args: unknown) => {
      const row = await (original as (a: unknown) => Promise<unknown>)(args);
      if (!injected) {
        injected = true;
        await prisma.dropParticipant.updateMany({
          where: { id: participantId, chargeStatus: 'NONE' },
          data: { chargeStatus: 'CAPTURED' },
        });
      }
      return row;
    }) as typeof prisma.order.findUnique);

    try {
      await settle({ dropId, now: new Date(), port: fakeChargePort() });
      expect(injected).toBe(true);
      expect(forDrop('capture_succeeded', dropId)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('redemption', () => {
  it('scanned fires per submitted code; completed only for a real claim', async () => {
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'PICKUP_OPEN',
    });
    const participantId = await fx.participant({
      dropId,
      qty: 2,
      chargeStatus: 'CAPTURED',
    });
    const code = signRedemptionCode({ participantId, dropId, qty: 2 });
    const args = { code, merchantIds: [merchantId], userId: ownerUserId };

    const first = await redeemCode(args);
    expect(first.kind).toBe('REDEEMED');
    const double = await redeemCode(args);
    expect(double.kind).toBe('ALREADY_REDEEMED');
    const bad = await redeemCode({ ...args, code: 'not-a-code' });
    expect(bad.kind).toBe('REFUSED');

    const scans = named('redemption_scanned').filter((row) => row.merchantId === merchantId);
    const completions = forDrop('redemption_completed', dropId);
    // Three submitted codes: the claim, the double scan, and the bad code.
    expect(scans).toHaveLength(3);
    // Only one of them actually took plates.
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      merchantId,
      participantId,
      taken: 2,
      redeemedQty: 2,
      partial: false,
    });

    // The code is a bearer token. It must appear in no analytics line, and
    // neither may the customer's name.
    const raw = readFileSync(logPath, 'utf8');
    expect(raw).not.toContain(code);
    expect(raw).not.toContain('v1.');
  });
});

describe('AI draft generation', () => {
  it('ai_draft_generated fires once per generation with surface and guardrail state', async () => {
    const quietStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    quietStart.setUTCHours(21, 0, 0, 0);

    const args = {
      merchantIds: [merchantId],
      answers: {
        menuItemId: itemId,
        quietStart: quietStart.toISOString(),
        intent: 'EITHER' as const,
        maxQty: 30,
      },
      now: new Date(),
      port: createUnavailablePort('no_key'),
    };

    const first = await buildDealProposals(args);
    expect(first.proposals.length).toBeGreaterThan(0);
    expect(first.aiDraftId).not.toBeNull();

    const rows = named('ai_draft_generated');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      merchantId,
      itemId,
      aiDraftId: first.aiDraftId,
      surface: 'merchant_builder',
      guardrailPassed: true,
      proposalCount: first.proposals.length,
      source: 'planner',
    });
    expect(rows[0]).not.toHaveProperty('merchantName');
    expect(rows[0]).not.toHaveProperty('answers');

    // A second run is a second generation, not a duplicate of the first.
    await buildDealProposals(args);
    expect(named('ai_draft_generated')).toHaveLength(2);
  });
});
