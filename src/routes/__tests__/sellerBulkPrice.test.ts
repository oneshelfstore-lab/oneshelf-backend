import { describe, it, expect } from "vitest";
import { applyPriceRule, planVariantReprice, type BulkPriceRule } from "../sellerCatalog.js";

const rule = (over: Partial<BulkPriceRule> = {}): BulkPriceRule =>
  ({ target: "SELLING", mode: "PERCENT", value: -10, roundToRupee: false, ...over });

// A bulk repricing is the one screen where a wrong number is applied to hundreds of rows at once,
// and every failure mode is silent: nothing on screen distinguishes "sold below cost across the
// whole catalog" from "ran a sale". These pin the guards that make that impossible.
describe("applyPriceRule", () => {
  it("applies a percent, an amount and a set", () => {
    expect(applyPriceRule(100, rule({ mode: "PERCENT", value: -10 }))).toBe(90);
    expect(applyPriceRule(100, rule({ mode: "AMOUNT", value: -5 }))).toBe(95);
    expect(applyPriceRule(100, rule({ mode: "SET", value: 42 }))).toBe(42);
  });

  it("rounds to paise by default and to the rupee on request", () => {
    // 10% off ₹48 is ₹43.20 — a seller thinks in ₹43.
    expect(applyPriceRule(48, rule({ value: -10 }))).toBe(43.2);
    expect(applyPriceRule(48, rule({ value: -10, roundToRupee: true }))).toBe(43);
  });
});

describe("planVariantReprice", () => {
  const base = { sellingPrice: 100, mrp: 120, costPrice: 60, saleFloor: 70, bulkPrice: null };

  it("reprices the selling price and leaves the MRP alone", () => {
    const r = planVariantReprice(base, 0, rule({ value: -10 }), false);
    expect(r).toEqual({ ok: true, newPrice: 90, newMrp: 120 });
  });

  it("moves both when target is BOTH", () => {
    const r = planVariantReprice(base, 0, rule({ target: "BOTH", value: 10 }), false);
    expect(r).toEqual({ ok: true, newPrice: 110, newMrp: 132 });
  });

  it("refuses to price above the MRP (Legal Metrology ceiling)", () => {
    // +50% on ₹100 is ₹150 against a ₹120 MRP — an offence, not a rounding question.
    const r = planVariantReprice(base, 0, rule({ value: 50 }), false);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/above the MRP/);
  });

  it("refuses to drop below the seller's own sale floor", () => {
    const r = planVariantReprice(base, 0, rule({ value: -50 }), false); // ₹50 vs a ₹70 floor
    expect(r.ok).toBe(false);
  });

  it("lets the house seller run a loss-leader below cost, but not an external seller", () => {
    const noFloor = { ...base, saleFloor: null };
    const deep = rule({ value: -50 }); // ₹50 against a ₹60 cost
    expect(planVariantReprice(noFloor, 0, deep, false).ok).toBe(false);
    expect(planVariantReprice(noFloor, 0, deep, true).ok).toBe(true);
  });

  it("refuses a price that would sit under its own bulk-tier price", () => {
    // A "bulk discount" that costs more than buying one is worse than no offer.
    const withBulk = { ...base, bulkPrice: 95, saleFloor: null, costPrice: null };
    const r = planVariantReprice(withBulk, 6, rule({ value: -10 }), false);
    expect(r.ok).toBe(false);
    // bulkMinQty 0 means the tier is off — the same price is then fine.
    expect(planVariantReprice(withBulk, 0, rule({ value: -10 }), false).ok).toBe(true);
  });

  it("refuses ₹0 and negative outcomes", () => {
    expect(planVariantReprice(base, 0, rule({ mode: "AMOUNT", value: -100 }), true).ok).toBe(false);
  });

  it("skips a no-op instead of writing it", () => {
    const r = planVariantReprice(base, 0, rule({ mode: "SET", value: 100 }), false);
    expect(r).toEqual({ ok: false, reason: "Already at this price." });
  });
});
