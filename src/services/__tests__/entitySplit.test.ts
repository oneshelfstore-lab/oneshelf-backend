import { describe, it, expect } from "vitest";
import { isSameLegalEntity } from "../entitySplit.js";
import { sumSellerLines, computeSellerSplit } from "../sellerSplit.js";
import { TCS_RATE_PCT } from "../../data/taxRates.js";

/**
 * Runbook step 09 — the entity-split flag, tested where it can be tested purely.
 *
 * The flag itself is one row in StoreConfig; what matters is the decision it feeds and the money
 * that decision produces. Both are here. The live half (reading the real config, and the real 194-O
 * function no longer short-circuiting on isHouse) is scripts/proveEntitySplit.ts.
 */

const HOUSE = { isHouse: true };
const EXTERNAL = { isHouse: false };

describe("isSameLegalEntity", () => {
  it("treats the house store as the platform while the flag is off", () => {
    expect(isSameLegalEntity(HOUSE, false)).toBe(true);
  });

  it("treats it as a separate party once the flag is on", () => {
    expect(isSameLegalEntity(HOUSE, true)).toBe(false);
  });

  it("never treats an external seller as the platform, either way", () => {
    expect(isSameLegalEntity(EXTERNAL, false)).toBe(false);
    expect(isSameLegalEntity(EXTERNAL, true)).toBe(false);
  });

  // ⚠️ A null seller is a pre-marketplace line with no seller recorded. Those are the store's own
  // goods and must stay exempt whatever the flag says — otherwise a legacy row starts accruing a
  // commission owed to nobody the day the flag flips.
  it("keeps a seller-less legacy line exempt even with the flag on", () => {
    expect(isSameLegalEntity(null, true)).toBe(true);
    expect(isSameLegalEntity(undefined, true)).toBe(true);
  });
});

describe("what the flag does to a house slice's money", () => {
  /** ₹500 of house goods, all taxable, at whatever rate the shop would be charged. */
  const place = (houseIsSeparate: boolean, sellerCommissionPct: number) => {
    const totals = sumSellerLines([{ lineTotal: 500, taxableValue: 500 }], sellerCommissionPct);
    return computeSellerSplit({
      subtotal: totals.subtotal,
      taxableValue: totals.taxableValue,
      commissionPct: totals.commissionPct,
      commissionAmount: totals.commissionAmount,
      commissionGstAmount: totals.commissionGstAmount,
      tcsRatePct: TCS_RATE_PCT,
      tdsAmount: 0, // 194-O is off; see the prove script for the live decision
      isHouse: isSameLegalEntity(HOUSE, houseIsSeparate),
    });
  };

  // Step 09's prove, first half. ⚠️ The zero commission comes from the DATA, not from the code:
  // the live house Seller row carries commissionPct 0, and ownerSellers.ts refuses to change it.
  // computeSellerSplit has never exempted the house store from commission — only from TCS.
  it("charges a house slice nothing while the platform and the shop are one entity", () => {
    const split = place(false, 0);
    expect(split.commissionAmount).toBe(0);
    expect(split.tcsAmount).toBe(0);
    expect(split.tdsAmount).toBe(0);
    expect(split.netPayable).toBe(500);
  });

  // Step 09's prove, second half. Flip the flag and the shop is a seller like any other.
  it("charges it once the shop is a separate legal entity", () => {
    const split = place(true, 5);
    expect(split.commissionAmount).toBe(25); // 5% of 500
    expect(split.commissionGstAmount).toBe(4.5); // 18% on top, withheld since step 07
    expect(split.tcsAmount).toBe(2.5); // 0.5% of 500
    expect(split.netPayable).toBe(468);
  });

  // ⚠️ Worth being explicit about, because it is the thing most likely to be misread as a bug:
  // flipping the flag alone does NOT start charging commission. The rate is still 0 until somebody
  // sets one, so only TCS appears. Step 23 has to do both.
  it("still charges no commission with the flag on but no rate set", () => {
    const split = place(true, 0);
    expect(split.commissionAmount).toBe(0);
    expect(split.tcsAmount).toBe(2.5); // TCS does appear — it comes from the statute, not a contract
  });

  it("leaves an external seller's slice identical whichever way the flag sits", () => {
    const external = (houseIsSeparate: boolean) => {
      const totals = sumSellerLines([{ lineTotal: 500, taxableValue: 500 }], 5);
      return computeSellerSplit({
        subtotal: totals.subtotal,
        taxableValue: totals.taxableValue,
        commissionPct: totals.commissionPct,
        commissionAmount: totals.commissionAmount,
        commissionGstAmount: totals.commissionGstAmount,
        tcsRatePct: TCS_RATE_PCT,
        tdsAmount: 0,
        isHouse: isSameLegalEntity(EXTERNAL, houseIsSeparate),
      });
    };
    expect(external(false)).toEqual(external(true));
  });
});
