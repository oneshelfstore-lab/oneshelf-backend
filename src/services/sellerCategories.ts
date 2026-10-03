// Which top-level categories a seller may list in. A seller ticks departments at registration ("Grocery",
// "Books & Education"…) — the 16 super-categories; the server keeps them as shopType + alsoSellCategories
// (data/shopTypes.ts, DEPARTMENT_REP). A seller sees exactly the roots on the supers they picked.
//
// Fail-open on purpose: a seller whose departments match no super-category (a trade nobody has built a shelf for
// yet, or an old seller with no shopType) sees everything rather than an empty, un-saveable picker.

import type { Prisma } from "@prisma/client";
import { ValidationError } from "../lib/errors.js";
import { HIDDEN_DEPARTMENTS, SHOP_TYPES } from "../data/shopTypes.js";

type Db = Pick<Prisma.TransactionClient, "seller" | "category">;

// Every registry shop type belongs to one super-category (its `department`, which since the 16-super picker IS the
// super-category's name). Retired ones (fashion) and the menu-based Food trades match no super and are simply ignored.
const KEY_TO_SUPER = new Map(SHOP_TYPES.map((s) => [s.key, s.department]));

/** Super-category names a seller registered for, recovered from their stored shop type + also-sell keys. */
export function departmentsOf(shopType: string | null | undefined, alsoSell: readonly string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const key of [shopType, ...(alsoSell ?? [])]) {
    const name = key ? KEY_TO_SUPER.get(key) : undefined;
    if (name && name !== "Food" && !HIDDEN_DEPARTMENTS.has(name)) out.add(name);
  }
  return [...out];
}

export type PickerRoot = {
  id: string; slug: string; name: string; nameHi: string | null; imageUrl: string | null; displayOrder: number;
  superCategory: { id: string; slug: string; name: string; isActive: boolean } | null;
};

/**
 * Pure: the roots a seller who registered for these super-categories may use — those on a picked, active super. No picks,
 * or none matching any active super → every root on an active super plus roots on no super yet (fail open, so the picker
 * is never empty).
 */
export function allowedRoots<T extends PickerRoot>(roots: T[], picked: string[]): T[] {
  const sellable = roots.filter((r) => !r.superCategory || r.superCategory.isActive);
  if (picked.length === 0) return sellable;
  const allowed = sellable.filter((r) => r.superCategory && picked.includes(r.superCategory.name));
  return allowed.length > 0 ? allowed : sellable;
}

/** The seller's allowed top-level categories, each carrying its super-category (null = not on any shelf yet). */
export async function loadAllowedRoots(db: Db, sellerId: string) {
  const [seller, roots] = await Promise.all([
    db.seller.findUnique({ where: { id: sellerId }, select: { shopType: true, alsoSellCategories: true } }),
    db.category.findMany({
      where: { isActive: true, parentId: null },
      orderBy: { displayOrder: "asc" },
      select: {
        id: true, slug: true, name: true, nameHi: true, imageUrl: true, displayOrder: true,
        superCategory: { select: { id: true, slug: true, name: true, isActive: true, displayOrder: true } },
      },
    }),
  ]);
  const ordered = [...roots].sort((a, b) => (a.superCategory?.displayOrder ?? 1e9) - (b.superCategory?.displayOrder ?? 1e9) || a.displayOrder - b.displayOrder);
  return allowedRoots(ordered, departmentsOf(seller?.shopType, seller?.alsoSellCategories));
}

/** Throws if this seller may not file a product under top-level category `rootId`. */
export async function assertSellerMayUseCategory(db: Db, sellerId: string, rootId: string): Promise<void> {
  const roots = await loadAllowedRoots(db, sellerId);
  if (!roots.some((r) => r.id === rootId)) {
    throw new ValidationError("That category isn't part of what your shop sells. Pick one from your list.");
  }
}
