import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { signRedemptionCode } from "@/lib/settlement/redemption-code";
import {
  type SettlementFixtures,
  settlementFixtures,
} from "@/lib/settlement/__tests__/settlement-fixtures";

import { REFUSAL_COPY, type RefusalReason } from "../rules";
import { redeemCode } from "../redeem";

/**
 * Redemption against real Postgres — FR-601…FR-605.
 *
 * ## Why not a fake
 *
 * The invariant this file exists for is *"`redeemedQty` never exceeds `qty` under
 * concurrent scans"*, and that invariant does not live in TypeScript. It lives in
 * `SELECT … FOR UPDATE` and in Postgres's EvalPlanQual re-check. A mocked Prisma
 * would happily run both of my concurrent calls one after the other and pass.
 *
 * The settlement suite already established this shape (`cutoff-decision.concurrency
 * .test.ts`): two `Promise.all` calls against one row, then assert on what the
 * database actually contains.
 *
 * ## The codes
 *
 * Signed with the ambient secret (`signRedemptionCode(payload)` with no second
 * argument), because `redeemCode` verifies with the ambient secret too. Using a
 * test secret would only prove that two different keys disagree.
 */

const PREFIX = `redeem${Date.now()}`;
const fx: SettlementFixtures = settlementFixtures(PREFIX);

let merchantId = "";
let otherMerchantId = "";
let itemId = "";

/**
 * Accounts this file creates — the second scanner in the audit-trail test.
 *
 * `fx.cleanup()` handles the drop, its participants and its customers; a `User` made
 * here is not its business. That scanner was leaking one account per run.
 */
const createdUserIds: string[] = [];

beforeAll(async () => {
  merchantId = await fx.merchant();
  otherMerchantId = await fx.merchant("acct_test_other");
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  // Every step attempted, and the run still fails if any of them did — a throw in step
  // one must not skip the rest, or a failing run leaks more than a passing one.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // The extra scanner, then the fixtures. `MerchantUser` has no cascade from `User`, so
  // the membership must go before the account it points at.
  if (createdUserIds.length > 0) {
    await step(() =>
      prisma.merchantUser.deleteMany({
        where: { userId: { in: createdUserIds } },
      }),
    );
    await step(() =>
      prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }),
    );
  }
  await step(() => fx.cleanup());

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `teardown left the database dirty (${failures.length} step(s) failed)`,
    );
  }
});

/**
 * A participant who has been charged and whose drop is at the pickup window —
 * i.e. a code that *should* work. Every test starts from this and breaks exactly
 * one thing, so a failure names the thing that was broken.
 */
async function collectable(args: {
  qty: number;
  merchant?: string;
  item?: string;
  dropStatus?:
    "PICKUP_OPEN" | "CAPTURED" | "FAILED" | "CANCELLED" | "COMPLETED";
  chargeStatus?:
    "CAPTURED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "FAILED" | "NONE";
}): Promise<{ dropId: string; participantId: string; code: string }> {
  const dropId = await fx.drop({
    merchantId: args.merchant ?? merchantId,
    menuItemId: args.item ?? itemId,
    dealPriceCents: 1000,
    minQty: 1,
    status: args.dropStatus ?? "PICKUP_OPEN",
  });
  const participantId = await fx.participant({
    dropId,
    qty: args.qty,
    chargeStatus: args.chargeStatus ?? "CAPTURED",
  });
  const code = signRedemptionCode({ participantId, dropId, qty: args.qty });
  return { dropId, participantId, code };
}

async function rowOf(participantId: string) {
  return prisma.dropParticipant.findUniqueOrThrow({
    where: { id: participantId },
    select: {
      qty: true,
      redeemedQty: true,
      redeemedAt: true,
      redeemedByUserId: true,
    },
  });
}

/** A `User.id` to attribute the scan to. Reuses the merchant's owner. */
async function staffUserId(merchant: string): Promise<string> {
  const row = await prisma.merchantUser.findFirstOrThrow({
    where: { merchantId: merchant },
    select: { userId: true },
  });
  return row.userId;
}

