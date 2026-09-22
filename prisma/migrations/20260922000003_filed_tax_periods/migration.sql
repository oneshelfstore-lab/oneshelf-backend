-- Runbook step 18: a filed GST period stops moving.
--
-- Every return in this system is computed live from current data, so cancelling an October order
-- silently changes what September's GSTR-8 and GSTR-1 would produce — after September was filed
-- with the old numbers. A reversal belongs in the period it HAPPENS in, not retroactively in the
-- one it reverses.
--
-- Order.cancelledAt is what makes that answerable: before or after the period was filed? Without a
-- timestamp the only thing available is the CURRENT status, which is precisely what rewrites
-- history. Nullable, so every order cancelled before this column existed reads as "cancelled at an
-- unknown time" — harmless, because no period has ever been filed and the first one will contain
-- only cancellations that carry a stamp.
--
-- FiledTaxPeriod is one table for both returns. GSTR-1 and GSTR-8 are filed separately, on
-- different dates, and can legitimately disagree about which months are closed; returnType keeps
-- them independent while the freezing RULE stays in one place.
--
-- Purely additive: one nullable column and one new table. Nothing reads either yet at the moment
-- this ships, so the database may run ahead of the code — the only direction that is safe.
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FiledTaxPeriod" (
    "id" TEXT NOT NULL,
    "returnType" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiledTaxPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FiledTaxPeriod_returnType_idx" ON "FiledTaxPeriod"("returnType");

-- CreateIndex
CREATE UNIQUE INDEX "FiledTaxPeriod_returnType_period_key" ON "FiledTaxPeriod"("returnType", "period");

