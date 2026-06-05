/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "StoreConfig" ADD COLUMN     "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 30;

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");
