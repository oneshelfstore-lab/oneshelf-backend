-- Commission rates are floored at 0 and capped at 100, in the DATABASE (runbook step 20).
--
-- ⚠️ THE FLOOR IS THE POINT, AND IT IS NOT A FORMATTING RULE. A negative commission is the platform
-- PAYING the seller a fee — a different supply in the opposite direction, with the GST liability and
-- the invoice both pointing the other way. Nothing downstream is built to handle that: the payout
-- would add to netPayable, the monthly commission invoice would bill a negative taxable value, and
-- GSTR-1 would carry a supply that never happened. Rejecting it in a form field leaves every other
-- writer — a script, a console session, the next route — free to do it anyway.
--
-- ⚠️ Prisma cannot express a CHECK, so this is raw SQL and the schema file cannot show it. That is
-- the trade: a constraint the ORM does not know about is invisible in schema.prisma, but a rule that
-- only the ORM enforces is not a rule.
--
-- Verified against live data before writing this, because a CHECK that fails to apply is not a
-- warning — `prisma migrate deploy` runs on boot, so it would crash-loop the service:
--   sellers out of [0,100]:   0   (every rate is 0 or 5)
--   overrides out of [0,100]: 0   (none set)
--   commission requests:      0

ALTER TABLE "Seller"
  ADD CONSTRAINT "Seller_commissionPct_range"
  CHECK ("commissionPct" >= 0 AND "commissionPct" <= 100);

-- NULL is allowed and means "use the seller's rate", never "zero commission" — see
-- services/sellerSplit.ts resolveCommissionPct.
ALTER TABLE "CatalogProduct"
  ADD CONSTRAINT "CatalogProduct_commissionPctOverride_range"
  CHECK ("commissionPctOverride" IS NULL OR ("commissionPctOverride" >= 0 AND "commissionPctOverride" <= 100));

ALTER TABLE "CommissionRequest"
  ADD CONSTRAINT "CommissionRequest_rates_range"
  CHECK (
    "currentPct"   >= 0 AND "currentPct"   <= 100 AND
    "requestedPct" >= 0 AND "requestedPct" <= 100 AND
    ("approvedPct" IS NULL OR ("approvedPct" >= 0 AND "approvedPct" <= 100))
  );
