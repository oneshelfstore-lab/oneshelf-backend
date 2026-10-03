// "Product Intelligence" (CATALOG_PLAN.md phase 6): given everything the seller filled in (name, brand, category,
// the category's own fields, sizes…), OpenAI PROPOSES a category, an English description, highlights, search
// keywords, an "At a glance" table and — for widely sold branded products only — pack-label facts
// (ingredients, allergens, veg mark, nutrition). The proposal is never saved here: the editor shows it and the
// seller taps Apply, and the label facts additionally need the "I checked this against the pack" tick
// (services/productLabel.ts enforces that server-side).
//
// Hard rules: AI proposes, the catalog decides. The category must be one of the ids WE sent, table values must
// come from what the seller typed, allergens come from a fixed list, and nothing says a product is "free from"
// anything. English only for now.

import type { Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { openaiJson, OpenAINotConfiguredError } from "../lib/openai.js";
import { ValidationError, sendError } from "../lib/errors.js";
import { pathTo } from "./categoryTree.js";
import { ALLERGENS, DIET_MARKS, nutritionSchema, type Nutrition } from "./productLabel.js";

export const DAILY_CAP = 40;
const FEATURE = "product-intel";

const labelled = z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(100) });

export const analyzeSchema = z.object({
  name: z.string().trim().min(2).max(200),
  brand: z.string().trim().max(100).optional(),
  packSize: z.string().trim().max(40).optional(), // free text as typed, e.g. "500 ml"
  productType: z.string().trim().max(20).optional(), // PACKAGED | LOOSE | PRODUCE …
  isPackaged: z.boolean().optional(),
  /** The category the seller already picked, as text ("Stationery › Pens"). When present we don't ask for one. */
  category: z.string().trim().max(200).optional(),
  /** The category's own fields exactly as shown in the editor: Colour: blue, Tip size: 0.7 mm … */
  attributes: z.array(labelled).max(25).optional(),
  /** One line per size card: "5 pieces", "500 g" … */
  sizes: z.array(z.string().trim().max(60)).max(20).optional(),
  countryOfOrigin: z.string().trim().max(80).optional(),
  /** What the seller already wrote — improved, not discarded. */
  existingDescription: z.string().trim().max(800).optional(),
});
export type AnalyzeInput = z.infer<typeof analyzeSchema>;

/** A category the model may pick. The editors store a top-level slug + a sub-category NAME (the server links the
 *  name to the child node), so only top-level categories and their direct children are offered for now. */
export type CategoryOption = { id: string; path: string; categorySlug: string; subcategory: string };

export type LabelProposal = {
  ingredients: string;
  allergens: string[];
  dietMark: string | null;
  nutrition: Nutrition | null;
};

export type Analysis = {
  categoryId: string | null;
  alternativeCategoryId: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  brand: string | null;
  description: string;
  highlights: string[];
  searchKeywords: string[];
  /** "At a glance" rows, every value traceable to something the seller typed. */
  table: { label: string; value: string }[];
  /** Pack-label facts from the model's general knowledge — null unless it recognised a mainstream product. */
  label: LabelProposal | null;
  /** Plain-language notes for the seller to double-check before applying. */
  warnings: string[];
};

// Claims we never let the model make on its own. If one shows up and the seller didn't type it (or it is not
// in the name/brand), the highlight is dropped and a description gets a warning.
const RISKY = [
  "organic", "100% natural", "all natural", "pure", "premium", "healthy", "fresh", "farm", "diabetic", "sugar free",
  "no preservatives", "preservative free", "certified", "fssai", "iso", "cure", "immunity", "protein", "vitamin",
  "calcium", "low fat", "fat free", "gluten free", "vegan", "imported", "handmade", "best",
];

/** Risky claim words that appear in `text` but not in anything the seller supplied. Pure. */
export function claimWarnings(text: string, supplied: string): string[] {
  const t = text.toLowerCase(), s = supplied.toLowerCase();
  return RISKY.filter((w) => new RegExp(`\\b${w}\\b`).test(t) && !s.includes(w));
}

/** Every fact the seller gave, as one lowercase blob — what claims and table values are checked against. */
export function suppliedText(input: AnalyzeInput): string {
  return [
    input.name, input.brand, input.packSize, input.category, input.countryOfOrigin, input.existingDescription,
    ...(input.attributes ?? []).flatMap((a) => [a.label, a.value]),
    ...(input.sizes ?? []),
  ].filter(Boolean).join(" ");
}

