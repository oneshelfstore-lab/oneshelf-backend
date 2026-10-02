import { describe, it, expect } from "vitest";
import { buildCollectionWhere, collectionBodySchema, hasSelector, inWindow, slugify } from "../collections.js";

// grocery > dairy > milk ; grocery > staples ; fresh
const tree = [
  { id: "grocery", parentId: null }, { id: "dairy", parentId: "grocery" }, { id: "milk", parentId: "dairy" },
  { id: "staples", parentId: "grocery" }, { id: "fresh", parentId: null },
];

describe("buildCollectionWhere", () => {
  it("MANUAL = exactly the pinned products (rules are ignored)", () => {
    expect(buildCollectionWhere({ mode: "MANUAL", rules: { brands: ["Amul"] } }, ["a", "b"], [], tree)).toEqual({ id: { in: ["a", "b"] } });
  });

  it("SMART with no usable selector falls back to pins only (never 'everything')", () => {
    expect(buildCollectionWhere({ mode: "SMART", rules: {} }, ["a"], [], tree)).toEqual({ id: { in: ["a"] } });
    expect(buildCollectionWhere({ mode: "SMART", rules: { inStock: true } }, [], [], tree)).toEqual({ id: { in: [] } });
    expect(buildCollectionWhere({ mode: "SMART", rules: "garbage" }, [], [], tree)).toEqual({ id: { in: [] } });
  });

  it("SMART category rule expands to the whole subtree, matching categoryId or leafCategoryId", () => {
    const w: any = buildCollectionWhere({ mode: "SMART", rules: { categoryIds: ["dairy"] } }, [], [], tree);
    const ids = w.OR[0].AND[0].OR[0].categoryId.in.sort();
    expect(ids).toEqual(["dairy", "milk"]);
    expect(w.OR[0].AND[0].OR[1].leafCategoryId.in.sort()).toEqual(["dairy", "milk"]);
  });

  it("SMART ANDs every rule, ORs the pins, and subtracts excludes", () => {
    const w: any = buildCollectionWhere(
      { mode: "SMART", rules: { brands: ["Amul", "Mother Dairy"], priceMax: 100, inStock: true } }, ["pin1"], ["gone"], tree,
    );
    expect(w.AND[1]).toEqual({ id: { notIn: ["gone"] } });
    const or = w.AND[0].OR;
    expect(or[1]).toEqual({ id: { in: ["pin1"] } });
    const and = or[0].AND;
    expect(and).toHaveLength(3); // brands, price, inStock
    expect(and[0].OR).toHaveLength(2);
    expect(and[1].variants.some.sellingPrice).toEqual({ gte: undefined, lte: 100 });
    expect(and[2].variants.some.stock).toEqual({ gt: 0 });
  });
});

describe("hasSelector", () => {
  it("needs categories, brands or a price bound; inStock alone is not enough", () => {
    expect(hasSelector({ inStock: true })).toBe(false);
    expect(hasSelector({ priceMin: 0 })).toBe(true);
    expect(hasSelector({ brands: ["x"] })).toBe(true);
    expect(hasSelector(null)).toBe(false);
  });
});

describe("inWindow", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  it("open-ended, inside, before and after the window", () => {
    expect(inWindow({ startsAt: null, endsAt: null }, now)).toBe(true);
    expect(inWindow({ startsAt: new Date("2026-10-01"), endsAt: new Date("2026-11-01") }, now)).toBe(true);
    expect(inWindow({ startsAt: new Date("2026-10-25"), endsAt: null }, now)).toBe(false);
    expect(inWindow({ startsAt: null, endsAt: new Date("2026-10-10") }, now)).toBe(false);
  });
});

describe("collectionBodySchema", () => {
  it("applies defaults for a minimal manual collection", () => {
    const r = collectionBodySchema.parse({ name: "Diwali essentials" });
    expect(r).toMatchObject({ kind: "COLLECTION", mode: "MANUAL", showOn: [], isActive: true, displayOrder: 0 });
  });
  it("rejects a SMART collection with no real rule and a backwards window", () => {
    expect(collectionBodySchema.safeParse({ name: "x", mode: "SMART", rules: { inStock: true } }).success).toBe(false);
    expect(collectionBodySchema.safeParse({ name: "x", startsAt: "2026-11-01", endsAt: "2026-10-01" }).success).toBe(false);
  });
  it("accepts a SMART collection with a price band and coerces dates", () => {
    const r = collectionBodySchema.parse({ name: "Under 100", mode: "SMART", rules: { priceMax: 100 }, endsAt: "2026-12-01" });
    expect(r.endsAt).toBeInstanceOf(Date);
  });
});

describe("slugify", () => {
  it("lowercases, hyphenates and never returns empty", () => {
    expect(slugify("Diwali Essentials & Pooja!")).toBe("diwali-essentials-and-pooja");
    expect(slugify("!!!")).toBe("collection");
  });
});
