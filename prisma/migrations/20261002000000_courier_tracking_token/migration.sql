-- AlterTable
ALTER TABLE "CourierBooking" ADD COLUMN     "trackingToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CourierBooking_trackingToken_key" ON "CourierBooking"("trackingToken");

