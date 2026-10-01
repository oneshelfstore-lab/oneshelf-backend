-- Food seller app F1 + F2 (FOOD_SELLER_PLAN.md). Purely additive.

-- F1: timed close + temporary dish unavailability.
ALTER TABLE "Seller" ADD COLUMN "reopenAt" TIMESTAMP(3),
ADD COLUMN "closedReason" TEXT;

ALTER TABLE "MenuItem" ADD COLUMN "unavailableUntil" TIMESTAMP(3);

-- F2: Veg / Egg / Non-veg, plus the owner's Popular tag.
CREATE TYPE "FoodType" AS ENUM ('VEG', 'EGG', 'NON_VEG');

ALTER TABLE "MenuItem" ADD COLUMN "foodType" "FoodType" NOT NULL DEFAULT 'VEG',
ADD COLUMN "isBestseller" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the old boolean so existing dishes keep their dot.
UPDATE "MenuItem" SET "foodType" = 'NON_VEG' WHERE "isVeg" = false;
