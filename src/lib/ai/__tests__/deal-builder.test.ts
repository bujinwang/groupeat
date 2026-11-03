import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDealProposals } from '@/lib/ai/deal-builder';
import { createUnavailablePort, AiUnavailableError, type CompletionPort } from '@/lib/ai/port';
import { createItem } from '@/lib/db/items';
import { prisma } from '@/lib/db/prisma';
import { isAppError } from '@/lib/errors';

/**
 * The orchestration, against a real database and a fake model.
 *
 * ## What only this file can catch
 *
 * `plan.test.ts` proves the planner's arithmetic. It cannot prove that
 * `buildDealProposals` *uses* it — which dish it reads, whose floor it applies,
 * whether an ineligible dish is refused before planning, and above all whether an
 * AI failure actually leaves a usable result behind. Those are properties of the
 * wiring, and the Sprint 2 fee-bearer defect was exactly a wiring bug that 141
 * green unit tests could not see.
 *
 * ## Why the fake is a port and not a mock
 *
 * Each case below is a real failure mode from PRD-v1 §9.5 — down, timed out,
 * invalid JSON, a banned term, a wrong price. The assertions are about what the
 * merchant gets, never about which method was called: "the title fell back" is a
 * product fact, "`complete` was called once" is not.
 */

const PREFIX = `ai-deal-builder-${Date.now()}`;

type Fixture = { merchantId: string; userId: string; itemId: string; thinItemId: string };
const fixtures: Fixture[] = [];
let fixture: Fixture;

const NOW = new Date();

/**
 * Two days out, at 21:00Z, as an instant.
 *
 * Not "2pm Mountain": from 2026-11-01 Alberta is UTC−6 year-round, so 21:00Z is
 * 3pm. No assertion here depends on the local hour — this is a fixture the
 * planner is handed, and the tests read the planner's output, not a label — but
 * the comment used to state 2pm and would send the next reader hunting for a
 * bug in `plan.ts`. Nothing is wrong with `plan.ts`; the law changed.
 */
function quietStartIso(): string {
  const date = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
  date.setUTCHours(21, 0, 0, 0);
  return date.toISOString();
}

function answers(overrides: Partial<Parameters<typeof buildDealProposals>[0]['answers']> = {}) {
  return {
    menuItemId: fixture.itemId,
    quietStart: quietStartIso(),
    intent: 'EITHER' as const,
    maxQty: 30,
    ...overrides,
  };
}

/** A port that returns whatever the test wants. */
function portReturning(text: string): CompletionPort {
  return { complete: async () => text };
}

function copyReply(overrides: Record<string, string> = {}): string {
  return JSON.stringify({
    proposals: [
      {
        archetype: 'QUIET_HOUR',
        title: 'Quiet Hour Bowl',
        description: 'One batch, made for the group.',
        shareMessage: 'Quiet Hour Bowl at $13.10 a plate, pickup in two days.',
        rationale: 'Fills your quiet hour.',
        ...overrides,
      },
    ],
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: true,
    },
    select: { id: true },
  });

  const merchant = await prisma.merchant.create({
    data: {
      name: 'Golden Dragon',
      slug: PREFIX,
      status: 'PENDING',
      floorPctOfMenu: 0.25,
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });

  const item = await createItem([merchant.id], {
    name: 'Beef Bowl',
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: 30,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });

  // No price clears the floor on this one (PRD-v1 §7.4 vector D).
  const thinItem = await createItem([merchant.id], {
    name: 'Loss Leader',
    description: null,
    menuPriceCents: 900,
    foodCostCents: 850,
    packagingCents: 30,
    batchYield: 20,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });

  fixture = {
    merchantId: merchant.id,
    userId: user.id,
    itemId: item.id,
    thinItemId: thinItem.id,
  };
  fixtures.push(fixture);
});

afterAll(async () => {
  for (const entry of fixtures) {
    // This line must come *first*, and the reason changed when `merchantId` gained a
    // `SetNull` foreign key: deleting the merchant no longer leaves the draft pointing at
    // a dead id, it blanks the id. `deleteMany({ merchantId })` could then not find the
    // row at all, and the leftover would surface as a fixture leak on the next run —
    // exactly the failure this teardown was written to prevent, arriving by a new route.
    await prisma.aiDraft.deleteMany({ where: { merchantId: entry.merchantId } }).catch(() => undefined);
    await prisma.drop.deleteMany({ where: { merchantId: entry.merchantId } }).catch(() => undefined);
    await prisma.merchant.delete({ where: { id: entry.merchantId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: entry.userId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('buildDealProposals — with no model', () => {
  it('still returns three publishable proposals', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: createUnavailablePort('no_key'),
    });

    expect(result.source).toBe('planner');
    expect(result.proposals).toHaveLength(3);

    for (const proposal of result.proposals) {
      // 1600 menu, 480 food, 80 packaging, 25% floor → $11.12 is the floor.
      expect(proposal.dealPriceCents).toBeGreaterThanOrEqual(1112);
      expect(proposal.dealPriceCents).toBeLessThan(1600);
      expect(proposal.menuItemId).toBe(fixture.itemId);
    }
  });

  it('writes the audit row, so the copy can be explained later', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: createUnavailablePort('no_key'),
    });

    expect(result.aiDraftId).not.toBeNull();

    const row = await prisma.aiDraft.findUnique({ where: { id: result.aiDraftId! } });
    expect(row?.surface).toBe('merchant_builder');
    expect(row?.promptVersion).toBe(result.promptVersion);
    expect(row?.guardrailPassed).toBe(true);
  });

  it('records the merchant’s name on the row, so the row can survive the merchant', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: createUnavailablePort('no_key'),
    });

    const row = await prisma.aiDraft.findUniqueOrThrow({
      where: { id: result.aiDraftId! },
      select: { merchantId: true, merchantName: true },
    });
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: fixture.merchantId },
      select: { name: true },
    });

    // Named, and named *correctly* — compared against the merchant rather than against a
    // literal, so this is a statement about what was copied rather than about the
    // fixture's naming convention.
    expect(row.merchantId).toBe(fixture.merchantId);
    expect(row.merchantName).toBe(merchant.name);

    // This test does *not* try to assert that the planner's `'Your restaurant'`
    // placeholder never reaches the record, because no fixture can make that branch run:
    // `item.merchantId` is a foreign key, so the merchant always exists here and both
    // `??` arms are dead. The probe that deleted the distinction between the planner's
    // name and the audit name survived for exactly that reason, and the repair was to
    // stop keeping two variables rather than to write a third assertion here. See the
    // comment at `buildDealProposals`.
  });
});

