import { describe, it, expect } from "vitest";
import { unpackedSellers, packBlockerMessage, type SliceReadiness } from "../subOrderFulfillment.js";

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
