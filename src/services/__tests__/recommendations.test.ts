import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ products: [] as any[], base: null as any, mine: [] as any[], rows: [] as any[] }));

// Minimal fake of the three Prisma calls the service makes. `find` honours the where clauses the service uses.
vi.mock("../../lib/prisma.js", () => ({
  default: {
    catalogProduct: {
      findFirst: vi.fn(async () => h.base),
      findMany: vi.fn(async ({ where }: any) =>
        h.products.filter((p) =>
          (!where.id?.in || where.id.in.includes(p.id)) &&
          (!where.id?.notIn || !where.id.notIn.includes(p.id)) &&
          (!where.categoryId || p.categoryId === where.categoryId) &&
          (!where.brand?.equals || p.brand?.toLowerCase() === where.brand.equals.toLowerCase()) &&
          (!where.sellerId || p.sellerId === where.sellerId),
        ),
      ),
    },
    orderItem: {
      findMany: vi.fn(async ({ select }: any) => (select.variant ? h.rows : h.mine)),
    },
  },
}));

import { getRecommendations, rankCoPurchased, scoreSimilar } from "../recommendations.js";

const ctx = { eligible: {}, include: {} };
const prod = (id: string, over: any = {}) => ({
  id, name: id, brand: null, categoryId: "dairy", leafCategoryId: null, sellerId: null,
  variants: [{ sellingPrice: 30 }], ...over,
});

describe("rankCoPurchased", () => {
  it("counts distinct orders, drops self and one-off pairings, most frequent first", () => {
    const rows = [
      { orderId: "o1", productId: "bread" }, { orderId: "o2", productId: "bread" }, { orderId: "o2", productId: "bread" },
      { orderId: "o1", productId: "eggs" }, { orderId: "o2", productId: "eggs" }, { orderId: "o3", productId: "eggs" },
      { orderId: "o1", productId: "salt" },
      { orderId: "o1", productId: "milk" }, { orderId: "o2", productId: "milk" },
    ];
    expect(rankCoPurchased(rows, "milk")).toEqual([
      { productId: "eggs", orders: 3 },
      { productId: "bread", orders: 2 }, // the duplicate row in o2 is one order
    ]);
  });
});

describe("scoreSimilar", () => {
  const base = { brand: "Amul", price: 30, leafCategoryId: "milk" };
  it("rewards same sub-category, same brand and close price", () => {
    const full = scoreSimilar(base, { brand: "amul ", price: 30, leafCategoryId: "milk" });
    expect(full).toBe(2 + 3 + 2);
    expect(scoreSimilar(base, { brand: "Other", price: 30, leafCategoryId: null })).toBe(2);
    expect(scoreSimilar(base, { brand: null, price: 300, leafCategoryId: null })).toBe(0);
  });
});

describe("getRecommendations", () => {
  const reset = (base: any, products: any[], mine: any[] = [], rows: any[] = []) => {
    h.base = base; h.products = products; h.mine = mine; h.rows = rows;
  };

  it("null when the viewed product is not visible", async () => {
    reset(null, []);
    expect(await getRecommendations("x", ctx as any)).toBeNull();
  });

  it("builds sections, never repeats a product, drops sections under 3", async () => {
    const co = (orderId: string, productId: string) => ({ orderId, variant: { productId } });
    reset(
      { ...prod("milk", { brand: "Amul", sellerId: "s1", seller: { isHouse: false } }) },
      [
        prod("bread"), prod("eggs"), prod("butter"),                                  // co-purchased
        prod("curd", { brand: "Amul" }), prod("paneer", { brand: "Amul" }), prod("ghee", { brand: "Amul" }), // same category/brand
        prod("tea", { categoryId: "bev", brand: "Amul", sellerId: "s1" }),            // same brand + store, other category
      ],
      [{ orderId: "o1" }, { orderId: "o2" }],
      ["bread", "eggs", "butter"].flatMap((p) => [co("o1", p), co("o2", p)]),
    );
    const out = (await getRecommendations("milk", ctx as any))!;
    const byType = Object.fromEntries(out.map((s) => [s.type, s.products.map((p: any) => p.id)]));
    expect(byType.FREQUENTLY_BOUGHT_TOGETHER?.sort()).toEqual(["bread", "butter", "eggs"]);
    // The co-purchased trio is excluded from SIMILAR; what remains in the category is curd/paneer/ghee.
    expect(byType.SIMILAR?.sort()).toEqual(["curd", "ghee", "paneer"]);
    // Brand + store shelves would only have "tea" left (1 item) → dropped.
    expect(byType.BRAND).toBeUndefined();
    expect(byType.FROM_THIS_STORE).toBeUndefined();
    const all = out.flatMap((s) => s.products.map((p: any) => p.id));
    expect(new Set(all).size).toBe(all.length);
  });

  it("a shop with no order history shows only what is real (no together shelf)", async () => {
    reset(prod("milk"), [prod("a"), prod("b"), prod("c")], [{ orderId: "o1" }], []);
    const out = (await getRecommendations("milk", ctx as any))!;
    expect(out.map((s) => s.type)).toEqual(["SIMILAR"]);
  });

  it("house-store products never get a 'from this store' shelf", async () => {
    reset(
      prod("milk", { sellerId: "house", seller: { isHouse: true } }),
      [prod("a", { sellerId: "house" }), prod("b", { sellerId: "house", categoryId: "x" }), prod("c", { sellerId: "house", categoryId: "y" }), prod("d", { sellerId: "house", categoryId: "z" })],
    );
    const out = (await getRecommendations("milk", ctx as any))!;
    expect(out.some((s) => s.type === "FROM_THIS_STORE")).toBe(false);
  });
});
