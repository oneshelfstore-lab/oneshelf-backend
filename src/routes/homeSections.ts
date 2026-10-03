import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";
import { cacheControl, memoCache, PUBLIC_TTL_MS, PUBLIC_TTL_SECONDS } from "../lib/httpCache.js";

// ─── Studio sections (web builder → customer app) ────────────────────
//
// The dashboard's Studio edits `draftConfig`; Publish copies it to `publishedConfig`. The customer app only
// reads published configs of active sections, for one page ("HOME" or "dept:<slug>"). Every config carries
// the section's look as data (colours, shape, columns, artwork) so a new design needs no app update.

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const url = z.string().max(600);

/** CATEGORY_SHAPES — optional full-bleed artwork on top, then a grid of shaped tiles (cutout + caption). */
export const categoryShapesConfig = z.object({
  bg: z.object({ from: hex, to: hex, angle: z.number().int().min(0).max(360) })
    .default({ from: "#FFE6D0", to: "#FFE6D0", angle: 180 }),
  header: z.object({ url, aspect: z.number().min(0.5).max(6) }).default({ url: "", aspect: 2.4 }),
  columns: z.number().int().min(2).max(4).default(3),
  shape: z.enum(["pentagon", "arch", "rounded", "circle"]).default("pentagon"),
  tile: z.object({ from: hex, to: hex }).default({ from: "#FE9365", to: "#FE9365" }),
  caption: z.object({ color: hex, size: z.number().min(10).max(24), weight: z.number().int().min(400).max(900) })
    .default({ color: "#070000", size: 14, weight: 600 }),
  imageScale: z.number().min(0.4).max(1).default(0.8),
  items: z.array(z.object({
    title: z.string().max(80).default(""),
    image: url.default(""),
    target: z.object({ type: z.enum(["none", "category", "product"]), id: z.string().max(80) })
      .default({ type: "none", id: "" }),
  })).max(24).default([]),
});

const CONFIG_BY_TYPE = { CATEGORY_SHAPES: categoryShapesConfig } as const;
const TYPES = Object.keys(CONFIG_BY_TYPE) as [keyof typeof CONFIG_BY_TYPE];

function parseConfig(type: keyof typeof CONFIG_BY_TYPE, raw: unknown) {
  const r = CONFIG_BY_TYPE[type].safeParse(raw ?? {});
  if (!r.success) throw new ValidationError("Invalid section config", r.error.errors);
  return r.data;
}

const bust = () => memoCache.bust("home-sections");

// ─── Public router (no auth, mounted at /api/app/home-sections) ───────

export const publicHomeSectionRouter = Router();

publicHomeSectionRouter.get("/", cacheControl(PUBLIC_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const page = typeof req.query.page === "string" && req.query.page ? req.query.page : "HOME";
    const data = await memoCache.get(`home-sections:${page}`, PUBLIC_TTL_MS, async () => {
      const rows = await prisma.homeSection.findMany({
        where: { page, isActive: true, publishedAt: { not: null } },
        orderBy: { displayOrder: "asc" },
        select: { id: true, type: true, displayOrder: true, publishedConfig: true },
      });
      return rows
        .filter((r) => r.publishedConfig != null)
        .map((r) => ({ id: r.id, type: r.type, displayOrder: r.displayOrder, config: r.publishedConfig }));
    });
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Admin router (dashboard JWT, mounted at /api/home-sections) ──────

export const adminHomeSectionRouter = Router();

adminHomeSectionRouter.get("/", async (req: Request, res: Response) => {
  try {
    const page = typeof req.query.page === "string" && req.query.page ? req.query.page : "HOME";
    const data = await prisma.homeSection.findMany({ where: { page }, orderBy: { displayOrder: "asc" } });
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

const createSchema = z.object({
  page: z.string().min(1).max(80).default("HOME"),
  type: z.enum(TYPES),
  displayOrder: z.number().int().min(0).default(0),
  draftConfig: z.unknown().optional(),
});

adminHomeSectionRouter.post("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const p = createSchema.safeParse(req.body);
    if (!p.success) throw new ValidationError("Invalid section", p.error.errors);
    const last = await prisma.homeSection.aggregate({ where: { page: p.data.page }, _max: { displayOrder: true } });
    const row = await prisma.homeSection.create({
      data: {
        page: p.data.page,
        type: p.data.type,
        displayOrder: p.data.displayOrder || (last._max.displayOrder ?? 0) + 1,
        draftConfig: parseConfig(p.data.type, p.data.draftConfig) as any,
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    sendError(res, e);
  }
});

const updateSchema = z.object({
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  draftConfig: z.unknown().optional(),
});

adminHomeSectionRouter.put("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.homeSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("HomeSection", id);
    const p = updateSchema.safeParse(req.body);
    if (!p.success) throw new ValidationError("Invalid section", p.error.errors);
    const row = await prisma.homeSection.update({
      where: { id },
      data: {
        ...(p.data.displayOrder !== undefined ? { displayOrder: p.data.displayOrder } : {}),
        ...(p.data.isActive !== undefined ? { isActive: p.data.isActive } : {}),
        ...(p.data.draftConfig !== undefined
          ? { draftConfig: parseConfig(existing.type as keyof typeof CONFIG_BY_TYPE, p.data.draftConfig) as any }
          : {}),
      },
    });
    bust(); // order / visibility changes are live immediately; draft edits aren't, but busting is cheap
    res.json({ success: true, data: row });
  } catch (e) {
    sendError(res, e);
  }
});

adminHomeSectionRouter.post("/:id/publish", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.homeSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("HomeSection", id);
    const row = await prisma.homeSection.update({
      where: { id },
      data: { publishedConfig: existing.draftConfig as any, publishedAt: new Date() },
    });
    bust();
    res.json({ success: true, data: row });
  } catch (e) {
    sendError(res, e);
  }
});

adminHomeSectionRouter.post("/:id/unpublish", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.homeSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("HomeSection", id);
    const row = await prisma.homeSection.update({
      where: { id },
      data: { publishedConfig: Prisma.DbNull, publishedAt: null },
    });
    bust();
    res.json({ success: true, data: row });
  } catch (e) {
    sendError(res, e);
  }
});

adminHomeSectionRouter.delete("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.homeSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("HomeSection", id);
    await prisma.homeSection.delete({ where: { id } });
    bust();
    res.json({ success: true, message: "Section deleted" });
  } catch (e) {
    sendError(res, e);
  }
});
