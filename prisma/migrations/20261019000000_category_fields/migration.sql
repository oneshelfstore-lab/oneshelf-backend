-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "fieldSchema" JSONB;

-- AlterTable
ALTER TABLE "CatalogProduct" ADD COLUMN     "attributes" JSONB;
