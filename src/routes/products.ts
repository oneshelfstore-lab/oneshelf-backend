import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, ConflictError, sendError } from "../lib/errors.js";

const router = Router();

// ─── Validation Schemas ──────────────────────────────────────────────

const ProductCategory = z.enum([
  "GROCERY_STAPLES", "DAIRY", "BEVERAGES", "SNACKS", "PERSONAL_CARE",
  "CLEANING", "PACKAGED_FOOD", "FROZEN", "SPICES", "OILS", "OTHER",
]);

const ProductUnit = z.enum([
  "PCS", "KG", "GM", "LTR", "ML", "PKT", "BOX", "DOZEN",
]);

const productBaseSchema = z.object({
  name: z.string().min(1, "Product name is required").max(200),
  sku: z.string().min(1, "SKU is required").max(50),
  barcode: z.string().max(50).optional(),
  hsnCode: z.string().min(4).max(8),
  category: ProductCategory,
  gstRate: z.number().min(0).max(100),
  cessRate: z.number().min(0).default(0),
  mrp: z.number().positive("MRP must be > 0"),
  sellingPrice: z.number().positive("Selling price must be > 0"),
  costPrice: z.number().min(0),
  isTaxInclusive: z.boolean().default(true),
  isExempt: z.boolean().default(false),
  isBranded: z.boolean().default(false),
  unit: ProductUnit,
  trackInventory: z.boolean().default(true),
  currentStock: z.number().int().min(0).default(0),
  minStockLevel: z.number().int().min(0).default(0),
});

const createProductSchema = productBaseSchema.refine(
  (data) => data.sellingPrice <= data.mrp,
  {
    message: "Selling price cannot exceed MRP (illegal under Indian law)",
    path: ["sellingPrice"],
  },
);

const updateProductSchema = productBaseSchema.partial().refine(
  (data) => {
    if (data.sellingPrice !== undefined && data.mrp !== undefined) {
      return data.sellingPrice <= data.mrp;
    }
    return true;
  },
  {
    message: "Selling price cannot exceed MRP (illegal under Indian law)",
    path: ["sellingPrice"],
  },
);

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(100).optional(),
  category: ProductCategory.optional(),
  sortBy: z.enum(["name", "sku", "sellingPrice", "createdAt"]).default("name"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

// ─── POST /api/products — Create product ─────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid product data", parsed.error.errors);
    }
    const data = parsed.data;

    // Validate HSN code exists in master
    const hsnEntries = await prisma.hsnMaster.findMany({
      where: { code: data.hsnCode },
    });
    if (hsnEntries.length === 0) {
      throw new ValidationError(`HSN code '${data.hsnCode}' not found in HSN master table`);
    }

    // Warn if GST rate doesn't match any HSN entry (but allow override)
    const matchingRate = hsnEntries.some(
      (h) => Number(h.defaultGstRate) === data.gstRate,
    );

    // Check SKU uniqueness
    const existingSku = await prisma.product.findUnique({
      where: { sku: data.sku },
    });
    if (existingSku) {
      throw new ConflictError(`SKU '${data.sku}' already exists`);
    }

    const product = await prisma.product.create({ data });

    const response: Record<string, unknown> = {
      success: true,
      data: product,
    };
    if (!matchingRate) {
      response.warning = `GST rate ${data.gstRate}% does not match any default rate for HSN ${data.hsnCode}. Override applied.`;
    }

    res.status(201).json(response);
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/products — List with pagination ────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, search, category, sortBy, sortOrder } = parsed.data;

    const where: Record<string, unknown> = { isActive: true };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { sku: { contains: search, mode: "insensitive" } },
        { barcode: { contains: search, mode: "insensitive" } },
      ];
    }
    if (category) {
      where.category = category;
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.product.count({ where }),
    ]);

    res.json({
      success: true,
      data: products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/products/search — Quick search for billing ─────────────

router.get("/search", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 1) {
      res.json({ success: true, data: [] });
      return;
    }

    // Fast search by name, SKU, or barcode — limited to 20 results
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { sku: { startsWith: q, mode: "insensitive" } },
          { barcode: { equals: q } },
        ],
      },
      take: 20,
      orderBy: { name: "asc" },
    });

    res.json({ success: true, data: products });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/products/:id — Single product with HSN details ─────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
    });

    if (!product || !product.isActive) {
      throw new NotFoundError("Product", req.params.id!);
    }

    // Fetch HSN details for context
    const hsnEntries = await prisma.hsnMaster.findMany({
      where: { code: product.hsnCode },
    });

    res.json({
      success: true,
      data: {
        ...product,
        hsnDetails: hsnEntries,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── PUT /api/products/:id — Update product ──────────────────────────

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
    });
    if (!existing || !existing.isActive) {
      throw new NotFoundError("Product", req.params.id!);
    }

    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid product data", parsed.error.errors);
    }
    const data = parsed.data;

    // If HSN is being changed, validate it
    if (data.hsnCode) {
      const hsnEntries = await prisma.hsnMaster.findMany({
        where: { code: data.hsnCode },
      });
      if (hsnEntries.length === 0) {
        throw new ValidationError(`HSN code '${data.hsnCode}' not found in HSN master table`);
      }
    }

    // If SKU is being changed, check uniqueness
    if (data.sku && data.sku !== existing.sku) {
      const skuExists = await prisma.product.findUnique({
        where: { sku: data.sku },
      });
      if (skuExists) {
        throw new ConflictError(`SKU '${data.sku}' already exists`);
      }
    }

    // Cross-validate sellingPrice vs MRP (considering one might not be in the update)
    const finalMrp = data.mrp ?? Number(existing.mrp);
    const finalSellingPrice = data.sellingPrice ?? Number(existing.sellingPrice);
    if (finalSellingPrice > finalMrp) {
      throw new ValidationError("Selling price cannot exceed MRP (illegal under Indian law)");
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data,
    });

    res.json({ success: true, data: product });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── DELETE /api/products/:id — Soft delete ──────────────────────────

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) {
      throw new NotFoundError("Product", req.params.id!);
    }

    await prisma.product.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true, message: "Product deactivated" });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── POST /api/products/bulk — Bulk import ───────────────────────────

