import { describe, it, expect } from "vitest";
import { SELLABLE_SUPERS, allowedRoots, departmentsOf, effectiveSupers, type PickerRoot } from "../sellerCategories.js";

const sup = (name: string, isActive = true) => ({ id: name, slug: name, name, isActive });
const root = (id: string, superCategory: PickerRoot["superCategory"]): PickerRoot =>
  ({ id, slug: id, name: id, nameHi: null, imageUrl: null, displayOrder: 0, superCategory });
const roots = [
  root("pens", sup("Stationery & Office")),
  root("staples", sup("Grocery & Food")),
  root("textbooks", sup("Books & Education")),
  root("hidden", sup("Retired", false)),
  root("orphan", null),
];

describe("departmentsOf", () => {
  it("recovers the super-categories a seller registered for from shop type + also-sell", () => {
    expect(departmentsOf("STATIONERY", ["GENERAL_STORE"]).sort()).toEqual(["Grocery & Food", "Stationery & Office"]);
    expect(departmentsOf("GENERAL_STORE", ["PHARMACY"]).sort()).toEqual(["Grocery & Food", "Health & Wellness"]);
    expect(departmentsOf("BOOKS", [])).toEqual(["Books & Education"]);
  });
  it("uses the shop type's own super, not just the representative", () => {
    expect(departmentsOf("DAIRY", ["PET_FOOD", "NURSERY"]).sort()).toEqual(["Fresh & Dairy", "Home & Kitchen", "Pet Supplies"]);
  });
  it("ignores restaurants/bakeries (food layer) and retired fashion trades", () => {
    expect(departmentsOf("RESTAURANT", ["CLOTHING", "BAKERY"])).toEqual([]);
    expect(departmentsOf(null, [])).toEqual([]);
  });
});

describe("allowedRoots", () => {
  it("shows only the roots on the supers the seller picked", () => {
    expect(allowedRoots(roots, ["Stationery & Office"]).map((r) => r.id)).toEqual(["pens"]);
    expect(allowedRoots(roots, ["Stationery & Office", "Grocery & Food"]).map((r) => r.id)).toEqual(["pens", "staples"]);
  });
  it("Stationery and Books are separate picks now", () => {
    expect(allowedRoots(roots, ["Books & Education"]).map((r) => r.id)).toEqual(["textbooks"]);
  });
  it("fails open: no picks, or none matching an active super → everything sellable, never an inactive super", () => {
    expect(allowedRoots(roots, []).map((r) => r.id)).toEqual(["pens", "staples", "textbooks", "orphan"]);
    expect(allowedRoots(roots, ["Pet Supplies"]).map((r) => r.id)).toEqual(["pens", "staples", "textbooks", "orphan"]);
  });
});

describe("effectiveSupers / SELLABLE_SUPERS", () => {
  const base = { shopType: "STATIONERY", alsoSellCategories: ["GENERAL_STORE"], sellsSuperCategories: ["Pet Supplies"], categoriesConfirmedAt: null as Date | null };
  it("until the seller confirms, the list is derived from their registration keys", () => {
    expect(effectiveSupers(base).sort()).toEqual(["Grocery & Food", "Stationery & Office"]);
  });
  it("once confirmed, their own pick wins — even over what their shop-type keys say", () => {
    expect(effectiveSupers({ ...base, categoriesConfirmedAt: new Date() })).toEqual(["Pet Supplies"]);
  });
  it("offers the 16 supers, never Food", () => {
    expect(SELLABLE_SUPERS).toHaveLength(16);
    expect(SELLABLE_SUPERS).not.toContain("Food");
    expect(SELLABLE_SUPERS).not.toContain("Fashion");
  });
});
