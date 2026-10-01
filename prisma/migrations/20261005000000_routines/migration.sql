-- Routines: a Subscription becomes a multi-item parent. Additive, plus two legacy columns relaxed to NULL.
CREATE TYPE "PriceCeilingType" AS ENUM ('ABSOLUTE', 'PERCENT');

ALTER TABLE "Subscription"
  ALTER COLUMN "variantId" DROP NOT NULL,
  ALTER COLUMN "quantity" DROP NOT NULL,
  ADD COLUMN "name" TEXT,
  ADD COLUMN "deliverySlotId" TEXT NOT NULL DEFAULT 'MORNING',
  ADD COLUMN "priceCeilingType" "PriceCeilingType" NOT NULL DEFAULT 'ABSOLUTE',
  ADD COLUMN "priceCeilingValue" DECIMAL(10,2) NOT NULL DEFAULT 30;

CREATE TABLE "SubscriptionItem" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "imageUrl" TEXT,
    "quantity" DECIMAL(14,6) NOT NULL,
    "isLoose" BOOLEAN NOT NULL DEFAULT false,
    "stepSize" DECIMAL(10,3),
    "stepUnit" TEXT,
    "unitPriceSnapshot" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionItem_subscriptionId_variantId_key" ON "SubscriptionItem"("subscriptionId", "variantId");
CREATE INDEX "SubscriptionItem_variantId_idx" ON "SubscriptionItem"("variantId");

ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every existing single-product subscription becomes a routine holding exactly one item.
-- Loose rows get a NULL snapshot (their old snapshot was per-base-unit, not app-format) — the engine
-- fills it on the first run. Idempotent: skips rows that already have an item.
INSERT INTO "SubscriptionItem" ("id", "subscriptionId", "variantId", "productName", "imageUrl", "quantity", "isLoose", "stepSize", "stepUnit", "unitPriceSnapshot")
SELECT 'si_' || s."id", s."id", s."variantId", s."productName", s."imageUrl", s."quantity", s."isLoose", s."stepSize", s."stepUnit",
       CASE WHEN s."isLoose" THEN NULL ELSE s."unitPriceSnapshot" END
FROM "Subscription" s
WHERE s."variantId" IS NOT NULL
  AND s."quantity" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "SubscriptionItem" i WHERE i."subscriptionId" = s."id");
