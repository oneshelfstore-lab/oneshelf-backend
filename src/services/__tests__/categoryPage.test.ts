import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ default: {} }));
vi.mock("../../routes/catalog.js", () => ({ formatProductForApp: (p: any) => p, SELLER_SELECT: {}, SELLER_TRADING: {} }));
vi.mock("../../routes/collections.js", () => ({ VISIBLE: {}, whereFor: async () => ({}) }));
vi.mock("../../routes/categories.js", () => ({ loadSubcategories: async () => [] }));

import { topIdsByCount } from "../../routes/categoryPage.js";

describe("topIdsByCount", () => {
  it("most frequent first, ties by id, ignores blanks, capped at n", () => {
    expect(topIdsByCount(["b", "a", "b", null, undefined, "c", "a", "b", "d"], 3)).toEqual(["b", "a", "c"]);
  });
  it("empty in, empty out", () => {
    expect(topIdsByCount([], 5)).toEqual([]);
  });
});
