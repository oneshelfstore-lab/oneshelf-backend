import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { formatVariantForApp, fromAppFormat, toAppFormat, assertVariantFloors } from "../utils/looseUnitConverter.js";

// Seller-scoped catalog. Mounted at /api/app/seller/catalog. Every query is hard-filtered to the
// caller's own sellerId — a seller can never see or edit another seller's products. New products are
// created INACTIVE (pending admin approval in the Moderation tab). Clone of ownerCatalog, scoped tighter.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

const ProductTypeEnum = z.enum(["PACKAGED", "LOOSE", "PRODUCE", "DAIRY"]);
const PackageUnitEnum = z.enum(["KG", "GRAM", "LITRE", "ML", "PIECE", "PACKET", "BOX", "DOZEN", "BUNDLE"]);

function isLooseType(productType: string): boolean {
  return productType === "LOOSE" || productType === "PRODUCE";
}

// Persist a free-text brand name into the shared Brand table so it shows up in the brand dropdown for
// the seller's next product. The seller editor lets the brand be typed directly, so a brand that's
// never gone through the explicit "add brand" dialog would otherwise never reach the dropdown. Upsert
// by the unique name; best-effort — a brand-bookkeeping failure must never break the product save.
async function ensureBrandPersisted(name?: string | null): Promise<void> {
  const brand = (name ?? "").trim();
  if (!brand) return;
  try {
    await prisma.brand.upsert({
      where: { name: brand },
      update: {},
      create: { name: brand, logoUrl: null },
    });
  } catch (e) {
    console.warn("ensureBrandPersisted (seller) failed — non-fatal:", e);
  }
}

function formatProductForApp(product: any) {
  const isLoose = isLooseType(product.productType);
  return {
    id: product.id,
    handle: product.handle,
    name: product.name,
    nameHi: product.nameHi,
    brand: product.brand,
    categoryId: product.categoryId,
    category: product.category ?? undefined,
    subcategory: product.subcategory,
    productType: product.productType,
    description: product.description,
    hsnCode: product.hsnCode,
    gstRate: product.gstRate != null ? Number(product.gstRate) : null,
    cessRate: product.cessRate != null ? Number(product.cessRate) : 0,
    isPackaged: product.isPackaged,
    isTaxInclusive: product.isTaxInclusive,
    isExempt: product.isExempt,
    isBranded: product.isBranded,
    isSubscribable: product.isSubscribable,
    // Surfaced so the HOUSE manager's editor prefills these correctly on edit (third-party sellers
    // can't change them anyway).
    featuredIn99Store: product.featuredIn99Store,
    isSampleEligible: product.isSampleEligible,
    isBuyOneGetOne: product.isBuyOneGetOne,
    imageUrls: product.imageUrls,
    searchKeywords: product.searchKeywords,
    isActive: product.isActive,
    variants: product.variants?.map((v: any) => {
      const base = formatVariantForApp(v, isLoose);
      // Private merchant fields — exposed ONLY on this seller-scoped serializer (never the customer one)
      // so the editor prefills costPrice/saleFloor on edit and a re-save doesn't wipe them.
      const app = toAppFormat(v, isLoose);
      return { ...base, costPrice: app.costPrice, saleFloor: app.saleFloor };
    }) ?? [],
  };
}

const variantSchema = z.object({
  id: z.string().optional(),
  sku: z.string().min(1).max(50),
  barcode: z.string().max(50).optional().nullable(),
  packageSize: z.number().positive(),
  packageUnit: PackageUnitEnum,
  mrp: z.number().positive(),
  sellingPrice: z.number().positive(),
  costPrice: z.number().min(0).optional().nullable(),
  saleFloor: z.number().min(0).optional().nullable(),
  stock: z.number().min(0),
  lowStockThreshold: z.number().int().min(0).default(5),
  bulkMinQty: z.number().int().min(0).default(0),
  bulkPrice: z.number().positive().optional().nullable(),
  gstRateOverride: z.number().min(0).max(100).optional().nullable(),
});

