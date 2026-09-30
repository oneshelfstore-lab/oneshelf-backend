-- CreateEnum
CREATE TYPE "CourierStatus" AS ENUM ('PENDING_PAYMENT', 'SEARCHING', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CANCELLED', 'FAILED');

-- AlterTable
ALTER TABLE "StoreConfig" ADD COLUMN     "courierEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "courierExpressFee" INTEGER NOT NULL DEFAULT 17,
ADD COLUMN     "courierMaxKm" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "courierPickupRadiusKm" INTEGER,
ADD COLUMN     "courierPlatformFee" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "courierSearchTimeoutMin" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "courierSlabs" JSONB,
ADD COLUMN     "courierWeightSurcharge" JSONB;

-- CreateTable
CREATE TABLE "CourierBooking" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "CourierStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "pickupLat" DECIMAL(10,7) NOT NULL,
    "pickupLng" DECIMAL(10,7) NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "pickupContactName" TEXT NOT NULL,
    "pickupContactPhone" TEXT NOT NULL,
    "dropLat" DECIMAL(10,7) NOT NULL,
    "dropLng" DECIMAL(10,7) NOT NULL,
    "dropAddress" TEXT NOT NULL,
    "dropLandmark" TEXT,
    "recipientName" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "parcelType" TEXT NOT NULL,
    "weightBand" TEXT NOT NULL,
    "declaredValueBand" TEXT NOT NULL,
    "speed" TEXT NOT NULL,
    "prohibitedAckAt" TIMESTAMP(3) NOT NULL,
    "distanceKm" DECIMAL(6,2) NOT NULL,
    "deliveryFee" DECIMAL(10,2) NOT NULL,
    "platformFee" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "walletApplied" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "idempotencyKey" TEXT,
    "riderId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "pickupPhotoPath" TEXT,
    "dropPhotoPath" TEXT,
    "ratingStars" INTEGER,
    "ratingComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierSecret" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "pickupOtp" VARCHAR(6) NOT NULL,
    "deliveryOtp" VARCHAR(6) NOT NULL,
    "pickupAttempts" INTEGER NOT NULL DEFAULT 0,
    "pickupLockedUntil" TIMESTAMP(3),
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "deliveryLockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "lat" DECIMAL(10,7),
    "lng" DECIMAL(10,7),
    "accuracyM" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourierBooking_number_key" ON "CourierBooking"("number");

-- CreateIndex
CREATE UNIQUE INDEX "CourierBooking_razorpayOrderId_key" ON "CourierBooking"("razorpayOrderId");

-- CreateIndex
CREATE INDEX "CourierBooking_customerId_createdAt_idx" ON "CourierBooking"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "CourierBooking_status_createdAt_idx" ON "CourierBooking"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CourierBooking_riderId_status_idx" ON "CourierBooking"("riderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CourierBooking_customerId_idempotencyKey_key" ON "CourierBooking"("customerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CourierSecret_bookingId_key" ON "CourierSecret"("bookingId");

-- CreateIndex
CREATE INDEX "CourierEvent_bookingId_createdAt_idx" ON "CourierEvent"("bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "CourierBooking" ADD CONSTRAINT "CourierBooking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierBooking" ADD CONSTRAINT "CourierBooking_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierSecret" ADD CONSTRAINT "CourierSecret_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "CourierBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierEvent" ADD CONSTRAINT "CourierEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "CourierBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

