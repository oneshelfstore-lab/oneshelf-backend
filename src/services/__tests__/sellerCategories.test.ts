import { describe, it, expect } from "vitest";
import { allowedRoots, departmentsOf, type PickerRoot } from "../sellerCategories.js";

const sup = (slug: string, departments: string[], isActive = true) => ({ id: slug, slug, name: slug, departments, isActive });
const root = (id: string, superCategory: PickerRoot["superCategory"]): PickerRoot =>
  ({ id, slug: id, name: id, nameHi: null, imageUrl: null, displayOrder: 0, superCategory });
const roots = [
  root("pens", sup("school", ["Books & stationery"])),
  root("staples", sup("grocery", ["Grocery"])),
  root("diwali", sup("diwali", [])),
  root("orphan", null),
];

describe("departmentsOf", () => {
  it("recovers registration departments from shop type + also-sell, incl. licensed Health lines", () => {
    expect(departmentsOf("STATIONERY", ["GENERAL_STORE"]).sort()).toEqual(["Books & stationery", "Grocery"]);
    expect(departmentsOf("GENERAL_STORE", ["PHARMACY"]).sort()).toEqual(["Grocery", "Health"]);
    expect(departmentsOf(null, [])).toEqual([]);
  });
});

describe("allowedRoots", () => {
  it("shows only the roots under supers whose departments match", () => {
    expect(allowedRoots(roots, ["Books & stationery"]).map((r) => r.id)).toEqual(["pens"]);
    expect(allowedRoots(roots, ["Books & stationery", "Grocery"]).map((r) => r.id)).toEqual(["pens", "staples"]);
  });
  it("fails open: no departments, or none matching any super → everything", () => {
    expect(allowedRoots(roots, []).map((r) => r.id)).toEqual(["pens", "staples", "orphan"]);
    expect(allowedRoots(roots, ["Pet"]).map((r) => r.id)).toEqual(["pens", "staples", "orphan"]);
  });
  it("never offers a super with no departments (Diwali), even when failing open", () => {
    expect(allowedRoots(roots, []).some((r) => r.id === "diwali")).toBe(false);
  });
  it("ignores inactive supers", () => {
    expect(allowedRoots([root("a", sup("s", ["Grocery"], false)), root("b", null)], ["Grocery"])).toHaveLength(1);
  });
});
