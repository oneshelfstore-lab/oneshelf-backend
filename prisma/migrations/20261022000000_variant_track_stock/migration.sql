-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN "trackStock" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "maxOrderQty" INTEGER;
