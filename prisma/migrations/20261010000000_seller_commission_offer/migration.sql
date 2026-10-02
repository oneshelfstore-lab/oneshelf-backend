-- Seller commission offer (slider at onboarding) + owner-set per-category rates. Purely additive.
ALTER TABLE "Seller" ADD COLUMN "offeredCommissionPct" DECIMAL(5,2);

CREATE TABLE "SellerCategoryCommission" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "pct" DECIMAL(5,2) NOT NULL,
    "setByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerCategoryCommission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SellerCategoryCommission_sellerId_categoryId_key" ON "SellerCategoryCommission"("sellerId", "categoryId");
CREATE INDEX "SellerCategoryCommission_categoryId_idx" ON "SellerCategoryCommission"("categoryId");

ALTER TABLE "SellerCategoryCommission" ADD CONSTRAINT "SellerCategoryCommission_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellerCategoryCommission" ADD CONSTRAINT "SellerCategoryCommission_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
