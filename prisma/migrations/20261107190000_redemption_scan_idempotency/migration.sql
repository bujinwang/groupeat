-- FR-606 prerequisite: idempotent redemption.
--
-- `redeemedQty` is incremented by `take`, so a per-unit redeem replayed after a
-- lost response takes a second plate. Measured against real Postgres before this
-- table existed: first scan `requested: 1` → `redeemedQty = 1`; the byte-identical
-- replay → `redeemedQty = 2`. A whole-order scan was accidentally safe because a
-- replay re-reads `remaining = 0` and answers ALREADY_REDEEMED, but per-unit is
-- not — and a flaky network is exactly the condition FR-606 exists for.
--
-- The key is the client's `scanId`, not the redemption code: the code identifies
-- the *order*, so two staff members scanning it at two counters are two legitimate
-- scans that must each take their own units. One `scanId` per human scan, reused
-- across retries, is the distinction that is actually wanted.
--
-- No backfill. Scans before this table existed have no key and cannot be replayed
-- idempotently; that is a property of the past, not a row to invent.

-- CreateTable
CREATE TABLE "RedemptionScan" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "taken" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedemptionScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RedemptionScan_participantId_scanId_key" ON "RedemptionScan"("participantId", "scanId");

-- CreateIndex
CREATE INDEX "RedemptionScan_participantId_idx" ON "RedemptionScan"("participantId");

-- AddForeignKey
ALTER TABLE "RedemptionScan" ADD CONSTRAINT "RedemptionScan_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "DropParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