export function buildPrompt(input: AnalyzeInput, categories: CategoryOption[]): string {
  const facts = [
    `Name: ${input.name}`,
    input.brand && `Brand: ${input.brand}`,
    input.category && `Category: ${input.category}`,
    input.productType && `Product type: ${input.productType}`,
    input.isPackaged != null && `Packaged product: ${input.isPackaged ? "yes" : "no"}`,
    input.packSize && `Pack size: ${input.packSize}`,
    input.sizes?.length && `Sizes sold: ${input.sizes.join("; ")}`,
    ...(input.attributes ?? []).map((a) => `${a.label}: ${a.value}`),
    input.countryOfOrigin && `Country of origin: ${input.countryOfOrigin}`,
    input.existingDescription && `Seller's own description (improve it, keep its facts): ${input.existingDescription}`,
  ].filter(Boolean).join("\n");

  const pickCategory = !input.category && categories.length > 0;
  return [
    "You help a shop owner in India list a product on an online store. Write in English only.",
    "Use ONLY the FACTS below, plus ordinary common knowledge of what this kind of product is and what it is used for.",
    "",
    "FACTS:", facts, "",
    ...(pickCategory ? ["CATEGORIES (choose by exact id):", ...categories.map((c) => `${c.id} | ${c.path}`), ""] : []),
    "Return JSON:",
    pickCategory
      ? "- categoryId: the single best category id from the list above. alternativeCategoryId: a second plausible id, or empty."
      : "- categoryId and alternativeCategoryId: empty strings (the category is already chosen).",
    "- confidence: HIGH only if the category is obvious from the name; LOW if guessing.",
    "- brand: the brand if clear from the facts, else empty.",
    "- description: 60 to 100 words of plain English, one or two short paragraphs, written like a good shop listing. Start with the product name. Say what it is, what it is used for and who it suits, using ordinary common knowledge of this kind of product. Work in the seller's details (colour, size, type, pack contents) naturally, each fact ONCE; never present the pack size itself as a benefit ('providing biscuits to share'). You may say what a spec means in practice only when it is universally true (for example: a 0.7 mm tip writes a fine line). NEVER write about the listing or the buyer's choice: no 'stated', 'listed', 'helps distinguish', 'when selecting', 'check the pack', 'consider'. No filler, no repeated facts, no marketing adjectives (smooth, premium, best, durable) unless the seller used them.",
    "  Example of the tone (a different product): 'Classmate Soft Cover Notebook is a ruled notebook for school and college notes. Its 172 pages are single-line ruled, and the pack holds 6 notebooks, so there is one for every subject.'",
    "- highlights: up to 5 short bullets from the FACTS that help a buyer choose (variant, colour, tip or material, what is in the pack). Do NOT repeat the product name, brand, pack size or product type, and never write 'Packaged product'. Return fewer bullets, or none, rather than filler.",
    "- searchKeywords: up to 8 lowercase search terms a shopper might type (English or Hinglish).",
    "- table: OPTIONAL extra rows of {label, value}, only for facts that add something the product page does not already show (for example what is in the pack, or size options). Do NOT repeat the name, brand, category, pack size or any field already listed in the FACTS with its own label (the page shows those separately). Copy each value EXACTLY as given in the FACTS. If nothing useful remains, return an empty list.",
    "- knownProduct: true ONLY if this is a widely sold, nationally known branded PACKAGED FOOD/DRINK/PERSONAL-CARE product whose label you genuinely know. Otherwise false (loose items, local brands, anything unsure).",
    "- ingredients / allergens / dietMark / nutrition: fill ONLY when knownProduct is true, from the product's usual pack label. Otherwise leave them empty (empty string, empty list, dietMark empty, nutrition basis NONE).",
    "  dietMark: for a known food or drink, set VEG, NON_VEG, VEGAN or EGG (the mark every Indian food pack carries) whenever you are confident; leave it empty only if unsure.",
    "  allergens: only items that the ingredients clearly contain, chosen from the allowed list. NEVER state that a product is free from anything.",
    "  nutrition: values per 100 g or 100 ml when you know them, else null for each unknown number.",
    "",
    "RULES: no health or medical benefits, certifications, freshness, shelf life, or quality words (premium, best, pure, natural, organic) unless they appear in the FACTS. If unsure, say less.",
  ].join("\n");
}

