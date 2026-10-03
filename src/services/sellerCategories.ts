// Which top-level categories a seller may list in. A seller ticks departments at registration ("Grocery",
// "Books & stationery"…); the server keeps them as shopType + alsoSellCategories (data/shopTypes.ts). A
// super-category lists the departments allowed to sell in it (SuperCategory.departments, set from the backend),
// so adding a new super later needs no code change.
//
// Fail-open on purpose: a seller whose departments match no super-category (a trade nobody has built a shelf for
// yet, or an old seller with no shopType) sees everything rather than an empty, un-saveable picker.

import type { Prisma } from "@prisma/client";
import { ValidationError } from "../lib/errors.js";
import { DEPARTMENT_REP } from "../data/shopTypes.js";

type Db = Pick<Prisma.TransactionClient, "seller" | "category">;

// Licensed lines are asked inside the Health department (DEPARTMENT_EXTRAS), so they map back to it.
const KEY_TO_DEPARTMENT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(DEPARTMENT_REP).map(([dept, key]) => [key, dept])),
  PHARMACY: "Health",
  MEDICAL_DEVICE: "Health",
};

/** Registration departments a seller ticked, recovered from the stored shop type + also-sell keys. */
export function departmentsOf(shopType: string | null | undefined, alsoSell: readonly string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const key of [shopType, ...(alsoSell ?? [])]) {
    const dept = key ? KEY_TO_DEPARTMENT[key] : undefined;
    if (dept) out.add(dept);
  }
  return [...out];
}

export type PickerRoot = {
  id: string; slug: string; name: string; nameHi: string | null; imageUrl: string | null; displayOrder: number;
  superCategory: { id: string; slug: string; name: string; departments: string[]; isActive: boolean } | null;
};

/**
 * Pure: the roots a seller with these departments may use. A super with no departments (a seasonal "Diwali" shelf) or
 * an inactive one is never sellable, not even by the fail-open fallback. Empty departments, or no match at all →
 * every sellable root (including ones on no shelf yet).
 */
export function allowedRoots<T extends PickerRoot>(roots: T[], departments: string[]): T[] {
  const sellable = roots.filter((r) => !r.superCategory || (r.superCategory.isActive && r.superCategory.departments.length > 0));
  if (departments.length === 0) return sellable;
  const allowed = sellable.filter((r) => r.superCategory?.departments.some((d) => departments.includes(d)));
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
        superCategory: { select: { id: true, slug: true, name: true, departments: true, isActive: true, displayOrder: true } },
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
