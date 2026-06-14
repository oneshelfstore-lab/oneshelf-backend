import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { formatVariantForApp, fromAppFormat } from "../utils/looseUnitConverter.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// ─── Shared ────────────────────────────────────────────────────────

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
    brand: product.brand,
    categoryId: product.categoryId,
    category: product.category ?? undefined,
    subcategory: product.subcategory,
    productType: product.productType,
    description: product.description,
    hsnCode: product.hsnCode,
    gstRate: product.gstRate != null ? Number(product.gstRate) : null,
    isPackaged: product.isPackaged,
    imageUrls: product.imageUrls,
    searchKeywords: product.searchKeywords,
    isActive: product.isActive,
    variants: product.variants?.map((v: any) => formatVariantForApp(v, isLoose)) ?? [],
  };
}

// ─── GET / — list all products (including inactive) ────────────────

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
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
      data: products.map(formatProductForApp),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST / — create product + variants ────────────────────────────

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
  isSampleEligible: z.boolean().default(false),
  featuredIn99Store: z.boolean().default(false),
  imageUrls: z.array(z.string()).default([]),
  searchKeywords: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  variants: z.array(variantCreateSchema).min(1).max(20),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = productCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid product data", parsed.error.errors);
    const { variants, categorySlug, ...productData } = parsed.data;

    const cat = await prisma.category.findUnique({ where: { slug: categorySlug } });
    if (!cat) throw new ValidationError(`Category '${categorySlug}' not found`);

    // Auto-generate handle if it conflicts
    let handle = productData.handle;
    const existing = await prisma.catalogProduct.findUnique({ where: { handle } });
    if (existing) {
      handle = `${handle}-${Date.now().toString(36)}`;
    }

    // Check SKU uniqueness
    const skus = variants.map(v => v.sku);
    const existingSkus = await prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { sku: true } });
    if (existingSkus.length > 0) {
      // Auto-suffix conflicting SKUs
      const existSet = new Set(existingSkus.map(s => s.sku));
      variants.forEach(v => {
        if (existSet.has(v.sku)) {
          v.sku = `${v.sku}-${Date.now().toString(36)}`;
        }
      });
    }

    // Convert loose variant prices from app format (per-increment) to API format (per-base-unit)
    const isLoose = isLooseType(productData.productType);
    const convertedVariants = variants.map(v => {
      const converted = fromAppFormat(
        { mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: v.costPrice, stock: v.stock, bulkPrice: v.bulkPrice, packageSize: v.packageSize },
        isLoose
      );
      return {
        sku: v.sku,
        barcode: v.barcode,
        packageSize: v.packageSize,
        packageUnit: v.packageUnit,
        mrp: converted.mrp,
        sellingPrice: converted.sellingPrice,
        costPrice: converted.costPrice,
        stock: converted.stock,
        lowStockThreshold: v.lowStockThreshold,
        bulkMinQty: v.bulkMinQty,
        bulkPrice: converted.bulkPrice,
        gstRateOverride: v.gstRateOverride,
      };
    });

    const product = await prisma.catalogProduct.create({
      data: {
        ...productData,
        handle,
        categoryId: cat.id,
        variants: { create: convertedVariants },
      },
      include: {
        variants: { orderBy: { packageSize: "asc" } },
        category: { select: { slug: true, name: true } },
      },
    });

    res.status(201).json({ success: true, data: formatProductForApp(product) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT /:id — update product + upsert variants ──────────────────

router.put("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const productId = req.params.id as string;
    const existing = await prisma.catalogProduct.findUnique({
      where: { id: productId },
      include: { variants: true },
    });
    if (!existing) throw new NotFoundError("Product", productId);

    const updateSchema = productCreateSchema.partial().omit({ variants: true }).extend({
      variants: z.array(variantCreateSchema.extend({ id: z.string().optional() })).optional(),
    });

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
          const converted = fromAppFormat(
            { mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: (v as any).costPrice, stock: v.stock, bulkPrice: v.bulkPrice, packageSize: v.packageSize },
            isLoose
          );
          if (v.id) {
            const { id: vid, ...rest } = v;
            await tx.productVariant.update({
              where: { id: vid },
              data: {
                ...rest,
                mrp: converted.mrp,
                sellingPrice: converted.sellingPrice,
                stock: converted.stock,
                bulkPrice: converted.bulkPrice,
              },
            });
          } else {
            const { id: _unused, ...rest } = v;
            await tx.productVariant.create({
              data: {
                ...rest,
                mrp: converted.mrp,
                sellingPrice: converted.sellingPrice,
                stock: converted.stock,
                bulkPrice: converted.bulkPrice,
                productId,
              },
            });
          }
        }
      }
    });

    const updated = await prisma.catalogProduct.findUnique({
      where: { id: productId },
      include: {
        variants: { orderBy: { packageSize: "asc" } },
        category: { select: { slug: true, name: true } },
      },
    });

    res.json({ success: true, data: formatProductForApp(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /:id — soft-delete ─────────────────────────────────────

router.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const productId = req.params.id as string;
    const existing = await prisma.catalogProduct.findUnique({ where: { id: productId } });
    if (!existing) throw new NotFoundError("Product", productId);

    await prisma.catalogProduct.update({ where: { id: productId }, data: { isActive: false } });
    res.json({ success: true, message: "Product deactivated" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PATCH /:id/toggle — toggle isActive ──────────────────────────

router.patch("/:id/toggle", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const productId = req.params.id as string;
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
    const existing = await prisma.catalogProduct.findUnique({ where: { id: productId } });
    if (!existing) throw new NotFoundError("Product", productId);

    await prisma.catalogProduct.update({ where: { id: productId }, data: { isActive } });
    res.json({ success: true, message: `Product ${isActive ? "activated" : "deactivated"}` });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PATCH /:id/stock — quick stock update for a variant ──────────

router.patch("/:id/stock", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const productId = req.params.id as string;
    const { variantId, stock } = z.object({
      variantId: z.string().min(1),
      stock: z.number().min(0),
    }).parse(req.body);

    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId },
      include: { product: { select: { productType: true } } },
    });
    if (!variant) throw new NotFoundError("Variant", variantId);

    const isLoose = isLooseType(variant.product.productType);
    const converted = fromAppFormat(
      { mrp: Number(variant.mrp), sellingPrice: Number(variant.sellingPrice), stock, bulkPrice: variant.bulkPrice ? Number(variant.bulkPrice) : undefined, packageSize: Number(variant.packageSize) },
      isLoose
    );

    await prisma.productVariant.update({ where: { id: variantId }, data: { stock: converted.stock } });
    res.json({ success: true, message: "Stock updated" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Owner categories (CRUD with Firebase auth) ───────────────────

// GET /categories — all categories (including inactive)
router.get("/categories", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { displayOrder: "asc" },
      include: { _count: { select: { catalogProducts: true } } },
    });
    res.json({ success: true, data: categories });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /categories — create category
router.post("/categories", async (req: FirebaseAuthRequest, res: Response) => {
  try {
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

// DELETE /categories/:id — delete category
router.delete("/categories/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const catId = req.params.id as string;
    const cat = await prisma.category.findUnique({ where: { id: catId } });
    if (!cat) throw new NotFoundError("Category", catId);

    await prisma.category.delete({ where: { id: catId } });
    res.json({ success: true, message: "Category deleted" });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /categories/seed — seed default categories
router.post("/categories/seed", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const defaults = [
      { slug: "staples_grains", name: "Staples & Grains", displayOrder: 0 },
      { slug: "dairy", name: "Dairy", displayOrder: 1 },
      { slug: "oils_spices_masalas", name: "Oils, Spices & Masalas", displayOrder: 2 },
      { slug: "beverages", name: "Beverages", displayOrder: 3 },
      { slug: "snacks_namkeen", name: "Snacks & Namkeen", displayOrder: 4 },
      { slug: "packaged_canned", name: "Packaged & Canned Foods", displayOrder: 5 },
      { slug: "bakery_breakfast", name: "Bakery & Breakfast", displayOrder: 6 },
      { slug: "household_personal", name: "Household & Personal Care", displayOrder: 7 },
    ];

    for (const cat of defaults) {
      await prisma.category.upsert({
        where: { slug: cat.slug },
        update: { name: cat.name, displayOrder: cat.displayOrder },
        create: { ...cat, isActive: true },
      });
    }

    const all = await prisma.category.findMany({ orderBy: { displayOrder: "asc" } });
    res.json({ success: true, data: all, message: `Seeded ${defaults.length} categories` });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
