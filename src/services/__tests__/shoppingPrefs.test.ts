import { describe, it, expect } from "vitest";
import { shoppingPrefsSchema, readShoppingPrefs } from "../shoppingPrefs.js";

describe("shoppingPrefsSchema", () => {
  it("dedupes services and categories", () => {
    const p = shoppingPrefsSchema.parse({ services: ["SHOP", "SHOP", "FOOD"], categories: ["dairy", "dairy"] });
    expect(p.services).toEqual(["SHOP", "FOOD"]);
    expect(p.categories).toEqual(["dairy"]);
  });

  it("rejects an unknown service instead of storing it", () => {
    expect(shoppingPrefsSchema.safeParse({ services: ["TELEPORT"], categories: [] }).success).toBe(false);
  });

  it("caps categories so a client can't store an unbounded blob", () => {
    const many = Array.from({ length: 31 }, (_, i) => `c${i}`);
    expect(shoppingPrefsSchema.safeParse({ services: [], categories: many }).success).toBe(false);
  });
});

describe("readShoppingPrefs", () => {
  it("NULL means never asked, distinct from an explicit 'chose nothing'", () => {
    expect(readShoppingPrefs(null)).toBeNull();
    expect(readShoppingPrefs({ services: [], categories: [] })).toEqual({ services: [], categories: [] });
  });

  it("reads malformed stored JSON as never-set rather than throwing", () => {
    expect(readShoppingPrefs("garbage")).toBeNull();
    expect(readShoppingPrefs({ services: ["NOPE"], categories: [] })).toBeNull();
  });
});
