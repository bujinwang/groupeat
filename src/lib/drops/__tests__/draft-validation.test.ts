import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDraft, getDrop, updateDraft } from '@/lib/db/drops';
import { createItem } from '@/lib/db/items';
import { prisma } from '@/lib/db/prisma';
import { collectDraftFieldErrors } from '@/lib/drops/draft-validation';
import { validateDropTiming } from '@/lib/drops/rules';
import { isAppError } from '@/lib/errors';

/**
 * Saving a draft must reject the same things whether it is created or edited.
 *
 * These tests exist because of a real defect found by driving the HTTP API by
 * hand: `POST` rejected a window whose cutoff came after pickup started, while
 * `PATCH` accepted the identical body. A draft could therefore be created
 * valid and then edited into a state that could never publish — and the merchant
 * would not find out until they pressed Publish, possibly days later, with the
 * drop already announced.
 *
 * The same gap let `maxQty` exceed the dish's real `batchYield` on create, because
 * the route checked quantities with `Number.MAX_SAFE_INTEGER` standing in for a
 * value it had not read.
 *
 * Runs against `DATABASE_URL` and creates its own merchant, dish and drops.
 */

const PREFIX = `draft-validation-${Date.now()}`;

type Fixture = { merchantId: string; userId: string; itemId: string };
const fixtures: Fixture[] = [];

const BATCH_YIELD = 10;

let fixture: Fixture;

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/** A window that is valid: cutoff tomorrow, pickup the day after. */
function validTiming() {
  return {
    cutoffAt: hoursFromNow(24),
    windowStart: hoursFromNow(48),
    windowEnd: hoursFromNow(50),
  };
}

function draftInput(overrides: Partial<Parameters<typeof createDraft>[1]> = {}) {
  return {
    menuItemId: fixture.itemId,
    title: 'Validation Test Drop',
    description: null,
    heroImageUrl: null,
    dealPriceCents: 1300,
    minQty: 5,
    maxQty: BATCH_YIELD,
    maxPerCustomer: 4,
    aiRationale: null,
    ...validTiming(),
    ...overrides,
  };
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
      name: 'Draft Validation Test',
      slug: PREFIX,
      status: 'PENDING',
      users: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });

  const item = await createItem([merchant.id], {
    name: 'Validation Bowl',
    description: null,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    batchYield: BATCH_YIELD,
    prepMinutes: 6,
    isBatchable: true,
    containsAlcohol: false,
    category: 'Bowls',
  });

  fixture = { merchantId: merchant.id, userId: user.id, itemId: item.id };
  fixtures.push(fixture);
});

