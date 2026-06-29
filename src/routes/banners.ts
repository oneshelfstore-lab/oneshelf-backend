import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { cacheControl, memoCache, PUBLIC_TTL_MS, PUBLIC_TTL_SECONDS } from "../lib/httpCache.js";

// ─── Public router (no auth, mounted at /api/app/banners) ───────────

export const publicBannerRouter = Router();

publicBannerRouter.get("/", cacheControl(PUBLIC_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    // Optional ?placement=HOME|CATEGORY filter so category-page banners are a distinct set from
    // the Home carousel. No param → all active banners (back-compat for any existing caller).
    const placement = typeof req.query.placement === "string" ? req.query.placement : undefined;
    // Cache per placement. Note: the time-window filter (start/end dates) is evaluated inside the
    // loader using "now" at cache-fill time, so a banner can be at most PUBLIC_TTL_MS late to
    // appear/expire by schedule — acceptable for a 60s window; owner add/delete busts immediately.
    const data = await memoCache.get(`banners:${placement ?? "all"}`, PUBLIC_TTL_MS, async () => {
      const now = new Date();
      return prisma.banner.findMany({
        where: {
          isActive: true,
          ...(placement ? { placement } : {}),
          OR: [
            { startDate: null, endDate: null },
            { startDate: { lte: now }, endDate: null },
            { startDate: null, endDate: { gte: now } },
            { startDate: { lte: now }, endDate: { gte: now } },
          ],
        },
        orderBy: { displayOrder: "asc" },
      });
    });
    res.json({ success: true, data });
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
  placement: z.enum(["HOME", "CATEGORY", "SPOTLIGHT", "BULK"]).default("HOME"),
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
    memoCache.bust("banners");
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
    memoCache.bust("banners");
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
    memoCache.bust("banners");
    res.json({ success: true, message: "Banner deactivated" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Owner router (FIREBASE auth, mounted at /api/app/owner/banners) ──
//
// The Android owner app authenticates with Firebase (not the dashboard's JWT), so it needs a
// Firebase-auth banner write path. Without this, OwnerViewModel.addBanner/deleteBanner fell back to
// Firestore while the app READS banners from Postgres (GET /api/app/banners) → added banners never
// appeared in the list / on the customer Home, and delete did nothing. Mirrors ownerCatalog's auth.

export const ownerBannerRouter = Router();
ownerBannerRouter.use(firebaseAuthMiddleware as any);
ownerBannerRouter.use(requireAppRole("OWNER") as any);

ownerBannerRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const banners = await prisma.banner.findMany({ orderBy: { displayOrder: "asc" } });
    res.json({ success: true, data: banners });
  } catch (e) {
    sendError(res, e);
  }
});

ownerBannerRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = bannerSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid banner data", parsed.error.errors);

    const banner = await prisma.banner.create({ data: parsed.data });
    memoCache.bust("banners");
    res.status(201).json({ success: true, data: banner });
  } catch (e) {
    sendError(res, e);
  }
});

ownerBannerRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.banner.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Banner", req.params.id!);

    // Hard delete — the owner tapped the trash icon expecting it gone (the public list filters by
    // isActive, so a soft-delete would also disappear, but hard delete avoids accumulating rows).
    await prisma.banner.delete({ where: { id: req.params.id } });
    memoCache.bust("banners");
    res.json({ success: true, message: "Banner deleted" });
  } catch (e) {
    sendError(res, e);
  }
});
