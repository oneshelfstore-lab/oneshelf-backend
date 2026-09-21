-- One column, so a payout that absorbs a clawback still adds up (runbook step 12).
--
-- netPaid = grossAmount − commission − tcs − tds + adjustmentTotal. Folding an adjustment into
-- netPaid without recording it separately would leave a payout row whose own numbers do not
-- reconcile, which is how a settlement statement quietly stops balancing.
--
-- DEFAULT 0 is a true statement about every payout that exists: there are none. Nothing has ever
-- been paid out, so there is nothing for this to be wrong about.
ALTER TABLE "SellerPayout" ADD COLUMN     "adjustmentTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;
