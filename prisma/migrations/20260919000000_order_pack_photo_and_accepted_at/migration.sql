-- Purely additive, both nullable: no backfill, no default, nothing to lose.
-- "Order" gets the moment a rider CLAIMED the job (the rider card renders "accepted N min ago" from
-- it; updatedAt could not be used, it is bumped by every unrelated write).
-- "SubOrder" gets the seller's photo of the packed bag (a Storage object path, signed on read).
ALTER TABLE "Order" ADD COLUMN "acceptedAt" TIMESTAMP(3);
ALTER TABLE "SubOrder" ADD COLUMN "packPhotoUrl" TEXT;
