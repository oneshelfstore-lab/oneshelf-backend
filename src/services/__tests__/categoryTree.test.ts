import { describe, it, expect } from "vitest";
import { assertCanMove, buildTree, childSlug, resolveCategoryFields, subtreeIds } from "../categoryTree.js";

// grocery(root) > dairy > milk > toned ; grocery > staples ; fresh(root)
const rows = [
  { id: "grocery", parentId: null },
  { id: "dairy", parentId: "grocery" },
  { id: "milk", parentId: "dairy" },
  { id: "toned", parentId: "milk" },
  { id: "staples", parentId: "grocery" },
  { id: "fresh", parentId: null },
];

describe("assertCanMove", () => {
  it("allows moving a branch under another root", () => {
    expect(() => assertCanMove(rows, "staples", "fresh")).not.toThrow();
  });
  it("refuses to move a root", () => {
    expect(() => assertCanMove(rows, "fresh", "grocery")).toThrow(/Top-level/);
  });
  it("refuses a cycle (under own descendant or itself)", () => {
    expect(() => assertCanMove(rows, "dairy", "toned")).toThrow(/under itself/);
    expect(() => assertCanMove(rows, "dairy", "dairy")).toThrow(/under itself/);
  });
  it("refuses to go past the depth cap", () => {
    // dairy subtree is 3 deep; under `toned` is excluded above, so put it under a depth-3 node elsewhere
    const deep = [...rows, { id: "a", parentId: "staples" }, { id: "b", parentId: "a" }];
    expect(() => assertCanMove(deep, "dairy", "b")).toThrow(/levels deep/);
  });
});

describe("subtreeIds", () => {
  it("returns the node and all descendants", () => {
    expect(subtreeIds(rows, "dairy").sort()).toEqual(["dairy", "milk", "toned"]);
  });
});

describe("buildTree", () => {
  const cat = (id: string, parentId: string | null, displayOrder = 0) => ({
    id, parentId, displayOrder, slug: id, name: id, nameHi: null, imageUrl: null, description: null,
    showInNavigation: true, isActive: true, superCategoryId: null,
  });
  const tree = buildTree(
    [cat("grocery", null), cat("dairy", "grocery", 1), cat("staples", "grocery", 0), cat("milk", "dairy"), cat("fresh", null, 1)],
    new Map([["milk", 5], ["staples", 2]]),
    new Map([["grocery", 9], ["fresh", 1]]),
  );
  it("nests children in display order, roots first", () => {
    expect(tree.map((n) => n.id)).toEqual(["grocery", "fresh"]);
    expect(tree[0]!.children.map((n) => n.id)).toEqual(["staples", "dairy"]);
  });
  it("roll up counts: roots use categoryId, children sum their subtree's leaf products", () => {
    expect(tree[0]!.productCount).toBe(9);
    expect(tree[0]!.children[1]!.productCount).toBe(5); // dairy = milk
    expect(tree[0]!.children[0]!.productCount).toBe(2);
  });
});

describe("resolveCategoryFields", () => {
  const cats: Record<string, any> = {
    grocery: { id: "grocery", slug: "grocery", name: "Grocery", parentId: null },
    dairy: { id: "dairy", slug: "grocery__dairy", name: "Dairy", parentId: "grocery" },
    milk: { id: "milk", slug: "grocery__milk", name: "Milk", parentId: "dairy" },
    fresh: { id: "fresh", slug: "fresh", name: "Fresh", parentId: null },
  };
  const db: any = {
    category: {
      findUnique: async ({ where }: any) => (where.id ? cats[where.id] : Object.values(cats).find((c) => c.slug === where.slug)) ?? null,
      findFirst: async ({ where }: any) =>
        Object.values(cats).find((c) => c.parentId === where.parentId && c.name.toLowerCase() === where.name.equals.toLowerCase()) ?? null,
    },
  };

  it("leaf wins: root derived from the leaf, subcategory = leaf name", async () => {
    expect(await resolveCategoryFields(db, { leafCategoryId: "milk" })).toEqual({
      categoryId: "grocery", leafCategoryId: "milk", subcategory: "Milk",
    });
  });
  it("leaf that is itself a root: no leaf, no subcategory", async () => {
    expect(await resolveCategoryFields(db, { leafCategoryId: "grocery" })).toEqual({
      categoryId: "grocery", leafCategoryId: null, subcategory: null,
    });
  });
  it("admin routes: a root categoryId links a matching child; a child categoryId is treated as the leaf", async () => {
    expect((await resolveCategoryFields(db, { categoryId: "grocery", subcategory: "Dairy" })).leafCategoryId).toBe("dairy");
    expect(await resolveCategoryFields(db, { categoryId: "milk" })).toEqual({
      categoryId: "grocery", leafCategoryId: "milk", subcategory: "Milk",
    });
  });
  it("old app: slug + free-text name links to the matching child (case-insensitive)", async () => {
    expect(await resolveCategoryFields(db, { categorySlug: "grocery", subcategory: "dairy " })).toEqual({
      categoryId: "grocery", subcategory: "dairy ", leafCategoryId: "dairy",
    });
  });
  it("old app: unknown free-text keeps the string and clears the leaf", async () => {
    expect((await resolveCategoryFields(db, { categorySlug: "grocery", subcategory: "Mystery" })).leafCategoryId).toBeNull();
  });
  it("changing the top-level category without a subcategory drops the stale leaf", async () => {
    expect((await resolveCategoryFields(db, { categorySlug: "fresh" }, "grocery")).leafCategoryId).toBeNull();
  });
  it("nothing sent → nothing written", async () => {
    expect(await resolveCategoryFields(db, {}, "grocery")).toEqual({});
  });
  it("unknown leaf / slug is a validation error", async () => {
    await expect(resolveCategoryFields(db, { leafCategoryId: "nope" })).rejects.toThrow(/not found/);
    await expect(resolveCategoryFields(db, { categorySlug: "nope" })).rejects.toThrow(/not found/);
  });
});

describe("childSlug", () => {
  it("is deterministic and within the 50-char slug limit", () => {
    expect(childSlug("dairy", "Curd & Yogurt")).toBe("dairy__curd_and_yogurt");
    expect(childSlug("x".repeat(40), "A very long sub category name").length).toBeLessThanOrEqual(50);
  });
});
