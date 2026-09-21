-- Busy mode (Seller) + per-item serving windows (MenuItem).
--
-- Purely additive: every column is nullable or carries a DEFAULT, so existing rows need no
-- backfill and the pre-deploy code keeps working unchanged (it simply never reads them).
--   busyUntil NULL          => not busy  (the isBusy check requires a FUTURE timestamp)
--   busyExtraMinutes 0      => adds nothing even if busyUntil were somehow set
--   availableFrom/To NULL   => item is available whenever the restaurant is open

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN "busyUntil" TIMESTAMP(3),
                     ADD COLUMN "busyExtraMinutes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN "availableFrom" VARCHAR(5),
                       ADD COLUMN "availableTo" VARCHAR(5);
