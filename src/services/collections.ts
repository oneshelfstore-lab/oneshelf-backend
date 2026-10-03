// Collections (CATALOG_PLAN.md phase 3): customer-facing groupings that are not taxonomy — Bestsellers,
// Diwali, Hostel essentials, "Hair fall care". One resolver turns a collection into a Prisma `where`, so the
// public list, the product page, the admin preview and (phase 8b) Home shelves all agree on membership.

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { subtreeIds, type TreeRow } from "./categoryTree.js";
import { IN_STOCK } from "./stockAvailability.js";

export const KINDS = ["COLLECTION", "OCCASION", "CONCERN"] as const;
export const MODES = ["MANUAL", "SMART"] as const;
export const SURFACES = ["HOME", "CATEGORIES"] as const;

export const rulesSchema = z.object({
  categoryIds: z.array(z.string().min(1)).max(50).optional(), // any tree node; its whole subtree counts
  brands: z.array(z.string().min(1).max(100)).max(50).optional(),
  priceMin: z.number().min(0).optional(),
  priceMax: z.number().min(0).optional(),
  inStock: z.boolean().optional(),
});
export type Rules = z.infer<typeof rulesSchema>;

/** A SMART collection needs at least one real selector; `inStock` alone would be "every product in stock". */
export const hasSelector = (r?: Rules | null): boolean =>
  !!r && (!!r.categoryIds?.length || !!r.brands?.length || r.priceMin != null || r.priceMax != null);

type CollectionLike = { mode: string; rules: unknown };

/**
 * Which products belong to this collection (before the caller's own visibility filter).
 *   MANUAL: exactly the pinned products.
 *   SMART : (products matching ALL rules) OR pinned, in both cases minus excluded.
 * Prices compare the stored per-variant sellingPrice (loose items are stored per base unit, so a price band is
 * approximate for them — ponytail: fine for "Under ₹100" style bands on packaged goods).
 */
export function buildCollectionWhere(
  c: CollectionLike,
  pinned: string[],
  excluded: string[],
  tree: TreeRow[],
): Prisma.CatalogProductWhereInput {
  const pins: Prisma.CatalogProductWhereInput = { id: { in: pinned } };
  let base = pins;

  const rules = c.mode === "SMART" ? rulesSchema.safeParse(c.rules ?? {}) : null;
  if (rules?.success && hasSelector(rules.data)) {
    const r = rules.data;
    const and: Prisma.CatalogProductWhereInput[] = [];
    if (r.categoryIds?.length) {
      const ids = [...new Set(r.categoryIds.flatMap((id) => subtreeIds(tree, id)))];
      and.push({ OR: [{ categoryId: { in: ids } }, { leafCategoryId: { in: ids } }] });
    }
    if (r.brands?.length) and.push({ OR: r.brands.map((b) => ({ brand: { equals: b, mode: "insensitive" as const } })) });
    if (r.priceMin != null || r.priceMax != null) {
      and.push({ variants: { some: { isActive: true, sellingPrice: { gte: r.priceMin, lte: r.priceMax } } } });
    }
    if (r.inStock) and.push({ variants: { some: { isActive: true, ...IN_STOCK } } });
    base = { OR: [{ AND: and }, pins] };
  }
  return excluded.length ? { AND: [base, { id: { notIn: excluded } }] } : base;
}

/** True while `now` is inside the collection's optional [startsAt, endsAt] window. */
export function inWindow(c: { startsAt: Date | null; endsAt: Date | null }, now: Date = new Date()): boolean {
  return (!c.startsAt || c.startsAt <= now) && (!c.endsAt || c.endsAt >= now);
}

/** `where` for "active and inside its window" on the Collection table. */
export const liveCollectionWhere = (now: Date = new Date()): Prisma.CollectionWhereInput => ({
  isActive: true,
  AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
});

/** URL slug from a name: lowercase, hyphens. Callers add a suffix when it collides. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "collection";
}

export const collectionBodySchema = z.object({
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-_]+$/, "Slug must be lowercase letters, digits, - or _").optional(),
  name: z.string().trim().min(1).max(100),
  nameHi: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  imageUrl: z.string().max(500).optional().nullable(),
  kind: z.enum(KINDS).default("COLLECTION"),
  mode: z.enum(MODES).default("MANUAL"),
  rules: rulesSchema.optional().nullable(),
  showOn: z.array(z.enum(SURFACES)).max(4).default([]),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  displayOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
}).refine((b) => b.mode !== "SMART" || hasSelector(b.rules), { message: "A smart collection needs at least one rule (categories, brands or a price range)" })
  .refine((b) => !b.startsAt || !b.endsAt || b.startsAt <= b.endsAt, { message: "End date must be after the start date" });
