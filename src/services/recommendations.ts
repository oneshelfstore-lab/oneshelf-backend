// Product-page recommendations (CATALOG_PLAN.md phase 5). One call returns ranked sections so the app no
// longer assembles them from three requests:
//   FREQUENTLY_BOUGHT_TOGETHER  other products that shared an order with this one (last 90 days, ≥ 2 orders)
//   SIMILAR                     same category, scored by same sub-category, same brand and price closeness
//   BRAND                       more from this brand
//   FROM_THIS_STORE             more from the same shop (external sellers only)
// Every candidate must pass the caller's `eligible` filter (active, approved, in stock, seller trading) BEFORE
// ranking, and a section with fewer than MIN_SECTION items is dropped, so a quiet shop shows only what is real.
// Same product never appears in two sections. Not cached server-side (memoCache is unbounded per key);
// the route's Cache-Control covers repeat opens.

import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";

export const MIN_SECTION = 3;
export const MAX_SECTION = 10;
const CO_WINDOW_DAYS = 90;
const MIN_CO_ORDERS = 2;
const MAX_CO_ORDERS = 400; // orders sampled for one product; keeps the lookup cheap for best-sellers
const SIMILAR_CANDIDATES = 60;

export type SectionType = "FREQUENTLY_BOUGHT_TOGETHER" | "SIMILAR" | "BRAND" | "FROM_THIS_STORE";

/** Distinct-order counts per other product, ≥ MIN_CO_ORDERS, most co-ordered first. Pure. */
export function rankCoPurchased(rows: { orderId: string; productId: string }[], selfId: string): { productId: string; orders: number }[] {
  const orders = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.productId === selfId) continue;
    (orders.get(r.productId) ?? orders.set(r.productId, new Set()).get(r.productId)!).add(r.orderId);
  }
  return [...orders]
    .map(([productId, s]) => ({ productId, orders: s.size }))
    .filter((x) => x.orders >= MIN_CO_ORDERS)
    .sort((a, b) => b.orders - a.orders || a.productId.localeCompare(b.productId));
}

export type Facts = { brand: string | null; price: number; leafCategoryId: string | null };

/** How alike two products are: same sub-category +2, same brand +3, price within 40% up to +2. Pure. */
export function scoreSimilar(base: Facts, cand: Facts): number {
  let s = 0;
  if (base.leafCategoryId && base.leafCategoryId === cand.leafCategoryId) s += 2;
  if (base.brand && cand.brand && base.brand.trim().toLowerCase() === cand.brand.trim().toLowerCase()) s += 3;
  if (base.price > 0 && cand.price > 0) {
    const fit = Math.min(base.price, cand.price) / Math.max(base.price, cand.price);
    if (fit >= 0.6) s += 2 * fit;
  }
  return s;
}

const priceOf = (p: { variants: { sellingPrice: unknown }[] }) => Number(p.variants[0]?.sellingPrice ?? 0);

type Ctx = {
  /** Extra `where` every candidate must satisfy (active, approved, in stock, seller trading). */
  eligible: Prisma.CatalogProductWhereInput;
  /** The `include` the caller formats products with (variants, category, seller). */
  include: Prisma.CatalogProductInclude;
};

/** Returns null when the product itself is not visible (caller 404s). Products are raw Prisma rows. */
export async function getRecommendations(productId: string, ctx: Ctx) {
  const base = await prisma.catalogProduct.findFirst({
    where: { id: productId, ...ctx.eligible, variants: undefined }, // the viewed product may be out of stock itself
    select: {
      id: true, brand: true, categoryId: true, leafCategoryId: true, sellerId: true,
      seller: { select: { isHouse: true } },
      variants: { where: { isActive: true }, orderBy: { packageSize: "asc" }, take: 1, select: { sellingPrice: true } },
    },
  });
  if (!base) return null;

  const used = new Set<string>([base.id]);
  const sections: { type: SectionType; products: any[] }[] = [];
  const push = (type: SectionType, products: any[]) => {
    const fresh = products.filter((p) => !used.has(p.id)).slice(0, MAX_SECTION);
    if (fresh.length < MIN_SECTION) return;
    fresh.forEach((p) => used.add(p.id));
    sections.push({ type, products: fresh });
  };
  const find = (where: Prisma.CatalogProductWhereInput, take: number) =>
    prisma.catalogProduct.findMany({
      where: { ...ctx.eligible, id: { notIn: [...used] }, ...where },
      include: ctx.include,
      orderBy: { name: "asc" },
      take,
    });

  // 1. Frequently bought together — real order data.
  const since = new Date(Date.now() - CO_WINDOW_DAYS * 86_400_000);
  const mine = await prisma.orderItem.findMany({
    where: { variant: { productId: base.id }, order: { createdAt: { gte: since }, status: { not: "CANCELLED" } } },
    select: { orderId: true },
    distinct: ["orderId"],
    take: MAX_CO_ORDERS,
  });
  if (mine.length >= MIN_CO_ORDERS) {
    const rows = await prisma.orderItem.findMany({
      where: { orderId: { in: mine.map((m) => m.orderId) }, variant: { productId: { not: base.id } } },
      select: { orderId: true, variant: { select: { productId: true } } },
    });
    const ranked = rankCoPurchased(rows.flatMap((r) => (r.variant ? [{ orderId: r.orderId, productId: r.variant.productId }] : [])), base.id);
    if (ranked.length) {
      const top = ranked.slice(0, MAX_SECTION + 6);
      const found = await find({ id: { in: top.map((t) => t.productId) } }, top.length);
      const rank = new Map(top.map((t, i) => [t.productId, i]));
      push("FREQUENTLY_BOUGHT_TOGETHER", found.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!));
    }
  }

  // 2. Similar — same top-level category, best match first.
  const facts: Facts = { brand: base.brand, price: priceOf(base), leafCategoryId: base.leafCategoryId };
  const similar = await find({ categoryId: base.categoryId }, SIMILAR_CANDIDATES);
  push(
    "SIMILAR",
    similar
      .map((p: any) => ({ p, s: scoreSimilar(facts, { brand: p.brand, price: priceOf(p), leafCategoryId: p.leafCategoryId }) }))
      .sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name))
      .map((x) => x.p),
  );

  // 3. More from this brand.
  if (base.brand?.trim()) push("BRAND", await find({ brand: { equals: base.brand.trim(), mode: "insensitive" } }, MAX_SECTION));

  // 4. More from this shop — only meaningful for an external seller (the house store IS the store).
  if (base.sellerId && base.seller && !base.seller.isHouse) push("FROM_THIS_STORE", await find({ sellerId: base.sellerId }, MAX_SECTION));

  return sections;
}
