// Pack-label facts (ingredients, allergens, veg mark, nutrition) and the "At a glance" table.
// NUTRITION_PLAN.md hard rules: a human confirms every value, and customers only ever see confirmed data.
//
//  - The editor may be PRE-FILLED by AI (services/productIntelligence.ts), but nothing regulated is saved
//    unless the same request carries labelVerified=true ("I checked this against the pack").
//  - `labelVerifiedAt` is what the customer API keys on: no stamp → the label fields are not returned at all.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ValidationError } from "../lib/errors.js";

/** Fixed vocabulary — the model and the seller can only pick from this (never free text, never "free from"). */
export const ALLERGENS = [
  "MILK", "GLUTEN", "WHEAT", "SOY", "PEANUT", "TREE_NUTS", "EGG", "FISH", "SHELLFISH", "SESAME", "MUSTARD", "CELERY", "SULPHITES",
] as const;
export const DIET_MARKS = ["VEG", "NON_VEG", "VEGAN", "EGG"] as const;

const grams = z.number().min(0).max(1000).optional().nullable();

export const nutritionSchema = z.object({
  basis: z.enum(["PER_100G", "PER_100ML", "PER_SERVING"]),
  servingSize: z.string().max(40).optional().nullable(),
  energyKcal: z.number().min(0).max(1000).optional().nullable(),
  proteinG: grams,
  carbsG: grams,
  sugarG: grams,
  addedSugarG: grams,
  fatG: grams,
  satFatG: grams,
  transFatG: grams,
  fibreG: grams,
  sodiumMg: z.number().min(0).max(40000).optional().nullable(),
});
export type Nutrition = z.infer<typeof nutritionSchema>;

export const tableRowSchema = z.object({ label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(80) });

/** Zod fragment spread into the seller and owner product schemas. */
export const labelFields = {
  descriptionTable: z.array(tableRowSchema).max(10).optional().nullable(),
  ingredients: z.string().trim().max(1500).optional().nullable(),
  allergens: z.array(z.enum(ALLERGENS)).max(13).optional(),
  dietMark: z.enum(DIET_MARKS).optional().nullable(),
  nutrition: nutritionSchema.optional().nullable(),
  /** The seller's "I checked this against the pack" tick. Never stored as-is — it becomes labelVerifiedAt. */
  labelVerified: z.boolean().optional(),
};

interface LabelInput {
  descriptionTable?: { label: string; value: string }[] | null;
  ingredients?: string | null;
  allergens?: string[];
  dietMark?: string | null;
  nutrition?: unknown;
  labelVerified?: boolean;
}

const hasRegulatedData = (p: LabelInput) =>
  !!p.ingredients?.trim() || (p.allergens?.length ?? 0) > 0 || !!p.dietMark || !!p.nutrition;

/**
 * Splits the label fields out of a parsed product body and returns what to write.
 *  - nothing sent        → {} (the stored label is left untouched; older apps omit all of it)
 *  - regulated data sent → requires labelVerified=true, else 400; stamps labelVerifiedAt = now
 *  - all of it cleared   → everything nulled and the stamp removed
 * The caller must DELETE `labelVerified` from what it spreads into Prisma (it is not a column).
 */
export function labelWrite(p: LabelInput): Record<string, unknown> {
  // The table is plain descriptive text, not a regulated fact — no tick needed. Json columns need DbNull, not null.
  const table: Record<string, unknown> = p.descriptionTable === undefined ? {}
    : { descriptionTable: p.descriptionTable?.length ? p.descriptionTable : Prisma.DbNull };
  return { ...table, ...regulatedWrite(p) };
}

function regulatedWrite(p: LabelInput): Record<string, unknown> {
  const sent = p.ingredients !== undefined || p.allergens !== undefined || p.dietMark !== undefined || p.nutrition !== undefined;
  if (!sent) return {};
  if (!hasRegulatedData(p)) {
    return { ingredients: null, allergens: [], dietMark: null, nutrition: Prisma.DbNull, labelVerifiedAt: null };
  }
  if (p.labelVerified !== true) {
    throw new ValidationError("Tick \"I checked this against the pack\" before saving ingredients, allergens or nutrition.");
  }
  return {
    ingredients: p.ingredients?.trim() || null,
    allergens: p.allergens ?? [],
    dietMark: p.dietMark ?? null,
    nutrition: p.nutrition ?? Prisma.DbNull,
    labelVerifiedAt: new Date(),
  };
}

/** The label block for API responses. Customers get it only once verified; the editors always get it. */
export function labelForApp(product: any, audience: "customer" | "editor") {
  const verified = !!product.labelVerifiedAt;
  const base = { descriptionTable: product.descriptionTable ?? [], labelVerified: verified };
  if (audience === "customer" && !verified) {
    return { ...base, ingredients: null, allergens: [], dietMark: null, nutrition: null };
  }
  return {
    ...base,
    ingredients: product.ingredients ?? null,
    allergens: product.allergens ?? [],
    dietMark: product.dietMark ?? null,
    nutrition: product.nutrition ?? null,
  };
}
