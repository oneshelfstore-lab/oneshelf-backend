import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";
import { formatVariantForApp } from "../utils/looseUnitConverter.js";

// ─── Shared ──────────────────────────────────────────────────────────

const ProductTypeEnum = z.enum(["PACKAGED", "LOOSE", "PRODUCE", "DAIRY"]);
const PackageUnitEnum = z.enum(["KG", "GRAM", "LITRE", "ML", "PIECE", "PACKET", "BOX", "DOZEN", "BUNDLE"]);

function isLooseType(productType: string): boolean {
  return productType === "LOOSE" || productType === "PRODUCE";
}

export function formatProductForApp(product: any) {
  const isLoose = isLooseType(product.productType);
  return {
    id: product.id,
    handle: product.handle,
    name: product.name,
    nameHi: product.nameHi ?? null,
    brand: product.brand,
    categoryId: product.categoryId,
    category: product.category ?? undefined,
    subcategory: product.subcategory,
    productType: product.productType,
    description: product.description,
    hsnCode: product.hsnCode,
    gstRate: product.gstRate != null ? Number(product.gstRate) : null,
    cessRate: Number(product.cessRate ?? 0),
    isPackaged: product.isPackaged,
    isTaxInclusive: product.isTaxInclusive ?? true,
    isExempt: product.isExempt ?? false,
    isBranded: product.isBranded ?? false,
    isSampleEligible: product.isSampleEligible ?? false,
    featuredIn99Store: product.featuredIn99Store ?? false,
    isSubscribable: product.isSubscribable ?? false,
    imageUrls: product.imageUrls,
    searchKeywords: product.searchKeywords,
    isActive: product.isActive,
    // Marketplace (Phase 6): who sells this. Null for legacy products with no seller link; the
    // app shows "Sold by <name>" only for non-house sellers (the house store sells directly).
    seller: product.seller
      ? { id: product.seller.id, name: product.seller.name, isHouse: product.seller.isHouse }
      : null,
    variants: product.variants?.map((v: any) => formatVariantForApp(v, isLoose)) ?? [],
  };
}

// Reusable include for the seller chip on customer-facing product reads.
const SELLER_SELECT = { select: { id: true, name: true, isHouse: true } } as const;

// ═══════════════════════════════════════════════════════════════════════
// Public router (no auth, mounted at /api/app/products)
// ═══════════════════════════════════════════════════════════════════════

export const publicCatalogRouter = Router();

