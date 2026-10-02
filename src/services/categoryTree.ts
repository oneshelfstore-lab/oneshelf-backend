// Category tree helpers (CATALOG_PLAN.md phase 1).
//
// Model: `Category.parentId` makes a tree. Top-level rows (parentId null) are exactly the "categories"
// the app has always known: commission, GST, analytics, Home chips and banners all key on them.
// A product's `categoryId` therefore stays the TOP-LEVEL category; `leafCategoryId` is the deepest node.
// Only this file derives one from the other, so the two can never disagree.
//
// Invariant kept by moveCategory: roots are never moved or demoted, so no commission/Home/banner
// reference can silently change meaning.

import type { Prisma } from "@prisma/client";
import { ValidationError, NotFoundError } from "../lib/errors.js";

export const MAX_DEPTH = 4; // root = depth 1

type Db = Pick<Prisma.TransactionClient, "category">;

export type TreeRow = { id: string; parentId: string | null };

/** id → ancestors-first path ending at the node (root first). Stops on a cycle or missing parent. */
export function pathTo(rows: Map<string, TreeRow>, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  for (let cur: string | null = id; cur && !seen.has(cur); ) {
    seen.add(cur);
    path.unshift(cur);
    cur = rows.get(cur)?.parentId ?? null;
  }
  return path;
}

/** The node and every descendant. */
export function subtreeIds(rows: TreeRow[], id: string): string[] {
  const kids = new Map<string, string[]>();
  for (const r of rows) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r.id]);
  const out: string[] = [];
  for (const stack = [id]; stack.length; ) {
    const cur = stack.pop()!;
    out.push(cur);
    stack.push(...(kids.get(cur) ?? []));
  }
  return out;
}

/** Height of the subtree under id (a lone node = 1). */
function height(rows: TreeRow[], id: string): number {
  const kids = rows.filter((r) => r.parentId === id);
  return 1 + Math.max(0, ...kids.map((k) => height(rows, k.id)));
}

/** Throws if moving `id` under `newParentId` would break the tree. Pure, so it is unit-tested. */
export function assertCanMove(rows: TreeRow[], id: string, newParentId: string): void {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const node = byId.get(id);
  if (!node) throw new NotFoundError("Category", id);
  if (!byId.has(newParentId)) throw new NotFoundError("Category", newParentId);
  if (!node.parentId) throw new ValidationError("Top-level categories cannot be moved; reorder or edit them instead");
  if (subtreeIds(rows, id).includes(newParentId)) throw new ValidationError("A category cannot be moved under itself");
  const depthOfParent = pathTo(byId, newParentId).length;
  if (depthOfParent + height(rows, id) > MAX_DEPTH) throw new ValidationError(`Categories can be at most ${MAX_DEPTH} levels deep`);
}

/** Re-parent a non-root node and re-derive categoryId for every product in its subtree, atomically. */
export async function moveCategory(tx: Prisma.TransactionClient, id: string, newParentId: string): Promise<void> {
  const rows = await tx.category.findMany({ select: { id: true, parentId: true } });
  assertCanMove(rows, id, newParentId);
  await tx.category.update({ where: { id }, data: { parentId: newParentId } });
  const byId = new Map(rows.map((r) => [r.id, r.id === id ? { id, parentId: newParentId } : r]));
  const newRoot = pathTo(byId, id)[0]!;
  await tx.catalogProduct.updateMany({
    where: { leafCategoryId: { in: subtreeIds(rows, id) } },
    data: { categoryId: newRoot },
  });
}

/** Root-first chain of ancestors for a stored node (DB walk; trees are ≤ MAX_DEPTH deep). */
async function rootOf(db: Db, id: string): Promise<{ root: { id: string }; node: { id: string; name: string; parentId: string | null } }> {
  const node = await db.category.findUnique({ where: { id }, select: { id: true, name: true, parentId: true } });
  if (!node) throw new ValidationError(`Category '${id}' not found`);
  let top: { id: string; parentId: string | null } = node;
  for (let i = 0; top.parentId && i < MAX_DEPTH + 2; i++) {
    const p = await db.category.findUnique({ where: { id: top.parentId }, select: { id: true, parentId: true } });
    if (!p) break;
    top = p;
  }
  return { root: top, node };
}

