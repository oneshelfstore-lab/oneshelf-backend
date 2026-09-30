-- Customer shopping preferences (services + category interests). Additive: one nullable column.
-- NULL = never asked; no backfill needed.
ALTER TABLE "User" ADD COLUMN "shoppingPrefs" JSONB;