describe("redeemCode — the happy path", () => {
  it("takes every remaining plate, records who took it, and stamps the time", async () => {
    const { participantId, code } = await collectable({ qty: 3 });
    const userId = await staffUserId(merchantId);

    const before = new Date();
    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });

    expect(outcome.kind).toBe("REDEEMED");
    if (outcome.kind !== "REDEEMED") throw new Error("expected REDEEMED");

    // 3 plates asked for, 3 taken, 0 left — all three numbers stated separately
    // because a bug that swapped `taken` and `redeemedQty` would still look fine
    // if only one of them were asserted.
    expect(outcome.qty).toBe(3);
    expect(outcome.taken).toBe(3);
    expect(outcome.redeemedQty).toBe(3);
    expect(outcome.remaining).toBe(0);
    expect(outcome.participantId).toBe(participantId);

    const row = await rowOf(participantId);
    expect(row.redeemedQty).toBe(3);
    expect(row.redeemedByUserId).toBe(userId);
    expect(row.redeemedAt).not.toBeNull();
    // Against the wall clock on **both** sides. The upper bound costs nothing and
    // catches the failure this assertion was written for: `redeemedAt` is a
    // `timestamp without time zone`, so a bare `NOW()` stores the server's *local*
    // wall time, and on an Edmonton machine that is a 7-hour error that still looks
    // like a plausible timestamp. A lower bound alone would pass for a stale value
    // and an upper bound alone would pass for a future one.
    expect(row.redeemedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(row.redeemedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("takes a partial quantity when the diner says how many they are collecting", async () => {
    const { participantId, code } = await collectable({ qty: 4 });
    const userId = await staffUserId(merchantId);

    const first = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
      requested: 2,
    });
    if (first.kind !== "REDEEMED") throw new Error("expected REDEEMED");
    expect(first.taken).toBe(2);
    expect(first.remaining).toBe(2);

    const second = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    if (second.kind !== "REDEEMED") throw new Error("expected REDEEMED");
    expect(second.taken).toBe(2);
    expect(second.redeemedQty).toBe(4);
    expect(second.remaining).toBe(0);

    expect((await rowOf(participantId)).redeemedQty).toBe(4);
  });

  it("unwraps a code that arrived as a URL from the scanner", async () => {
    const { participantId, code } = await collectable({ qty: 1 });
    const userId = await staffUserId(merchantId);

    const outcome = await redeemCode({
      code: `https://groupeat.ca/c/${code}`,
      merchantIds: [merchantId],
      userId,
    });

    expect(outcome.kind).toBe("REDEEMED");
    expect((await rowOf(participantId)).redeemedQty).toBe(1);
  });

  it("reports the diner's name so the counter can check it against a face", async () => {
    const { participantId, code } = await collectable({ qty: 1 });
    const userId = await staffUserId(merchantId);

    const participant = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { customerId: true },
    });
    await prisma.customer.update({
      where: { id: participant.customerId },
      data: { name: "Wei Chen" },
    });

    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    if (outcome.kind !== "REDEEMED") throw new Error("expected REDEEMED");
    expect(outcome.name).toBe("Wei Chen");
  });
});

