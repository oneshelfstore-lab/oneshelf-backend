import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, NotFoundError } from "../lib/errors.js";
import { cacheControl, memoCache, PUBLIC_TTL_MS, PUBLIC_TTL_SECONDS } from "../lib/httpCache.js";
import { formatProductForApp, SELLER_SELECT } from "./catalog.js";
import { VISIBLE, whereFor } from "./collections.js";
import { loadSubcategories } from "./categories.js";
import { liveCollectionWhere } from "../services/collections.js";
import { IN_STOCK } from "../services/stockAvailability.js";

// Customer category landing page (CATALOG_PLAN.md phase 7): one call returns everything the page shows —
// the category, its sub-category tiles, what is popular in it, and the owner's collections that have products
// in it. Mounted at /api/app/categories (alongside publicCategoryRouter; this only owns /:slug/page).

export const publicCategoryPageRouter = Router();

const POPULAR_DAYS = 30;
const POPULAR_SAMPLE = 2000; // order lines scanned per category
const SHELF_SIZE = 10;
const MIN_SHELF = 3;
const MAX_COLLECTION_SHELVES = 3;

/** The most frequent ids first (ties by id so the order is stable), at most n. Pure. */
export function topIdsByCount(ids: (string | null | undefined)[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([id]) => id);
}

const include = {
  variants: { where: { isActive: true }, orderBy: { packageSize: "asc" as const } },
  category: { select: { slug: true, name: true } },
  seller: SELLER_SELECT,
};
const inStock = { variants: { some: { isActive: true, ...IN_STOCK } } };

async function loadCategoryPage(slugOrId: string) {
  const category = await prisma.category.findFirst({
    where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true, parentId: null },
    select: { id: true, slug: true, name: true, nameHi: true, description: true, imageUrl: true },
  });
  if (!category) return null;

  const inCategory = { AND: [VISIBLE, { categoryId: category.id }] };
  const [productCount, subs] = await Promise.all([
    prisma.catalogProduct.count({ where: inCategory }),
    loadSubcategories(category.slug),
  ]);

  // Popular = most ordered in the last 30 days; topped up with in-stock products so a new shop still has a shelf.
  const since = new Date(Date.now() - POPULAR_DAYS * 86_400_000);
  const recent = await prisma.orderItem.findMany({
    where: { variant: { product: { categoryId: category.id } }, order: { createdAt: { gte: since }, status: { not: "CANCELLED" } } },
    select: { variant: { select: { productId: true } } },
    take: POPULAR_SAMPLE,
  });
  const topIds = topIdsByCount(recent.map((r) => r.variant?.productId), SHELF_SIZE);
  const ranked = topIds.length
    ? await prisma.catalogProduct.findMany({ where: { AND: [inCategory, inStock, { id: { in: topIds } }] }, include })
    : [];
  const order = new Map(topIds.map((id, i) => [id, i]));
  ranked.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const filler = ranked.length >= SHELF_SIZE ? [] : await prisma.catalogProduct.findMany({
    where: { AND: [inCategory, inStock, { id: { notIn: ranked.map((p) => p.id) } }] },
    include, orderBy: { name: "asc" }, take: SHELF_SIZE - ranked.length,
  });
  const popular = [...ranked, ...filler];

  // Owner collections meant for category pages, limited to their products in THIS category.
  const cols = await prisma.collection.findMany({
    where: { ...liveCollectionWhere(), showOn: { has: "CATEGORIES" } },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    take: 10,
  });
  const shelves: { collection: { id: string; slug: string; name: string; nameHi: string | null; description: string | null; kind: string }; products: any[] }[] = [];
  for (const c of cols) {
    if (shelves.length >= MAX_COLLECTION_SHELVES) break;
    const products = await prisma.catalogProduct.findMany({
      where: { AND: [inCategory, inStock, await whereFor(c)] }, include, orderBy: { name: "asc" }, take: SHELF_SIZE,
    });
    if (products.length >= MIN_SHELF) {
      shelves.push({ collection: { id: c.id, slug: c.slug, name: c.name, nameHi: c.nameHi, description: c.description, kind: c.kind }, products });
    }
  }

  return {
    category: { ...category, productCount },
    subcategories: subs.filter((s) => s.productCount > 0),
    popular: popular.map(formatProductForApp),
    collections: shelves.map((s) => ({ collection: s.collection, products: s.products.map(formatProductForApp) })),
  };
}

// GET /api/app/categories/:slug/page — slug or id of a TOP-LEVEL category.
publicCategoryPageRouter.get("/:slug/page", cacheControl(PUBLIC_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    // Resolve the real category BEFORE touching the cache: keying it by raw URL input would let anyone grow the
    // (unbounded) in-memory cache with junk slugs.
    const found = await prisma.category.findFirst({ where: { OR: [{ slug }, { id: slug }], isActive: true, parentId: null }, select: { slug: true } });
    if (!found) throw new NotFoundError("Category", slug);
    const data = await memoCache.get(`categories:page:${found.slug}`, PUBLIC_TTL_MS, () => loadCategoryPage(found.slug));
    if (!data) throw new NotFoundError("Category", slug);
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});
