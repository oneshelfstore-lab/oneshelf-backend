import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Owner-set rates for many (seller, category) pairs at once → Map keyed `${sellerId}:${categoryId}`.
 * For read-side screens that must show the same rate the order path charges.
 */
export async function loadCategoryRatesFor(
  db: Db,
  pairs: { sellerId: string | null; categoryId: string }[],
): Promise<Map<string, number>> {
  const sellerIds = [...new Set(pairs.map((p) => p.sellerId).filter((s): s is string => !!s))];
  if (sellerIds.length === 0) return new Map();
  const rows = await db.sellerCategoryCommission.findMany({
    where: { sellerId: { in: sellerIds }, categoryId: { in: [...new Set(pairs.map((p) => p.categoryId))] } },
    select: { sellerId: true, categoryId: true, pct: true },
  });
  return new Map(rows.map((r) => [`${r.sellerId}:${r.categoryId}`, Number(r.pct)]));
}

/**
 * The owner's per-category commission rows for one seller, as categoryId → pct.
 *
 * Feeds `SellerLine.categoryCommissionPct`. An absent category is simply absent from the map — the
 * caller passes `undefined`/null and resolveCommissionPct falls through to the seller default. It
 * must never be defaulted to 0 here.
 */
export async function loadCategoryRates(db: Db, sellerId: string): Promise<Map<string, number>> {
  const rows = await db.sellerCategoryCommission.findMany({
    where: { sellerId },
    select: { categoryId: true, pct: true },
  });
  return new Map(rows.map((r) => [r.categoryId, Number(r.pct)]));
}
