-- Shop-type requirement profiles (src/data/shopTypes.ts).
--
-- `shopType`     WHICH kind of shop, one level finer than `vertical` — decides which onboarding
--                fields are asked for and required, and whether the owner's review queue flags the
--                submission as a licensed trade. TEXT, not an enum, so a new trade needs no DB
--                migration (same reasoning as `vertical`).
-- `categoryData` Answers to the fields only one trade is ever asked (a pharmacy's drug licence, a
--                jeweller's BIS number), as {fieldKey: value}. JSONB rather than a column per
--                trade: ~40 columns that are null for every seller but one, plus a migration each
--                time a shop type is added.
--
-- Both NULLABLE with no default, so this is safe on a populated table and needs no backfill:
-- profileFor() resolves a NULL shopType off `vertical` (SHOP → general store, FOOD → restaurant),
-- which is the profile every existing seller's data was already collected under.
ALTER TABLE "Seller" ADD COLUMN     "categoryData" JSONB,
ADD COLUMN     "shopType" TEXT;
