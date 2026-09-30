import { describe, it, expect } from "vitest";
import { priceMoved } from "../priceHistory.js";

describe("priceMoved", () => {
  it("is false when nothing changed, even with float noise", () => {
    expect(priceMoved({ sellingPrice: 29, mrp: 30 }, { sellingPrice: 29.000001, mrp: 30 })).toBe(false);
  });
  it("catches a selling-price or an MRP change on its own", () => {
    expect(priceMoved({ sellingPrice: 29, mrp: 30 }, { sellingPrice: 31, mrp: 30 })).toBe(true);
    expect(priceMoved({ sellingPrice: 29, mrp: 30 }, { sellingPrice: 29, mrp: 32 })).toBe(true);
  });
});
