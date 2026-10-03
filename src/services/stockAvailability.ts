/**
 * Untracked stock ("I don't want to commit a number"): a variant with trackStock=false is orderable
 * until the seller hides it, capped per order at maxOrderQty. Everything that used to ask "stock > 0"
 * goes through here so the rule lives in one place.
 */

/** Per-order cap for an untracked variant whose seller never set one. */
export const DEFAULT_UNTRACKED_CAP = 10;

/** Prisma fragment for `variants: { some: { isActive: true, ...IN_STOCK } }`. */
export const IN_STOCK = { OR: [{ trackStock: false }, { stock: { gt: 0 } }] };

interface StockLike {
  stock: unknown;
  trackStock?: boolean | null;
  maxOrderQty?: number | null;
  packageSize?: unknown;
}

/** True when the variant can be ordered at all. */
export function hasStock(v: StockLike): boolean {
  return v.trackStock === false || Number(v.stock) > 0;
}

/**
 * The most that can be ordered, in the column's BASE units (what Number(variant.stock) is for a
 * tracked variant). Untracked → the seller's cap, converted from sale increments to base units.
 */
export function stockLimitBase(v: StockLike, isLoose: boolean): number {
  if (v.trackStock !== false) return Number(v.stock);
  const cap = v.maxOrderQty ?? DEFAULT_UNTRACKED_CAP;
  return isLoose ? cap * (Number(v.packageSize) || 1) : cap;
}
