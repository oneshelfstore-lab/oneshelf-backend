-- Routines: per-routine delivery instructions, copied onto each generated order. Additive.
ALTER TABLE "Subscription" ADD COLUMN "deliveryNote" TEXT;