export type CategoryInput = {
  /** The app's historical field: the top-level category's slug. */
  categorySlug?: string;
  /** Same thing by id (the JWT admin routes). A non-top-level id is treated as a leaf, never stored as categoryId. */
  categoryId?: string;
  /** Legacy free-text sub-category name. */
  subcategory?: string | null;
  /** New: the deepest node. Wins over the two above. */
  leafCategoryId?: string | null;
};

export type CategoryFields = { categoryId?: string; leafCategoryId?: string | null; subcategory?: string | null };

/**
 * One place that turns what a client sent into the three columns, for product create and update.
 *  - leafCategoryId given → categoryId := its root, subcategory := its name (null when it IS the root).
 *  - else categorySlug / subcategory (old apps) → categoryId from the slug, and the free-text name is
 *    linked to a matching child node when one exists (so legacy writes keep the tree in step).
 * `currentCategoryId` is the product's existing top-level category (update only).
 * Returns only the fields to write; an empty object means "leave the category columns alone".
 */
export async function resolveCategoryFields(db: Db, input: CategoryInput, currentCategoryId?: string): Promise<CategoryFields> {
  let leafId = input.leafCategoryId;
  let cat: { id: string } | null = null;
  if (!leafId && input.categoryId) {
    const c = await db.category.findUnique({ where: { id: input.categoryId }, select: { id: true, parentId: true } });
    if (!c) throw new ValidationError(`Category '${input.categoryId}' not found`);
    if (c.parentId) leafId = c.id;
    else cat = c;
  }
  if (leafId) {
    const { root, node } = await rootOf(db, leafId);
    const isRoot = node.id === root.id; // a root needs no leaf: categoryId already says it all
    return { categoryId: root.id, leafCategoryId: isRoot ? null : node.id, subcategory: isRoot ? null : node.name };
  }

  const out: CategoryFields = {};
  let catId = currentCategoryId;
  if (!cat && input.categorySlug) {
    cat = await db.category.findUnique({ where: { slug: input.categorySlug }, select: { id: true } });
    if (!cat) throw new ValidationError(`Category '${input.categorySlug}' not found`);
  }
  if (cat) {
    catId = cat.id;
    out.categoryId = cat.id;
    // Moved to another top-level category without saying which sub-category: the old leaf no longer applies.
    if (currentCategoryId && currentCategoryId !== cat.id && input.subcategory === undefined) out.leafCategoryId = null;
  }
  if (input.subcategory !== undefined) {
    out.subcategory = input.subcategory;
    const name = input.subcategory?.trim();
    const child = name && catId
      ? await db.category.findFirst({ where: { parentId: catId, name: { equals: name, mode: "insensitive" } }, select: { id: true } })
      : null;
    out.leafCategoryId = child?.id ?? null;
  }
  return out;
}

export type TreeNode = {
  id: string; slug: string; name: string; nameHi: string | null; imageUrl: string | null;
  description: string | null; displayOrder: number; showInNavigation: boolean; isActive: boolean;
  superCategoryId: string | null; productCount: number; children: TreeNode[];
};

type TreeCategory = Omit<TreeNode, "productCount" | "children"> & { parentId: string | null };

/**
 * Nested tree from flat rows. `byLeaf` = products per leafCategoryId, `byRoot` = products per top-level
 * categoryId. A node's count = its own leaf products plus everything below it; a root also counts
 * products that only know the top-level category.
 */
