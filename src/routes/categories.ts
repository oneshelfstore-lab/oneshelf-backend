import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";

// ─── Public router (no auth, mounted at /api/app/categories) ────────

export const publicCategoryRouter = Router();

publicCategoryRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: "asc" },
    });
    res.json({ success: true, data: categories });
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
    res.json({ success: true, data: { imported, errors, details: results } });
  } catch (e) {
    sendError(res, e);
  }
});
