-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "platformFeeReversedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0;
