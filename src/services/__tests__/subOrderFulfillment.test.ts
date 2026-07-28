import { describe, it, expect } from "vitest";
import {
  unpackedSellers,
  packBlockerMessage,
  sliceRefundValue,
  splitRefundTenders,
  type SliceReadiness,
} from "../subOrderFulfillment.js";

/**
 * Pins the two ways this guard can be wrong, both silent:
 *   - too loose → the owner can still force PACKED past an unready seller and deadlock the collection
 *     run (the bug this exists to fix);
 *   - too strict → it blocks on a house slice, which would break every ordinary single-store order,
 *     since the collect route auto-collects house slices regardless of their status.
 */
const slice = (o: Partial<SliceReadiness> = {}): SliceReadiness => ({
  status: "PLACED",
  sellerName: "Seller",
  isHouse: false,
  ...o,
});

describe("unpackedSellers", () => {
  it("blocks on an external seller who hasn't packed", () => {
    expect(unpackedSellers([slice({ sellerName: "Aman Medicos" })])).toEqual(["Aman Medicos"]);
    expect(unpackedSellers([slice({ status: "ACCEPTED", sellerName: "Aman Medicos" })])).toEqual(["Aman Medicos"]);
  });

  it("never blocks on a house slice, whatever its status", () => {
    const house = [
      slice({ isHouse: true, sellerName: "Oneshelf", status: "PLACED" }),
      slice({ isHouse: true, sellerName: "Oneshelf", status: "ACCEPTED" }),
    ];
    expect(unpackedSellers(house)).toEqual([]);
  });

  it("treats PACKED / COLLECTED / CANCELLED as ready", () => {
    const ready = ["PACKED", "COLLECTED", "CANCELLED"].map((status) => slice({ status }));
    expect(unpackedSellers(ready)).toEqual([]);
  });

  it("names every blocking seller on a multi-seller order, and only those", () => {
    const order = [
      slice({ sellerName: "House", isHouse: true }),
      slice({ sellerName: "Ready Traders", status: "PACKED" }),
      slice({ sellerName: "Slow Traders" }),
      slice({ sellerName: "Also Slow", status: "ACCEPTED" }),
    ];
    expect(unpackedSellers(order)).toEqual(["Slow Traders", "Also Slow"]);
  });

  it("passes an order with no sub-orders at all (legacy / pre-split)", () => {
    expect(unpackedSellers([])).toEqual([]);
  });
});

describe("packBlockerMessage", () => {
  it("agrees with itself on singular vs plural", () => {
    expect(packBlockerMessage(["Solo"])).toContain("Solo hasn't packed");
    expect(packBlockerMessage(["A", "B"])).toContain("A, B haven't packed");
  });
});

/**
 * Refunding one seller's slice of a multi-seller order. Over-refunding hands back money the customer
 * never paid; under-refunding keeps money for goods they'll never get. Both are silent.
 */
describe("sliceRefundValue", () => {
  // ₹1000 of goods, ₹100 coupon, ₹30 delivery → customer charged ₹930.
  const order = { subtotal: 1000, totalAmount: 930, walletApplied: 0, deliveryCharge: 30 };

  it("refunds the slice's share of what was charged for GOODS, never the delivery", () => {
    // Slice is 40% of the goods → 40% of the ₹900 post-discount goods value.
    expect(sliceRefundValue(order, 400)).toBe(360);
  });

  it("passes the order-level discount through proportionally", () => {
    // Whole order as one slice → the full goods value, i.e. total minus the delivery that still runs.
    expect(sliceRefundValue(order, 1000)).toBe(900);
  });

  it("counts store credit as money the customer put in", () => {
    // Same order settled with ₹500 of credit: charged ₹430 + ₹500 credit = the same ₹900 of goods.
    const withCredit = { subtotal: 1000, totalAmount: 430, walletApplied: 500, deliveryCharge: 30 };
    expect(sliceRefundValue(withCredit, 400)).toBe(360);
  });

  it("never refunds more than the whole order, or anything on a degenerate order", () => {
    expect(sliceRefundValue(order, 5000)).toBe(900);
    expect(sliceRefundValue({ subtotal: 0, totalAmount: 0, walletApplied: 0, deliveryCharge: 0 }, 100)).toBe(0);
    expect(sliceRefundValue(order, 0)).toBe(0);
  });

  it("returns 0 when delivery alone accounts for the charge (nothing paid for goods)", () => {
    const freebie = { subtotal: 500, totalAmount: 30, walletApplied: 0, deliveryCharge: 30 };
    expect(sliceRefundValue(freebie, 250)).toBe(0);
  });
});

describe("splitRefundTenders", () => {
  it("takes it out of cash first", () => {
    expect(splitRefundTenders(360, { totalAmount: 930, walletApplied: 0 })).toEqual({ cash: 360, wallet: 0 });
  });

  it("falls back to store credit only for what cash can't cover", () => {
    // Customer was charged ₹100 and paid ₹500 from credit; a ₹360 refund is ₹100 cash + ₹260 credit.
    expect(splitRefundTenders(360, { totalAmount: 100, walletApplied: 500 })).toEqual({ cash: 100, wallet: 260 });
  });

  it("never returns more than was actually taken by either tender", () => {
    // Fully wallet-paid: nothing to refund in cash.
    expect(splitRefundTenders(360, { totalAmount: 0, walletApplied: 500 })).toEqual({ cash: 0, wallet: 360 });
    // Nothing collected at all (COD not yet paid) → nothing to hand back, only the due amount drops.
    expect(splitRefundTenders(360, { totalAmount: 0, walletApplied: 0 })).toEqual({ cash: 0, wallet: 0 });
  });
});
