import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ default: {} }));

import { analyzeSchema, buildPrompt, claimWarnings, describeChoice, sanitizeAnalysis } from "../productIntelligence.js";

const input = analyzeSchema.parse({ name: "Amul Taaza Milk", brand: "Amul", packSize: "500 ml" });
const ids = new Set(["milk", "curd", "shampoo"]);

describe("claimWarnings", () => {
  it("flags a claim the seller never supplied", () => {
    expect(claimWarnings("Pure organic milk", "Amul Taaza Milk Amul 500 ml")).toEqual(["organic", "pure"]);
  });
  it("allows it when the seller's own details contain it", () => {
    expect(claimWarnings("Fresh paneer", "Fresh Paneer 200 g")).toEqual([]);
  });
  it("matches whole words only", () => {
    expect(claimWarnings("Isolated pack", "x")).toEqual([]);
  });
});

describe("sanitizeAnalysis", () => {
  const ok = {
    categoryId: "milk", alternativeCategoryId: "curd", confidence: "HIGH", brand: "Amul",
    description: "Amul Taaza Milk is a 500 ml milk pack.", descriptionHi: "अमूल ताज़ा मिल्क 500 मिली का पैक है।",
    highlights: ["500 ml pack", "Amul", "Premium quality", "Milk", "extra"], searchKeywords: ["Milk", "milk", "amul milk"],
  };

  it("keeps a valid proposal and drops risky highlights", () => {
    const a = sanitizeAnalysis(ok, input, ids);
    expect(a.categoryId).toBe("milk");
    expect(a.alternativeCategoryId).toBe("curd");
    expect(a.highlights).not.toContain("Premium quality");
    expect(a.highlights.length).toBeLessThanOrEqual(4);
    expect(a.searchKeywords).toEqual(["milk", "amul milk"]); // lowercased + de-duplicated
    expect(a.warnings.some((w) => w.includes("premium"))).toBe(true);
  });

  it("rejects a category id we did not offer", () => {
    const a = sanitizeAnalysis({ ...ok, categoryId: "made-up", alternativeCategoryId: "milk" }, input, ids);
    expect(a.categoryId).toBeNull();
    expect(a.confidence).toBe("LOW");
    expect(a.warnings.join(" ")).toMatch(/choose it yourself/);
    expect(a.alternativeCategoryId).toBe("milk");
  });

  it("alternative may not equal the main category", () => {
    expect(sanitizeAnalysis({ ...ok, alternativeCategoryId: "milk" }, input, ids).alternativeCategoryId).toBeNull();
  });

  it("language EN returns no Hindi; HI returns no English", () => {
    expect(sanitizeAnalysis(ok, { ...input, language: "EN" }, ids).descriptionHi).toBe("");
    expect(sanitizeAnalysis(ok, { ...input, language: "HI" }, ids).description).toBe("");
  });

  it("survives garbage from the model", () => {
    const a = sanitizeAnalysis({ highlights: "nope", searchKeywords: 5, confidence: "SURE" }, input, ids);
    expect(a).toMatchObject({ categoryId: null, confidence: "LOW", highlights: [], searchKeywords: [], description: "" });
  });
});

describe("buildPrompt", () => {
  it("lists categories by id and carries the facts", () => {
    const p = buildPrompt(input, [{ id: "milk", path: "Grocery › Dairy › Milk", categorySlug: "grocery", subcategory: "Milk" }]);
    expect(p).toContain("milk | Grocery › Dairy › Milk");
    expect(p).toContain("Pack size: 500 ml");
  });
});

describe("analyzeSchema", () => {
  it("defaults to both languages and rejects a one-letter name", () => {
    expect(input.language).toBe("BOTH");
    expect(analyzeSchema.safeParse({ name: "a" }).success).toBe(false);
  });
});

describe("describeChoice", () => {
  const opts = [
    { id: "g", path: "Grocery", categorySlug: "grocery", subcategory: "" },
    { id: "m", path: "Grocery › Milk", categorySlug: "grocery", subcategory: "Milk" },
  ];
  it("returns the editor fields for a child, a root, and null for unknown", () => {
    expect(describeChoice(opts, "m")).toEqual({ path: "Grocery › Milk", categorySlug: "grocery", subcategory: "Milk" });
    expect(describeChoice(opts, "g")?.subcategory).toBe("");
    expect(describeChoice(opts, "x")).toBeNull();
    expect(describeChoice(opts, null)).toBeNull();
  });
});