export function buildTree(rows: TreeCategory[], byLeaf: Map<string, number>, byRoot: Map<string, number>): TreeNode[] {
  const flat = rows.map((r) => ({ id: r.id, parentId: r.parentId }));
  const make = (r: TreeCategory): TreeNode => {
    const { parentId: _p, ...rest } = r;
    const kids = rows.filter((c) => c.parentId === r.id).sort((a, b) => a.displayOrder - b.displayOrder).map(make);
    const own = r.parentId ? subtreeIds(flat, r.id).reduce((n, id) => n + (byLeaf.get(id) ?? 0), 0) : (byRoot.get(r.id) ?? 0);
    return { ...rest, productCount: own, children: kids };
  };
  return rows.filter((r) => !r.parentId).sort((a, b) => a.displayOrder - b.displayOrder).map(make);
}

/** Stable slug for a child node: `<parentSlug>__<name>` keeps the global unique constraint. */
export function childSlug(parentSlug: string, name: string): string {
  const part = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${parentSlug}__${part}`.slice(0, 50);
}

/** Throws if node `id` cannot be merged into `intoId` (its products and sub-categories move there, then it is deleted). Pure. */
export function assertCanMerge(rows: TreeRow[], id: string, intoId: string): void {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const node = byId.get(id);
  if (!node) throw new NotFoundError("Category", id);
  if (!byId.has(intoId)) throw new NotFoundError("Category", intoId);
  if (!node.parentId) throw new ValidationError("Top-level categories cannot be merged (commission and Home depend on them)");
  if (subtreeIds(rows, id).includes(intoId)) throw new ValidationError("A category cannot be merged into itself or one of its own sub-categories");
  // Its children move up to sit under the target, so they must still fit the depth limit.
  const childHeight = height(rows, id) - 1;
  if (childHeight > 0 && pathTo(byId, intoId).length + childHeight > MAX_DEPTH) {
    throw new ValidationError(`Categories can be at most ${MAX_DEPTH} levels deep`);
  }
}

/**
 * Merge `id` into `intoId`, atomically: products filed directly on it and its sub-categories move to the target,
 * SMART collection rules that named it are repointed, then the empty node is deleted.
 */
export async function mergeCategory(tx: Prisma.TransactionClient, id: string, intoId: string): Promise<void> {
  const rows = await tx.category.findMany({ select: { id: true, parentId: true } });
  assertCanMerge(rows, id, intoId);
  const { root, node: into } = await rootOf(tx, intoId);
  const intoIsRoot = into.id === root.id;

  await tx.catalogProduct.updateMany({
    where: { leafCategoryId: id },
    data: { leafCategoryId: intoIsRoot ? null : into.id, categoryId: root.id, subcategory: intoIsRoot ? null : into.name },
  });
  await tx.category.updateMany({ where: { parentId: id }, data: { parentId: intoId } });
  const below = subtreeIds(rows, id).filter((x) => x !== id);
  if (below.length) await tx.catalogProduct.updateMany({ where: { leafCategoryId: { in: below } }, data: { categoryId: root.id } });

  // Collections whose rules selected the merged node now select its replacement.
  const smart = await tx.collection.findMany({ where: { mode: "SMART" }, select: { id: true, rules: true } });
  for (const c of smart) {
    const r = c.rules as { categoryIds?: string[] } | null;
    if (r?.categoryIds?.includes(id)) {
      const ids = [...new Set(r.categoryIds.map((x) => (x === id ? intoId : x)))];
      await tx.collection.update({ where: { id: c.id }, data: { rules: { ...r, categoryIds: ids } } });
    }
  }
  await tx.category.delete({ where: { id } });
}

/** File these products under category node `categoryId` (any depth); categoryId/subcategory are derived from it. Returns the count moved. */
export async function assignProducts(tx: Prisma.TransactionClient, productIds: string[], categoryId: string): Promise<number> {
  const f = await resolveCategoryFields(tx, { leafCategoryId: categoryId });
  const r = await tx.catalogProduct.updateMany({
    where: { id: { in: productIds } },
    data: { categoryId: f.categoryId!, leafCategoryId: f.leafCategoryId ?? null, subcategory: f.subcategory ?? null },
  });
  return r.count;
}