describe("redeemCode — the double scan (FR-605)", () => {
  it("is idempotent and answers with the time of the FIRST collection", async () => {
    const { participantId, code } = await collectable({ qty: 2 });
    const userId = await staffUserId(merchantId);

    await redeemCode({ code, merchantIds: [merchantId], userId });
    const firstTime = (await rowOf(participantId)).redeemedAt;
    expect(firstTime).not.toBeNull();

    const second = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });

    // Not a refusal, not a 409: FR-605 says a double scan shows "already
    // redeemed at {time}". A queue is full of double taps.
    expect(second.kind).toBe("ALREADY_REDEEMED");
    if (second.kind !== "ALREADY_REDEEMED")
      throw new Error("expected ALREADY_REDEEMED");
    expect(second.redeemedQty).toBe(2);
    expect(second.qty).toBe(2);

    // The stored time did not move. That is the assertion FR-605 needs: the staff
    // member remembers the first scan, not the most recent one.
    const row = await rowOf(participantId);
    expect(row.redeemedQty).toBe(2);
    expect(row.redeemedAt?.getTime()).toBe(firstTime?.getTime());
  });

  it("does not write a second time, so the audit trail keeps the original scanner", async () => {
    const { participantId, code } = await collectable({ qty: 1 });
    const firstUserId = await staffUserId(merchantId);

    await redeemCode({ code, merchantIds: [merchantId], userId: firstUserId });

    // A second user with access to the same merchant, scanning the same code.
    const other = await prisma.user.create({
      data: {
        email: `${PREFIX}-second-${Date.now()}@example.test`,
        passwordHash: "not-a-real-hash",
        role: "MERCHANT",
        mustChangePassword: true,
      },
      select: { id: true },
    });
    createdUserIds.push(other.id);
    await prisma.merchantUser.create({
      data: { merchantId, userId: other.id, role: "STAFF" },
    });

    await redeemCode({ code, merchantIds: [merchantId], userId: other.id });

    const row = await rowOf(participantId);
    expect(row.redeemedByUserId).toBe(firstUserId);
  });
});

describe("redeemCode — concurrency", () => {
  it("never hands out more plates than were paid for, when two counters scan at once", async () => {
    // Three plates, two staff, two plates each: exactly one of them must be told
    // they could only have part of what they asked for.
    const { participantId, code } = await collectable({ qty: 3 });
    const userId = await staffUserId(merchantId);

    const outcomes = await Promise.all([
      redeemCode({ code, merchantIds: [merchantId], userId, requested: 2 }),
      redeemCode({ code, merchantIds: [merchantId], userId, requested: 2 }),
    ]);

    const taken = outcomes.reduce(
      (sum, outcome) =>
        sum +
        (outcome.kind === "REDEEMED" || outcome.kind === "PARTIAL"
          ? outcome.taken
          : 0),
      0,
    );

    // The invariant, asserted on the database rather than on the return values:
    // 3 plates are 3 plates whatever the two screens said.
    const row = await rowOf(participantId);
    expect(row.redeemedQty).toBe(3);
    expect(row.redeemedQty).toBeLessThanOrEqual(row.qty);

    // And the reports agree with it. A loser that claimed units it did not get
    // would show up here as `taken !== 3`.
    expect(taken).toBe(3);
  });

  it("answers the loser truthfully instead of taking the plate twice", async () => {
    // One plate, two scans: the second must not take anything.
    const { participantId, code } = await collectable({ qty: 1 });
    const userId = await staffUserId(merchantId);

    const outcomes = await Promise.all([
      redeemCode({ code, merchantIds: [merchantId], userId }),
      redeemCode({ code, merchantIds: [merchantId], userId }),
    ]);

    const redeemed = outcomes.filter((outcome) => outcome.kind === "REDEEMED");
    const already = outcomes.filter(
      (outcome) => outcome.kind === "ALREADY_REDEEMED",
    );

    expect(redeemed).toHaveLength(1);
    expect(already).toHaveLength(1);

    // The loser still learns *when*: FR-605 applies to the racing staff member
    // just as much as to the one who double-taps thirty seconds later.
    const loser = already[0];
    if (loser?.kind !== "ALREADY_REDEEMED")
      throw new Error("expected ALREADY_REDEEMED");
    expect(loser.redeemedAt).not.toBeNull();

    expect((await rowOf(participantId)).redeemedQty).toBe(1);
  });

  it("holds the invariant across sixteen simultaneous scans", async () => {
    // The honest version of the previous test: a queue, not two taps. If the lock
    // is missing or the clamp is outside it, this is the test that catches it —
    // concurrency bugs need enough contenders to lose the race on purpose.
    const qty = 5;
    const { participantId, code } = await collectable({ qty });
    const userId = await staffUserId(merchantId);

    const outcomes = await Promise.all(
      Array.from({ length: 16 }, () =>
        redeemCode({ code, merchantIds: [merchantId], userId }),
      ),
    );

    const row = await rowOf(participantId);
    expect(row.redeemedQty).toBe(qty);
    expect(row.redeemedQty).toBeLessThanOrEqual(row.qty);

    const taken = outcomes.reduce(
      (sum, outcome) =>
        sum +
        (outcome.kind === "REDEEMED" || outcome.kind === "PARTIAL"
          ? outcome.taken
          : 0),
      0,
    );
    expect(taken).toBe(qty);

    // Every scan got an answer that was one of the four designed outcomes. No
    // throws, no undefined.
    for (const outcome of outcomes) {
      expect(["REDEEMED", "PARTIAL", "ALREADY_REDEEMED"]).toContain(
        outcome.kind,
      );
    }
  });
});

