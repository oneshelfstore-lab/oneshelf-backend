import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";
import { SUBCATEGORIES, slugifySub } from "../data/subcategories.js";
import { cacheControl, memoCache, PUBLIC_TTL_MS, PUBLIC_TTL_SECONDS } from "../lib/httpCache.js";

// ─── Public router (no auth, mounted at /api/app/categories) ────────

export const publicCategoryRouter = Router();

publicCategoryRouter.get("/", cacheControl(PUBLIC_TTL_SECONDS), async (_req: Request, res: Response) => {
  try {
    const data = await memoCache.get("categories", PUBLIC_TTL_MS, async () => {
      const categories = await prisma.category.findMany({
        where: { isActive: true },
        orderBy: { displayOrder: "asc" },
        include: { _count: { select: { catalogProducts: true } } },
      });
      // Flatten the relation count into a plain productCount the app consumes
      // (mirrors the admin endpoint's _count include; counts ALL catalog products
      // in the category — active or not, matching the admin tile counts).
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

// GET /api/app/categories/:slug/subcategories — canonical sub-categories for a
// category, each with a live count of active products. Returns the curated list
// (ordered) merged with any legacy/free-text values present in the data, so nothing
// is hidden. Powers the category → sub-category browsing rail.
publicCategoryRouter.get("/:slug/subcategories", cacheControl(PUBLIC_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug!;
    const data = await memoCache.get(`categories:sub:${slug}`, PUBLIC_TTL_MS, async () => {
      const category = await prisma.category.findUnique({ where: { slug }, select: { id: true } });
      if (!category) return [] as { slug: string; name: string; productCount: number }[];

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
      const out: { slug: string; name: string; productCount: number }[] = [];

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
    });

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
    const slug = req.params.slug as string;
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
});

adminCategoryRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { displayOrder: "asc" },
      include: { _count: { select: { catalogProducts: true } } },
      take: 500,
    });
    res.json({ success: true, data: categories });
  } catch (e) {
    sendError(res, e);
  }
});

adminCategoryRouter.post("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid category data", parsed.error.errors);

    const existing = await prisma.category.findUnique({ where: { slug: parsed.data.slug } });
    if (existing) throw new ConflictError(`Category slug '${parsed.data.slug}' already exists`);

    const category = await prisma.category.create({ data: parsed.data });
    memoCache.bust("categories", "super-cats");
    res.status(201).json({ success: true, data: category });
  } catch (e) {
    sendError(res, e);
  }
});

adminCategoryRouter.put("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Category", req.params.id!);

    const parsed = categorySchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid category data", parsed.error.errors);

    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      const dup = await prisma.category.findUnique({ where: { slug: parsed.data.slug } });
      if (dup) throw new ConflictError(`Category slug '${parsed.data.slug}' already exists`);
    }

    const category = await prisma.category.update({ where: { id: req.params.id }, data: parsed.data });
    memoCache.bust("categories", "super-cats");
    res.json({ success: true, data: category });
  } catch (e) {
    sendError(res, e);
  }
});

adminCategoryRouter.delete("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Category", req.params.id!);

    await prisma.category.update({ where: { id: req.params.id }, data: { isActive: false } });
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
