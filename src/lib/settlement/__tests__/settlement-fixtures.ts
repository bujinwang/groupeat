import 'dotenv/config';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES, buildGuardrailSnapshot, readGuardrailSnapshot } from '@/lib/guardrail';

import { platformFeeCentsForOrder } from '../platform-fee';

/**
 * Fixtures for the settlement tests — real Postgres, created and torn down per
 * file, following `src/lib/drops/__tests__/draft-validation.test.ts`.
 *
 * Every test file gets its own `settlementFixtures(prefix)` and calls
 * `cleanup()` in `afterAll`. Ids are tracked as they are created rather than
 * discovered by pattern at teardown, so a test that fails half way still leaves
 * the database as it found it.
 *
 * ## Why the drop is created directly rather than through `createDraft`
 *
 * These tests are about what happens to a drop *after* it is published, and half
 * of them need a drop in a state `publishDrop` refuses to produce (`LOCKED`,
 * `FAILED`, a missing `stripeAccountId`). Going through the publish path would
 * need Stripe and a frozen snapshot for every case, and would test the publish
 * gate instead of settlement.
 */

/**
 * Every value of `DropStatus`, transcribed from `prisma/schema.prisma` in the
 * order the enum declares them.
 *
 * Exists so a test can iterate all of them and still have TypeScript check each
 * one — a hardcoded `['FAILED', 'CAPTURED']` inside a test is how a status gets
 * forgotten when the enum grows. `void-status.registry.test.ts` is the consumer
 * that matters: it fails if this list and the enum ever disagree.
 *
 * Kept in the fixtures rather than in one test file because two tests now need it.
 */
export const ALL_DROP_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type DropStatusLiteral = (typeof ALL_DROP_STATUSES)[number];

export type DropSpec = {
  merchantId: string;
  menuItemId: string;
  dealPriceCents: number;
  minQty: number;
  maxQty?: number;
  /**
   * Default `PUBLISHED`.
   *
   * Widened from four literals to the whole enum so the status-list tests can
   * create a drop in any state. These fixtures bypass `publishDrop` on purpose
   * (see the module docblock), so no state is off-limits here.
   */
  status?: DropStatusLiteral;
  /** Default: one hour ago — i.e. already due. */
  cutoffAt?: Date;
  lockedAt?: Date | null;
  windowStart?: Date;
  windowEnd?: Date;
};

export type ParticipantSpec = {
  dropId: string;
  qty: number;
  /** Default: `qty × dealPriceCents` of the drop this participant belongs to. */
  amountCents?: number;
  /**
   * Default: `platformFeeCentsForOrder()` against the drop's **frozen** snapshot.
   *
   * It used to default to `0`, which quietly made every test that omitted it
   * describe a row the join path must never write: a participant with `qty: 10`
   * and a fee of nothing. Settlement reads the stored fee verbatim and never
   * recomputes it (design §11.1), so those tests still passed — they were simply
   * not describing reality, and the one number in the system that depends on a
   * rounding rule nobody had implemented was the one nobody had to supply.
   *
   * Now the default *is* the obligation. A test that wants a wrong fee to see what
   * happens still passes one explicitly, which is the only case where `0` belongs.
   */
  platformFeeCents?: number;
  authStatus?: 'PENDING' | 'AUTHORIZED' | 'FAILED' | 'VOIDED' | 'EXPIRED';
  chargeStatus?: 'NONE' | 'CAPTURED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED';
  /** Default: a generated, unique `pi_…`. Pass `null` to model the data error. */
  paymentIntentId?: string | null;
  redemptionCode?: string | null;
};

const HOUR = 60 * 60 * 1000;