describe("redeemCode — refusals, one per reason", () => {
  it("refuses a code it did not sign", async () => {
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code: "v1.not-a-code.nope",
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "BAD_CODE" });
  });

  it("refuses an empty scan without touching the database", async () => {
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code: "   ",
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "BAD_CODE" });
  });

  it("refuses when the user has no merchant at all", async () => {
    const { code } = await collectable({ qty: 1 });
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({ code, merchantIds: [], userId });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "NOT_YOUR_DROP" });
  });

  it("refuses a code belonging to another merchant, indistinguishably from an unknown order", async () => {
    const { participantId, code } = await collectable({ qty: 1 });
    const userId = await staffUserId(merchantId);

    const outcome = await redeemCode({
      code,
      merchantIds: [otherMerchantId],
      userId,
    });

    expect(outcome).toEqual({ kind: "REFUSED", reason: "NOT_YOUR_DROP" });
    // Nothing was taken.
    expect((await rowOf(participantId)).redeemedQty).toBe(0);

    // The copy is byte-identical to the unknown-order case, or a valid code
    // becomes a probe for drop ids. Asserted on the strings, not on intent.
    expect(REFUSAL_COPY.NOT_YOUR_DROP).toEqual(
      REFUSAL_COPY.UNKNOWN_PARTICIPANT,
    );
  });

  it("refuses a code whose signed drop does not match the order", async () => {
    const { participantId } = await collectable({ qty: 1 });
    const userId = await staffUserId(merchantId);

    // A code that verifies, but names a different drop than the row it points at.
    const code = signRedemptionCode({
      participantId,
      dropId: "some-other-drop-id",
      qty: 1,
    });

    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "NOT_YOUR_DROP" });
    expect((await rowOf(participantId)).redeemedQty).toBe(0);
  });

  it("refuses a drop that is merely CAPTURED — capture is not the pickup window", async () => {
    // The deliberate exclusion in `REDEEMABLE_STATUSES`. Capture happens at the
    // cutoff, which can be the day before; the kitchen has not cooked.
    const { participantId, code } = await collectable({
      qty: 1,
      dropStatus: "CAPTURED",
    });
    const userId = await staffUserId(merchantId);

    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "NOT_YET" });
    expect((await rowOf(participantId)).redeemedQty).toBe(0);
  });

  it("still redeems on a COMPLETED drop, because the food is still owed", async () => {
    // `COMPLETED` is when the *merchant* finished; a late diner is still owed
    // their order, and refusing them would mean the merchant kept the money.
    const { code } = await collectable({ qty: 1, dropStatus: "COMPLETED" });
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome.kind).toBe("REDEEMED");
  });

  it("refuses a drop that failed its threshold", async () => {
    const { code } = await collectable({
      qty: 1,
      dropStatus: "FAILED",
      chargeStatus: "NONE",
    });
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "DROP_FAILED" });
  });

  it("refuses a cancelled drop", async () => {
    const { code } = await collectable({
      qty: 1,
      dropStatus: "CANCELLED",
      chargeStatus: "NONE",
    });
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "DROP_CANCELLED" });
  });

  it("refuses a refunded order even though the drop is at the window", async () => {
    const { participantId, code } = await collectable({
      qty: 2,
      chargeStatus: "REFUNDED",
    });
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "REFUNDED" });
    expect((await rowOf(participantId)).redeemedQty).toBe(0);
  });

  it("refuses a partially refunded order", async () => {
    const { code } = await collectable({
      qty: 2,
      chargeStatus: "PARTIALLY_REFUNDED",
    });
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "REFUNDED" });
  });

  it("refuses a declined card", async () => {
    const { participantId, code } = await collectable({
      qty: 1,
      chargeStatus: "FAILED",
    });
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "NOT_CHARGED" });
    expect((await rowOf(participantId)).redeemedQty).toBe(0);
  });

  it("refuses an order that was never charged", async () => {
    const { code } = await collectable({ qty: 1, chargeStatus: "NONE" });
    const userId = await staffUserId(merchantId);
    const outcome = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(outcome).toEqual({ kind: "REFUSED", reason: "NOT_CHARGED" });
  });

  it("has copy for every reason it can produce", async () => {
    // The compile-time guarantee (`Record<RefusalReason, …>`) is the real check;
    // this asserts the values are non-empty, because a blank red box at a counter
    // is worse than a wrong one.
    const reasons: RefusalReason[] = [
      "BAD_CODE",
      "UNKNOWN_PARTICIPANT",
      "NOT_YOUR_DROP",
      "NOT_YET",
      "DROP_FAILED",
      "DROP_CANCELLED",
      "NOT_CHARGED",
      "REFUNDED",
      "FULLY_REDEEMED",
    ];
    for (const reason of reasons) {
      expect(REFUSAL_COPY[reason].title.length).toBeGreaterThan(0);
      expect(REFUSAL_COPY[reason].detail.length).toBeGreaterThan(0);
    }
  });
});

