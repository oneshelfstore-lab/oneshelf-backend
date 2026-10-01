import { describe, it, expect, vi } from "vitest";

// Released app builds speak the single-product subscription shape. The routine API must keep accepting
// it and keep returning the fields those builds parse.
vi.mock("../../lib/prisma.js", () => ({ default: {} }));
vi.mock("../../middleware/firebaseAuth.js", () => ({
  firebaseAuthMiddleware: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

import { legacyToItems, serialize } from "../../routes/subscriptions.js";

describe("old single-product create body", () => {
  it("is folded into a one-item routine", () => {
    const out = legacyToItems({ variantId: "v1", quantity: 2, addressId: "a1", frequency: "DAILY" }) as any;
    expect(out.items).toEqual([{ variantId: "v1", quantity: 2 }]);
    expect(out.addressId).toBe("a1");
  });

  it("leaves a new-style body (with items) alone", () => {
    const body = { items: [{ variantId: "v1", quantity: 1 }, { variantId: "v2", quantity: 3 }] };
    expect(legacyToItems(body)).toBe(body);
  });
});

describe("serialize — what old and new apps read", () => {
  const routine = {
    id: "s1",
    name: "Morning essentials",
    productName: "Morning essentials",
    variantId: null,
    quantity: null,
    priceCeilingValue: "30",
    items: [
      { id: "i1", variantId: "milk", productName: "Milk", quantity: "2", isLoose: false, stepSize: null, stepUnit: null, unitPriceSnapshot: "50" },
      { id: "i2", variantId: "bread", productName: "Bread", quantity: "1", isLoose: false, stepSize: null, stepUnit: null, unitPriceSnapshot: "40" },
    ],
  };

  it("exposes every item as numbers", () => {
    const s = serialize(routine);
    expect(s.items.map((i: any) => [i.variantId, i.quantity, i.unitPriceSnapshot])).toEqual([["milk", 2, 50], ["bread", 1, 40]]);
    expect(s.priceCeilingValue).toBe(30);
  });

  it("derives the legacy single-product fields from the first item (old builds never see null)", () => {
    const s = serialize(routine);
    expect(s.variantId).toBe("milk");
    expect(s.quantity).toBe(2);
    expect(s.unitPriceSnapshot).toBe(50);
    expect(s.productName).toBe("Morning essentials");
  });

  it("a legacy row with no items serialises from its own columns", () => {
    const s = serialize({ id: "s2", productName: "Milk", variantId: "milk", quantity: "3", isLoose: false, stepSize: null, stepUnit: null, unitPriceSnapshot: "50", items: [] });
    expect(s.items).toEqual([]);
    expect(s.variantId).toBe("milk");
    expect(s.quantity).toBe(3);
    expect(s.unitPriceSnapshot).toBe(50);
  });
});
