-- Seller Open/Closed switch (sellerAccount.ts POST /store-status). Additive + nullable: null = open.
ALTER TABLE "Seller" ADD COLUMN "closedSince" TIMESTAMP(3);
