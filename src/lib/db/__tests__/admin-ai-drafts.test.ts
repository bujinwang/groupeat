import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { settlementFixtures, type SettlementFixtures } from '@/lib/settlement/__tests__/settlement-fixtures';

import { countDraftsForMerchant, listAdminDrafts, loadAdminDraft } from '../admin-ai-drafts';

/**
 * FR-905's page query, against real Postgres.
 *
 * ## What these tests protect
 *
 *   1. **A historical row renders instead of throwing.** The module reads two `Json`
 *      columns it does not own, written by whatever prompt version was current that
 *      day. The screen exists to look at *old* rows, so the failure mode that matters
 *      is a row from a previous shape crashing the list for every operator at once.
 *      Half the tests here are malformed rows that must degrade to empty fields.
 *   2. **The floor is read from the proposals, not from `inputJson`.** `persistAuditRow`
 *      stores four costs and a percentage and no floor — the floor rides on each
 *      `PlannedProposal`. A loader reading `inputJson.minViablePriceCents` type-checks,
 *      never finds it, and turns the screen's most important number into a permanent
 *      dash. The test asserts a real number derived from the proposals.
 *   3. **A draft outlives its merchant, and the row keeps its name.** `merchantId` is a
 *      `SetNull` foreign key and the row records the merchant's name at write time, so
 *      deleting the merchant blanks the id and leaves the evidence — including what the
 *      merchant was called. The name is a *snapshot*: renaming the merchant afterwards
 *      does not rewrite it, and the row that says so is the assertion, not the prose.
 *   4. **Nothing here writes.** The row is the evidence in a merchant dispute; a loader
 *      that touched it would be tampering with its own exhibit.
 */

const PREFIX = `ai${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

let merchantId = '';
let otherMerchantId = '';
let oldestId = '';
let newestId = '';

const HOUR = 60 * 60 * 1000;
const draftIds: string[] = [];

/** A guardrail input block shaped exactly as `persistAuditRow` writes it. */
function inputJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answers: { quietStart: '2026-11-02T18:00:00.000Z', maxQty: 40, intent: 'fill_quiet_hours' },
    fees: { platformFeePct: 0.08, platformFeeFloorCents: 60, platformFeeCapCents: 200 },
    floorPctOfMenu: 0.25,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    ...overrides,
  };
}

/** The shape `persistAuditRow` writes: `source`, `proposals`, `copyRejected`. */
function outputJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'planner',
    proposals: [
      {
        archetype: 'WEEKDAY_LUNCH',
        dealPriceCents: 1200,
        menuPriceCents: 1600,
        minViablePriceCents: 1150,
        discountPct: 0.25,
        isThinDiscount: false,
        minQty: 4,
        maxQty: 40,
        title: 'Lunch, cheaper',
        rationale: 'Fills a quiet Tuesday.',
      },
      {
        archetype: 'BULK',
        dealPriceCents: 1050,
        menuPriceCents: 1600,
        minViablePriceCents: 1150,
        discountPct: 0.34,
        isThinDiscount: false,
        minQty: 6,
        maxQty: 40,
        title: 'Feed the team',
        rationale: 'Bigger batch, better price.',
      },
    ],
    copyRejected: [],
    ...overrides,
  };
}

async function draft(args: {
  merchantId?: string;
  /**
   * Default `null`, which models a row written **before** the column existed.
   *
   * That is the interesting default: it forces the whole existing suite through the live
   * fallback, so a `resolveName` that only ever read `draft.merchantName` fails here
   * rather than in production. The snapshot path — and the two ways it differs from the
   * live path — is exercised explicitly in "a draft outlives its merchant".
   */
  merchantName?: string | null;
  input?: unknown;
  output?: unknown;
  createdAt?: Date;
  surface?: string;
}): Promise<string> {
  const row = await prisma.aiDraft.create({
    data: {
      merchantId: args.merchantId ?? merchantId,
      merchantName: args.merchantName ?? null,
      surface: args.surface ?? 'merchant_builder',
      promptVersion: 'deal-builder-v1',
      inputJson: (args.input ?? inputJson()) as never,
      outputJson: (args.output ?? outputJson()) as never,
      guardrailPassed: true,
      createdAt: args.createdAt ?? new Date(),
    },
    select: { id: true },
  });
  draftIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}a`);
  otherMerchantId = await fx.merchant(`acct_${PREFIX}b`);

  // Explicit, well-separated instants rather than "now" three times in a row: the
  // ordering test must fail on the `orderBy`, not on ties in `createdAt`.
  oldestId = await draft({ createdAt: new Date(Date.now() - 3 * HOUR) });
  newestId = await draft({ createdAt: new Date(Date.now() - 1 * HOUR) });
});