export function settlementFixtures(prefix: string) {
  const merchantIds: string[] = [];
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const dropIds: string[] = [];
  const itemIds: string[] = [];

  let phoneSeq = 0;
  let codeSeq = 0;
  let piSeq = 0;

  return {
    nextPaymentIntentId(): string {
      piSeq += 1;
      return `pi_${prefix}_${piSeq}`;
    },

    async merchant(stripeAccountId: string | null = 'acct_test_settlement'): Promise<string> {
      const user = await prisma.user.create({
        data: {
          email: `${prefix}-${Date.now()}-${userIds.length}@example.test`,
          passwordHash: 'not-a-real-hash',
          role: 'MERCHANT',
          mustChangePassword: true,
        },
        select: { id: true },
      });
      userIds.push(user.id);

      const merchant = await prisma.merchant.create({
        data: {
          name: `${prefix} merchant`,
          slug: `${prefix}-${Date.now()}-${merchantIds.length}`,
          status: 'ACTIVE',
          stripeAccountId,
          floorPctOfMenu: 0.25,
          users: { create: { userId: user.id, role: 'OWNER' } },
        },
        select: { id: true },
      });
      merchantIds.push(merchant.id);
      return merchant.id;
    },

    async item(merchantId: string): Promise<string> {
      const item = await prisma.menuItem.create({
        data: {
          merchantId,
          name: `${prefix} bowl`,
          menuPriceCents: 1600,
          foodCostCents: 480,
          packagingCents: 80,
          batchYield: 60,
          prepMinutes: 6,
          isBatchable: true,
          containsAlcohol: false,
          category: 'Bowls',
        },
        select: { id: true },
      });
      itemIds.push(item.id);
      return item.id;
    },

    async drop(spec: DropSpec): Promise<string> {
      const now = Date.now();
      codeSeq += 1;
      const snapshot = buildGuardrailSnapshot(
        {
          ...DEFAULT_FEES,
          menuPriceCents: 1600,
          foodCostCents: 480,
          packagingCents: 80,
          floorPctOfMenu: 0.25,
        },
        spec.dealPriceCents,
        new Date(now).toISOString(),
      );

      const drop = await prisma.drop.create({
        data: {
          merchantId: spec.merchantId,
          menuItemId: spec.menuItemId,
          publicCode: `${prefix}${codeSeq}`.toUpperCase().slice(0, 24),
          title: `${prefix} drop ${codeSeq}`,
          dealPriceCents: spec.dealPriceCents,
          minQty: spec.minQty,
          maxQty: spec.maxQty ?? Math.max(spec.minQty * 2, spec.minQty + 1),
          maxPerCustomer: 4,
          cutoffAt: spec.cutoffAt ?? new Date(now - HOUR),
          windowStart: spec.windowStart ?? new Date(now + HOUR),
          windowEnd: spec.windowEnd ?? new Date(now + 2 * HOUR),
          status: spec.status ?? 'PUBLISHED',
          guardrailSnapshot: snapshot,
          publishedAt: new Date(now - 2 * HOUR),
          lockedAt: spec.lockedAt ?? null,
        },
        select: { id: true },
      });
      dropIds.push(drop.id);
      return drop.id;
    },

    async participant(spec: ParticipantSpec): Promise<string> {
      const drop = await prisma.drop.findUniqueOrThrow({
        where: { id: spec.dropId },
        select: { dealPriceCents: true, guardrailSnapshot: true },
      });
      phoneSeq += 1;

      const customer = await prisma.customer.create({
        data: { phone: `+1555${prefix.replace(/\D/g, '').slice(0, 6)}${String(phoneSeq).padStart(4, '0')}` },
        select: { id: true },
      });
      customerIds.push(customer.id);

      const participant = await prisma.dropParticipant.create({
        data: {
          dropId: spec.dropId,
          customerId: customer.id,
          qty: spec.qty,
          amountCents: spec.amountCents ?? spec.qty * drop.dealPriceCents,
          platformFeeCents:
            spec.platformFeeCents ??
            platformFeeCentsForOrder({
              qty: spec.qty,
              // The stored price, not a constant: a fixture drop can be created at
              // any price and the fee must follow it.
              dealPriceCents: drop.dealPriceCents,
              // The frozen constants, read through the validating reader — so this
              // default fails loudly if a snapshot is unreadable rather than
              // silently producing `NaN` money.
              fees: readGuardrailSnapshot(drop.guardrailSnapshot).input,
            }),
          authStatus: spec.authStatus ?? 'AUTHORIZED',
          chargeStatus: spec.chargeStatus ?? 'NONE',
          paymentIntentId:
            spec.paymentIntentId === null
              ? null
              : (spec.paymentIntentId ?? `pi_${prefix}_${++piSeq}`),
          redemptionCode: spec.redemptionCode ?? null,
        },
        select: { id: true },
      });
      return participant.id;
    },

    async cleanup(): Promise<void> {
      // Ledger rows have no foreign key (design §5), so nothing cascades to them.
      if (dropIds.length > 0) {
        await prisma.ledgerEntry.deleteMany({ where: { dropId: { in: dropIds } } }).catch(() => undefined);
        // Cascades participants and orders.
        await prisma.drop.deleteMany({ where: { id: { in: dropIds } } }).catch(() => undefined);
      }
      if (customerIds.length > 0) {
        await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => undefined);
      }
      if (itemIds.length > 0) {
        await prisma.menuItem.deleteMany({ where: { id: { in: itemIds } } }).catch(() => undefined);
      }
      if (merchantIds.length > 0) {
        await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => undefined);
      }
      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
      }
      await prisma.$disconnect();
    },
  };
}

export type SettlementFixtures = ReturnType<typeof settlementFixtures>;
