import "dotenv/config";

import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { signRedemptionCode } from "@/lib/settlement/redemption-code";
import {
  type SettlementFixtures,
  settlementFixtures,
} from "@/lib/settlement/__tests__/settlement-fixtures";

import { redeemCode } from "../redeem";

/**
 * A foreign `P2002` injected at the exact `tx.redemptionScan.create()` statement.
 *
 * `RedemptionScan` has one unique index — `participantId_scanId` — and a generated
 * `id` primary key. There is no second unique column a test could collide on
 * through the public API, so a real foreign collision on this insert cannot be
 * produced with fixtures alone. The injection below is the smallest honest probe:
 * the surrounding transaction, the `SELECT … FOR UPDATE`, the `UPDATE` and the
 * rollback are all real Postgres work; only the failing statement is substituted.
 *
 * Two shapes are probed because the defect had two halves: an error naming a
 * foreign column, and an error naming no column at all. Both are `P2002`, and the
 * old field-blind check called both a replay.
 */

type TransactionCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;
type TransactionRunner = (callback: TransactionCallback) => Promise<unknown>;

/** Captured before any substitution, so restoring is exact and not a spy artefact. */
const REAL_TRANSACTION = prisma.$transaction.bind(prisma) as TransactionRunner;

const PREFIX = `redeem-fp${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

let merchantId = "";
let itemId = "";

beforeAll(async () => {
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

/**
 * Swap only `create` on the transaction client handed to `claimUnits`, then let
 * the real callback run unchanged. Returns the restore function; `probe` calls it
 * in `finally` so a failed assertion cannot leak the patch into the next test.
 */
function injectP2002AtScanInsert(injected: unknown): () => void {
  const original = prisma.$transaction;
  prisma.$transaction = ((callback: TransactionCallback) =>
    REAL_TRANSACTION(async (tx) => {
      const delegate = tx.redemptionScan as {
        create: Prisma.TransactionClient["redemptionScan"]["create"];
      };
      const create = delegate.create;
      delegate.create = (async () => {
        throw injected;
      }) as unknown as Prisma.TransactionClient["redemptionScan"]["create"];
      try {
        return await callback(tx);
      } finally {
        delegate.create = create;
      }
    })) as unknown as typeof prisma.$transaction;
  return () => {
    prisma.$transaction = original;
  };
}

function p2002(meta?: { target: unknown }): Error & { code: string; meta?: unknown } {
  const error = new Error("Unique constraint failed") as Error & {
    code: string;
    meta?: unknown;
  };
  error.code = "P2002";
  if (meta !== undefined) {
    error.meta = meta;
  }
  return error;
}

/**
 * Real fixtures, a real transaction, one substituted statement. Returns both the
 * thrown value and the resolved outcome so a failure message can show the false
 * claim that was made instead.
 */
async function probe(injected: unknown): Promise<{
  thrown: unknown;
  resolved: unknown;
  redeemedQty: number;
  scans: number;
}> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1000,
    minQty: 1,
    status: "PICKUP_OPEN",
  });
  const participantId = await fx.participant({
    dropId,
    qty: 4,
    chargeStatus: "CAPTURED",
  });
  const code = signRedemptionCode({ participantId, dropId, qty: 4 });
  const session = await prisma.merchantUser.findFirstOrThrow({
    where: { merchantId },
    select: { userId: true },
  });
  const scanId = `foreign-p2002-${participantId}`;
  const restore = injectP2002AtScanInsert(injected);

  let resolved: unknown;
  let thrown: unknown;
  try {
    thrown = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId: session.userId,
      requested: 1,
      scanId,
    }).then(
      (value) => {
        resolved = value;
        return undefined;
      },
      (reason: unknown) => reason,
    );
  } finally {
    restore();
  }

  const row = await prisma.dropParticipant.findUniqueOrThrow({
    where: { id: participantId },
    select: { redeemedQty: true },
  });
  const scans = await prisma.redemptionScan.count({
    where: { participantId, scanId },
  });
  return { thrown, resolved, redeemedQty: row.redeemedQty, scans };
}

describe("redeemCode — a foreign P2002 at the scan insert", () => {
  it("propagates a collision on a different column instead of claiming a replay", async () => {
    const injected = p2002({ target: ["id"] });
    const result = await probe(injected);

    // At HEAD this resolved as ALREADY_REDEEMED: the field-blind predicate could
    // not tell `id` from the scan key, the re-read found no scan row, and the
    // caller was told a plate had been taken by a scan that does not exist.
    expect(
      result.thrown,
      `foreign P2002 must propagate; redeemCode instead returned ${JSON.stringify(result.resolved)}`,
    ).toBe(injected);
    expect(result.redeemedQty).toBe(0);
    expect(result.scans).toBe(0);
  });

  it("propagates a half-reported scan key instead of claiming a replay", async () => {
    // This is the guard on production's `SCAN_KEY_FIELDS`: if it ever shrinks to
    // one column, `['participantId']` becomes a match and this live case turns
    // into a false REPLAYED answer. A single column is not the compound key.
    const injected = p2002({ target: ["participantId"] });
    const result = await probe(injected);

    expect(
      result.thrown,
      `half-reported scan key must propagate; redeemCode instead returned ${JSON.stringify(result.resolved)}`,
    ).toBe(injected);
    expect(result.redeemedQty).toBe(0);
    expect(result.scans).toBe(0);
  });

  it("propagates a collision with no reported target instead of claiming a replay", async () => {
    // A P2002 without `meta.target` cannot be attributed to the scan key. Here a
    // REPLAYED answer would be a guess presented as a fact, so it must surface.
    const injected = p2002();
    const result = await probe(injected);

    expect(
      result.thrown,
      `untargeted P2002 must propagate; redeemCode instead returned ${JSON.stringify(result.resolved)}`,
    ).toBe(injected);
    expect(result.redeemedQty).toBe(0);
    expect(result.scans).toBe(0);
  });
});
