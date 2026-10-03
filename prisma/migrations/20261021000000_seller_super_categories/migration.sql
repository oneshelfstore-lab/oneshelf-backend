-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "categoriesConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "sellsSuperCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];
