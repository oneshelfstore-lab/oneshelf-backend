import { describe, it, expect } from "vitest";
import { hasStock, stockLimitBase, DEFAULT_UNTRACKED_CAP } from "../stockAvailability.js";

describe("stockAvailability", () => {
  it("tracked variants follow the stock number", () => {
    expect(hasStock({ stock: 0 })).toBe(false);
    expect(hasStock({ stock: 3, trackStock: true })).toBe(true);
    expect(stockLimitBase({ stock: 7 }, false)).toBe(7);
  });
  it("untracked variants are always available, capped per order", () => {
    expect(hasStock({ stock: 0, trackStock: false })).toBe(true);
    expect(stockLimitBase({ stock: 0, trackStock: false }, false)).toBe(DEFAULT_UNTRACKED_CAP);
    expect(stockLimitBase({ stock: 0, trackStock: false, maxOrderQty: 4 }, false)).toBe(4);
    // loose: cap is in sale increments, limit is in base units (4 × 0.25 kg)
    expect(stockLimitBase({ stock: 0, trackStock: false, maxOrderQty: 4, packageSize: 0.25 }, true)).toBe(1);
  });
});