describe('buildDealProposals — with a model', () => {
  it('uses the model copy when it passes the linter', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: portReturning(copyReply()),
    });

    expect(result.source).toBe('model');
    expect(result.copyRejected).toEqual([]);

    const quiet = result.proposals.find((proposal) => proposal.archetype === 'QUIET_HOUR');
    expect(quiet?.title).toBe('Quiet Hour Bowl');
    expect(quiet?.rationale).toBe('Fills your quiet hour.');
  });

  it('keeps the planner title but accepts the other fields when one field breaks a rule', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: portReturning(copyReply({ title: 'Best bowl in Calgary' })),
    });

    const quiet = result.proposals.find((proposal) => proposal.archetype === 'QUIET_HOUR');

    // The banned superlative is refused…
    expect(quiet?.title).not.toContain('Best');
    expect(result.copyRejected.some((rejection) => rejection.field === 'title')).toBe(true);

    // …and the three good fields are still the model's.
    expect(quiet?.rationale).toBe('Fills your quiet hour.');
    expect(result.source).toBe('model');
  });

  it('refuses a price the model invented, and keeps the planner price', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: portReturning(copyReply({ shareMessage: 'Get it for $9.99 a plate.' })),
    });

    const quiet = result.proposals.find((proposal) => proposal.archetype === 'QUIET_HOUR');
    expect(quiet?.shareMessage).not.toContain('$9.99');
    expect(quiet?.shareMessage).toContain(`$${(quiet!.dealPriceCents / 100).toFixed(2)}`);

    expect(
      result.copyRejected.some((rejection) => rejection.kind === 'price_mismatch'),
    ).toBe(true);
  });

  it('falls back to the planner when the model is down', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: {
        complete: async () => {
          throw new AiUnavailableError('timeout', 'too slow');
        },
      },
    });

    expect(result.source).toBe('planner');
    expect(result.proposals).toHaveLength(3);
    expect(result.copyRejected).toEqual([]);
  });

  it('falls back to the planner when the model returns prose instead of JSON', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: portReturning('Sure! Here are some ideas I had.'),
    });

    expect(result.source).toBe('planner');
    expect(result.proposals).toHaveLength(3);
  });

  it('falls back to the planner when the model throws something unexpected', async () => {
    const result = await buildDealProposals({
      merchantIds: [fixture.merchantId],
      answers: answers(),
      now: NOW,
      port: {
        complete: async () => {
          throw new TypeError('socket hang up');
        },
      },
    });

    expect(result.source).toBe('planner');
    expect(result.proposals).toHaveLength(3);
  });
});

describe('buildDealProposals — refusals are about the dish, not the model', () => {
  it('refuses a dish where no price clears the floor', async () => {
    await expect(
      buildDealProposals({
        merchantIds: [fixture.merchantId],
        answers: answers({ menuItemId: fixture.thinItemId }),
        now: NOW,
        port: createUnavailablePort('no_key'),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) && error.status === 422 && 'menuItemId' in (error.fieldErrors ?? {}),
    );
  });

  it('refuses an alcohol item even though it is batchable', async () => {
    const beer = await createItem([fixture.merchantId], {
      name: 'Beer Flight',
      description: null,
      menuPriceCents: 1800,
      foodCostCents: 600,
      packagingCents: 100,
      batchYield: 20,
      prepMinutes: 4,
      isBatchable: true,
      containsAlcohol: true,
      category: 'Drinks',
    });

    await expect(
      buildDealProposals({
        merchantIds: [fixture.merchantId],
        answers: answers({ menuItemId: beer.id }),
        now: NOW,
        port: createUnavailablePort('no_key'),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.status === 422,
    );
  });

  it("returns 404 for another merchant's dish", async () => {
    await expect(
      buildDealProposals({
        merchantIds: ['a-merchant-that-is-not-this-one'],
        answers: answers(),
        now: NOW,
        port: createUnavailablePort('no_key'),
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.status === 404);
  });
});
