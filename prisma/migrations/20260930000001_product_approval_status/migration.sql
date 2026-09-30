-- Product moderation state + a real soft delete (routes/sellerCatalog.ts, routes/ownerCatalog.ts).
-- Before this, "Remove" and "Reject" both set isActive=false — the same state as "pending approval" —
-- so removed/rejected products reappeared in the owner's approval queue.
ALTER TABLE "CatalogProduct" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'APPROVED';
ALTER TABLE "CatalogProduct" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "CatalogProduct" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Backfill: an inactive product of an EXTERNAL seller is what the app already showed as "pending".
-- House / seller-less inactive rows are owner-hidden products and stay APPROVED (just switched off).
-- ⚠️ Rows an external seller previously "removed" can't be told apart from real submissions, so they
-- come back once as PENDING; rejecting them from the owner's queue clears them.
UPDATE "CatalogProduct" p
SET "approvalStatus" = 'PENDING'
FROM "Seller" s
WHERE p."sellerId" = s."id" AND s."isHouse" = false AND p."isActive" = false;

CREATE INDEX "CatalogProduct_approvalStatus_idx" ON "CatalogProduct"("approvalStatus");
