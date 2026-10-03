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

const num = (d: number, min: number, max: number) => z.number().min(min).max(max).default(d);
const gradient = (from: string, to: string) =>
  z.object({ from: hex.default(from), to: hex.default(to), angle: z.number().int().min(0).max(360).default(180) }).default({});

/**
 * CATEGORY_SHAPES — one block of a page: optional heading, optional full-bleed artwork, then a grid of shaped
 * tiles (cutout or photo + caption), optionally on a wavy-edged background. Every field has a default, so older
 * saved configs keep parsing as fields are added. Web twin: frontend/src/lib/sections.ts.
 */
export const categoryShapesConfig = z.object({
  bg: gradient("#FFE6D0", "#FFE6D0"),
  edge: z.object({
    waveTop: z.boolean().default(false), waveBottom: z.boolean().default(false),
    amp: num(5.1, 0, 20), length: num(40.9, 10, 200), phase: num(19.6, 0, 200),
  }).default({}),
  title: z.object({
    text: z.string().max(80).default(""), align: z.enum(["left", "center"]).default("left"),
    size: num(20, 12, 40), weight: z.number().int().min(400).max(900).default(800), color: hex.default("#221F18"),
    imageUrl: url.default(""), imageHeight: num(40, 16, 120), gap: num(8, 0, 40),
  }).default({}),
  header: z.object({ url: url.default(""), aspect: num(2.4, 0.5, 6) }).default({}),
  columns: z.number().int().min(2).max(4).default(3),
  shape: z.enum(["pentagon", "arch", "rounded", "circle", "apple"]).default("pentagon"),
  tile: z.object({
    from: hex.default("#FE9365"), to: hex.default("#FE9365"),
    strokeColor: hex.default("#F7B17E"), strokeWidth: num(0, 0, 6), aspect: num(1, 0.6, 1.6), radius: num(18, 0, 60),
  }).default({}),
  imageMode: z.enum(["contain", "cover"]).default("contain"),
  imageAlign: z.enum(["center", "bottom"]).default("center"),
  imageScale: num(0.8, 0.4, 1),
  caption: z.object({ color: hex.default("#070000"), size: num(14, 10, 24), weight: z.number().int().min(400).max(900).default(600), lineHeight: num(1.25, 0.9, 1.8) }).default({}),
  layout: z.object({
    sidePad: num(14, 0, 40), gap: num(15, 0, 40), rowGap: num(22, 0, 60),
    captionTop: num(10, 0, 30), topPad: num(13, 0, 80), bottomPad: num(33, 0, 80),
    mode: z.enum(["grid", "scroll"]).default("grid"), tileWidth: num(109, 60, 220),
  }).default({}),
  items: z.array(z.object({
    title: z.string().max(80).default(""),
    image: url.default(""),
    target: z.object({ type: z.enum(["none", "category", "product"]), id: z.string().max(80) })
      .default({ type: "none", id: "" }),
  })).max(24).default([]),
});

/** ARTWORK_BANNER — one full-width picture (heading and art baked in) that can open a category. */
export const artworkBannerConfig = z.object({
  image: z.object({ url: url.default(""), aspect: num(2.4, 0.5, 6) }).default({}),
  target: z.object({ type: z.enum(["none", "category", "product"]), id: z.string().max(80) })
    .default({ type: "none", id: "" }),
});

/**
 * PRODUCT_ROW — an uploaded banner (the section's heading, art baked in) over a sideways row of the app's own
 * product cards, filled live from a Collection or a Category. The optional see-all target shows the small ">" button
 * on the banner's bottom-right corner.
 */
export const productRowConfig = z.object({
  bg: gradient("#FFFFFF", "#FFFFFF"),
  header: z.object({ url: url.default(""), aspect: num(2.23, 0.5, 6) }).default({}),
  target: z.object({ type: z.enum(["none", "category", "product"]), id: z.string().max(80) })
    .default({ type: "none", id: "" }),
  source: z.object({ type: z.enum(["category", "collection"]).default("category"), id: z.string().max(80).default("") }).default({}),
  limit: z.number().int().min(1).max(30).default(10),
  cardWidth: num(132, 100, 220),
  gap: num(10, 0, 40), bottomPad: num(16, 0, 80),
});

const CONFIG_BY_TYPE = {
  CATEGORY_SHAPES: categoryShapesConfig, ARTWORK_BANNER: artworkBannerConfig, PRODUCT_ROW: productRowConfig,
} as const;
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
