import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ default: {} }));
vi.mock("../../lib/firebase.js", () => ({ admin: {}, isFirebaseInitialized: () => false }));

import { analyzeSchema, buildPrompt, claimWarnings, describeChoice, sanitizeAnalysis, sanitizeLabel } from "../productIntelligence.js";
import { labelWrite, labelForApp } from "../productLabel.js";

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
    description: "Amul Taaza Milk is a 500 ml milk pack.",
    highlights: ["500 ml pack", "Amul", "Premium quality", "Milk", "extra", "sixth"], searchKeywords: ["Milk", "milk", "amul milk"],
    table: [], knownProduct: false, ingredients: "", allergens: [], dietMark: "", nutrition: { basis: "NONE" },
  };

  it("keeps a valid proposal and drops risky highlights", () => {
    const a = sanitizeAnalysis(ok, input, ids);
    expect(a.categoryId).toBe("milk");
    expect(a.alternativeCategoryId).toBe("curd");
    expect(a.highlights).not.toContain("Premium quality");
    expect(a.highlights.length).toBeLessThanOrEqual(5);
    expect(a.searchKeywords).toEqual(["milk", "amul milk"]); // lowercased + de-duplicated
    expect(a.warnings.some((w) => w.includes("premium"))).toBe(true);
    expect(a.label).toBeNull();
  });

  it("rejects a category id we did not offer", () => {
    const a = sanitizeAnalysis({ ...ok, categoryId: "made-up", alternativeCategoryId: "milk" }, input, ids);
    expect(a.categoryId).toBeNull();
    expect(a.confidence).toBe("LOW");
    expect(a.warnings.join(" ")).toMatch(/choose it yourself/);
    expect(a.alternativeCategoryId).toBe("milk");
  });

  it("does not ask the seller to pick a category when they already chose one", () => {
    const chosen = analyzeSchema.parse({ name: "Cello Pen", category: "Stationery › Pens" });
    expect(sanitizeAnalysis({ ...ok, categoryId: "" }, chosen, new Set()).warnings.join(" ")).not.toMatch(/choose it yourself/);
  });

  it("alternative may not equal the main category", () => {
    expect(sanitizeAnalysis({ ...ok, alternativeCategoryId: "milk" }, input, ids).alternativeCategoryId).toBeNull();
  });

  it("returns English only — no Hindi field exists any more", () => {
    expect(sanitizeAnalysis(ok, input, ids)).not.toHaveProperty("descriptionHi");
  });

  it("survives garbage from the model", () => {
    const a = sanitizeAnalysis({ highlights: "nope", searchKeywords: 5, confidence: "SURE", table: "x" }, input, ids);
    expect(a).toMatchObject({ categoryId: null, confidence: "LOW", highlights: [], searchKeywords: [], description: "", table: [], label: null });
  });
});

describe("table rows", () => {
  const pen = analyzeSchema.parse({
    name: "Cello Butterflow Pen", brand: "Cello", category: "Stationery › Pens",
    attributes: [{ label: "Colour", value: "blue" }, { label: "Tip size", value: "0.7 mm" }, { label: "Pack of", value: "5" }],
  });
  it("keeps rows whose value the seller typed and drops invented ones", () => {
    const a = sanitizeAnalysis({
      table: [{ label: "Colour", value: "Blue" }, { label: "Tip size", value: "0.7 mm" }, { label: "Warranty", value: "2 years" }],
    }, pen, new Set());
    // Colour and Tip size are category fields the page already shows, so they are not repeated either.
    expect(a.table).toEqual([]);
  });
  it("drops name/brand/category/pack-size rows but keeps a genuinely new fact", () => {
    const a = sanitizeAnalysis({
      table: [{ label: "Brand", value: "Cello" }, { label: "Pack size", value: "5" }, { label: "In the pack", value: "5" }],
    }, pen, new Set());
    expect(a.table).toEqual([{ label: "In the pack", value: "5" }]);
  });
});