const bulkProductSchema = z.array(
  productBaseSchema.refine((data) => data.sellingPrice <= data.mrp, {
    message: "Selling price cannot exceed MRP (illegal under Indian law)",
    path: ["sellingPrice"],
  }),
).min(1).max(500);

router.post("/bulk", async (req: Request, res: Response) => {
  try {
    const parsed = bulkProductSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid bulk product data", parsed.error.errors);
    }
    const products = parsed.data;

    // Validate all HSN codes exist
    const uniqueHsnCodes = [...new Set(products.map((p) => p.hsnCode))];
    const existingHsn = await prisma.hsnMaster.findMany({
      where: { code: { in: uniqueHsnCodes } },
      select: { code: true },
    });
    const existingHsnSet = new Set(existingHsn.map((h) => h.code));
    const missingHsn = uniqueHsnCodes.filter((c) => !existingHsnSet.has(c));
    if (missingHsn.length > 0) {
      throw new ValidationError(
        `HSN codes not found in master: ${missingHsn.join(", ")}`,
      );
    }

    // Validate all SKUs are unique (among themselves and in DB)
    const skus = products.map((p) => p.sku);
    const duplicateSkus = skus.filter((s, i) => skus.indexOf(s) !== i);
    if (duplicateSkus.length > 0) {
      throw new ValidationError(
        `Duplicate SKUs in batch: ${[...new Set(duplicateSkus)].join(", ")}`,
      );
    }

    const existingSkus = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true },
    });
    if (existingSkus.length > 0) {
      throw new ConflictError(
        `SKUs already exist: ${existingSkus.map((p) => p.sku).join(", ")}`,
      );
    }

    // Bulk create in a transaction
    const result = await prisma.$transaction(
      products.map((p) => prisma.product.create({ data: p })),
    );

    res.status(201).json({
      success: true,
      data: { created: result.length },
      message: `${result.length} products created successfully`,
    });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