afterAll(async () => {
  for (const f of fixtures) {
    // Drops first: `Drop_merchantId_fkey` has no cascade, so deleting the
    // merchant before its drops fails and leaves the whole fixture behind.
    await prisma.drop.deleteMany({ where: { merchantId: f.merchantId } }).catch(() => undefined);
    await prisma.merchant.delete({ where: { id: f.merchantId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: f.userId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('collectDraftFieldErrors · the checks shared by create and update', () => {
  it('accepts a sound draft, so the happy path stays silent', async () => {
    const errors = await collectDraftFieldErrors({
      merchantIds: [fixture.merchantId],
      value: draftInput(),
      now: new Date(),
    });

    // A non-empty object here would mean every save shows a spurious warning.
    expect(errors).toEqual({});
  });

  it('rejects a cutoff after pickup starts', async () => {
    const timing = validTiming();
    const errors = await collectDraftFieldErrors({
      merchantIds: [fixture.merchantId],
      value: draftInput({ cutoffAt: timing.windowEnd }),
      now: new Date(),
    });

    expect(errors.cutoffAt).toMatch(/close before pickup starts/i);
  });

  it("rejects a maxQty above the dish's real batch yield", async () => {
    const errors = await collectDraftFieldErrors({
      merchantIds: [fixture.merchantId],
      value: draftInput({ maxQty: BATCH_YIELD + 15 }),
      now: new Date(),
    });

    // The number in the message has to be the dish's, not a placeholder.
    expect(errors.maxQty).toContain(String(BATCH_YIELD));
  });

  it('accepts a maxQty exactly at the batch yield', async () => {
    const errors = await collectDraftFieldErrors({
      merchantIds: [fixture.merchantId],
      value: draftInput({ maxQty: BATCH_YIELD }),
      now: new Date(),
    });

    expect(errors.maxQty).toBeUndefined();
  });

  it('rejects a minimum above the maximum', async () => {
    const errors = await collectDraftFieldErrors({
      merchantIds: [fixture.merchantId],
      value: draftInput({ minQty: 8, maxQty: 4 }),
      now: new Date(),
    });

    expect(errors.minQty).toMatch(/minimum can't be higher/i);
  });

  it('does not judge the price — a draft is allowed to be unprofitable', async () => {
    // The floor is enforced at publish, not at save, because FR-203's slider
    // needs an unprofitable draft to exist before the merchant has moved it.
    const errors = await collectDraftFieldErrors({
      merchantIds: [fixture.merchantId],
      value: draftInput({ dealPriceCents: 1 }),
      now: new Date(),
    });

    expect(errors).toEqual({});
  });

  it('reads the yield for the drop being saved, not the one already stored', async () => {
    // A merchant swapping dishes in the editor must be judged against the new
    // dish's capacity; checking the old one would let an impossible draft through.
    const roomy = await createItem([fixture.merchantId], {
      name: 'Roomy Tray',
      description: null,
      menuPriceCents: 900,
      foodCostCents: 300,
      packagingCents: 40,
      batchYield: 60,
      prepMinutes: 10,
      isBatchable: true,
      containsAlcohol: false,
      category: 'Bowls',
    });

    const errors = await collectDraftFieldErrors({
      merchantIds: [fixture.merchantId],
      value: draftInput({ menuItemId: roomy.id, maxQty: 40 }),
      now: new Date(),
    });

    expect(errors.maxQty).toBeUndefined();
  });
});

describe("updateDraft · a published drop's terms are frozen", () => {
  it('refuses an edit with a 409, not a 422', async () => {
    const draft = await createDraft([fixture.merchantId], draftInput());

    // Move it to PUBLISHED directly: publishDrop needs Stripe and a snapshot,
    // neither of which this test is about.
    await prisma.drop.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });

    let caught: unknown;
    try {
      await updateDraft([fixture.merchantId], draft.id, { title: 'Changed my mind' });
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      // 409, because no different body would be accepted — the drop's state is
      // the obstacle. A 422 would invite a client to retry with fixed fields.
      expect(caught.status).toBe(409);
      expect(caught.publicMessage).toMatch(/already live/i);
    }
  });

  it('leaves the stored terms untouched after a refused edit', async () => {
    const draft = await createDraft([fixture.merchantId], draftInput());
    await prisma.drop.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });

    await updateDraft([fixture.merchantId], draft.id, { dealPriceCents: 1200 }).catch(
      () => undefined,
    );

    const after = await getDrop([fixture.merchantId], draft.id);
    // The price a diner was shown must not move after authorisation.
    expect(after.dealPriceCents).toBe(draft.dealPriceCents);
  });

  it('still allows an edit while the drop is a draft', async () => {
    const draft = await createDraft([fixture.merchantId], draftInput());

    const updated = await updateDraft([fixture.merchantId], draft.id, {
      dealPriceCents: 1250,
    });

    expect(updated.dealPriceCents).toBe(1250);
    expect(updated.status).toBe('DRAFT');
  });
});

describe('validateDropTiming · the boundary the create route relies on', () => {
  it('rejects a cutoff more than five days after publish', () => {
    const issues = validateDropTiming(
      {
        cutoffAt: hoursFromNow(24 * 9),
        windowStart: hoursFromNow(24 * 10),
        windowEnd: hoursFromNow(24 * 10 + 2),
      },
      new Date(),
    );

    expect(issues.some((issue) => issue.field === 'cutoffAt')).toBe(true);
  });
});
