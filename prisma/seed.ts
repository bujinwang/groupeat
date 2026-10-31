import 'dotenv/config';

import { MerchantRole, MerchantStatus, PrismaClient, UserRole } from '@prisma/client';
import { hashSync } from 'bcryptjs';

import { emit } from '../src/lib/analytics/events';
import {
  DEFAULT_FEES,
  checkCostPlausibility,
  minViablePrice,
  validateItemCosts,
} from '../src/lib/guardrail';
import type { CompleteGuardrailInput } from '../src/lib/guardrail';

/**
 * Seed data — ARCHITECTURE-sprint1 T01.
 *
 * 1 ADMIN, 1 ORGANISER (so T03 can demo the role gate), 3 merchants on the
 * default 25% floor and PENDING status, and 7 dishes: the four priced test
 * vectors plus the three edge cases the sprint has to be able to show —
 * not batchable, contains alcohol, and an implausible ingredient cost.
 *
 * Vector E (missing food cost) cannot be seeded: `MenuItem.foodCostCents` is
 * non-nullable by design (PRD-sprint1 §8, ARCHITECTURE-sprint1 A-2). It exists
 * only as a unit-test fixture.
 *
 * Idempotent: every write is an upsert or a lookup-then-update, so running the
 * seed twice is harmless.
 */

const prisma = new PrismaClient();

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'GroupEat!2026';
const BCRYPT_COST = 10;

type SeedItem = {
  name: string;
  description: string;
  menuPriceCents: number;
  foodCostCents: number;
  packagingCents: number;
  batchYield: number;
  prepMinutes: number | null;
  isBatchable: boolean;
  containsAlcohol: boolean;
  category: string;
};

type SeedMerchant = {
  name: string;
  slug: string;
  pickupAddress: string;
  pickupInstructions: string;
  owner: { email: string; name: string };
  items: SeedItem[];
};

const MERCHANTS: readonly SeedMerchant[] = [
  {
    name: 'Beef Bowl',
    slug: 'beef-bowl',
    pickupAddress: '1204 Jasper Ave NW, Edmonton, AB',
    pickupInstructions: 'Ring the bell at the side door. Ask for the batch order.',
    owner: { email: 'bob@beefbowl.ca', name: 'Bob Nakamura' },
    items: [
      {
        name: 'Beef Bowl',
        description: 'Braised beef, rice, pickled cabbage. The flagship batch dish.',
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        batchYield: 30,
        prepMinutes: 6,
        isBatchable: true,
        containsAlcohol: false,
        category: 'Bowls',
      },
      {
        name: 'Steak Sandwich',
        description: 'Ribeye on a toasted bun. Ingredients eat most of the menu price.',
        menuPriceCents: 900,
        foodCostCents: 850,
        packagingCents: 30,
        batchYield: 20,
        prepMinutes: 5,
        isBatchable: true,
        containsAlcohol: false,
        category: 'Sandwiches',
      },
      {
        name: 'Hand-cut Fries',
        description: 'Fried to order, so they cannot be batched.',
        menuPriceCents: 500,
        foodCostCents: 120,
        packagingCents: 30,
        batchYield: 60,
        prepMinutes: 4,
        isBatchable: false,
        containsAlcohol: false,
        category: 'Sides',
      },
      {
        name: 'Beef Bowl — Catering Tray',
        description: 'Same dish, ten servings. Seeded with an implausible ingredient cost.',
        menuPriceCents: 1600,
        foodCostCents: 50,
        packagingCents: 80,
        batchYield: 10,
        prepMinutes: 10,
        isBatchable: true,
        containsAlcohol: false,
        category: 'Bowls',
      },
    ],
  },
  {
    name: 'Latte Bar',
    slug: 'latte-bar',
    pickupAddress: '8710 109 St NW, Edmonton, AB',
    pickupInstructions: 'Order at the end of the counter. Batches are boxed and labelled.',
    owner: { email: 'cara@lattebar.ca', name: 'Cara Lindqvist' },
    items: [
      {
        name: 'Latte',
        description: '12 oz, oat or dairy. A batch of 40 is a normal morning.',
        menuPriceCents: 650,
        foodCostCents: 110,
        packagingCents: 35,
        batchYield: 40,
        prepMinutes: 3,
        isBatchable: true,
        containsAlcohol: false,
        category: 'Coffee',
      },
    ],
  },
  {
    name: 'Duck House',
    slug: 'duck-house',
    pickupAddress: '10445 124 St NW, Edmonton, AB',
    pickupInstructions: 'Pickup at the bar. Bring the redemption code.',
    owner: { email: 'dev@duckhouse.ca', name: 'Dev Sandhu' },
    items: [
      {
        name: 'Duck Confit',
        description: 'Slow-cooked leg, potatoes, greens. Expensive ingredients, little room.',
        menuPriceCents: 1200,
        foodCostCents: 660,
        packagingCents: 50,
        batchYield: 20,
        prepMinutes: 12,
        isBatchable: true,
        containsAlcohol: false,
        category: 'Mains',
      },
      {
        name: 'House Red (Bottle)',
        description: 'AGLC: alcohol may never appear in a drop. Seeded to prove the block.',
        menuPriceCents: 1100,
        foodCostCents: 350,
        packagingCents: 60,
        batchYield: 24,
        prepMinutes: null,
        isBatchable: true,
        containsAlcohol: true,
        category: 'Drinks',
      },
    ],
  },
];

function toGuardrailInput(item: SeedItem, floorPctOfMenu: number): CompleteGuardrailInput {
  return {
    ...DEFAULT_FEES,
    menuPriceCents: item.menuPriceCents,
    foodCostCents: item.foodCostCents,
    packagingCents: item.packagingCents,
    floorPctOfMenu,
  };
}

