import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";
import { cacheControl, memoCache, PUBLIC_TTL_MS, PUBLIC_TTL_SECONDS } from "../lib/httpCache.js";
import { formatProductForApp, SELLER_SELECT, SELLER_TRADING } from "./catalog.js";
import {
  buildCollectionWhere, collectionBodySchema, inWindow, liveCollectionWhere, rulesSchema, slugify, KINDS, MODES,
} from "../services/collections.js";

// What a customer may see in any listing (same rule as the catalog browse + recommendations).
export const VISIBLE = { isActive: true, approvalStatus: "APPROVED", deletedAt: null, ...SELLER_TRADING } as const;

/** Resolved membership `where` for a stored collection (loads its pins/excludes and the category tree). */
export async function whereFor(c: { id: string; mode: string; rules: unknown }) {
  const [links, tree] = await Promise.all([
    prisma.collectionProduct.findMany({ where: { collectionId: c.id }, select: { productId: true, mode: true } }),
    c.mode === "SMART" ? prisma.category.findMany({ select: { id: true, parentId: true } }) : Promise.resolve([]),
  ]);
  return buildCollectionWhere(
    c,
    links.filter((l) => l.mode === "PIN").map((l) => l.productId),
    links.filter((l) => l.mode === "EXCLUDE").map((l) => l.productId),
    tree,
  );
}

// ─── Public router (no auth, mounted at /api/app/collections) ───────

export const publicCollectionRouter = Router();

