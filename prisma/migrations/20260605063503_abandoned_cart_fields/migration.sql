-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliverySlot" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "cartReminderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastCartReminderAt" TIMESTAMP(3);
