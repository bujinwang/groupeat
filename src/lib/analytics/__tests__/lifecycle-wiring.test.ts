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
  SENTINEL_CUSTOMER_NAME_PREFIX,
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
    // ## The positive control, first
    //
    // The assertion this test is really about is `toHaveLength(0)`, and a zero
    // proves nothing on its own: a deleted emitter, a dropped `record(...)` call,
    // a sink pointed at the wrong path and a worker that skipped the participant
    // entirely all produce zero. So a second, ordinary drop is settled through the
    // same port first and must produce exactly one line. That establishes the two
    // premises the zero depends on — the decline path emits, and `forDrop` finds
    // it — before the zero is asked to mean "the loser suppressed it".
    const controlDropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const controlParticipantId = await fx.participant({ dropId: controlDropId, qty: 1 });
    await settle({
      dropId: controlDropId,
      now: new Date(),
      port: fakeChargePort({ declineParticipantIds: [controlParticipantId] }),
    });
    expect(forDrop('capture_failed', controlDropId)).toHaveLength(1);

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

    // The losing worker has to have *reached* the decline branch for the zero
    // below to be about the CAS rather than about being skipped. `FAILED` is not
    // this worker's write — the port wrote it — but the row proves the loop
    // processed this participant and `settle` continued past the provider call.
    const row = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { chargeStatus: true },
    });
    expect(row.chargeStatus).toBe('FAILED');

    // The winning tick reports the decline; this one must not. There is no
    // winner emitter in this fixture, so the honest expectation is zero lines.
    expect(forDrop('capture_failed', dropId)).toHaveLength(0);
  });

  it('a worker that loses the repair CAS does not report a second capture', async () => {
    // The same shape of control as above, for the repair path: an ordinary
    // existing-`Order` drop is repaired through `settle` and must emit exactly
    // one `capture_succeeded`. Without it, the zero further down would be
    // indistinguishable from a repair path that never emits at all.
    const controlDropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'LOCKED',
      lockedAt: new Date(Date.now() - 60_000),
    });
    const controlParticipantId = await fx.participant({ dropId: controlDropId, qty: 2 });
    const controlParticipant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: controlParticipantId },
      select: { amountCents: true, platformFeeCents: true },
    });
    await prisma.order.create({
      data: {
        dropId: controlDropId,
        participantId: controlParticipantId,
        qty: 2,
        unitPriceCents: 1000,
        subtotalCents: controlParticipant.amountCents,
        platformFeeCents: controlParticipant.platformFeeCents,
        stripeChargeId: 'ch_from_the_control',
      },
    });
    await settle({ dropId: controlDropId, now: new Date(), port: fakeChargePort() });
    expect(forDrop('capture_succeeded', controlDropId)).toHaveLength(1);

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
      // The repair branch was entered (the CAS was attempted) and the row is
      // CAPTURED, so the zero below is about the lost CAS, not about a `settle`
      // that never looked at this participant.
      const row = await prisma.dropParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { chargeStatus: true },
      });
      expect(row.chargeStatus).toBe('CAPTURED');
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
    //
    // The name is the interesting half, because `redeemCode` *does* load it —
    // `ALREADY_REDEEMED` returns it so the counter screen can say who collected
    // the plates, and the double scan above went through that path. Carrying it
    // into the sink is therefore one field away at every emission site, and the
    // fixture's `SENTINEL_CUSTOMER_NAME_PREFIX` is a value that could not appear
    // by coincidence. Asserting it against the whole file covers every event this
    // test produced, not only `redemption_scanned`.
    const raw = readFileSync(logPath, 'utf8');
    expect(raw).not.toContain(code);
    expect(raw).not.toContain('v1.');
    expect(raw).not.toContain(SENTINEL_CUSTOMER_NAME_PREFIX);

    // Positive control for the line above: the sink is not empty, so "does not
    // contain the sentinel" is a fact about what was written rather than about a
    // log path that never received a line.
    expect(raw).toContain('"event":"redemption_scanned"');
    // And the fixture really did put the sentinel on this diner, so the absence
    // above is about the sink and not about a customer row that had no name —
    // the defect this assertion was silently unable to see before.
    const participantRow = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { customer: { select: { name: true } } },
    });
    expect(participantRow.customer.name).toContain(SENTINEL_CUSTOMER_NAME_PREFIX);
  });

  it('attributes a scan to the drop\'s merchant, not to the first id in the session', async () => {
    // ## The defect this test was written for
    //
    // `requireMerchantScope` returns `merchantIds` ordered by `merchantId`
    // (`authorize.ts`), and the pre-fix code emitted
    // `redemptionScanned({ merchantId: merchantIds[0] })`. A staff member attached
    // to two restaurants therefore reported **every** scan against whichever
    // merchant sorted first — including scans of the other restaurant's food. The
    // number looks plausible, which is why nothing caught it: no assertion in the
    // suite ever had a session whose first merchant was not the drop's.
    //
    // Uuids sort arbitrarily, so the order is not guessed here: the two ids are
    // sorted the way `requireMerchantScope` sorts them, and the drop is created
    // under the **last** one. That makes `merchantIds[0] !== dropMerchantId` a
    // property of the fixture rather than a coincidence of the uuid space.
    const secondMerchantId = await fx.merchant('acct_test_second');
    // The same human, at two restaurants. `fx.cleanup()` deletes both merchants,
    // which cascades this membership — no extra teardown step is needed.
    await prisma.merchantUser.create({
      data: { merchantId: secondMerchantId, userId: ownerUserId, role: 'OWNER' },
    });

    const scope = [merchantId, secondMerchantId].sort();
    const first = scope[0]!;
    const dropMerchantId = scope[1]!;
    expect(dropMerchantId).not.toBe(first);

    const secondItemId = await fx.item(dropMerchantId);
    const dropId = await fx.drop({
      merchantId: dropMerchantId,
      menuItemId: secondItemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'PICKUP_OPEN',
    });
    const participantId = await fx.participant({
      dropId,
      qty: 1,
      chargeStatus: 'CAPTURED',
    });
    const code = signRedemptionCode({ participantId, dropId, qty: 1 });

    // The log accumulates across this file, so the assertions below read only the
    // lines this test added. A whole-file count would compare against the three
    // scans the earlier redemption test already wrote.
    const before = named('redemption_scanned').length;
    const outcome = await redeemCode({ code, merchantIds: scope, userId: ownerUserId });
    expect(outcome.kind).toBe('REDEEMED');

    const written = named('redemption_scanned').slice(before);
    // One submitted code, one line — and it names the restaurant whose food was
    // collected. A scan attributed to `first` would still be exactly one line, so
    // the count is the control and the merchant is the assertion.
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ merchantId: dropMerchantId });
  });

  it('still counts a scan whose code resolved no participant, under the session\'s first merchant', async () => {
    // ## Why this is a decision and not an oversight
    //
    // `redemption_scanned` is the top of the redemption funnel: it counts *codes
    // submitted to the scanner*, which is what the till does, and the rate that
    // matters is completions ÷ scans. A malformed or unknown code is a scan — it
    // is the number that says "staff are typing codes that do not work" — so
    // suppressing it would make the funnel's denominator quietly better than
    // reality, and the existing assertion above (`three submitted codes, three
    // scan lines`) already locks this in.
    //
    // The consequence is that such a scan has no drop, and therefore no merchant,
    // to be attributed to. `merchantIds[0]` is used as a **fallback**, and this
    // test states that plainly rather than leaving it to be discovered: the line
    // is a scan that happened under this session, not a claim about which
    // restaurant's food it was. Nothing joins on it.
    const scope = [merchantId];
    const before = named('redemption_scanned').length;

    const refused = await redeemCode({ code: 'not-a-code', merchantIds: scope, userId: ownerUserId });
    expect(refused.kind).toBe('REFUSED');
    if (refused.kind !== 'REFUSED') throw new Error('unreachable');
    expect(refused.reason).toBe('BAD_CODE');
    // The answer the screen renders carries no merchant at all — that is a
    // deliberate property of `RedeemOutcome` (`redeem.ts` explains why), so there
    // is nothing to assert here about the *answer*. The claim being tested is about
    // the *line*, below.

    const after = named('redemption_scanned');
    expect(after.length - before).toBe(1);
    // …and the line falls back to the session's first merchant, which is the only
    // merchant this account has here.
    expect(after[after.length - 1]).toMatchObject({ merchantId });
  });

  it('emits one scan per submitted code even when a scan loses a race and retries', async () => {
    // The retry loop in `redeemCode` re-reads and tries again. Three attempts for
    // one scan must not be three funnel entries, so the emission sits outside the
    // loop — and this drives the race that exercises it rather than trusting the
    // loop's shape. Two codes submitted, two lines, whichever worker wins.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: 1000,
      minQty: 1,
      status: 'PICKUP_OPEN',
    });
    const participantId = await fx.participant({ dropId, qty: 1, chargeStatus: 'CAPTURED' });
    const code = signRedemptionCode({ participantId, dropId, qty: 1 });
    const args = { code, merchantIds: [merchantId], userId: ownerUserId };

    const before = named('redemption_scanned').length;
    const outcomes = await Promise.all([redeemCode(args), redeemCode(args)]);
    const after = named('redemption_scanned');

    // Two submissions. Exactly one of them took the plate; the other is either an
    // `ALREADY_REDEEMED` double scan or a `PARTIAL`/`RETRY` that ended the same
    // way. Either is one scan.
    expect(after.length - before).toBe(2);
    expect(outcomes.filter((outcome) => outcome.kind === 'REDEEMED')).toHaveLength(1);
    // Both lines carry the drop's merchant: the race does not change whose food
    // it was.
    for (const row of after.slice(before)) {
      expect(row.merchantId).toBe(merchantId);
    }
  });

  it('emits nothing when the session has no merchant at all', async () => {
    // An empty scope means no `MerchantUser` row, which `redeemCode` answers
    // before it can attribute anything to anybody. A line here would have to
    // invent a merchant id, and an invented one joins to nothing.
    const before = named('redemption_scanned').length;
    const outcome = await redeemCode({ code: 'irrelevant', merchantIds: [], userId: ownerUserId });
    expect(outcome.kind).toBe('REFUSED');
    expect(named('redemption_scanned').length - before).toBe(0);
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
