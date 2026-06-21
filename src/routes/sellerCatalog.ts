import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { formatVariantForApp, fromAppFormat } from "../utils/looseUnitConverter.js";

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
    imageUrls: product.imageUrls,
    searchKeywords: product.searchKeywords,
    isActive: product.isActive,
    variants: product.variants?.map((v: any) => formatVariantForApp(v, isLoose)) ?? [],
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
    const { variants, categorySlug, ...productData } = parsed.data;

    const cat = await prisma.category.findUnique({ where: { slug: categorySlug } });
    if (!cat) throw new ValidationError(`Category '${categorySlug}' not found`);

    let handle = productData.handle;
    if (await prisma.catalogProduct.findUnique({ where: { handle } })) handle = `${handle}-${Date.now().toString(36)}`;

    const skus = variants.map((v) => v.sku);
    const existingSkus = await prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { sku: true } });
    if (existingSkus.length > 0) {
      const existSet = new Set(existingSkus.map((s) => s.sku));
      variants.forEach((v) => { if (existSet.has(v.sku)) v.sku = `${v.sku}-${Date.now().toString(36)}`; });
    }

    const isLoose = isLooseType(productData.productType);
    const convertedVariants = variants.map((v) => {
      const c = fromAppFormat({ mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: v.costPrice, stock: v.stock, bulkPrice: v.bulkPrice, packageSize: v.packageSize }, isLoose);
      return {
        sku: v.sku, barcode: v.barcode, packageSize: v.packageSize, packageUnit: v.packageUnit,
        mrp: c.mrp, sellingPrice: c.sellingPrice, costPrice: c.costPrice, stock: c.stock,
        lowStockThreshold: v.lowStockThreshold, bulkMinQty: v.bulkMinQty, bulkPrice: c.bulkPrice, gstRateOverride: v.gstRateOverride,
      };
    });

    const product = await prisma.catalogProduct.create({
      data: {
        ...productData,
        handle,
        categoryId: cat.id,
        sellerId: req.sellerId!,
        isActive: false, // pending admin approval
        variants: { create: convertedVariants },
      },
      include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
    });

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
      delete updateData.isActive; // activation is admin moderation only

      if (Object.keys(updateData).length > 0) {
        await tx.catalogProduct.update({ where: { id: productId }, data: updateData });
      }

      if (variantUpdates) {
        const incomingIds = variantUpdates.filter((v: any) => v.id).map((v: any) => v.id!);
        const toRemove = existing.variants.map((v: any) => v.id).filter((id: string) => !incomingIds.includes(id));
        if (toRemove.length > 0) {
          await tx.productVariant.updateMany({ where: { id: { in: toRemove } }, data: { isActive: false } });
        }
        for (const v of variantUpdates) {
          const c = fromAppFormat({ mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: (v as any).costPrice, stock: v.stock, bulkPrice: v.bulkPrice, packageSize: v.packageSize }, isLoose);
          if (v.id) {
            const { id: vid, ...rest } = v;
            await tx.productVariant.update({ where: { id: vid }, data: { ...rest, mrp: c.mrp, sellingPrice: c.sellingPrice, stock: c.stock, bulkPrice: c.bulkPrice } });
          } else {
            const { id: _unused, ...rest } = v;
            await tx.productVariant.create({ data: { ...rest, mrp: c.mrp, sellingPrice: c.sellingPrice, stock: c.stock, bulkPrice: c.bulkPrice, productId } });
          }
        }
      }
    });

    const updated = await prisma.catalogProduct.findUnique({
      where: { id: productId },
      include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
    });
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

export default router;
