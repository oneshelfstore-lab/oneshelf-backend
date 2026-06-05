import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";

// ─── Public router (no auth, mounted at /api/app/banners) ───────────

export const publicBannerRouter = Router();

publicBannerRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const banners = await prisma.banner.findMany({
      where: {
        isActive: true,
        OR: [
          { startDate: null, endDate: null },
          { startDate: { lte: now }, endDate: null },
          { startDate: null, endDate: { gte: now } },
          { startDate: { lte: now }, endDate: { gte: now } },
        ],
      },
      orderBy: { displayOrder: "asc" },
    });
    res.json({ success: true, data: banners });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Admin router (JWT auth, mounted at /api/banners) ────────────────

export const adminBannerRouter = Router();

const bannerSchema = z.object({
  imageUrl: z.string().min(1).max(500),
  targetCategory: z.string().max(50).optional().nullable(),
  targetUrl: z.string().max(500).optional().nullable(),
  displayOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  startDate: z.coerce.date().optional().nullable(),
  endDate: z.coerce.date().optional().nullable(),
});

adminBannerRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const banners = await prisma.banner.findMany({ orderBy: { displayOrder: "asc" } });
    res.json({ success: true, data: banners });
  } catch (e) {
    sendError(res, e);
  }
});

adminBannerRouter.post("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = bannerSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid banner data", parsed.error.errors);

    const banner = await prisma.banner.create({ data: parsed.data });
    res.status(201).json({ success: true, data: banner });
  } catch (e) {
    sendError(res, e);
  }
});

adminBannerRouter.put("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.banner.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Banner", req.params.id!);

    const parsed = bannerSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid banner data", parsed.error.errors);

    const banner = await prisma.banner.update({ where: { id: req.params.id }, data: parsed.data });
    res.json({ success: true, data: banner });
  } catch (e) {
    sendError(res, e);
  }
});

adminBannerRouter.delete("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.banner.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Banner", req.params.id!);

    await prisma.banner.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ success: true, message: "Banner deactivated" });
  } catch (e) {
    sendError(res, e);
  }
});
