-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "description" TEXT,
ADD COLUMN     "nameHi" TEXT,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "showInNavigation" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CatalogProduct" ADD COLUMN     "leafCategoryId" TEXT;

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE INDEX "CatalogProduct_leafCategoryId_idx" ON "CatalogProduct"("leafCategoryId");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_leafCategoryId_fkey" FOREIGN KEY ("leafCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
