-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "menuItemId" TEXT;

-- AlterTable
ALTER TABLE "StoreConfig" ADD COLUMN     "foodCommissionPct" DECIMAL(5,2) NOT NULL DEFAULT 15,
ADD COLUMN     "foodEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "avgPrepMinutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "closeTime" VARCHAR(5),
ADD COLUMN     "cuisines" TEXT,
ADD COLUMN     "minOrderValue" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "openTime" VARCHAR(5),
ADD COLUMN     "vertical" TEXT NOT NULL DEFAULT 'SHOP';

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "menuCategoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "prepMinutes" INTEGER NOT NULL DEFAULT 20,
    "sacCode" VARCHAR(8),
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuCategory_sellerId_isActive_idx" ON "MenuCategory"("sellerId", "isActive");

-- CreateIndex
CREATE INDEX "MenuItem_sellerId_isActive_idx" ON "MenuItem"("sellerId", "isActive");

-- CreateIndex
CREATE INDEX "MenuItem_menuCategoryId_idx" ON "MenuItem"("menuCategoryId");

-- CreateIndex
CREATE INDEX "Seller_vertical_isActive_idx" ON "Seller"("vertical", "isActive");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_menuCategoryId_fkey" FOREIGN KEY ("menuCategoryId") REFERENCES "MenuCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