const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.%]+/g, " ").trim();

/** Turns the raw model JSON into a safe Analysis. Pure — unit tested. */
export function sanitizeAnalysis(raw: any, input: AnalyzeInput, allowedIds: Set<string>): Analysis {
  const supplied = suppliedText(input);
  const suppliedNorm = norm(supplied);
  const warnings: string[] = [];

  const categoryId = allowedIds.has(raw?.categoryId) ? String(raw.categoryId) : null;
  const alt = allowedIds.has(raw?.alternativeCategoryId) && raw.alternativeCategoryId !== categoryId ? String(raw.alternativeCategoryId) : null;
  const conf = ["HIGH", "MEDIUM", "LOW"].includes(raw?.confidence) ? raw.confidence : "LOW";

  const description = clip(raw?.description, 950); // the editors cap a description at 1000 characters
  const risky = claimWarnings(`${description} ${raw?.highlights?.join?.(" ") ?? ""}`, supplied);
  if (risky.length) warnings.push(`The text mentions "${risky.join('", "')}", which you didn't enter. Check it is true or remove it.`);

  const highlights: string[] = (Array.isArray(raw?.highlights) ? raw.highlights : [])
    .map((h: unknown) => clip(h, 60))
    .filter((h: string) => h && claimWarnings(h, supplied).length === 0)
    .slice(0, 5);

  const searchKeywords: string[] = [...new Set<string>(
    (Array.isArray(raw?.searchKeywords) ? raw.searchKeywords : []).map((k: unknown) => clip(k, 30).toLowerCase()).filter(Boolean),
  )].slice(0, 8);

  // A table row survives only if its value is something the seller actually gave us, and it is not a repeat of what
  // the product page already shows (name, brand, category, pack size, and every category field has its own spot).
  const alreadyShown = new Set(
    ["name", "product name", "brand", "category", "pack size", "size", "sizes", "packaged product", "product type", ...(input.attributes ?? []).map((a) => a.label)].map(norm),
  );
  const table = (Array.isArray(raw?.table) ? raw.table : [])
    .map((r: any) => ({ label: clip(r?.label, 40), value: clip(r?.value, 80) }))
    .filter((r: { label: string; value: string }) =>
      r.label && r.value && suppliedNorm.includes(norm(r.value)) && !alreadyShown.has(norm(r.label)))
    .slice(0, 8);

  const label = sanitizeLabel(raw, input.isPackaged !== false);
  if (label) warnings.push("Ingredients, allergens and nutrition are AI suggestions from general knowledge — not read from your pack. Compare each with the pack, then tick the box to confirm.");

  if (!categoryId && !input.category) warnings.push("Couldn't pick a category from your list; choose it yourself.");
  return {
    categoryId, alternativeCategoryId: alt, confidence: categoryId ? conf : "LOW",
    brand: clip(raw?.brand, 100) || null, description, highlights, searchKeywords, table, label, warnings,
  };
}

/** Pack-label facts the model may suggest. Null unless it flagged a known product AND something valid survives. Pure. */
export function sanitizeLabel(raw: any, packaged: boolean): LabelProposal | null {
  if (!packaged || raw?.knownProduct !== true) return null;

  let ingredients = clip(raw?.ingredients, 1500);
  // "free from X" is a safety claim we never let the model make.
  if (/\bfree\b|-free\b/i.test(ingredients)) ingredients = "";

  const allowed = new Set<string>(ALLERGENS);
  const allergens = [...new Set<string>((Array.isArray(raw?.allergens) ? raw.allergens : []).map(String))].filter((a) => allowed.has(a));
  const dietMark = (DIET_MARKS as readonly string[]).includes(raw?.dietMark) ? String(raw.dietMark) : null;

  let nutrition: Nutrition | null = null;
  const n = raw?.nutrition;
  if (n && n.basis && n.basis !== "NONE") {
    const parsed = nutritionSchema.safeParse({ ...n, servingSize: n.servingSize ? String(n.servingSize) : null });
    // Needs at least energy or one macro, or it is an empty table.
    if (parsed.success && [parsed.data.energyKcal, parsed.data.proteinG, parsed.data.carbsG, parsed.data.fatG].some((v) => v != null)) {
      nutrition = parsed.data;
    }
  }

  if (!ingredients && allergens.length === 0 && !dietMark && !nutrition) return null;
  return { ingredients, allergens, dietMark, nutrition };
}