/**
 * FR-606 — the replay, which is the reason the idempotency key exists.
 *
 * ## The bug this pins
 *
 * `redeemedQty` is incremented by `take`, so a **per-unit** redeem replayed after a
 * lost response took a second plate. Measured against this database before the fix:
 * first scan (`requested: 1`) → `redeemedQty = 1`; the byte-identical replay →
 * `redeemedQty = 2`. A whole-order scan was accidentally safe — a replay re-reads
 * `remaining = 0` and answers `ALREADY_REDEEMED` — which is exactly why the bug
 * survived: the common path hid it and only per-unit exposed it.
 *
 * Every other test in this file omits `scanId`, and that is deliberate: no key means
 * no dedupe, which is the pre-FR-606 behaviour those tests describe. These are the
 * only ones that opt in.
 */
describe("redeemCode — FR-606 idempotent replay", () => {
  it("does not take a second plate when the same scanId is replayed", async () => {
    const { participantId, code } = await collectable({ qty: 4 });
    const userId = await staffUserId(merchantId);
    const scanId = "scan-replay-1";

    const first = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
      requested: 1,
      scanId,
    });
    expect(first.kind).toBe("REDEEMED");
    if (first.kind !== "REDEEMED") throw new Error("expected REDEEMED");
    expect(first.taken).toBe(1);
    expect((await rowOf(participantId)).redeemedQty).toBe(1);

    // The retry: identical request, identical key.
    const replay = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
      requested: 1,
      scanId,
    });

    // This is the whole point. Before the key existed this was `REDEEMED` with
    // `redeemedQty = 2` — two plates for one scan.
    expect(replay.kind).toBe("ALREADY_REDEEMED");
    expect((await rowOf(participantId)).redeemedQty).toBe(1);

    // And exactly one scan row, not two.
    const scans = await prisma.redemptionScan.count({
      where: { participantId, scanId },
    });
    expect(scans).toBe(1);
  });

  it("reports the quantity the original scan took, not the one the retry asked for", async () => {
    // The retry may arrive with a different `requested` (a client that lost its
    // response re-derives it from a UI that moved on). It still must be answered
    // with what actually happened, or the screen tells staff the wrong number.
    const { participantId, code } = await collectable({ qty: 4 });
    const userId = await staffUserId(merchantId);
    const scanId = "scan-replay-2";

    const first = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
      requested: 2,
      scanId,
    });
    if (first.kind !== "REDEEMED") throw new Error("expected REDEEMED");
    expect(first.taken).toBe(2);

    const replay = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
      requested: 1,
      scanId,
    });
    expect(replay.kind).toBe("ALREADY_REDEEMED");
    if (replay.kind !== "ALREADY_REDEEMED")
      throw new Error("expected ALREADY_REDEEMED");
    // The row says 2 collected, and that is what the screen must show.
    expect(replay.redeemedQty).toBe(2);
    expect((await rowOf(participantId)).redeemedQty).toBe(2);
  });

  it("still lets a DIFFERENT scan of the same code take more plates", async () => {
    // The key identifies the *attempt*, not the order. Two staff members scanning
    // the same receipt at two counters are two legitimate scans, and keying on the
    // code instead would silently refuse the second one — a worse bug than the one
    // being fixed, because it looks like "already collected".
    const { participantId, code } = await collectable({ qty: 4 });
    const userId = await staffUserId(merchantId);

    const first = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
      requested: 1,
      scanId: "scan-a",
    });
    expect(first.kind).toBe("REDEEMED");

    const second = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
      requested: 1,
      scanId: "scan-b",
    });
    expect(second.kind).toBe("REDEEMED");
    if (second.kind !== "REDEEMED") throw new Error("expected REDEEMED");
    expect(second.taken).toBe(1);
    expect((await rowOf(participantId)).redeemedQty).toBe(2);
  });

  it("takes exactly one plate when two concurrent retries of one scan race", async () => {
    // The condition a queue actually produces on a flaky network: the retry fires
    // before the first response is handled, so both arrive together. The unique
    // index is the arbiter — one wins the claim, the other is told to re-read.
    const { participantId, code } = await collectable({ qty: 4 });
    const userId = await staffUserId(merchantId);
    const scanId = "scan-race";

    const outcomes = await Promise.all([
      redeemCode({
        code,
        merchantIds: [merchantId],
        userId,
        requested: 1,
        scanId,
      }),
      redeemCode({
        code,
        merchantIds: [merchantId],
        userId,
        requested: 1,
        scanId,
      }),
    ]);

    // One plate, never two — regardless of which request won.
    expect((await rowOf(participantId)).redeemedQty).toBe(1);

    const redeems = outcomes.filter((outcome) => outcome.kind === "REDEEMED");
    expect(redeems.length).toBe(1);

    // The loser is answered as a replay, not as a spent retry budget. That matters
    // because the retry-exhausted path re-reads the row and would tell the diner
    // "already collected" even when nothing was collected — the exact wrong answer
    // if the winner's claim had not committed.
    const losers = outcomes.filter(
      (outcome) => outcome.kind === "ALREADY_REDEEMED",
    );
    expect(losers.length).toBe(1);

    // And the loser reports the winner's number, not the number it asked for.
    const loser = losers[0];
    if (loser === undefined || loser.kind !== "ALREADY_REDEEMED") {
      throw new Error("expected ALREADY_REDEEMED");
    }
    expect(loser.redeemedQty).toBe(1);

    const scans = await prisma.redemptionScan.count({
      where: { participantId, scanId },
    });
    expect(scans).toBe(1);

    // The rollback is the invariant that keeps this honest: the losing attempt's
    // `UPDATE … redeemedQty` must be gone, so the scan count (1) and the quantity
    // (1) agree. If the losing claim had committed while its scan row rolled back,
    // there would be one plate with no record of which scan took it.
    const row = await rowOf(participantId);
    expect(row.redeemedQty).toBe(scans);
  });

  it("keeps the pre-FR-606 behaviour when no scanId is supplied", async () => {
    // The opt-in boundary. A client that does not send a key behaves exactly as it
    // did before this feature, which is what keeps every other test and caller
    // meaningful — and it is the honest description of a whole-order scan.
    const { participantId, code } = await collectable({ qty: 2 });
    const userId = await staffUserId(merchantId);

    const first = await redeemCode({ code, merchantIds: [merchantId], userId });
    expect(first.kind).toBe("REDEEMED");

    const second = await redeemCode({
      code,
      merchantIds: [merchantId],
      userId,
    });
    expect(second.kind).toBe("ALREADY_REDEEMED");
    expect((await rowOf(participantId)).redeemedQty).toBe(2);
  });
});
