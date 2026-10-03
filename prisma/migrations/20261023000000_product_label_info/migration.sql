-- AlterTable
ALTER TABLE "CatalogProduct" ADD COLUMN "descriptionTable" JSONB,
ADD COLUMN "ingredients" TEXT,
ADD COLUMN "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "dietMark" TEXT,
ADD COLUMN "nutrition" JSONB,
ADD COLUMN "labelVerifiedAt" TIMESTAMP(3);
