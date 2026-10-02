-- Seller.alsoSellCategories: other shop trades a seller also sells (their extra licences are required too). Purely additive.
ALTER TABLE "Seller" ADD COLUMN "alsoSellCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];