// GET /?showOn=HOME&kind=OCCASION — live collections that actually have products, in display order.
publicCollectionRouter.get("/", cacheControl(PUBLIC_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const q = z.object({ showOn: z.enum(["HOME", "CATEGORIES"]).optional(), kind: z.enum(KINDS).optional() }).safeParse(req.query);
    if (!q.success) throw new ValidationError("Invalid query", q.error.errors);
    const { showOn, kind } = q.data;
    const data = await memoCache.get(`collections:list:${showOn ?? "all"}:${kind ?? "all"}`, PUBLIC_TTL_MS, async () => {
      const cols = await prisma.collection.findMany({
        where: { ...liveCollectionWhere(), ...(showOn && { showOn: { has: showOn } }), ...(kind && { kind }) },
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        take: 50,
      });
      const withCounts = await Promise.all(cols.map(async (c) => ({
        c, count: await prisma.catalogProduct.count({ where: { AND: [VISIBLE, await whereFor(c)] } }),
      })));
      return withCounts.filter((x) => x.count > 0).map(({ c, count }) => ({
        id: c.id, slug: c.slug, name: c.name, nameHi: c.nameHi, description: c.description, imageUrl: c.imageUrl,
        kind: c.kind, showOn: c.showOn, displayOrder: c.displayOrder, productCount: count,
      }));
    });
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /:slug/products?page&limit — { collection, products } for one live collection.
publicCollectionRouter.get("/:slug/products", cacheControl(30), async (req: Request, res: Response) => {
  try {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(30) }).safeParse(req.query);
    if (!q.success) throw new ValidationError("Invalid query", q.error.errors);
    const { page, limit } = q.data;
    const slug = String(req.params.slug);
    const c = await prisma.collection.findFirst({ where: { slug, ...liveCollectionWhere() } });
    if (!c) throw new NotFoundError("Collection", slug);

    const where = { AND: [VISIBLE, await whereFor(c)] };
    const [products, total] = await Promise.all([
      prisma.catalogProduct.findMany({
        where,
        include: {
          variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
          category: { select: { slug: true, name: true } },
          seller: SELLER_SELECT,
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.catalogProduct.count({ where }),
    ]);
    res.json({
      success: true,
      data: {
        collection: { id: c.id, slug: c.slug, name: c.name, nameHi: c.nameHi, description: c.description, imageUrl: c.imageUrl, kind: c.kind },
        products: products.map(formatProductForApp),
        total,
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Admin router (JWT auth, mounted at /api/collections) ───────────

export const adminCollectionRouter = Router();
const bust = () => memoCache.bust("collections");

adminCollectionRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const cols = await prisma.collection.findMany({
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { products: true } } },
      take: 200,
    });
    // Live product count per collection (what a customer would see now), computed with the same resolver.
    const data = await Promise.all(cols.map(async (c) => ({
      ...c,
      productCount: await prisma.catalogProduct.count({ where: { AND: [VISIBLE, await whereFor(c)] } }),
      live: c.isActive && inWindow(c),
    })));
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

adminCollectionRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const c = await prisma.collection.findUnique({
      where: { id: String(req.params.id) },
      include: { products: { include: { product: { select: { id: true, name: true, brand: true, imageUrls: true } } } } },
    });
    if (!c) throw new NotFoundError("Collection", String(req.params.id));
    const { products, ...rest } = c;
    res.json({
      success: true,
      data: {
        ...rest,
        pins: products.filter((l) => l.mode === "PIN").map((l) => l.product),
        excludes: products.filter((l) => l.mode === "EXCLUDE").map((l) => l.product),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

async function uniqueSlug(base: string): Promise<string> {
  for (let i = 0; ; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await prisma.collection.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
}

adminCollectionRouter.post("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = collectionBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid collection", parsed.error.errors);
    const { slug, rules, ...rest } = parsed.data;
    if (slug && (await prisma.collection.findUnique({ where: { slug }, select: { id: true } }))) {
      throw new ConflictError(`Collection slug '${slug}' already exists`);
    }
    const c = await prisma.collection.create({
      data: { ...rest, slug: slug ?? (await uniqueSlug(slugify(rest.name))), rules: rules ?? undefined },
    });
    bust();
    res.status(201).json({ success: true, data: c });
  } catch (e) {
    sendError(res, e);
  }
});

adminCollectionRouter.put("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.collection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Collection", id);
    const parsed = collectionBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid collection", parsed.error.errors);
    const { slug, rules, ...rest } = parsed.data;
    if (slug && slug !== existing.slug && (await prisma.collection.findUnique({ where: { slug }, select: { id: true } }))) {
      throw new ConflictError(`Collection slug '${slug}' already exists`);
    }
    const c = await prisma.collection.update({
      where: { id },
      // Rules left over from a SMART→MANUAL switch are harmless (ignored while mode is MANUAL), so no clearing here.
      data: { ...rest, ...(slug && { slug }), rules: rules ?? undefined },
    });
    bust();
    res.json({ success: true, data: c });
  } catch (e) {
    sendError(res, e);
  }
});

adminCollectionRouter.delete("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!(await prisma.collection.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError("Collection", id);
    await prisma.collection.delete({ where: { id } }); // pins/excludes cascade
    bust();
    res.json({ success: true, message: "Collection deleted" });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /:id/products { pins, excludes } — replace the manual pin and exclude lists.
adminCollectionRouter.put("/:id/products", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const parsed = z.object({
      pins: z.array(z.string().min(1)).max(500).default([]),
      excludes: z.array(z.string().min(1)).max(500).default([]),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid product lists", parsed.error.errors);
    if (!(await prisma.collection.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError("Collection", id);
    const excludes = new Set(parsed.data.excludes);
    const pins = [...new Set(parsed.data.pins)].filter((p) => !excludes.has(p)); // a product can't be both
    const known = new Set((await prisma.catalogProduct.findMany({ where: { id: { in: [...pins, ...excludes] } }, select: { id: true } })).map((p) => p.id));
    await prisma.$transaction([
      prisma.collectionProduct.deleteMany({ where: { collectionId: id } }),
      prisma.collectionProduct.createMany({
        data: [
          ...pins.filter((p) => known.has(p)).map((productId) => ({ collectionId: id, productId, mode: "PIN" })),
          ...[...excludes].filter((p) => known.has(p)).map((productId) => ({ collectionId: id, productId, mode: "EXCLUDE" })),
        ],
      }),
    ]);
    bust();
    res.json({ success: true, message: "Saved" });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /preview { mode, rules, pins, excludes } — live count + a few products for the wizard, without saving.
adminCollectionRouter.post("/preview", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = z.object({
      mode: z.enum(MODES),
      rules: rulesSchema.optional().nullable(),
      pins: z.array(z.string()).max(500).default([]),
      excludes: z.array(z.string()).max(500).default([]),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid preview", parsed.error.errors);
    const { mode, rules, pins, excludes } = parsed.data;
    const tree = mode === "SMART" ? await prisma.category.findMany({ select: { id: true, parentId: true } }) : [];
    const where = { AND: [VISIBLE, buildCollectionWhere({ mode, rules }, pins, excludes, tree)] };
    const [count, sample] = await Promise.all([
      prisma.catalogProduct.count({ where }),
      prisma.catalogProduct.findMany({ where, select: { id: true, name: true, brand: true, imageUrls: true }, orderBy: { name: "asc" }, take: 8 }),
    ]);
    res.json({ success: true, data: { count, sample } });
  } catch (e) {
    sendError(res, e);
  }
});
