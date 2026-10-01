-- Routines phase 5: per-item substitution rule + "prices went up" alert memory. Additive.
CREATE TYPE "SubstitutionRule" AS ENUM ('SKIP', 'SIMILAR');

ALTER TABLE "SubscriptionItem" ADD COLUMN "substitution" "SubstitutionRule" NOT NULL DEFAULT 'SKIP';
ALTER TABLE "Subscription" ADD COLUMN "lastAlertedTotal" DECIMAL(10,2);
