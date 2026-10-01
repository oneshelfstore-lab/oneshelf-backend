import { describe, it, expect } from "vitest";
import { normaliseDishOptions, parseDishOptions, resolveSelection } from "../foodOptions.js";

const dish = {
  name: "Chicken Biryani",
  price: 140,
  variants: [
    { id: "half", name: "Half", price: 140 },
    { id: "full", name: "Full", price: 220 },
  ],
  addOns: [
    { id: "raita", name: "Raita", price: 20 },
    { id: "chk", name: "Extra chicken", price: 80 },
  ],
  optionGroups: [
    {
      id: "spice", name: "Spice level", required: true, maxChoices: 1,
      options: [
        { id: "mild", name: "Mild", priceDelta: 0 },
        { id: "hot", name: "Spicy", priceDelta: 0 },
      ],
    },
    {
      id: "top", name: "Toppings", required: false, maxChoices: 2,
      options: [
        { id: "cheese", name: "Cheese", priceDelta: 30 },
        { id: "onion", name: "Onion", priceDelta: 10 },
        { id: "egg", name: "Egg", priceDelta: 15 },
      ],
    },
  ],
};

describe("resolveSelection", () => {
  it("prices size + add-ons + paid options, from the stored dish", () => {
    const r = resolveSelection(dish, { variantId: "full", addOnIds: ["raita", "chk"], optionIds: ["mild", "cheese"] });
    expect(r.unitPrice).toBe(220 + 20 + 80 + 30);
  });

  it("puts only PRICED things on the invoice line; free choices stay in the notes", () => {
    const r = resolveSelection(dish, { variantId: "half", addOnIds: ["raita"], optionIds: ["hot"] });
    expect(r.invoiceName).toBe("Chicken Biryani (Half) + Raita");
    expect(r.notes).toEqual(["Size: Half", "+ Raita", "Spice level: Spicy"]);
  });

  it("refuses a missing size, but a dish with no sizes needs none", () => {
    expect(() => resolveSelection(dish, { optionIds: ["mild"] })).toThrow(/Choose a size/);
    const plain = { ...dish, variants: [], optionGroups: [] };
    expect(resolveSelection(plain, {}).unitPrice).toBe(140);
    expect(() => resolveSelection(plain, { variantId: "full" })).toThrow();
  });

  it("enforces required groups and the pick limit", () => {
    expect(() => resolveSelection(dish, { variantId: "half" })).toThrow(/Choose Spice level/);
    expect(() =>
      resolveSelection(dish, { variantId: "half", optionIds: ["mild", "cheese", "onion", "egg"] }),
    ).toThrow(/at most 2/);
  });

  it("refuses ids that are not on this dish — a client cannot invent a price", () => {
    expect(() => resolveSelection(dish, { variantId: "half", addOnIds: ["free-lunch"], optionIds: ["mild"] })).toThrow();
    expect(() => resolveSelection(dish, { variantId: "half", optionIds: ["mild", "nope"] })).toThrow();
  });

  it("counts a repeated add-on id once", () => {
    const r = resolveSelection(dish, { variantId: "half", addOnIds: ["raita", "raita"], optionIds: ["mild"] });
    expect(r.unitPrice).toBe(140 + 20);
  });
});

describe("normaliseDishOptions", () => {
  it("mints ids, keeps existing ones, and pins price to the first size", () => {
    const n = normaliseDishOptions({
      variants: [{ id: "keep", name: "Half", price: 150 }, { name: "Full", price: 250 }],
    });
    expect(n.variants![0].id).toBe("keep");
    expect(n.variants![1].id).toBeTruthy();
    expect(n.variants![1].id).not.toBe("keep");
    expect(n.price).toBe(150);
  });

  it("does not touch price when there are no sizes, and clamps maxChoices to the option count", () => {
    const n = normaliseDishOptions({
      variants: [],
      optionGroups: [{ name: "Size", required: true, maxChoices: 5, options: [{ name: "A", priceDelta: 0 }, { name: "B", priceDelta: 0 }] }],
    });
    expect(n.price).toBeUndefined();
    expect(n.optionGroups![0].maxChoices).toBe(2);
  });

  it("gives duplicate ids a fresh one so lookups stay unambiguous", () => {
    const n = normaliseDishOptions({ addOns: [{ id: "x", name: "A", price: 1 }, { id: "x", name: "B", price: 2 }] });
    expect(new Set(n.addOns!.map((a) => a.id)).size).toBe(2);
  });
});

describe("parseDishOptions", () => {
  it("reads a malformed column as no options instead of throwing", () => {
    expect(parseDishOptions({ variants: "garbage", addOns: null, optionGroups: [{ nope: 1 }] })).toEqual({
      variants: [], addOns: [], optionGroups: [],
    });
  });
});
