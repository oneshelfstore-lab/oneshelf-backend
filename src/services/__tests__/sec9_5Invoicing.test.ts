import { describe, it, expect } from "vitest";
import { isStoreOwnSupply, isPlatformIssuedInvoice } from "../orderInvoice.js";

/**
 * GST Sec 9(5): restaurant service supplied through an e-commerce operator makes the PLATFORM the
 * deemed supplier — the platform issues the tax invoice under its own GSTIN and pays the 5% itself.
 * The money, however, is still the restaurant's, settled through the payout ledger.
 *
 * Those are TWO different questions, and every failure mode here is silent:
 *   - platform-issued too NARROW  → food invoices go out under the restaurant's GSTIN (and none of
 *     the seeded restaurants even has one), which is the compliance breach this pair fixes;
 *   - platform-issued too WIDE    → an external SHOP seller's invoice loses their GSTIN and their
 *     own consecutive invoice series;
 *   - store-own-supply too WIDE   → a Payment RECEIPT is booked for a food order, inflating the
 *     store's Daily Summary by the full order value of goods it never sold;
 *   - store-own-supply too NARROW → the store's own COD revenue silently vanishes from the books
 *     (the exact regression COMPLIANCE_PLAN.md P0-2 was raised for).
 */

const shop = (isHouse = false) => ({ isHouse, vertical: "SHOP" });
const restaurant = (isHouse = false) => ({ isHouse, vertical: "FOOD" });

describe("isStoreOwnSupply — drives store REVENUE (the Payment receipt)", () => {
  it("counts the house seller", () => {
    expect(isStoreOwnSupply(shop(true))).toBe(true);
  });

  it("counts a legacy order with no seller at all", () => {
    expect(isStoreOwnSupply(null)).toBe(true);
    expect(isStoreOwnSupply(undefined)).toBe(true);
  });

  it("excludes an external shop seller — their money is a pass-through liability", () => {
    expect(isStoreOwnSupply(shop())).toBe(false);
  });

  it("excludes a restaurant even though the platform issues its invoice", () => {
    // The whole point of splitting the two predicates. Getting this wrong books the full value of
    // every food order as store revenue.
    expect(isStoreOwnSupply(restaurant())).toBe(false);
  });

  it("still counts a house seller that is somehow flagged FOOD (own kitchen)", () => {
    // If Oneshelf ever cooks, the house seller becomes a restaurant — its supply is genuinely the
    // store's own, and Sec 9(5) does not apply to a supplier's own supply.
    expect(isStoreOwnSupply(restaurant(true))).toBe(true);
  });
});

describe("isPlatformIssuedInvoice — drives WHOSE GSTIN issues the invoice", () => {
  it("is true for the house seller (pre-food behaviour, unchanged)", () => {
    expect(isPlatformIssuedInvoice(shop(true))).toBe(true);
  });

  it("is true for a legacy order with no seller", () => {
    expect(isPlatformIssuedInvoice(null)).toBe(true);
  });

  it("is TRUE for a restaurant — Sec 9(5), the platform is the deemed supplier", () => {
    expect(isPlatformIssuedInvoice(restaurant())).toBe(true);
  });

  it("is FALSE for an external shop seller — they issue under their own GSTIN (Phase 6)", () => {
    expect(isPlatformIssuedInvoice(shop())).toBe(false);
  });

  it("treats a missing vertical as SHOP, not FOOD", () => {
    // Seller.vertical is a String defaulting to "SHOP"; a row read without the column selected must
    // never be mistaken for a restaurant, or a shop seller silently loses their GSTIN.
    expect(isPlatformIssuedInvoice({ isHouse: false })).toBe(false);
    expect(isPlatformIssuedInvoice({ isHouse: false, vertical: null })).toBe(false);
  });

  it("is case-sensitive on the wire value", () => {
    // vertical is a plain String column, and "FOOD" is the persisted wire value.
    expect(isPlatformIssuedInvoice({ isHouse: false, vertical: "food" })).toBe(false);
  });
});

describe("the two predicates disagree exactly where they should", () => {
  it("a restaurant is platform-issued but is NOT store revenue", () => {
    const r = restaurant();
    expect(isPlatformIssuedInvoice(r)).toBe(true);
    expect(isStoreOwnSupply(r)).toBe(false);
  });

  it("they agree for every non-food case", () => {
    for (const s of [shop(true), shop(), null]) {
      expect(isPlatformIssuedInvoice(s)).toBe(isStoreOwnSupply(s));
    }
  });
});