const productSchema = z.object({
  handle: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Handle must be lowercase with hyphens"),
  name: z.string().min(1).max(200),
  nameHi: z.string().max(200).optional().nullable(),
  brand: z.string().max(100).optional().nullable(),
  categorySlug: z.string().min(1).max(50),
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
  isSubscribable: z.boolean().default(false),
  // Owner-only merchandising toggles — accepted only from the HOUSE manager (stripped for
  // third-party sellers below, so they keep the limited editor).
  isSampleEligible: z.boolean().optional(),
  featuredIn99Store: z.boolean().optional(),
  isBuyOneGetOne: z.boolean().optional(),
  isActive: z.boolean().optional(),
  imageUrls: z.array(z.string()).default([]),
  searchKeywords: z.array(z.string()).default([]),
  variants: z.array(variantSchema).min(1).max(20),
});

// ─── GET / — this seller's products (incl. inactive/pending) ───────
router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const search = ((req.query.search as string) || "").slice(0, 100) || undefined;

    const where: any = { sellerId: req.sellerId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { handle: { contains: search, mode: "insensitive" } },
      ];
    }

    const [products, total] = await Promise.all([
      prisma.catalogProduct.findMany({
        where,
        include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.catalogProduct.count({ where }),
    ]);

    res.json({ success: true, data: products.map(formatProductForApp), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST / — create (forced sellerId + INACTIVE pending approval) ──
router.post("/", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid product data", parsed.error.errors);
    const { variants, categorySlug, isActive, isSampleEligible, featuredIn99Store, isBuyOneGetOne, ...productData } = parsed.data;

    const cat = await prisma.category.findUnique({ where: { slug: categorySlug } });
    if (!cat) throw new ValidationError(`Category '${categorySlug}' not found`);

    // The house manager (the store's own catalog) gets owner-level powers: products go LIVE
    // immediately and the merchandising toggles apply. Third-party sellers stay limited: their
    // products land inactive (pending owner approval) and the merchandising toggles are ignored.
    const isHouse = req.sellerIsHouse === true;
    const merchandising = isHouse
      ? {
          isActive: isActive ?? true,
          isSampleEligible: isSampleEligible ?? false,
          featuredIn99Store: featuredIn99Store ?? false,
          isBuyOneGetOne: isBuyOneGetOne ?? false,
        }
      : { isActive: false };

    let handle = productData.handle;
    if (await prisma.catalogProduct.findUnique({ where: { handle } })) handle = `${handle}-${Date.now().toString(36)}`;

    // Ensure SKUs are unique WITHIN this product AND against existing DB rows. Two sizes of the same
    // brand/category auto-generate the SAME SKU client-side (e.g. "GEN-STA-1PI"), which would trip the
    // unique constraint and fail the whole save. Append the index so same-millisecond suffixes also
    // can't re-collide.
    const dbSkus = new Set(
      (await prisma.productVariant.findMany({ where: { sku: { in: variants.map((v) => v.sku) } }, select: { sku: true } }))
        .map((s) => s.sku)
    );
    const usedSkus = new Set<string>();
    variants.forEach((v, i) => {
      let sku = v.sku;
      if (!sku || dbSkus.has(sku) || usedSkus.has(sku)) sku = `${sku || "SKU"}-${Date.now().toString(36)}${i}`;
      v.sku = sku;
      usedSkus.add(sku);
    });

    const isLoose = isLooseType(productData.productType);
    // Two-number pricing guardrail: block a below-cost selling/sale-floor price (the SELLER's own
    // guardrail, not a platform-set price). The house manager may run loss-leaders → allowBelowCost.
    for (const v of variants) {
      const floorErr = assertVariantFloors(
        { mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: v.costPrice ?? null, saleFloor: v.saleFloor ?? null },
        isHouse,
      );
      if (floorErr) throw new ValidationError(floorErr);
    }
    const convertedVariants = variants.map((v) => {
      const c = fromAppFormat({ mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: v.costPrice, saleFloor: v.saleFloor, stock: v.stock, bulkPrice: v.bulkPrice, packageSize: v.packageSize }, isLoose);
      return {
        sku: v.sku, barcode: v.barcode, packageSize: v.packageSize, packageUnit: v.packageUnit,
        mrp: c.mrp, sellingPrice: c.sellingPrice, costPrice: c.costPrice, saleFloor: c.saleFloor, stock: c.stock,
        lowStockThreshold: v.lowStockThreshold, bulkMinQty: v.bulkMinQty, bulkPrice: c.bulkPrice, gstRateOverride: v.gstRateOverride,
      };
    });

    const product = await prisma.catalogProduct.create({
      data: {
        ...productData,
        handle,
        categoryId: cat.id,
        sellerId: req.sellerId!,
        ...merchandising, // house → live now (+toggles); third-party → inactive pending approval
        variants: { create: convertedVariants },
      },
      include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
    });

    await ensureBrandPersisted(product.brand);

    res.status(201).json({ success: true, data: formatProductForApp(product) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT /:id — update (ownership-checked; can't self-activate) ────
router.put("/:id", async (req: SellerRequest, res: Response) => {
  try {
    const productId = req.params.id as string;
    const existing = await prisma.catalogProduct.findFirst({
      where: { id: productId, sellerId: req.sellerId },
      include: { variants: true },
    });
    if (!existing) throw new NotFoundError("Product", productId);

    const updateSchema = productSchema.partial().omit({ variants: true }).extend({ variants: z.array(variantSchema).optional() });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid product data", parsed.error.errors);
    const { variants: variantUpdates, categorySlug, ...productFields } = parsed.data;

    let categoryId: string | undefined;
    if (categorySlug) {
      const cat = await prisma.category.findUnique({ where: { slug: categorySlug } });
      if (!cat) throw new ValidationError(`Category '${categorySlug}' not found`);
      categoryId = cat.id;
    }

    const isLoose = isLooseType(productFields.productType ?? existing.productType);

    await prisma.$transaction(async (tx) => {
      const updateData: any = { ...productFields };
      if (categoryId) updateData.categoryId = categoryId;
      delete updateData.categorySlug;
      // Third-party sellers can't self-activate or set merchandising flags (owner moderation only).
      // The house manager can — it's the store's own catalog.
      if (req.sellerIsHouse !== true) {
        delete updateData.isActive;
        delete updateData.isSampleEligible;
        delete updateData.featuredIn99Store;
        delete updateData.isBuyOneGetOne;
      }

      if (Object.keys(updateData).length > 0) {
        await tx.catalogProduct.update({ where: { id: productId }, data: updateData });
      }

      if (variantUpdates) {
        const incomingIds = variantUpdates.filter((v: any) => v.id).map((v: any) => v.id!);
        const toRemove = existing.variants.map((v: any) => v.id).filter((id: string) => !incomingIds.includes(id));
        if (toRemove.length > 0) {
          await tx.productVariant.updateMany({ where: { id: { in: toRemove } }, data: { isActive: false } });
        }
        // Make SKUs of NEWLY-ADDED variants unique (vs existing DB rows, kept variants, and each
        // other) so adding a second size can't hit the unique constraint.
        const newOnes = variantUpdates.filter((v: any) => !v.id);
        if (newOnes.length > 0) {
          const dbSkus = new Set(
            (await tx.productVariant.findMany({ where: { sku: { in: newOnes.map((v: any) => v.sku) } }, select: { sku: true } }))
              .map((s) => s.sku)
          );
          const usedSkus = new Set<string>(variantUpdates.filter((v: any) => v.id).map((v: any) => v.sku));
          newOnes.forEach((v: any, i: number) => {
            let sku = v.sku;
            if (!sku || dbSkus.has(sku) || usedSkus.has(sku)) sku = `${sku || "SKU"}-${Date.now().toString(36)}${i}`;
            v.sku = sku;
            usedSkus.add(sku);
          });
        }
        const isHouseUpd = req.sellerIsHouse === true;
        for (const v of variantUpdates) {
          const floorErr = assertVariantFloors(
            { mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: (v as any).costPrice ?? null, saleFloor: (v as any).saleFloor ?? null },
            isHouseUpd,
          );
          if (floorErr) throw new ValidationError(floorErr);
          const c = fromAppFormat({ mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: (v as any).costPrice, saleFloor: (v as any).saleFloor, stock: v.stock, bulkPrice: v.bulkPrice, packageSize: v.packageSize }, isLoose);
          if (v.id) {
            const { id: vid, ...rest } = v;
            await tx.productVariant.update({ where: { id: vid }, data: { ...rest, mrp: c.mrp, sellingPrice: c.sellingPrice, costPrice: c.costPrice, saleFloor: c.saleFloor, stock: c.stock, bulkPrice: c.bulkPrice } });
          } else {
            const { id: _unused, ...rest } = v;
            await tx.productVariant.create({ data: { ...rest, mrp: c.mrp, sellingPrice: c.sellingPrice, costPrice: c.costPrice, saleFloor: c.saleFloor, stock: c.stock, bulkPrice: c.bulkPrice, productId } });
          }
        }
      }
    });

    const updated = await prisma.catalogProduct.findUnique({
      where: { id: productId },
      include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
    });

    await ensureBrandPersisted(updated?.brand);

    res.json({ success: true, data: formatProductForApp(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /:id — soft-delete (ownership-checked) ────────────────
router.delete("/:id", async (req: SellerRequest, res: Response) => {
  try {
    const productId = req.params.id as string;
    const existing = await prisma.catalogProduct.findFirst({ where: { id: productId, sellerId: req.sellerId } });
    if (!existing) throw new NotFoundError("Product", productId);
    await prisma.catalogProduct.update({ where: { id: productId }, data: { isActive: false } });
    res.json({ success: true, message: "Product removed" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PATCH /:id/stock — quick variant stock update (ownership) ────
router.patch("/:id/stock", async (req: SellerRequest, res: Response) => {
  try {
    const productId = req.params.id as string;
    const { variantId, stock } = z.object({ variantId: z.string().min(1), stock: z.number().min(0) }).parse(req.body);

    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId, product: { sellerId: req.sellerId } },
      include: { product: { select: { productType: true } } },
    });
    if (!variant) throw new NotFoundError("Variant", variantId);

    const isLoose = isLooseType(variant.product.productType);
    const c = fromAppFormat({ mrp: Number(variant.mrp), sellingPrice: Number(variant.sellingPrice), stock, bulkPrice: variant.bulkPrice ? Number(variant.bulkPrice) : undefined, packageSize: Number(variant.packageSize) }, isLoose);
    await prisma.productVariant.update({ where: { id: variantId }, data: { stock: c.stock } });
    res.json({ success: true, message: "Stock updated" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /categories — active categories (for the product form) ───
router.get("/categories", async (_req: SellerRequest, res: Response) => {
  try {
    const categories = await prisma.category.findMany({ where: { isActive: true }, orderBy: { displayOrder: "asc" } });
    res.json({ success: true, data: categories });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /categories — create a store category (HOUSE co-manager only) ───
// Categories are store-wide, so only the HOUSE manager (the owner's co-manager) may create one —
// third-party marketplace sellers cannot add global categories. Mirrors ownerCatalog's create
// (upsert by slug); the house manager gets the same "add new category" power as the owner.
router.post("/categories", async (req: SellerRequest, res: Response) => {
  try {
    if (!req.sellerIsHouse) {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Only the store's house manager can create categories", details: [] },
      });
    }
    const parsed = z.object({
      slug: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, "Slug must be lowercase alphanumeric with underscores"),
      name: z.string().min(1).max(100),
      imageUrl: z.string().max(500).optional().nullable(),
      displayOrder: z.number().int().min(0).default(0),
      isActive: z.boolean().default(true),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid category data", parsed.error.errors);

    const category = await prisma.category.upsert({
      where: { slug: parsed.data.slug },
      update: { name: parsed.data.name, imageUrl: parsed.data.imageUrl, displayOrder: parsed.data.displayOrder },
      create: parsed.data,
    });
    res.status(201).json({ success: true, data: category });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
