-- Refer & Earn removed entirely. Destructive: drops the referral tables/columns (all referral
-- history, commission accruals and payout rows are discarded).

-- 1. Referral tables (children first; DROP TABLE removes their indexes and FKs too).
DROP TABLE "ReferralCommission";
DROP TABLE "ReferralPayout";
DROP TABLE "Referral";
DROP TYPE "ReferralStatus";

-- 2. User columns (the referredById FK and referralCode unique index go with them).
ALTER TABLE "User"
  DROP COLUMN "referralCode",
  DROP COLUMN "referredById",
  DROP COLUMN "referralBankAccountName",
  DROP COLUMN "referralBankAccountNumber",
  DROP COLUMN "referralBankIfsc";

-- 3. StoreConfig knobs.
ALTER TABLE "StoreConfig"
  DROP COLUMN "referralEnabled",
  DROP COLUMN "referralRewardAmount",
  DROP COLUMN "referralWelcomeAmount",
  DROP COLUMN "referralMinOrder",
  DROP COLUMN "referralWelcomeExpiryDays",
  DROP COLUMN "referralCommissionPct",
  DROP COLUMN "referralCommissionMonths";

-- 4. Wallet ledger: keep historical REFERRAL_CREDIT rows (balances must still reconcile) by
--    re-labelling them ADJUSTMENT, then drop the enum value (Postgres can't DROP VALUE directly).
ALTER TABLE "WalletTransaction" DROP COLUMN "referralId";
ALTER TYPE "WalletTxnType" RENAME TO "WalletTxnType_old";
CREATE TYPE "WalletTxnType" AS ENUM ('ORDER_DEBIT', 'ORDER_REFUND', 'TOPUP', 'ADJUSTMENT');
ALTER TABLE "WalletTransaction" ALTER COLUMN "type" TYPE "WalletTxnType"
  USING (CASE WHEN "type"::text = 'REFERRAL_CREDIT' THEN 'ADJUSTMENT' ELSE "type"::text END)::"WalletTxnType";
DROP TYPE "WalletTxnType_old";