afterAll(async () => {
  if (draftIds.length > 0) {
    await prisma.aiDraft.deleteMany({ where: { id: { in: draftIds } } }).catch(() => undefined);
  }
  await fx.cleanup();
});

describe('listAdminDrafts', () => {
  it('returns newest first, because the caller is a phone call that just happened', async () => {
    const rows = await listAdminDrafts({ merchantId });
    const ordered = rows.map((row) => row.id);

    expect(ordered).toContain(newestId);
    expect(ordered).toContain(oldestId);
    expect(ordered.indexOf(newestId)).toBeLessThan(ordered.indexOf(oldestId));

    // And the property, not just these two: `orderBy` is the whole guarantee.
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        rows[index]!.createdAt.getTime(),
      );
    }
  });

  it('filters to one merchant when asked, and to every merchant when not', async () => {
    const foreign = await draft({ merchantId: otherMerchantId });

    const scoped = await listAdminDrafts({ merchantId });
    expect(scoped.every((row) => row.merchantId === merchantId)).toBe(true);
    expect(scoped.map((row) => row.id)).not.toContain(foreign);

    const every = await listAdminDrafts();
    expect(every.map((row) => row.id)).toContain(foreign);
  });

  it('names the merchant on every row, so an operator can say it out loud', async () => {
    const rows = await listAdminDrafts({ merchantId });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.merchantName).toBeTruthy();
    }
  });

  it('honours the limit', async () => {
    const rows = await listAdminDrafts({ merchantId, limit: 1 });
    expect(rows.length).toBe(1);
    // Still the newest one — a limit applied before the ordering would be arbitrary.
    expect(rows[0]?.id).toBe(newestId);
  });

  it('carries the lowest price the guardrail allowed, which is the number complained about', async () => {
    const rows = await listAdminDrafts({ merchantId });
    const row = rows.find((candidate) => candidate.id === newestId);

    // 1050, not 1200 and not the menu price: `Math.min` over the proposals.
    expect(row?.lowestDealPriceCents).toBe(1050);
    expect(row?.proposalCount).toBe(2);
    expect(row?.rejectionCount).toBe(0);
  });
});

