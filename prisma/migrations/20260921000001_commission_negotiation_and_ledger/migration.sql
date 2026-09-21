-- Commission negotiation, the adjustment ledger, and the switches (runbook step 05).
--
-- Purely additive: three new enum types, two new tables, six ADD COLUMNs, zero DROP, zero
-- ALTER COLUMN, and no backfill — every new column either defaults to the value that is already
-- true of every existing row, or is nullable. Nothing in the application reads any of it yet.
--
-- ⚠️ Two defaults are load-bearing and both say "nothing changes today":
--
--   Seller.gstScheme = REGULAR is correct for every seller on file, so it backfills them with no
--   script. It is NOT safe as a default for a seller onboarded tomorrow — a composition dealer may
--   not collect tax on supplies, so inheriting REGULAR silently gives them a tax invoice they are
--   not allowed to issue. Step 14 makes it an explicit choice at onboarding.
--
--   StoreConfig.houseSellerIsSeparateEntity = false preserves today's behaviour exactly. It is the
--   switch step 23 flips the day a platform GSTIN exists — which is what decouples a LEGAL date
--   from a deploy. On early, the platform starts charging itself commission and TCS on its own
--   supply and accruing a balance it owes itself.

-- CreateEnum
CREATE TYPE "SellerGstScheme" AS ENUM ('REGULAR', 'COMPOSITION');

-- CreateEnum
CREATE TYPE "CommissionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COUNTERED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AdjustmentKind" AS ENUM ('CLAWBACK', 'RATE_CORRECTION', 'MANUAL');

-- AlterTable
ALTER TABLE "CatalogProduct" ADD COLUMN     "commissionPctOverride" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "StoreConfig" ADD COLUMN     "houseSellerIsSeparateEntity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutHoldDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payoutRail" TEXT NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "gstScheme" "SellerGstScheme" NOT NULL DEFAULT 'REGULAR',
ADD COLUMN     "payoutAccountRef" TEXT;

-- CreateTable
CREATE TABLE "CommissionRequest" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "currentPct" DECIMAL(5,2) NOT NULL,
    "requestedPct" DECIMAL(5,2) NOT NULL,
    "sellerNote" TEXT,
    "status" "CommissionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approvedPct" DECIMAL(5,2),
    "ownerNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubOrderAdjustment" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "subOrderId" TEXT,
    "kind" "AdjustmentKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "payoutId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubOrderAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionRequest_status_createdAt_idx" ON "CommissionRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CommissionRequest_sellerId_status_idx" ON "CommissionRequest"("sellerId", "status");

-- CreateIndex
CREATE INDEX "CommissionRequest_productId_idx" ON "CommissionRequest"("productId");

-- CreateIndex
CREATE INDEX "SubOrderAdjustment_sellerId_settled_idx" ON "SubOrderAdjustment"("sellerId", "settled");

-- CreateIndex
CREATE INDEX "SubOrderAdjustment_subOrderId_idx" ON "SubOrderAdjustment"("subOrderId");

-- AddForeignKey
ALTER TABLE "CommissionRequest" ADD CONSTRAINT "CommissionRequest_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRequest" ADD CONSTRAINT "CommissionRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CatalogProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubOrderAdjustment" ADD CONSTRAINT "SubOrderAdjustment_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubOrderAdjustment" ADD CONSTRAINT "SubOrderAdjustment_subOrderId_fkey" FOREIGN KEY ("subOrderId") REFERENCES "SubOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubOrderAdjustment" ADD CONSTRAINT "SubOrderAdjustment_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "SellerPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