function assertSeedItemsAreValid(): void {
  const problems: string[] = [];

  for (const merchant of MERCHANTS) {
    for (const item of merchant.items) {
      const issues = validateItemCosts({
        menuPriceCents: item.menuPriceCents,
        foodCostCents: item.foodCostCents,
        packagingCents: item.packagingCents,
        batchYield: item.batchYield,
        prepMinutes: item.prepMinutes,
      });
      for (const issue of issues) {
        problems.push(`${merchant.slug}/${item.name}: ${issue.field} ${issue.code}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Seed data violates the cost invariant:\n${problems.join('\n')}`);
  }
}

async function main(): Promise<void> {
  assertSeedItemsAreValid();

  const passwordHash = hashSync(SEED_PASSWORD, BCRYPT_COST);

  // ---- admin --------------------------------------------------------------
  const admin = await prisma.user.upsert({
    where: { email: 'ops@groupeat.ca' },
    update: { role: UserRole.ADMIN },
    create: {
      email: 'ops@groupeat.ca',
      name: 'GroupEat Ops',
      passwordHash,
      role: UserRole.ADMIN,
      mustChangePassword: false,
    },
  });

  // ---- organiser (placeholder surface only in Sprint 1) --------------------
  const organiser = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: { role: UserRole.ORGANISER },
    create: {
      email: 'alice@example.com',
      name: 'Alice Chen',
      passwordHash,
      role: UserRole.ORGANISER,
      mustChangePassword: true,
    },
  });

  await prisma.organiserProfile.upsert({
    where: { userId: organiser.id },
    update: { displayName: 'Alice Chen' },
    create: { userId: organiser.id, displayName: 'Alice Chen', commissionPct: 5.0 },
  });

  // ---- merchants, owners, dishes -----------------------------------------
  for (const seedMerchant of MERCHANTS) {
    const merchant = await prisma.merchant.upsert({
      where: { slug: seedMerchant.slug },
      update: {
        name: seedMerchant.name,
        pickupAddress: seedMerchant.pickupAddress,
        pickupInstructions: seedMerchant.pickupInstructions,
      },
      create: {
        name: seedMerchant.name,
        slug: seedMerchant.slug,
        status: MerchantStatus.PENDING,
        floorPctOfMenu: 0.25,
        pickupAddress: seedMerchant.pickupAddress,
        pickupInstructions: seedMerchant.pickupInstructions,
      },
    });

    const owner = await prisma.user.upsert({
      where: { email: seedMerchant.owner.email },
      update: { role: UserRole.MERCHANT },
      create: {
        email: seedMerchant.owner.email,
        name: seedMerchant.owner.name,
        passwordHash,
        role: UserRole.MERCHANT,
        mustChangePassword: true,
      },
    });

    await prisma.merchantUser.upsert({
      where: { merchantId_userId: { merchantId: merchant.id, userId: owner.id } },
      update: { role: MerchantRole.OWNER },
      create: { merchantId: merchant.id, userId: owner.id, role: MerchantRole.OWNER },
    });

    // The Decimal boundary: floorPctOfMenu must become a number before it can
    // enter the guardrail (ARCHITECTURE-sprint1 §3.5 footgun).
    const floorPctOfMenu = Number(merchant.floorPctOfMenu);

    for (const item of seedMerchant.items) {
      const existing = await prisma.menuItem.findFirst({
        where: { merchantId: merchant.id, name: item.name },
        select: { id: true },
      });

      const data = {
        merchantId: merchant.id,
        name: item.name,
        description: item.description,
        menuPriceCents: item.menuPriceCents,
        foodCostCents: item.foodCostCents,
        packagingCents: item.packagingCents,
        batchYield: item.batchYield,
        prepMinutes: item.prepMinutes,
        isBatchable: item.isBatchable,
        containsAlcohol: item.containsAlcohol,
        category: item.category,
      };

      const saved = existing
        ? await prisma.menuItem.update({ where: { id: existing.id }, data })
        : await prisma.menuItem.create({ data });

      const input = toGuardrailInput(item, floorPctOfMenu);
      const minViable = minViablePrice(input);
      const warnings = checkCostPlausibility(input);

      const priceLabel =
        minViable === null ? 'no viable price' : `$${(minViable / 100).toFixed(2)}`;
      const flags: string[] = [];
      if (!item.isBatchable) flags.push('not batchable');
      if (item.containsAlcohol) flags.push('contains alcohol');
      if (warnings.length > 0) flags.push(warnings.join(','));

      console.log(
        `  · ${seedMerchant.slug} / ${item.name}: ${priceLabel}${
          flags.length > 0 ? ` [${flags.join(' | ')}]` : ''
        }`,
      );

      for (const warning of warnings) {
        // Lead's addition: a non-blocking plausibility warning is recorded so the
        // weekly report can echo it (PRD-sprint1 §7.4). No table in this migration.
        emit('food_cost_implausible', {
          itemId: saved.id,
          merchantId: merchant.id,
          warning,
          foodCostCents: item.foodCostCents,
          menuPriceCents: item.menuPriceCents,
        });
      }
    }
  }

  console.log('');
  console.log('Seed complete.');
  console.log(`  admin:      ops@groupeat.ca (${admin.role})`);
  console.log(`  organiser:  alice@example.com`);
  console.log(`  merchants:  ${MERCHANTS.map((m) => `${m.name} (${m.slug})`).join(', ')}`);
  console.log(`  password:   ${process.env.SEED_PASSWORD ? 'SEED_PASSWORD from .env' : 'default (see .env.example)'}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