describe('loadAdminDraft', () => {
  it('returns null for an id that does not exist, rather than throwing at a page', async () => {
    expect(await loadAdminDraft('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lifts the guardrail inputs out of inputJson into numbers', async () => {
    const detail = await loadAdminDraft(newestId);

    expect(detail?.inputs.floorPctOfMenu).toBe(0.25);
    expect(detail?.inputs.menuPriceCents).toBe(1600);
    expect(detail?.inputs.foodCostCents).toBe(480);
    expect(detail?.inputs.packagingCents).toBe(80);
    // The merchant's own answers, kept as a record rather than flattened.
    expect(detail?.answers).toMatchObject({ maxQty: 40 });
  });

  it('derives the floor from the proposals, because inputJson never stores one', async () => {
    const detail = await loadAdminDraft(newestId);

    // The assertion that would catch reading `inputJson.minViablePriceCents`: that
    // field does not exist, so such a loader returns `null` for every row ever
    // written, and the screen shows a dash where its central number belongs.
    expect(detail?.inputs.minViablePriceCents).toBe(1150);

    const stored = await prisma.aiDraft.findUniqueOrThrow({
      where: { id: newestId },
      select: { inputJson: true },
    });
    expect(stored.inputJson).not.toHaveProperty('minViablePriceCents');
  });

  it('reports no floor when a run stored no proposals, instead of inventing zero', async () => {
    const emptyId = await draft({ output: outputJson({ proposals: [] }) });
    const detail = await loadAdminDraft(emptyId);

    expect(detail?.proposals).toEqual([]);
    expect(detail?.inputs.minViablePriceCents).toBeNull();
    expect(detail?.lowestDealPriceCents).toBeNull();
  });

  it('survives an outputJson from an older shape without throwing', async () => {
    // Three historical shapes, in one test because the property is the same: the
    // reader degrades rather than throws. A throwing loader takes the whole list down
    // for one bad row, and the screen exists to look at old rows.
    const noProposalsKey = await draft({ output: { source: 'model' } });
    const proposalsNotAnArray = await draft({ output: { proposals: 'twelve' } });
    const arrayEntriesNotObjects = await draft({
      output: { proposals: [null, 7, 'x'], copyRejected: [{ field: 'title' }] },
    });

    for (const id of [noProposalsKey, proposalsNotAnArray, arrayEntriesNotObjects]) {
      const detail = await loadAdminDraft(id);
      expect(detail).not.toBeNull();
      expect(detail?.proposals.length).toBeGreaterThanOrEqual(0);
    }

    expect((await loadAdminDraft(noProposalsKey))?.proposals).toEqual([]);
    expect((await loadAdminDraft(proposalsNotAnArray))?.proposals).toEqual([]);

    // Entries that are not objects are dropped; the one that is keeps its field and
    // gets empty strings for the three it lacks.
    const partial = await loadAdminDraft(arrayEntriesNotObjects);
    expect(partial?.proposals).toEqual([]);
    expect(partial?.rejections).toEqual([
      { archetype: '', field: 'title', kind: '', detail: '' },
    ]);
  });

  it('survives an inputJson that is not an object at all', async () => {
    // `Json` accepts a bare string or array. Nothing in `persistAuditRow` writes one,
    // but the column permits it, so the loader cannot assume otherwise.
    const scalar = await draft({ input: 'legacy-row' });
    const detail = await loadAdminDraft(scalar);

    expect(detail?.inputs).toEqual({
      floorPctOfMenu: null,
      menuPriceCents: null,
      foodCostCents: null,
      packagingCents: null,
      // Not `null`, and that is the point: the floor is read from the proposals, which
      // live in `outputJson` and are intact here. An unreadable *input* row costs the
      // screen its cost figures, not its price.
      minViablePriceCents: 1150,
    });
    expect(detail?.answers).toBeNull();
  });

  it('keeps the raw JSON verbatim, and pretty-printed so it can be read', async () => {
    const detail = await loadAdminDraft(newestId);
    const stored = await prisma.aiDraft.findUniqueOrThrow({
      where: { id: newestId },
      select: { inputJson: true, outputJson: true },
    });

    // Round-trip equality, not a substring match: the point is that no field was
    // dropped on the way to the screen, not that some of it appears.
    expect(JSON.parse(detail?.inputJson ?? 'null')).toEqual(stored.inputJson);
    expect(JSON.parse(detail?.outputJson ?? 'null')).toEqual(stored.outputJson);

    // Pretty-printed because a 4 KB single line is unreadable, which defeats the
    // purpose of showing it at all.
    expect(detail?.inputJson).toContain('\n');
  });

  it('counts the copy fields the linter refused', async () => {
    const rejectedId = await draft({
      output: outputJson({
        copyRejected: [
          { archetype: 'BULK', field: 'title', kind: 'SUPERLATIVE', detail: '“best” is a claim.' },
          { archetype: 'BULK', field: 'shareMessage', kind: 'PRICE_CLAIM', detail: 'No price in copy.' },
        ],
      }),
    });
    const detail = await loadAdminDraft(rejectedId);

    expect(detail?.rejectionCount).toBe(2);
    expect(detail?.rejections[0]).toMatchObject({ field: 'title', kind: 'SUPERLATIVE' });
  });

  it('states guardrailPassed as stored, rather than recomputing it into a claim', async () => {
    const detail = await loadAdminDraft(newestId);

    // The column is a constant by construction; the loader's job is to report it as a
    // stored value, not to dress it up as a check that ran. The pages carry the
    // explanation — see `admin-ai-drafts.ts`.
    expect(detail?.guardrailPassed).toBe(true);
  });
});

describe('the merchant, and what happens when it goes', () => {
  it('refuses a merchant id that does not exist, which is what the foreign key is for', async () => {
    // The invariant that replaced the old test's premise. Until the `aidraft_merchant_fk`
    // migration, creating this row succeeded — that was the defect, stated as an
    // assertion. Now the database is the thing that refuses.
    await expect(
      prisma.aiDraft.create({
        data: {
          merchantId: `never-${PREFIX}`,
          surface: 'merchant_builder',
          promptVersion: 'deal-builder-v1',
          inputJson: inputJson() as never,
          outputJson: outputJson() as never,
          guardrailPassed: true,
        },
        select: { id: true },
      }),
    ).rejects.toThrow(/foreign key/i);

    // And nothing was left behind by the failed insert.
    expect(await prisma.aiDraft.count({ where: { merchantId: `never-${PREFIX}` } })).toBe(0);
  });

  it('keeps the row and its recorded name when the merchant is deleted', async () => {
    const doomed = await fx.merchant(`acct_${PREFIX}gone`);
    const doomedName = (
      await prisma.merchant.findUniqueOrThrow({ where: { id: doomed }, select: { name: true } })
    ).name;
    const surviving = await draft({ merchantId: doomed, merchantName: doomedName });

    await prisma.merchant.delete({ where: { id: doomed } });

    // The row survives, the pointer does not. This is `onDelete: SetNull` doing exactly
    // what it was chosen to do — `Cascade` would have taken the evidence with the
    // merchant, and this assertion is what tells the two apart.
    const stored = await prisma.aiDraft.findUniqueOrThrow({
      where: { id: surviving },
      select: { merchantId: true, merchantName: true },
    });
    expect(stored.merchantId).toBeNull();
    expect(stored.merchantName).toBe(doomedName);

    // And the screen can still name it, which is the whole reason the name is recorded.
    // Without the snapshot this row would render "Merchant no longer on file" over the
    // top of the one fact the complaint turns on.
    const row = (await listAdminDrafts()).find((candidate) => candidate.id === surviving);
    expect(row?.merchantId).toBeNull();
    expect(row?.merchantName).toBe(doomedName);

    const detail = await loadAdminDraft(surviving);
    expect(detail?.merchantName).toBe(doomedName);
    // The run itself is untouched: the merchant vanishing does not erase what the model
    // was asked or what it answered.
    expect(detail?.proposals).toHaveLength(2);
    expect(detail?.inputs.menuPriceCents).toBe(1600);
  });

  it('reports the name as recorded, so renaming a merchant does not rewrite history', async () => {
    // The recorded name and the live name are made to *differ* here, which is the only
    // way this can be an assertion. If both were the same string, a `resolveName` that
    // ignored the snapshot and always looked the merchant up would pass.
    const merchant = await fx.merchant(`acct_${PREFIX}ren`);
    const formerName = `Trading name ${PREFIX}`;
    const rowId = await draft({ merchantId: merchant, merchantName: formerName });

    await prisma.merchant.update({
      where: { id: merchant },
      data: { name: `Renamed ${PREFIX}` },
    });

    const row = (await listAdminDrafts()).find((candidate) => candidate.id === rowId);
    expect(row?.merchantName).toBe(formerName);
    expect(row?.merchantName).not.toBe(`Renamed ${PREFIX}`);
    expect((await loadAdminDraft(rowId))?.merchantName).toBe(formerName);

    // The column itself is unchanged too, so this is not a page-level filter over fresh
    // data — the audit record genuinely did not move.
    const stored = await prisma.aiDraft.findUniqueOrThrow({
      where: { id: rowId },
      select: { merchantName: true },
    });
    expect(stored.merchantName).toBe(formerName);
  });

  it('falls back to the live name for a row written before the column existed', async () => {
    // Rows already in the table when the migration ran have `merchantName: null` and a
    // live merchant. Reporting that as "no longer on file" would be a false statement
    // about an account that is entirely on file — on the screen built to answer
    // complaints. So the fallback looks the merchant up.
    const merchant = await fx.merchant(`acct_${PREFIX}pre`);
    const rowId = await draft({ merchantId: merchant, merchantName: null });

    const first = (await listAdminDrafts()).find((candidate) => candidate.id === rowId);
    expect(first?.merchantName).toBe(`${PREFIX} merchant`);

    // And it really is a live lookup rather than a cached or invented value: rename the
    // merchant and the fallback follows, which is the opposite of the snapshot's
    // behaviour and the reason these are two different code paths.
    await prisma.merchant.update({
      where: { id: merchant },
      data: { name: `Renamed ${PREFIX} pre` },
    });
    const second = (await listAdminDrafts()).find((candidate) => candidate.id === rowId);
    expect(second?.merchantName).toBe(`Renamed ${PREFIX} pre`);
  });

  it('has no name to give when both the record and the merchant are gone', async () => {
    // The honest `null`: a pre-column row whose merchant was later deleted. Neither
    // source can answer, and the page's "Merchant no longer on file" is then true.
    const merchant = await fx.merchant(`acct_${PREFIX}both`);
    const rowId = await draft({ merchantId: merchant, merchantName: null });
    await prisma.merchant.delete({ where: { id: merchant } });

    const row = (await listAdminDrafts()).find((candidate) => candidate.id === rowId);
    expect(row).toBeDefined();
    expect(row?.merchantId).toBeNull();
    expect(row?.merchantName).toBeNull();
    expect((await loadAdminDraft(rowId))?.merchantName).toBeNull();
  });
});

describe('nothing in this module writes', () => {
  it('leaves every column of the row exactly as it found it', async () => {
    // A row this test alone has touched. An earlier version of this test snapshotted
    // `newestId` *after* other tests had already loaded it, so a write inserted into
    // the loader had already happened before the "before" snapshot — and the probe
    // passed. A read-only assertion is only worth anything against a row whose first
    // read is this test's own.
    const untouched = await draft({
      createdAt: new Date(Date.now() - 4 * HOUR),
      output: outputJson({ source: 'model' }),
    });

    const before = await prisma.aiDraft.findUniqueOrThrow({ where: { id: untouched } });
    expect(before.accepted).toBeNull();

    await listAdminDrafts();
    await listAdminDrafts({ merchantId });
    await countDraftsForMerchant(merchantId);
    await loadAdminDraft(untouched);

    const after = await prisma.aiDraft.findUniqueOrThrow({ where: { id: untouched } });
    // The whole record, not just `accepted`: an `accepted` flag flipped by a read
    // would be invisible to a narrower assertion and would corrupt the audit. The row
    // is the exhibit in a merchant dispute, so a loader that edited it would be
    // tampering with its own evidence.
    expect(after).toEqual(before);
    expect(after.accepted).toBeNull();
  });
});

describe('countDraftsForMerchant', () => {
  it('counts one merchant only, because it is shown as a number on a link', async () => {
    const foreign = await draft({ merchantId: otherMerchantId });

    const forMerchant = await countDraftsForMerchant(merchantId);
    const forOther = await countDraftsForMerchant(otherMerchantId);

    // Each count matches its own merchant's rows exactly. The bug this guards is a
    // `count()` that drops the `where` — plausible in a one-line function, and it
    // would label every merchant's link with the size of the whole table.
    const actual = await prisma.aiDraft.count({ where: { merchantId } });
    const actualOther = await prisma.aiDraft.count({ where: { merchantId: otherMerchantId } });

    expect(forMerchant).toBe(actual);
    expect(forOther).toBe(actualOther);
    expect(forOther).toBeLessThan(actual);
    expect(foreign).toBeTruthy();

    // And a merchant with nothing gets 0, not a count of everything.
    expect(await countDraftsForMerchant(`none-${PREFIX}`)).toBe(0);
  });
});