describe("label proposal (AI suggestion from general knowledge)", () => {
  const known = {
    knownProduct: true, ingredients: "Milk solids, sugar, wheat flour.", allergens: ["MILK", "WHEAT", "GOLD"], dietMark: "VEG",
    nutrition: { basis: "PER_100G", servingSize: "", energyKcal: 480, proteinG: 7, carbsG: 70, sugarG: 25, addedSugarG: null, fatG: 20, satFatG: null, transFatG: null, fibreG: null, sodiumMg: 300 },
  };
  it("is only proposed for a known, packaged product", () => {
    expect(sanitizeLabel({ ...known, knownProduct: false }, true)).toBeNull();
    expect(sanitizeLabel(known, false)).toBeNull();
  });
  it("keeps only allergens from the fixed list", () => {
    expect(sanitizeLabel(known, true)?.allergens).toEqual(["MILK", "WHEAT"]);
  });
  it("drops a 'free from' claim and an out-of-range nutrition table", () => {
    expect(sanitizeLabel({ ...known, ingredients: "Gluten free wheat starch" }, true)?.ingredients).toBe("");
    expect(sanitizeLabel({ ...known, ingredients: "", allergens: [], dietMark: "", nutrition: { ...known.nutrition, proteinG: 5000 } }, true)).toBeNull();
  });
  it("adds a warning telling the seller to check the pack", () => {
    const a = sanitizeAnalysis({ ...known, categoryId: "milk", confidence: "HIGH", description: "x" }, input, ids);
    expect(a.label?.dietMark).toBe("VEG");
    expect(a.warnings.join(" ")).toMatch(/check|Compare/i);
  });
});

describe("labelWrite — the seller's tick", () => {
  it("refuses regulated data without the tick", () => {
    expect(() => labelWrite({ ingredients: "Sugar", labelVerified: false })).toThrow(/Tick/);
    expect(() => labelWrite({ allergens: ["MILK"] })).toThrow(/Tick/);
  });
  it("stamps labelVerifiedAt when ticked, and leaves the label alone when nothing is sent", () => {
    expect(labelWrite({ ingredients: "Sugar", labelVerified: true }).labelVerifiedAt).toBeInstanceOf(Date);
    expect(labelWrite({})).toEqual({});
  });
  it("clears the stamp when everything is emptied", () => {
    expect(labelWrite({ ingredients: "", allergens: [], dietMark: null, nutrition: null })).toMatchObject({ ingredients: null, allergens: [], labelVerifiedAt: null });
  });
});

describe("labelForApp — customers only see verified data", () => {
  const p = { ingredients: "Sugar", allergens: ["MILK"], dietMark: "VEG", nutrition: { basis: "PER_100G" }, descriptionTable: [{ label: "a", value: "b" }], labelVerifiedAt: null };
  it("hides the label from customers until verified, but not the table", () => {
    const c = labelForApp(p, "customer");
    expect(c).toMatchObject({ ingredients: null, allergens: [], dietMark: null, nutrition: null, labelVerified: false });
    expect(c.descriptionTable).toHaveLength(1);
  });
  it("shows it once verified, and always to the editor", () => {
    expect(labelForApp({ ...p, labelVerifiedAt: new Date() }, "customer").ingredients).toBe("Sugar");
    expect(labelForApp(p, "editor").ingredients).toBe("Sugar");
  });
});

describe("buildPrompt", () => {
  it("lists categories by id and carries every fact the seller entered", () => {
    const full = analyzeSchema.parse({
      name: "Cello Butterflow Pen", brand: "Cello", packSize: "5 pieces", sizes: ["5 pieces"],
      attributes: [{ label: "Tip size", value: "0.7 mm" }, { label: "Ink type", value: "Ball" }], countryOfOrigin: "India",
    });
    const p = buildPrompt(full, [{ id: "pens", path: "Stationery › Pens", categorySlug: "stationery", subcategory: "Pens" }]);
    for (const needle of ["pens | Stationery › Pens", "Brand: Cello", "Pack size: 5 pieces", "Tip size: 0.7 mm", "Ink type: Ball", "Country of origin: India"]) {
      expect(p).toContain(needle);
    }
  });
  it("skips the category list when the seller already picked one", () => {
    const p = buildPrompt(analyzeSchema.parse({ name: "Cello Pen", category: "Stationery › Pens" }), [{ id: "x", path: "X", categorySlug: "x", subcategory: "" }]);
    expect(p).not.toContain("CATEGORIES");
    expect(p).toContain("Category: Stationery › Pens");
  });
});

describe("analyzeSchema", () => {
  it("rejects a one-letter name and ignores the old language/image fields", () => {
    expect(analyzeSchema.safeParse({ name: "a" }).success).toBe(false);
    const old = analyzeSchema.parse({ name: "Amul Milk", language: "BOTH", imageBase64: "x".repeat(200) });
    expect(old).not.toHaveProperty("language");
    expect(old).not.toHaveProperty("imageBase64");
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
