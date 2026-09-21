-- Money-math columns for the marketplace migration (runbook step 04).
--
-- Purely additive: ten ADD COLUMNs, zero DROP, zero ALTER COLUMN. Nothing in the application reads
-- any of these yet, which is what makes it safe for the database to run ahead of the code — the only
-- direction that is safe.
--
-- ⚠️ Nine of the ten are NULLABLE rather than DEFAULT 0, and that is a deliberate correction to
-- the original plan. A money column that defaults to zero cannot distinguish "computed, came to
-- nothing" from "never computed". That is not hypothetical here: OrderItem.taxableValue was added
-- with DEFAULT 0, and one live row (ONS/2627/00028) now carries lineTotal 200 against taxableValue 0
-- with no way to tell from the data whether the goods were zero-rated or the column simply predates
-- them. Repeating that on SubOrder.taxableValue would move the same trap one level up, into the
-- number commission is about to be charged on.
--
-- The tenth, Invoice.invoiceKind, DOES default — because 'GOODS' is a true statement about every
-- invoice that exists today, so the default backfills all 374 of them correctly with no script.
-- That is the test: default only where the default is true of every existing row.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "invoiceKind" TEXT NOT NULL DEFAULT 'GOODS';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryGst" DECIMAL(10,2),
ADD COLUMN     "deliveryTaxable" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "commissionAmount" DECIMAL(12,2),
ADD COLUMN     "commissionPct" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "SubOrder" ADD COLUMN     "commissionGstAmount" DECIMAL(12,2),
ADD COLUMN     "commissionGstPct" DECIMAL(5,2),
ADD COLUMN     "taxableValue" DECIMAL(12,2),
ADD COLUMN     "tcsRatePct" DECIMAL(5,2),
ADD COLUMN     "tdsRatePct" DECIMAL(5,2);

-- ─── Backfill, for the two columns whose historical value is recoverable ──────────────────────────
--
-- These run here rather than as a post-deploy script because they are pure SQL and because
-- forgetting them is the failure this migration exists to prevent. Prisma runs a migration in one
-- transaction, so either both land or neither does.

-- SubOrder.taxableValue — the GST-exclusive base of the slice, which is exactly the sum of its own
-- order items' taxableValue. This is not a guess: scripts/replaySellerSplit.ts re-derived all 383
-- live sub-orders using this same sum and reproduced every stored tcsAmount to the paise.
-- ⚠️ Two kinds of slice are deliberately LEFT NULL rather than given a zero, because for them the
-- sum is not evidence of anything:
--   * a slice with no linked items — there is nothing to derive from;
--   * a slice whose items sum to 0 taxable while grossing more than 0. That combination is
--     impossible for real goods (a zero-rated line has taxable EQUAL to its gross, not zero), so it
--     can only mean the item predates OrderItem.taxableValue. Exactly one such slice exists today,
--     on order ONS/2627/00028. Writing 0 there would launder an unknown into a number and hand
--     step 07 a commission base of nil. NULL makes it refuse instead, which is what we want.
UPDATE "SubOrder" s
SET "taxableValue" = agg.total
FROM (
  SELECT "subOrderId" AS sid, sum("taxableValue") AS total, sum("lineTotal") AS gross
  FROM "OrderItem"
  WHERE "subOrderId" IS NOT NULL
  GROUP BY "subOrderId"
) agg
WHERE s.id = agg.sid
  AND NOT (agg.total = 0 AND agg.gross > 0);

-- SubOrder.tcsRatePct — the rate each slice's tcsAmount was ACTUALLY computed at, so that changing
-- the rate later cannot rewrite history. Three cases, and the same replay proved this rule
-- reproduces all 383 stored tcsAmounts:
--   house seller  → 0. The house store is the platform's own catalog; it collects no Sec-52 TCS on
--                      its own supply.
--   FOOD seller   → 0. Sec 9(5) makes the platform the deemed supplier on restaurant service, so
--                      TCS and 9(5) are alternatives, not additions.
--   anything else → 1. The superseded rate every goods slice to date was written at.
-- ⚠️ A stored 0 means "no TCS regime applied", not "unknown". Any reader recovering a liable value
-- as tcsAmount ÷ rate must skip those rows — both current readers already filter tcsAmount > 0, so
-- the division is unreachable for them today.
UPDATE "SubOrder" s
SET "tcsRatePct" = CASE WHEN sel."isHouse" OR sel.vertical = 'FOOD' THEN 0 ELSE 1 END
FROM "Seller" sel
WHERE sel.id = s."sellerId";

-- tdsRatePct is deliberately NOT backfilled. 194-O has never been enabled, so no rate has ever
-- applied to any row, and NULL is the honest record of that.
-- Order.deliveryTaxable/deliveryGst are deliberately NOT backfilled. Splitting a historical delivery
-- fee would require asserting a SAC rate that has not been confirmed — that call belongs to step 15,
-- not to a schema migration.
