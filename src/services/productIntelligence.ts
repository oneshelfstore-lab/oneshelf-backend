// "Product Intelligence" (CATALOG_PLAN.md phase 6): given what a seller typed (name, brand, pack size) and
// optionally a photo, Gemini PROPOSES a category, an English + Hindi description, highlights and search
// keywords. The proposal is never saved here — the editor shows it and the seller taps Apply.
//
// Hard rule: AI proposes, the catalog decides. The category must be one of the ids WE sent (anything
// else is dropped), and copy may only use facts the seller gave or text printed on the pack photo.

import type { Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { geminiJson, GeminiNotConfiguredError } from "../lib/gemini.js";
import { ValidationError, sendError } from "../lib/errors.js";
import { pathTo } from "./categoryTree.js";
import { sniffImage } from "../routes/uploads.js";

export const DAILY_CAP = 40;
const FEATURE = "product-intel";

export const analyzeSchema = z.object({
  name: z.string().trim().min(2).max(200),
  brand: z.string().trim().max(100).optional(),
  packSize: z.string().trim().max(40).optional(), // free text as typed, e.g. "500 ml"
  language: z.enum(["EN", "HI", "BOTH"]).default("BOTH"),
  imageBase64: z.string().min(100).max(2_800_000).optional(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
  // An already-uploaded product photo (editing an existing product). Only our Firebase Storage hosts are fetched.
  imageUrl: z.string().url().max(700).optional(),
});
export type AnalyzeInput = z.infer<typeof analyzeSchema>;

/** A category the model may pick. The editors store a top-level slug + a sub-category NAME (the server links the
 *  name to the child node), so only top-level categories and their direct children are offered for now. */
export type CategoryOption = { id: string; path: string; categorySlug: string; subcategory: string };

export type Analysis = {
  categoryId: string | null;
  alternativeCategoryId: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  brand: string | null;
  description: string;
  descriptionHi: string;
  highlights: string[];
  searchKeywords: string[];
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

export function buildPrompt(input: AnalyzeInput, categories: CategoryOption[]): string {
  const facts = [`Name: ${input.name}`, input.brand && `Brand: ${input.brand}`, input.packSize && `Pack size: ${input.packSize}`]
    .filter(Boolean).join("\n");
  return [
    "You help a shop owner in India list a grocery/household product. Use ONLY the facts below and, if a photo is attached, text visibly printed on the pack.",
    "",
    "FACTS:", facts, "",
    "CATEGORIES (choose by exact id):",
    ...categories.map((c) => `${c.id} | ${c.path}`), "",
    "Return JSON:",
    "- categoryId: the single best category id from the list above. alternativeCategoryId: a second plausible id, or empty.",
    "- confidence: HIGH only if the category is obvious from the name; LOW if guessing.",
    "- brand: the brand if clear from the facts or pack, else empty.",
    "- description: 1 to 2 plain sentences in English describing what the product is and its pack size.",
    "- descriptionHi: the same in natural Hindi (Devanagari), not a word-for-word translation.",
    "- highlights: up to 4 short factual bullets (pack size, brand, product type) in English.",
    "- searchKeywords: up to 8 lowercase search terms a shopper might type (English or Hinglish).",
    "",
    "RULES: never state ingredients, nutrition, health or medical benefits, certifications, origin, freshness, shelf life, quality words (premium, best, pure, natural, organic) or anything not given above. If unsure, say less.",
  ].join("\n");
}

/** Only https URLs on Firebase/Google Storage hosts: the server must never be pointable at arbitrary addresses (SSRF). Pure. */
export function isAllowedImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && ["firebasestorage.googleapis.com", "storage.googleapis.com"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Downloads an allowed image (≤ 2.5 MB, 8 s) and returns it base64-encoded with its real type, or null on any problem. */
async function fetchImage(url: string): Promise<{ data: string; mime: string } | null> {
  if (!isAllowedImageUrl(url)) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "error" });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const kind = buf.length <= 2_500_000 ? sniffImage(buf) : null;
    return kind ? { data: buf.toString("base64"), mime: kind.mime } : null;
  } catch {
    return null;
  }
}

const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

/** Turns the raw model JSON into a safe Analysis. Pure — unit tested. */
export function sanitizeAnalysis(raw: any, input: AnalyzeInput, allowedIds: Set<string>): Analysis {
  const supplied = [input.name, input.brand, input.packSize].filter(Boolean).join(" ");
  const warnings: string[] = [];

  const categoryId = allowedIds.has(raw?.categoryId) ? String(raw.categoryId) : null;
  const alt = allowedIds.has(raw?.alternativeCategoryId) && raw.alternativeCategoryId !== categoryId ? String(raw.alternativeCategoryId) : null;
  const conf = ["HIGH", "MEDIUM", "LOW"].includes(raw?.confidence) ? raw.confidence : "LOW";

  const description = input.language === "HI" ? "" : clip(raw?.description, 400);
  const descriptionHi = input.language === "EN" ? "" : clip(raw?.descriptionHi, 500);
  const risky = claimWarnings(`${description} ${raw?.highlights?.join?.(" ") ?? ""}`, supplied);
  if (risky.length) warnings.push(`The text mentions "${risky.join('", "')}", which you didn't enter. Check it is true or remove it.`);

  const highlights: string[] = (Array.isArray(raw?.highlights) ? raw.highlights : [])
    .map((h: unknown) => clip(h, 60))
    .filter((h: string) => h && claimWarnings(h, supplied).length === 0)
    .slice(0, 4);

  const searchKeywords: string[] = [...new Set<string>(
    (Array.isArray(raw?.searchKeywords) ? raw.searchKeywords : []).map((k: unknown) => clip(k, 30).toLowerCase()).filter(Boolean),
  )].slice(0, 8);

  if (!categoryId) warnings.push("Couldn't pick a category from your list; choose it yourself.");
  return {
    categoryId, alternativeCategoryId: alt, confidence: categoryId ? conf : "LOW",
    brand: clip(raw?.brand, 100) || null, description, descriptionHi, highlights, searchKeywords, warnings,
  };
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    categoryId: { type: "STRING" },
    alternativeCategoryId: { type: "STRING" },
    confidence: { type: "STRING", enum: ["HIGH", "MEDIUM", "LOW"] },
    brand: { type: "STRING" },
    description: { type: "STRING" },
    descriptionHi: { type: "STRING" },
    highlights: { type: "ARRAY", items: { type: "STRING" } },
    searchKeywords: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["categoryId", "confidence", "description", "descriptionHi", "highlights", "searchKeywords"],
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

/** Counts the attempt first (a failed Gemini call still costs us). true = within today's cap. */
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
    const options = await categoryOptions();
    const parts: any[] = [{ text: buildPrompt(input, options) }];
    if (input.imageBase64) parts.push({ inline_data: { mime_type: input.mimeType, data: input.imageBase64 } });
    else if (input.imageUrl) {
      const img = await fetchImage(input.imageUrl); // a failed fetch just means text-only analysis
      if (img) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
    }
    try {
      const raw = await geminiJson(parts, RESPONSE_SCHEMA, "product-intel", { temperature: 0.2, timeoutMs: 25_000 });
      const a = sanitizeAnalysis(raw, input, new Set(options.map((o) => o.id)));
      res.json({ success: true, data: { ...a, category: describeChoice(options, a.categoryId), alternativeCategory: describeChoice(options, a.alternativeCategoryId) } });
    } catch (e) {
      if (e instanceof GeminiNotConfiguredError) {
        return void res.status(503).json({ success: false, error: "AI suggestions aren't available right now." });
      }
      console.warn("product-intel failed:", e);
      res.status(502).json({ success: false, error: "Couldn't generate suggestions. Try again, or fill the details yourself." });
    }
  } catch (e) {
    sendError(res, e);
  }
}
