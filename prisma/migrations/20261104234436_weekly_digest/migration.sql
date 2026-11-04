-- FR-704: the weekly merchant digest.
--
-- Two additions, and they answer the two halves of the acceptance criterion:
--
--   * `MerchantUser.digestOptIn` / `digestOptInAt` are the express consent record.
--     It sits on the membership rather than on `User` because the consent is to
--     receive *this merchant's* numbers, not every merchant the person owns.
--     Default false: an owner opts in from Settings, and no account created before
--     this migration is silently subscribed.
--
--   * `DigestDelivery` is the idempotency record. A row exists only after the
--     provider accepted the message, and `(merchantId, userId, weekStart)` is
--     unique, so a retried cron run cannot send Monday's email twice. `weekStart`
--     is the local Monday 00:00 instant — the period described, not the send time.
--
-- No backfill and no data migration: there is nothing to convert. The new column
-- has a default, and the table starts empty.

-- AlterTable
ALTER TABLE "MerchantUser" ADD COLUMN     "digestOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "digestOptInAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DigestDelivery" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerId" TEXT,

    CONSTRAINT "DigestDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DigestDelivery_weekStart_idx" ON "DigestDelivery"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "DigestDelivery_merchantId_userId_weekStart_key" ON "DigestDelivery"("merchantId", "userId", "weekStart");

-- CreateIndex
CREATE INDEX "MerchantUser_merchantId_digestOptIn_idx" ON "MerchantUser"("merchantId", "digestOptIn");

-- AddForeignKey
ALTER TABLE "DigestDelivery" ADD CONSTRAINT "DigestDelivery_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestDelivery" ADD CONSTRAINT "DigestDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
