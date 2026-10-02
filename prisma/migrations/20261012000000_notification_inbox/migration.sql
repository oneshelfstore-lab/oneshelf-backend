-- CreateEnum
CREATE TYPE "NotifCategory" AS ENUM ('ORDERS', 'DELIVERY', 'ROUTINES', 'PAYMENTS', 'INVENTORY', 'BUSINESS', 'ACCOUNT', 'SUPPORT', 'PROMO', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotifKind" AS ENUM ('ACTION', 'STATUS', 'INFO', 'PROMO');

-- CreateEnum
CREATE TYPE "NotifSeverity" AS ENUM ('NORMAL', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" "NotifCategory" NOT NULL,
    "kind" "NotifKind" NOT NULL,
    "severity" "NotifSeverity" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "action" TEXT,
    "imageUrl" TEXT,
    "etaAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_kind_resolvedAt_idx" ON "Notification"("userId", "kind", "resolvedAt");

-- CreateIndex
CREATE INDEX "Notification_entityType_entityId_idx" ON "Notification"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