const nullableNum = { type: ["number", "null"] };
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    categoryId: { type: "string" },
    alternativeCategoryId: { type: "string" },
    confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
    brand: { type: "string" },
    description: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
    searchKeywords: { type: "array", items: { type: "string" } },
    table: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
    },
    knownProduct: { type: "boolean" },
    ingredients: { type: "string" },
    allergens: { type: "array", items: { type: "string", enum: [...ALLERGENS] } },
    dietMark: { type: "string", enum: ["", ...DIET_MARKS] },
    nutrition: {
      type: "object", additionalProperties: false,
      properties: {
        basis: { type: "string", enum: ["NONE", "PER_100G", "PER_100ML", "PER_SERVING"] },
        servingSize: { type: "string" },
        energyKcal: nullableNum, proteinG: nullableNum, carbsG: nullableNum, sugarG: nullableNum, addedSugarG: nullableNum,
        fatG: nullableNum, satFatG: nullableNum, transFatG: nullableNum, fibreG: nullableNum, sodiumMg: nullableNum,
      },
      required: ["basis", "servingSize", "energyKcal", "proteinG", "carbsG", "sugarG", "addedSugarG", "fatG", "satFatG", "transFatG", "fibreG", "sodiumMg"],
    },
  },
  required: [
    "categoryId", "alternativeCategoryId", "confidence", "brand", "description", "highlights", "searchKeywords",
    "table", "knownProduct", "ingredients", "allergens", "dietMark", "nutrition",
  ],
};

/** Active categories as `Grocery › Dairy`, so the model picks by id and the seller reads names. Depth ≤ 2. */
export async function categoryOptions(): Promise<CategoryOption[]> {
  const rows = await prisma.category.findMany({ where: { isActive: true }, select: { id: true, slug: true, name: true, parentId: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: CategoryOption[] = [];
  for (const r of rows) {
    const path = pathTo(byId, r.id);
    if (path.length > 2) continue;
    const root = byId.get(path[0]!)!;
    out.push({
      id: r.id,
      path: path.map((id) => byId.get(id)?.name ?? "").join(" › "),
      categorySlug: root.slug,
      subcategory: path.length === 2 ? r.name : "",
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 400);
}

/** The picked option's display path + the exact fields the editors write (slug + sub-category name). */
export function describeChoice(options: CategoryOption[], id: string | null) {
  const o = options.find((x) => x.id === id);
  return o ? { path: o.path, categorySlug: o.categorySlug, subcategory: o.subcategory } : null;
}

/** Counts the attempt first (a failed call still costs us). true = within today's cap. */
export async function takeAiQuota(userId: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const row = await prisma.aiUsage.upsert({
    where: { userId_feature_day: { userId, feature: FEATURE, day } },
    create: { userId, feature: FEATURE, day, count: 1 },
    update: { count: { increment: 1 } },
  });
  return row.count <= DAILY_CAP;
}

/** Express handler shared by the seller and owner product editors (auth is applied by their routers). */
export async function analyzeProductHandler(req: any, res: Response) {
  try {
    const parsed = analyzeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid product details", parsed.error.errors);
    if (!(await takeAiQuota(req.appUser!.id))) {
      return void res.status(429).json({ success: false, error: "Daily AI limit reached. You can still fill the details yourself." });
    }
    const input = parsed.data;
    // The category list is only sent when the seller hasn't picked a category yet.
    const options = input.category ? [] : await categoryOptions();
    try {
      const raw = await openaiJson(buildPrompt(input, options), RESPONSE_SCHEMA, "product-intel", { timeoutMs: 45_000 });
      const a = sanitizeAnalysis(raw, input, new Set(options.map((o) => o.id)));
      res.json({ success: true, data: { ...a, category: describeChoice(options, a.categoryId), alternativeCategory: describeChoice(options, a.alternativeCategoryId) } });
    } catch (e) {
      if (e instanceof OpenAINotConfiguredError) {
        return void res.status(503).json({ success: false, error: "AI suggestions aren't available right now." });
      }
      console.warn("product-intel failed:", e);
      res.status(502).json({ success: false, error: "Couldn't generate suggestions. Try again, or fill the details yourself." });
    }
  } catch (e) {
    sendError(res, e);
  }
}
