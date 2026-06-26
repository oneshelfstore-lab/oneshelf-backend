import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";

// ─── Owner super-category router (FIREBASE auth, mounted at /api/app/owner/super-categories) ──
//
// The Android owner app authenticates with Firebase (like ownerCatalog / ownerBanners), so it needs
// a Firebase-auth write path for the super-category (department) layer. Lets the owner create the
// big PNG tabs shown at the top of Home, reorder them, and assign which product-categories live
// under each. Mirrors the ownerBannerRouter auth + error style.

const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

const superCategorySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_]+$/, "Slug must be lowercase alphanumeric with underscores"),
  name: z.string().min(1).max(100),
  nameHi: z.string().max(100).optional().nullable(),
  imageUrl: z.string().max(500).optional().nullable(),
  displayOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

// GET / — all super-categories (incl. inactive), each with its child categories so the owner UI can
// show + edit assignments in one shot.
router.get("/", async (_req: Request, res: Response) => {
  try {
    const supers = await prisma.superCategory.findMany({
      orderBy: { displayOrder: "asc" },
      include: {
        categories: { orderBy: { displayOrder: "asc" }, select: { id: true, slug: true, name: true } },
      },
    });
    res.json({ success: true, data: supers });
  } catch (e) {
    sendError(res, e);
  }
});

// POST / — create (upsert by slug, like owner categories).
router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = superCategorySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid super-category data", parsed.error.errors);

    const { slug, ...rest } = parsed.data;
    const sup = await prisma.superCategory.upsert({
      where: { slug },
      update: rest,
      create: parsed.data,
    });
    res.status(201).json({ success: true, data: sup });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /:id — update fields.
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.superCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("SuperCategory", id);

    const parsed = superCategorySchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid super-category data", parsed.error.errors);

    const sup = await prisma.superCategory.update({ where: { id }, data: parsed.data });
    res.json({ success: true, data: sup });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /:id — remove. onDelete:SetNull unlinks the child categories (products untouched).
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.superCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("SuperCategory", id);

    await prisma.superCategory.delete({ where: { id } });
    res.json({ success: true, message: "Super-category deleted" });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /:id/assign — set the full list of child categories for this super-category. Categories in
// the list get superCategoryId=this; categories previously assigned here but NOT in the list are
// unlinked (superCategoryId=null). A category belongs to at most one super-category.
router.post("/:id/assign", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.superCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("SuperCategory", id);

    const parsed = z.object({ categoryIds: z.array(z.string()).default([]) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid assignment", parsed.error.errors);
    const categoryIds = parsed.data.categoryIds;

    await prisma.$transaction([
      // Unlink categories currently under this super-category that are no longer selected.
      prisma.category.updateMany({
        where: { superCategoryId: id, id: { notIn: categoryIds } },
        data: { superCategoryId: null },
      }),
      // Link the selected categories to this super-category (moves them from any other parent).
      prisma.category.updateMany({
        where: { id: { in: categoryIds } },
        data: { superCategoryId: id },
      }),
    ]);

    const updated = await prisma.superCategory.findUnique({
      where: { id },
      include: {
        categories: { orderBy: { displayOrder: "asc" }, select: { id: true, slug: true, name: true } },
      },
    });
    res.json({ success: true, data: updated });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
