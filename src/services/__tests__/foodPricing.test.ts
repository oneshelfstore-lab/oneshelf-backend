import { describe, it, expect } from "vitest";
import { priceFoodLines, computeFoodOrderTotals, round2, type FoodLineInput } from "../foodPricing.js";

const line = (over: Partial<FoodLineInput> = {}): FoodLineInput => ({
  menuItemId: "m1",
  name: "Paneer Butter Masala",
  imageUrl: null,
  unitPrice: 210,
  quantity: 1,
  gstRate: 5,
  sacCode: null,
  ...over,
});

describe("priceFoodLines", () => {
  it("backs GST OUT of the inclusive price rather than adding it on top", () => {
    // The silent failure this guards: charging ₹220.50 for a ₹210 menu item. Both directions
    // produce self-consistent totals, so only the taxable value distinguishes them.
    const [l] = priceFoodLines([line()]);
    expect(l!.lineTotal).toBe(210);
    expect(l!.taxableValue).toBe(200);
    expect(l!.cgst + l!.sgst).toBe(10);
  });

  it("splits tax evenly and always reconciles to the total tax", () => {
    // An odd-paisa tax is where independent rounding of each half drifts. Both sides are rounded:
    // the invariant is that the two halves foot to the tax IN PAISA, not in raw float arithmetic
    // (155 − 147.62 is 7.3799999999999955 as a double).
    const [l] = priceFoodLines([line({ unitPrice: 155, gstRate: 5 })]);
    expect(round2(l!.cgst + l!.sgst)).toBe(round2(l!.lineTotal - l!.taxableValue));
  });

  it("multiplies by quantity", () => {
    const [l] = priceFoodLines([line({ quantity: 3 })]);
    expect(l!.lineTotal).toBe(630);
  });

  it("handles a zero rate without dividing by zero", () => {
    const [l] = priceFoodLines([line({ gstRate: 0 })]);
    expect(l!.taxableValue).toBe(210);
    expect(l!.cgst).toBe(0);
    expect(l!.sgst).toBe(0);
  });
});

describe("computeFoodOrderTotals", () => {
  it("sums lines and adds delivery on top of the subtotal", () => {
    const t = computeFoodOrderTotals([line(), line({ unitPrice: 90, quantity: 2 })], 30);
    expect(t.subtotal).toBe(390); // 210 + 180
    expect(t.deliveryCharge).toBe(30);
    expect(t.totalAmount).toBe(420);
  });

  it("keeps totalTax equal to subtotal minus taxableValue", () => {
    const t = computeFoodOrderTotals([line({ unitPrice: 333, quantity: 3 })], 45);
    expect(t.totalTax).toBe(round2(t.subtotal - t.taxableValue));
  });

  it("does NOT tax the delivery charge", () => {
    // Delivery is outside taxableValue by design (matches the grocery path) — pinned so a later
    // change to fold it in is a deliberate decision with a failing test, not a silent drift.
    const withDelivery = computeFoodOrderTotals([line()], 50);
    const without = computeFoodOrderTotals([line()], 0);
    expect(withDelivery.taxableValue).toBe(without.taxableValue);
    expect(withDelivery.totalTax).toBe(without.totalTax);
  });

  it("an empty order is zero, not NaN", () => {
    const t = computeFoodOrderTotals([], 0);
    expect(t).toMatchObject({ subtotal: 0, taxableValue: 0, totalTax: 0, totalAmount: 0 });
  });
});