const browseSchema = z.object({
  q: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/app/products
publicCatalogRouter.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = browseSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query", parsed.error.errors);
    const { q, category, page, limit } = parsed.data;

    const where: any = { isActive: true };

    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        { searchKeywords: { has: q.toLowerCase() } },
      ];
    }

    if (category) {
      // Accept either the category slug or its id (the app sometimes navigates by id).
      where.category = { OR: [{ slug: category }, { id: category }] };
    }

    const [products, total] = await Promise.all([
      prisma.catalogProduct.findMany({
        where,
        include: {
          variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
          category: { select: { slug: true, name: true } },
          seller: SELLER_SELECT,
        },
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.catalogProduct.count({ where }),
    ]);

    res.json({
      success: true,
      data: products.map(formatProductForApp),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Autocomplete suggestions (slim, with thumbnail) ────────────────
// MUST be declared before "/:id" so "suggest"/"trending" aren't treated as ids.

const suggestSelect = {
  id: true,
  name: true,
  brand: true,
  imageUrls: true,
  variants: {
    where: { isActive: true },
    orderBy: { sellingPrice: "asc" as const },
    take: 1,
    select: { sellingPrice: true, stock: true },
  },
};

function toSuggestion(p: any) {
  const v = p.variants?.[0];
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    imageUrl: p.imageUrls?.[0] ?? null,
    price: v ? Number(v.sellingPrice) : null,
    inStock: v ? Number(v.stock) > 0 : false,
  };
}

// GET /api/app/products/suggest?q=
publicCatalogRouter.get("/suggest", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 100);
    if (q.length < 1) return res.json({ success: true, data: [] });

    // Primary: fast substring/keyword match.
    const products: any[] = await prisma.catalogProduct.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { brand: { contains: q, mode: "insensitive" } },
          { searchKeywords: { has: q.toLowerCase() } },
        ],
      },
      select: suggestSelect,
      orderBy: { name: "asc" },
      take: 8,
    });

    // Typo tolerance: if few hits, try trigram similarity (pg_trgm). Guarded —
    // if the extension isn't installed, this silently falls back to the above.
    if (products.length < 3) {
      try {
        const rows = await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "CatalogProduct"
          WHERE "isActive" = true AND similarity(name, ${q}) > 0.2
          ORDER BY similarity(name, ${q}) DESC
          LIMIT 8`;
        const known = new Set(products.map((p) => p.id));
        const missingIds = rows.map((r) => r.id).filter((id) => !known.has(id));
        if (missingIds.length > 0) {
          const fuzzy = await prisma.catalogProduct.findMany({
            where: { id: { in: missingIds }, isActive: true },
            select: suggestSelect,
          });
          products.push(...fuzzy);
        }
      } catch {
        /* pg_trgm not available — ignore, keep substring matches */
      }
    }

    res.json({ success: true, data: products.slice(0, 8).map(toSuggestion) });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/products/trending — best-sellers (by ordered quantity), shown when
// the search box is empty. Derived from existing order data; no extra tracking.
publicCatalogRouter.get("/trending", async (_req: Request, res: Response) => {
  try {
    const grouped = await prisma.orderItem.groupBy({
      by: ["variantId"],
      _sum: { quantity: true },
      where: { variantId: { not: null } },
      orderBy: { _sum: { quantity: "desc" } },
      take: 20,
    });
    const variantIds = grouped.map((g) => g.variantId).filter((v): v is string => !!v);
    if (variantIds.length === 0) return res.json({ success: true, data: [] });

    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds }, isActive: true },
      select: { productId: true },
    });
    const productIds = [...new Set(variants.map((v) => v.productId))].slice(0, 10);

    const products = await prisma.catalogProduct.findMany({
      where: { id: { in: productIds }, isActive: true },
      select: suggestSelect,
    });
    res.json({ success: true, data: products.map(toSuggestion) });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/products/trending-products — full products most ordered in the last 7 days,
// each with its weekly ordered-quantity count. Powers the Home "Trending this week" rail.
// Real order data only; in-stock products; the client shows the count chip only above a floor.
publicCatalogRouter.get("/trending-products", async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const grouped = await prisma.orderItem.groupBy({
      by: ["variantId"],
      _sum: { quantity: true },
      where: {
        variantId: { not: null },
        order: { createdAt: { gte: since }, status: { not: "CANCELLED" } },
      },
      orderBy: { _sum: { quantity: "desc" } },
      take: 50,
    });
    const variantIds = grouped.map((g) => g.variantId).filter((v): v is string => !!v);
    if (variantIds.length === 0) return res.json({ success: true, data: [] });

    // Roll weekly quantity up from variants to their parent products.
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds }, isActive: true },
      select: { id: true, productId: true },
    });
    const qtyByVariant = new Map(grouped.map((g) => [g.variantId!, Number(g._sum.quantity ?? 0)]));
    const qtyByProduct = new Map<string, number>();
    for (const v of variants) {
      qtyByProduct.set(v.productId, (qtyByProduct.get(v.productId) ?? 0) + (qtyByVariant.get(v.id) ?? 0));
    }
    const topProductIds = [...qtyByProduct.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);
    if (topProductIds.length === 0) return res.json({ success: true, data: [] });

    const products = await prisma.catalogProduct.findMany({
      where: { id: { in: topProductIds }, isActive: true },
      include: {
        variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
        category: { select: { slug: true, name: true } },
        seller: SELLER_SELECT,
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    // Preserve the most-ordered ordering, keep only in-stock products, attach the count.
    const data = topProductIds
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p && p.variants.some((v: any) => Number(v.stock) > 0))
      .map((p) => ({ product: formatProductForApp(p), count: qtyByProduct.get(p.id) ?? 0 }));
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/products/deal-today — one deterministic "today's pick" per day. Picked from products
// that ALREADY have a real discount (mrp > sellingPrice) — no fabricated pricing. Stable within the
// IST day, changes daily. Returns null when nothing is genuinely discounted.
publicCatalogRouter.get("/deal-today", async (_req: Request, res: Response) => {
  try {
    const products = await prisma.catalogProduct.findMany({
      where: { isActive: true, variants: { some: { isActive: true, stock: { gt: 0 } } } },
      include: {
        variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
        category: { select: { slug: true, name: true } },
        seller: SELLER_SELECT,
      },
    });

    const pool = products
      .map((p) => {
        let best = 0;
        for (const v of p.variants) {
          const mrp = Number(v.mrp), sp = Number(v.sellingPrice);
          if (mrp > sp && mrp > 0 && Number(v.stock) > 0) {
            best = Math.max(best, Math.round(((mrp - sp) / mrp) * 100));
          }
        }
        return { p, discountPct: best };
      })
      .filter((x) => x.discountPct > 0)
      .sort((a, b) => a.p.id.localeCompare(b.p.id)); // stable ordering for a stable daily pick

    if (pool.length === 0) return res.json({ success: true, data: null });

    // Deterministic by IST calendar date so it matches the customer's "today" and rotates daily.
    const istDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    let h = 0;
    for (let i = 0; i < istDate.length; i++) h = (h * 31 + istDate.charCodeAt(i)) >>> 0;
    const chosen = pool[h % pool.length]!;

    res.json({ success: true, data: { product: formatProductForApp(chosen.p), discountPct: chosen.discountPct } });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/products/under-99 — the "99 Store": products the owner flagged (featuredIn99Store)
// AND actually priced ₹99 or less (a cheapest active, in-stock variant ≤ 99), so the "everything
// under ₹99" promise stays true even if a flagged item is later repriced. In-stock only. Declared
// before "/:id" so the literal path isn't swallowed as a product id.
publicCatalogRouter.get("/under-99", async (_req: Request, res: Response) => {
  try {
    const products = await prisma.catalogProduct.findMany({
      where: {
        isActive: true,
        featuredIn99Store: true,
        variants: { some: { isActive: true, stock: { gt: 0 }, sellingPrice: { lte: 99 } } },
      },
      include: {
        variants: { where: { isActive: true }, orderBy: { sellingPrice: "asc" } },
        category: { select: { slug: true, name: true } },
        seller: SELLER_SELECT,
      },
      orderBy: { name: "asc" },
      take: 30,
    });
    res.json({ success: true, data: products.map(formatProductForApp) });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/products/stock-check — batch stock check for cart items.
// Returns current stock for each variant and alternatives for OOS items.
publicCatalogRouter.post("/stock-check", async (req: Request, res: Response) => {
  try {
    const { variantIds } = req.body;
    if (!Array.isArray(variantIds) || variantIds.length === 0) {
      throw new ValidationError("variantIds must be a non-empty array");
    }
    if (variantIds.length > 50) {
      throw new ValidationError("Maximum 50 variant IDs per check");
    }

    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        stock: true,
        productId: true,
        product: {
          select: { id: true, name: true, categoryId: true, isActive: true },
        },
      },
    });

    const variantMap = new Map(variants.map((v) => [v.id, v]));

    // Collect OOS product IDs → category IDs for batch alternatives fetch.
    const oosProducts = new Map<string, string>(); // productId → categoryId
    for (const v of variants) {
      if (Number(v.stock) <= 0 && v.product.isActive) {
        oosProducts.set(v.product.id, v.product.categoryId);
      }
    }

    // Batch-fetch alternatives for all OOS products at once (by category).
    const altsByProduct = new Map<string, any[]>();
    if (oosProducts.size > 0) {
      const categoryIds = [...new Set(oosProducts.values())];
      const altCandidates = await prisma.catalogProduct.findMany({
        where: {
          categoryId: { in: categoryIds },
          isActive: true,
          id: { notIn: [...oosProducts.keys()] },
          variants: { some: { isActive: true, stock: { gt: 0 } } },
        },
        include: {
          variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
          category: { select: { slug: true, name: true } },
          seller: SELLER_SELECT,
        },
        orderBy: { name: "asc" },
        take: 30, // cap total, we'll slice per product
      });

      // Group by categoryId then map to productId.
      const byCat = new Map<string, any[]>();
      for (const p of altCandidates) {
        const list = byCat.get(p.categoryId) ?? [];
        list.push(p);
        byCat.set(p.categoryId, list);
      }
      for (const [prodId, catId] of oosProducts) {
        altsByProduct.set(prodId, (byCat.get(catId) ?? []).slice(0, 6));
      }
    }

    const items = variantIds.map((vid: string) => {
      const v = variantMap.get(vid);
      if (!v) return { variantId: vid, found: false, stock: 0, productId: null, productName: null, alternatives: [] };
      const stock = Number(v.stock);
      const alts = stock <= 0 ? (altsByProduct.get(v.product.id) ?? []) : [];
      return {
        variantId: v.id,
        found: true,
        stock,
        productId: v.product.id,
        productName: v.product.name,
        alternatives: alts.map(formatProductForApp),
      };
    });

    res.json({ success: true, data: items });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/products/:id/alternatives — in-stock products from the same category.
// Used on the PDP when the viewed product is out of stock (OOS substitution).
publicCatalogRouter.get("/:id/alternatives", async (req: Request, res: Response) => {
  try {
    const product = await prisma.catalogProduct.findUnique({
      where: { id: req.params.id },
      select: { id: true, categoryId: true, isActive: true },
    });
    if (!product || !product.isActive) {
      throw new NotFoundError("Product", req.params.id!);
    }

    const alternatives = await prisma.catalogProduct.findMany({
      where: {
        categoryId: product.categoryId,
        isActive: true,
        id: { not: product.id },
        variants: { some: { isActive: true, stock: { gt: 0 } } },
      },
      include: {
        variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
        category: { select: { slug: true, name: true } },
        seller: SELLER_SELECT,
      },
      orderBy: { name: "asc" },
      take: 6,
    });

    res.json({ success: true, data: alternatives.map(formatProductForApp) });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/products/:id
publicCatalogRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const product = await prisma.catalogProduct.findUnique({
      where: { id: req.params.id },
      include: {
        variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
        category: { select: { slug: true, name: true } },
        seller: SELLER_SELECT,
      },
    });

    if (!product || !product.isActive) {
      throw new NotFoundError("Product", req.params.id!);
    }

    res.json({ success: true, data: formatProductForApp(product) });
  } catch (e) {
    sendError(res, e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Admin router (JWT auth, mounted at /api/catalog behind authMiddleware)
// ═══════════════════════════════════════════════════════════════════════

export const adminCatalogRouter = Router();

const variantCreateSchema = z.object({
  sku: z.string().min(1).max(50),
  barcode: z.string().max(50).optional().nullable(),
  packageSize: z.number().positive(),
  packageUnit: PackageUnitEnum,
  mrp: z.number().positive(),
  sellingPrice: z.number().positive(),
  costPrice: z.number().min(0).optional().nullable(),
  stock: z.number().min(0),
  lowStockThreshold: z.number().int().min(0).default(5),
  bulkMinQty: z.number().int().min(0).default(0),
  bulkPrice: z.number().positive().optional().nullable(),
  gstRateOverride: z.number().min(0).max(100).optional().nullable(),
});

const productCreateSchema = z.object({
  handle: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Handle must be lowercase with hyphens"),
  name: z.string().min(1).max(200),
  brand: z.string().max(100).optional().nullable(),
  categoryId: z.string().min(1),
  subcategory: z.string().max(100).optional().nullable(),
  productType: ProductTypeEnum,
  description: z.string().max(1000).optional().nullable(),
  hsnCode: z.string().min(4).max(8).optional().nullable(),
  gstRate: z.number().min(0).max(100).optional().nullable(),
  cessRate: z.number().min(0).max(100).default(0),
  isPackaged: z.boolean().default(true),
  isTaxInclusive: z.boolean().default(true),
  isExempt: z.boolean().default(false),
  isBranded: z.boolean().default(false),
  imageUrls: z.array(z.string()).default([]),
  searchKeywords: z.array(z.string()).default([]),
  variants: z.array(variantCreateSchema).min(1).max(20),
});

// GET /api/catalog — list all (including inactive)
adminCatalogRouter.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const search = ((req.query.search as string) || "").slice(0, 100) || undefined;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { handle: { contains: search, mode: "insensitive" } },
        { brand: { contains: search, mode: "insensitive" } },
      ];
    }

    const [products, total] = await Promise.all([
      prisma.catalogProduct.findMany({
        where,
        include: {
          variants: { orderBy: { packageSize: "asc" } },
          category: { select: { slug: true, name: true } },
        },
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.catalogProduct.count({ where }),
    ]);

    res.json({
      success: true,
      data: products,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/catalog — create product + variants
adminCatalogRouter.post("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = productCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid product data", parsed.error.errors);
    const { variants, ...productData } = parsed.data;

    const cat = await prisma.category.findUnique({ where: { id: productData.categoryId } });
    if (!cat) throw new ValidationError(`Category '${productData.categoryId}' not found`);

    const existing = await prisma.catalogProduct.findUnique({ where: { handle: productData.handle } });
    if (existing) throw new ConflictError(`Product handle '${productData.handle}' already exists`);

    const skus = variants.map(v => v.sku);
    const existingSkus = await prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { sku: true } });
    if (existingSkus.length > 0) throw new ConflictError(`SKUs already exist: ${existingSkus.map(s => s.sku).join(", ")}`);

    for (const v of variants) {
      if (v.sellingPrice > v.mrp) throw new ValidationError(`Variant ${v.sku}: sellingPrice cannot exceed MRP`);
      if (v.bulkPrice && v.bulkMinQty > 0 && v.bulkPrice >= v.sellingPrice) throw new ValidationError(`Variant ${v.sku}: bulkPrice must be < sellingPrice`);
    }

    const product = await prisma.catalogProduct.create({
      data: { ...productData, variants: { create: variants } },
      include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
    });

    res.status(201).json({ success: true, data: product });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /api/catalog/:id — update product + upsert variants
adminCatalogRouter.put("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.catalogProduct.findUnique({ where: { id: req.params.id }, include: { variants: true } });
    if (!existing) throw new NotFoundError("Product", req.params.id!);

    const updateSchema = productCreateSchema.partial().omit({ variants: true }).extend({
      variants: z.array(variantCreateSchema.extend({ id: z.string().optional() })).optional(),
    });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid product data", parsed.error.errors);
    const { variants: variantUpdates, ...productData } = parsed.data;

    if (productData.handle && productData.handle !== existing.handle) {
      const dup = await prisma.catalogProduct.findUnique({ where: { handle: productData.handle } });
      if (dup) throw new ConflictError(`Product handle '${productData.handle}' already exists`);
    }

    if (productData.categoryId) {
      const cat = await prisma.category.findUnique({ where: { id: productData.categoryId } });
      if (!cat) throw new ValidationError(`Category '${productData.categoryId}' not found`);
    }

    await prisma.$transaction(async (tx) => {
      if (Object.keys(productData).length > 0) {
        await tx.catalogProduct.update({ where: { id: req.params.id }, data: productData });
      }

      if (variantUpdates) {
        const incomingIds = variantUpdates.filter(v => v.id).map(v => v.id!);
        const toRemove = existing.variants.map(v => v.id).filter(id => !incomingIds.includes(id));
        if (toRemove.length > 0) {
          await tx.productVariant.updateMany({ where: { id: { in: toRemove } }, data: { isActive: false } });
        }

        for (const v of variantUpdates) {
          if (v.sellingPrice > v.mrp) throw new ValidationError(`Variant ${v.sku}: sellingPrice cannot exceed MRP`);
          if (v.id) {
            const { id: vid, ...data } = v;
            await tx.productVariant.update({ where: { id: vid }, data });
          } else {
            const { id: _unused, ...data } = v;
            await tx.productVariant.create({ data: { ...data, productId: req.params.id! } });
          }
        }
      }
    });

    const updated = await prisma.catalogProduct.findUnique({
      where: { id: req.params.id },
      include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
    });

    res.json({ success: true, data: updated });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /api/catalog/:id — soft-delete
adminCatalogRouter.delete("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.catalogProduct.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Product", req.params.id!);

    await prisma.catalogProduct.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ success: true, message: "Product deactivated" });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/catalog/import-csv — CSV import with dry-run
const csvProductRow = z.object({
  product_handle: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  brand: z.string().max(100).optional().nullable().default(null),
  category_slug: z.string().min(1).max(50),
  subcategory: z.string().max(100).optional().nullable().default(null),
  product_type: ProductTypeEnum,
  description: z.string().max(1000).optional().nullable().default(null),
  hsn_code: z.string().min(4).max(8).optional().nullable().default(null),
  gst_rate: z.coerce.number().min(0).max(100).optional().nullable().default(null),
  cess_rate: z.coerce.number().min(0).max(100).default(0),
  is_packaged: z.preprocess((v) => v === "TRUE" || v === true, z.boolean()),
  is_tax_inclusive: z.preprocess((v) => v !== "FALSE" && v !== false, z.boolean()).default(true),
  is_exempt: z.preprocess((v) => v === "TRUE" || v === true, z.boolean()).default(false),
  is_branded: z.preprocess((v) => v === "TRUE" || v === true, z.boolean()).default(false),
  image_urls: z.string().optional().nullable().default(null),
  search_keywords: z.string().optional().nullable().default(null),
  product_active: z.preprocess((v) => v !== "FALSE" && v !== false, z.boolean()).default(true),
  variant_sku: z.string().min(1).max(50),
  barcode: z.string().max(50).optional().nullable().default(null),
  package_size: z.coerce.number().positive(),
  package_unit: PackageUnitEnum,
  mrp: z.coerce.number().positive(),
  selling_price: z.coerce.number().positive(),
  cost_price: z.coerce.number().min(0).optional().nullable().default(null),
  stock: z.coerce.number().min(0),
  low_stock_threshold: z.coerce.number().int().min(0).default(5),
  bulk_min_qty: z.coerce.number().int().min(0).default(0),
  bulk_price: z.coerce.number().min(0).optional().nullable().default(null),
  variant_active: z.preprocess((v) => v !== "FALSE" && v !== false, z.boolean()).default(true),
  gst_rate_override: z.coerce.number().min(0).max(100).optional().nullable().default(null),
});

adminCatalogRouter.post("/import-csv", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const { rows } = req.body;
    // Coerce dryRun explicitly: default true (safe), and only false when the client
    // sends a real boolean false or the string "false" — avoids a stray truthy/odd
    // value silently committing or a "false" string blocking a real import.
    const dryRun = !(req.body.dryRun === false || req.body.dryRun === "false");
    if (!Array.isArray(rows) || rows.length === 0) throw new ValidationError("Body must contain a non-empty 'rows' array");
    if (rows.length > 2000) throw new ValidationError("Maximum 2000 rows per import");

    const rowErrors: { row: number; errors: string[] }[] = [];
    const validRows: (z.infer<typeof csvProductRow> & { _row: number })[] = [];

    for (let i = 0; i < rows.length; i++) {
      const parsed = csvProductRow.safeParse(rows[i]);
      if (!parsed.success) {
        rowErrors.push({ row: i + 1, errors: parsed.error.errors.map(e => `${e.path.join(".")}: ${e.message}`) });
      } else {
        const errs: string[] = [];
        if (parsed.data.selling_price > parsed.data.mrp) errs.push("selling_price cannot exceed mrp");
        if (parsed.data.bulk_price && parsed.data.bulk_min_qty > 0 && parsed.data.bulk_price >= parsed.data.selling_price) errs.push("bulk_price must be < selling_price");
        if (errs.length > 0) {
          rowErrors.push({ row: i + 1, errors: errs });
        } else {
          validRows.push({ ...parsed.data, _row: i + 1 });
        }
      }
    }

    // Validate categories
    const categorySlugs = [...new Set(validRows.map(r => r.category_slug))];
    const existingCats = await prisma.category.findMany({ where: { slug: { in: categorySlugs } }, select: { id: true, slug: true } });
    const catMap = new Map(existingCats.map(c => [c.slug, c.id]));
    for (const r of validRows) {
      if (!catMap.has(r.category_slug)) rowErrors.push({ row: r._row, errors: [`Category '${r.category_slug}' not found`] });
    }

    // Validate HSN codes
    const hsnCodes = [...new Set(validRows.filter(r => r.hsn_code).map(r => r.hsn_code!))];
    if (hsnCodes.length > 0) {
      const existingHsn = await prisma.hsnMaster.findMany({ where: { code: { in: hsnCodes } }, select: { code: true } });
      const hsnSet = new Set(existingHsn.map(h => h.code));
      for (const r of validRows) {
        if (r.hsn_code && !hsnSet.has(r.hsn_code)) rowErrors.push({ row: r._row, errors: [`HSN '${r.hsn_code}' not found in master`] });
      }
    }

    // Check SKU uniqueness
    const allSkus = validRows.map(r => r.variant_sku);
    const dupSkus = allSkus.filter((s, i) => allSkus.indexOf(s) !== i);
    if (dupSkus.length > 0) {
      const dupSet = new Set(dupSkus);
      for (const r of validRows) {
        if (dupSet.has(r.variant_sku)) rowErrors.push({ row: r._row, errors: [`Duplicate SKU '${r.variant_sku}' in file`] });
      }
    }
    const existingSkus = await prisma.productVariant.findMany({ where: { sku: { in: allSkus } }, select: { sku: true } });
    if (existingSkus.length > 0) {
      const existSet = new Set(existingSkus.map(s => s.sku));
      for (const r of validRows) {
        if (existSet.has(r.variant_sku)) rowErrors.push({ row: r._row, errors: [`SKU '${r.variant_sku}' already in DB`] });
      }
    }

    const errorRowNums = new Set(rowErrors.map(e => e.row));
    const importableRows = validRows.filter(r => !errorRowNums.has(r._row));

    const summary = { totalRows: rows.length, validRows: importableRows.length, errorRows: rowErrors.length, errors: rowErrors, dryRun };

    if (dryRun || importableRows.length === 0) {
      return res.json({ success: true, data: summary });
    }

    // Group by handle and import
    const grouped = new Map<string, typeof importableRows>();
    for (const r of importableRows) {
      const g = grouped.get(r.product_handle) ?? [];
      g.push(r);
      grouped.set(r.product_handle, g);
    }

    let productsCreated = 0;
    let variantsCreated = 0;

    await prisma.$transaction(async (tx) => {
      for (const [handle, groupRows] of grouped) {
        const first = groupRows[0]!;
        const catId = catMap.get(first.category_slug)!;

        const productData = {
          name: first.name, brand: first.brand, categoryId: catId,
          subcategory: first.subcategory, productType: first.product_type,
          description: first.description, hsnCode: first.hsn_code, gstRate: first.gst_rate,
          cessRate: first.cess_rate ?? 0,
          isPackaged: first.is_packaged,
          isTaxInclusive: first.is_tax_inclusive ?? true,
          isExempt: first.is_exempt ?? false,
          isBranded: first.is_branded ?? false,
          imageUrls: first.image_urls ? first.image_urls.split("|").map((u: string) => u.trim()) : [],
          searchKeywords: first.search_keywords ? first.search_keywords.split("|").map((k: string) => k.trim().toLowerCase()) : [],
          isActive: first.product_active,
        };
        const product = await tx.catalogProduct.upsert({
          where: { handle },
          update: productData,
          create: { handle, ...productData },
        });
        productsCreated++;

        for (const r of groupRows) {
          await tx.productVariant.create({
            data: {
              productId: product.id, sku: r.variant_sku, barcode: r.barcode,
              packageSize: r.package_size, packageUnit: r.package_unit,
              mrp: r.mrp, sellingPrice: r.selling_price, costPrice: r.cost_price,
              stock: r.stock,
              lowStockThreshold: r.low_stock_threshold, bulkMinQty: r.bulk_min_qty,
              bulkPrice: r.bulk_price, gstRateOverride: r.gst_rate_override, isActive: r.variant_active,
            },
          });
          variantsCreated++;
        }
      }
    });

    res.json({ success: true, data: { ...summary, productsCreated, variantsCreated } });
  } catch (e) {
    sendError(res, e);
  }
});
