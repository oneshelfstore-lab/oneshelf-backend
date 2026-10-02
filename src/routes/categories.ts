import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";
import { SUBCATEGORIES, slugifySub } from "../data/subcategories.js";
import { cacheControl, memoCache, PUBLIC_TTL_MS, PUBLIC_TTL_SECONDS } from "../lib/httpCache.js";
import { buildCategoryForm, fieldSchemaSchema } from "../services/categoryFields.js";
import { buildTree, childSlug, moveCategory, mergeCategory, assignProducts, subtreeIds, MAX_DEPTH, pathTo } from "../services/categoryTree.js";

// ─── Public router (no auth, mounted at /api/app/categories) ────────

export const publicCategoryRouter = Router();

// GET /api/app/categories/tree — the whole active tree, nested, with live product counts. Hidden
// (showInNavigation false) nodes and their descendants are left out. Declared before /:slug routes.
publicCategoryRouter.get("/tree", cacheControl(PUBLIC_TTL_SECONDS), async (_req: Request, res: Response) => {
  try {
    const data = await memoCache.get("categories:tree", PUBLIC_TTL_MS, async () => {
      const rows = await prisma.category.findMany({
        where: { isActive: true },
        orderBy: { displayOrder: "asc" },
        select: {
          id: true, slug: true, name: true, nameHi: true, imageUrl: true, description: true, displayOrder: true,
          showInNavigation: true, isActive: true, superCategoryId: true, parentId: true,
        },
      });
      // Drop hidden nodes together with everything under them.
      const hidden = new Set(rows.filter((r) => !r.showInNavigation).flatMap((r) => subtreeIds(rows, r.id)));
      const visible = rows.filter((r) => !hidden.has(r.id) && !(r.parentId && !rows.some((p) => p.id === r.parentId)));
      const [leaf, root] = await Promise.all([
        prisma.catalogProduct.groupBy({ by: ["leafCategoryId"], where: { isActive: true, leafCategoryId: { not: null } }, _count: { _all: true } }),
        prisma.catalogProduct.groupBy({ by: ["categoryId"], where: { isActive: true }, _count: { _all: true } }),
      ]);
      return buildTree(
        visible,
        new Map(leaf.map((g) => [g.leafCategoryId!, g._count._all])),
        new Map(root.map((g) => [g.categoryId, g._count._all])),
      );
    });
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/categories/:slug/form — one payload with every sub-category (and its type grandchildren) of a
// top-level category plus each one's full inherited product-form fields. Not cached: a seller who just got a
// field added by the owner should see it on the next open. Declared before nothing it could shadow (/tree is above).
publicCategoryRouter.get("/:slug/form", async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    const root = await prisma.category.findUnique({ where: { slug }, select: { id: true, parentId: true } });
    if (!root || root.parentId) throw new NotFoundError("Category", slug);
    const rows = await prisma.category.findMany({
      where: { isActive: true },
      select: { id: true, name: true, parentId: true, displayOrder: true, fieldSchema: true },
    });
    res.json({ success: true, data: buildCategoryForm(rows, root.id) });
  } catch (e) {
    sendError(res, e);
  }
});

publicCategoryRouter.get("/", cacheControl(PUBLIC_TTL_SECONDS), async (_req: Request, res: Response) => {
  try {
    const data = await memoCache.get("categories", PUBLIC_TTL_MS, async () => {
      const categories = await prisma.category.findMany({
        // parentId null: sub-category nodes are Category rows too, and must not appear as top-level categories.
        where: { isActive: true, parentId: null },
        orderBy: { displayOrder: "asc" },
        // ⚠️ ACTIVE products only. This is the PUBLIC/customer endpoint, and every customer-facing
        // catalog query filters `isActive: true` — so counting deactivated rows here reported
        // shelves that render empty when you open them. Measured on the live catalogue: Dairy,
        // Beverages and 3 others read non-zero while having nothing a customer could actually see.
        // The Android category strip hides a zero-count chip, so an inflated count here put dead
        // chips back on the home screen. The OWNER's own count is a separate endpoint
        // (ownerCatalog) and deliberately still counts everything — that one is an inventory view.
        include: { _count: { select: { catalogProducts: { where: { isActive: true } } } } },
      });
      // Flatten the relation count into a plain productCount the app consumes.
      return categories.map(({ _count, ...c }) => ({
        ...c,
        productCount: _count.catalogProducts,
      }));
    });
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

export type SubcategoryRow = { id?: string; slug: string; name: string; nameHi?: string | null; imageUrl?: string | null; productCount: number };

/** Sub-categories of the category with this slug: real tree children first, plus any unlinked legacy free-text names. */
export async function loadSubcategories(slug: string): Promise<SubcategoryRow[]> {
    const category = await prisma.category.findUnique({ where: { slug }, select: { id: true } });
    if (!category) return [] as SubcategoryRow[];

    // Real tree children win when the category has any; legacy free-text stays below for products not yet linked.
    const all = await prisma.category.findMany({
      where: { isActive: true, parentId: { not: null } },
      select: { id: true, parentId: true, name: true, nameHi: true, imageUrl: true, displayOrder: true, showInNavigation: true },
    });
    const kids = all.filter((c) => c.parentId === category.id && c.showInNavigation).sort((a, b) => a.displayOrder - b.displayOrder);
    if (kids.length > 0) {
      const byLeaf = await prisma.catalogProduct.groupBy({
        by: ["leafCategoryId"],
        where: { categoryId: category.id, isActive: true, leafCategoryId: { not: null } },
        _count: { _all: true },
      });
      const leafCount = new Map(byLeaf.map((g) => [g.leafCategoryId!, g._count._all]));
      const flat = all.map((c) => ({ id: c.id, parentId: c.parentId }));
      const names = new Set(kids.map((k) => k.name.trim().toLowerCase()));
      const out: SubcategoryRow[] = kids.map((k) => ({
        id: k.id,
        slug: slugifySub(k.name),
        name: k.name,
        nameHi: k.nameHi,
        imageUrl: k.imageUrl,
        productCount: subtreeIds(flat, k.id).reduce((n, id) => n + (leafCount.get(id) ?? 0), 0),
      }));
      const loose = await prisma.catalogProduct.groupBy({
        by: ["subcategory"],
        where: { categoryId: category.id, isActive: true, leafCategoryId: null, subcategory: { not: null } },
        _count: { _all: true },
      });
      for (const g of loose) {
        const name = (g.subcategory ?? "").trim();
        if (name && !names.has(name.toLowerCase())) out.push({ slug: slugifySub(name), name, productCount: g._count._all });
      }
      return out;
    }

    const grouped = await prisma.catalogProduct.groupBy({
      by: ["subcategory"],
      where: { categoryId: category.id, isActive: true, subcategory: { not: null } },
      _count: { _all: true },
    });

    // Sum counts by trimmed name (collapses "Rice" vs "Rice ").
    const counts = new Map<string, number>();
    for (const g of grouped) {
      const name = (g.subcategory ?? "").trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + g._count._all);
    }

    const canonical = SUBCATEGORIES[slug] ?? [];
    const seen = new Set<string>();
    const out: SubcategoryRow[] = [];

    // Curated list first (preserves order), with live counts.
    for (const name of canonical) {
      seen.add(name);
      out.push({ slug: slugifySub(name), name, productCount: counts.get(name) ?? 0 });
    }
    // Then any non-canonical values that exist in the data (legacy free-text).
    for (const [name, count] of counts) {
      if (!seen.has(name)) out.push({ slug: slugifySub(name), name, productCount: count });
    }
    return out;
}

// GET /api/app/categories/:slug/subcategories — canonical sub-categories for a
// category, each with a live count of active products. Returns the curated list
// (ordered) merged with any legacy/free-text values present in the data, so nothing
// is hidden. Powers the category → sub-category browsing rail.
publicCategoryRouter.get("/:slug/subcategories", cacheControl(PUBLIC_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    const data = await memoCache.get(`categories:sub:${slug}`, PUBLIC_TTL_MS, () => loadSubcategories(slug));

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Public super-category router (no auth, mounted at /api/app/super-categories) ──
//
// Powers the big PNG tabs at the top of Home + the storefront page they open.

export const publicSuperCategoryRouter = Router();

// GET / — ordered active super-categories (top tabs). Includes a childCount so the app can hide
// empty groups if it wants.
publicSuperCategoryRouter.get("/", cacheControl(PUBLIC_TTL_SECONDS), async (_req: Request, res: Response) => {
  try {
    const data = await memoCache.get("super-cats", PUBLIC_TTL_MS, async () => {
      const supers = await prisma.superCategory.findMany({
        where: { isActive: true },
        orderBy: { displayOrder: "asc" },
        include: { _count: { select: { categories: true } } },
      });
      return supers.map(({ _count, ...s }) => ({ ...s, childCount: _count.categories }));
    });
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /:slug — one super-category + its child categories (each with a live product count) for the
// storefront page. The app then loads products per child via the existing /products endpoint.
publicSuperCategoryRouter.get("/:slug", cacheControl(PUBLIC_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    const data = await memoCache.get(`super-cats:${slug}`, PUBLIC_TTL_MS, async () => {
      const sup = await prisma.superCategory.findUnique({
        where: { slug },
        include: {
          categories: {
            where: { isActive: true },
            orderBy: { displayOrder: "asc" },
            include: { _count: { select: { catalogProducts: true } } },
          },
        },
      });
      if (!sup) throw new NotFoundError("SuperCategory", slug);

      const { categories, ...rest } = sup;
      return {
        ...rest,
        categories: categories.map(({ _count, ...c }) => ({ ...c, productCount: _count.catalogProducts })),
      };
    });
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Admin router (JWT auth, mounted at /api/categories) ────────────

export const adminCategoryRouter = Router();

const categorySchema = z.object({
  slug: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, "Slug must be lowercase alphanumeric with underscores"),
  name: z.string().min(1).max(100),
  imageUrl: z.string().max(500).optional().nullable(),
  displayOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  nameHi: z.string().max(100).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  showInNavigation: z.boolean().default(true),
  // Product-form fields this category adds (inherited by everything below it). Empty array clears them.
  fieldSchema: fieldSchemaSchema.optional(),
});

// Create may omit the slug for a child (derived from the parent's slug + name). Re-parenting is a
// separate endpoint (/:id/move), so update never accepts parentId.
const categoryCreateSchema = categorySchema.extend({
  slug: categorySchema.shape.slug.optional(),
  parentId: z.string().min(1).optional(),
});

// GET / — EVERY node (children included, each with parentId and its own product count): this is the
// admin tree editor's feed. The customer-facing lists filter parentId: null instead.
adminCategoryRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { displayOrder: "asc" },
      include: { _count: { select: { catalogProducts: true, leafProducts: true } } },
      take: 1000,
    });
    res.json({ success: true, data: categories });
  } catch (e) {
    sendError(res, e);
  }
});

adminCategoryRouter.post("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = categoryCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid category data", parsed.error.errors);
    const { parentId, ...rest } = parsed.data;

    let slug = rest.slug;
    if (parentId) {
      const all = await prisma.category.findMany({ select: { id: true, parentId: true, slug: true } });
      const parent = all.find((c) => c.id === parentId);
      if (!parent) throw new NotFoundError("Category", parentId);
      if (pathTo(new Map(all.map((c) => [c.id, c])), parentId).length >= MAX_DEPTH) {
        throw new ValidationError(`Categories can be at most ${MAX_DEPTH} levels deep`);
      }
      slug ??= childSlug(parent.slug, rest.name);
    }
    if (!slug) throw new ValidationError("slug is required for a top-level category");

    const existing = await prisma.category.findUnique({ where: { slug } });
    if (existing) throw new ConflictError(`Category slug '${slug}' already exists`);

    const category = await prisma.category.create({ data: { ...rest, slug, parentId } });
    memoCache.bust("categories", "super-cats");
    res.status(201).json({ success: true, data: category });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /:id/move { parentId } — re-parent a NON-root node. Top-level categories are never moved (they carry
// commission, GST and Home references), and products in the subtree get their top-level categoryId re-derived.
adminCategoryRouter.put("/:id/move", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = z.object({ parentId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("parentId is required", parsed.error.errors);
    await prisma.$transaction((tx) => moveCategory(tx, String(req.params.id), parsed.data.parentId));
    memoCache.bust("categories", "super-cats");
    res.json({ success: true, message: "Category moved" });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /:id/merge { intoId } — fold a NON-root category into another: its products and sub-categories move there,
// SMART collection rules are repointed, and the node is deleted. Atomic.
adminCategoryRouter.post("/:id/merge", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = z.object({ intoId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("intoId is required", parsed.error.errors);
    await prisma.$transaction((tx) => mergeCategory(tx, String(req.params.id), parsed.data.intoId));
    memoCache.bust("categories", "super-cats", "collections");
    res.json({ success: true, message: "Categories merged" });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /assign-products { productIds, categoryId } — bulk-file products under any category node.
adminCategoryRouter.post("/assign-products", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = z.object({ productIds: z.array(z.string().min(1)).min(1).max(500), categoryId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("productIds and categoryId are required", parsed.error.errors);
    const moved = await prisma.$transaction((tx) => assignProducts(tx, parsed.data.productIds, parsed.data.categoryId));
    memoCache.bust("categories", "collections");
    res.json({ success: true, data: { moved } });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /reorder { ids } — displayOrder := index in `ids` (the caller sends one sibling group in the new order).
adminCategoryRouter.post("/reorder", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("ids must be a non-empty array", parsed.error.errors);
    await prisma.$transaction(parsed.data.ids.map((id, i) => prisma.category.update({ where: { id }, data: { displayOrder: i } })));
    memoCache.bust("categories", "super-cats");
    res.json({ success: true, message: "Reordered" });
  } catch (e) {
    sendError(res, e);
  }
});

adminCategoryRouter.put("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.category.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new NotFoundError("Category", String(req.params.id));

    const parsed = categorySchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid category data", parsed.error.errors);

    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      const dup = await prisma.category.findUnique({ where: { slug: parsed.data.slug } });
      if (dup) throw new ConflictError(`Category slug '${parsed.data.slug}' already exists`);
    }

    const category = await prisma.category.update({ where: { id: String(req.params.id) }, data: parsed.data });
    memoCache.bust("categories", "super-cats");
    res.json({ success: true, data: category });
  } catch (e) {
    sendError(res, e);
  }
});

adminCategoryRouter.delete("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.category.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new NotFoundError("Category", String(req.params.id));

    await prisma.category.update({ where: { id: String(req.params.id) }, data: { isActive: false } });
    memoCache.bust("categories", "super-cats");
    res.json({ success: true, message: "Category deactivated" });
  } catch (e) {
    sendError(res, e);
  }
});

const csvRowSchema = z.object({
  slug: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  image_url: z.string().max(500).optional().nullable(),
  display_order: z.coerce.number().int().min(0).default(0),
});

adminCategoryRouter.post("/import-csv", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw new ValidationError("Body must contain a non-empty 'rows' array");
    if (rows.length > 100) throw new ValidationError("Maximum 100 categories per import");

    const results: { row: number; slug: string; status: string; error?: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = csvRowSchema.safeParse(rows[i]);
      if (!parsed.success) {
        results.push({ row: i + 1, slug: rows[i]?.slug ?? "?", status: "error", error: parsed.error.errors.map(e => e.message).join("; ") });
        continue;
      }
      try {
        await prisma.category.upsert({
          where: { slug: parsed.data.slug },
          update: { name: parsed.data.name, imageUrl: parsed.data.image_url ?? null, displayOrder: parsed.data.display_order },
          create: { slug: parsed.data.slug, name: parsed.data.name, imageUrl: parsed.data.image_url ?? null, displayOrder: parsed.data.display_order },
        });
        results.push({ row: i + 1, slug: parsed.data.slug, status: "ok" });
      } catch (e: any) {
        results.push({ row: i + 1, slug: parsed.data.slug, status: "error", error: e.message });
      }
    }

    const imported = results.filter(r => r.status === "ok").length;
    const errors = results.filter(r => r.status === "error").length;
    if (imported > 0) memoCache.bust("categories", "super-cats");
    res.json({ success: true, data: { imported, errors, details: results } });
  } catch (e) {
    sendError(res, e);
  }
});
