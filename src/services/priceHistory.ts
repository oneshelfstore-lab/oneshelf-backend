import type { Prisma } from "@prisma/client";

type Db = Pick<Prisma.TransactionClient, "priceChange">;
export interface PriceSnapshot { sellingPrice: number; mrp: number }

/** True when either number actually moved (money compares at 2dp, the column's precision). */
export function priceMoved(a: PriceSnapshot, b: PriceSnapshot): boolean {
  const r = (n: number) => Math.round(n * 100);
  return r(a.sellingPrice) !== r(b.sellingPrice) || r(a.mrp) !== r(b.mrp);
}

/** Log one change. No-op when nothing moved, so callers can call it unconditionally. */
export async function recordPriceChange(
  db: Db, variantId: string, before: PriceSnapshot, after: PriceSnapshot, source: "EDITOR" | "BULK_RULE" | "CSV", by?: string | null,
) {
  if (!priceMoved(before, after)) return;
  await db.priceChange.create({
    data: {
      variantId, source, changedByName: by ?? null,
      oldPrice: before.sellingPrice, newPrice: after.sellingPrice, oldMrp: before.mrp, newMrp: after.mrp,
    },
  });
}
