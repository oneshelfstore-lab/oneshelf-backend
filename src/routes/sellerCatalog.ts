import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { formatVariantForApp, fromAppFormat, toAppFormat, assertVariantFloors } from "../utils/looseUnitConverter.js";
import { receiveBatch, applyStockEdit } from "../services/stockBatches.js";
import { calculateLineItemTax, calculateInvoiceTotals } from "../services/taxEngine.js";

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
    // Legal Metrology country-of-origin filter (Onboarding Phase 3) — editable by every seller
    // (a factual origin declaration, not a merchandising privilege, so it's NOT house-gated like
    // featuredIn99Store/isSampleEligible/isBuyOneGetOne below).
    isImported: product.isImported,
    countryOfOrigin: product.countryOfOrigin,
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
  // Universally editable (not house-gated) — a factual origin declaration every seller can set
  // for their own products, unlike the merchandising toggles below.
  isImported: z.boolean().default(false),
  countryOfOrigin: z.string().max(80).optional().nullable(),
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
    // Initial stock is seeded as each new variant's first StockBatch (below, after creation) rather
    // than written directly onto the row — receiveBatch is the ONLY place ProductVariant.stock/
    // costPrice should be written. SKU is unique within this creation (enforced above), so it's a
    // safe correlation key back to the created row.
    const convertedVariants = variants.map((v) => {
      const c = fromAppFormat({ mrp: v.mrp, sellingPrice: v.sellingPrice, costPrice: v.costPrice, saleFloor: v.saleFloor, stock: v.stock, bulkPrice: v.bulkPrice, packageSize: v.packageSize }, isLoose);
      return {
        sku: v.sku, barcode: v.barcode, packageSize: v.packageSize, packageUnit: v.packageUnit,
        mrp: c.mrp, sellingPrice: c.sellingPrice, saleFloor: c.saleFloor, stock: 0,
        initialStock: c.stock, initialCost: c.costPrice ?? 0,
        lowStockThreshold: v.lowStockThreshold, bulkMinQty: v.bulkMinQty, bulkPrice: c.bulkPrice, gstRateOverride: v.gstRateOverride,
      };
    });

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.catalogProduct.create({
        data: {
          ...productData,
          handle,
          categoryId: cat.id,
          sellerId: req.sellerId!,
          ...merchandising, // house → live now (+toggles); third-party → inactive pending approval
          variants: { create: convertedVariants.map(({ initialStock, initialCost, ...rest }) => rest) },
        },
        include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
      });

      const bySku = new Map(created.variants.map((v) => [v.sku, v]));
      for (const cv of convertedVariants) {
        if (cv.initialStock > 0) {
          const row = bySku.get(cv.sku);
          if (row) await receiveBatch(tx, row.id, cv.initialStock, cv.initialCost, "Initial stock");
        }
      }

      return tx.catalogProduct.findUnique({
        where: { id: created.id },
        include: { variants: { orderBy: { packageSize: "asc" } }, category: { select: { slug: true, name: true } } },
      });
    });

    await ensureBrandPersisted(product?.brand);

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
            // Existing variant: stock/costPrice are batch rollups — route the edit through
            // applyStockEdit instead of overwriting them directly (was silently blending a
            // different-cost restock into the same row with no history).
            const { id: vid, stock: _stock, costPrice: _costPrice, ...rest } = v as any;
            await tx.productVariant.update({ where: { id: vid }, data: { ...rest, mrp: c.mrp, sellingPrice: c.sellingPrice, saleFloor: c.saleFloor, bulkPrice: c.bulkPrice } });
            await applyStockEdit(tx, vid, c.stock, c.costPrice, "Edited via product editor");
          } else {
            const { id: _unused, stock: _stock, costPrice: _costPrice, ...rest } = v as any;
            const createdVariant = await tx.productVariant.create({ data: { ...rest, mrp: c.mrp, sellingPrice: c.sellingPrice, saleFloor: c.saleFloor, stock: 0, bulkPrice: c.bulkPrice, productId } });
            if (c.stock > 0) await receiveBatch(tx, createdVariant.id, c.stock, c.costPrice ?? 0, "Initial stock");
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
    // Quick stepper — no new cost info: an increase restocks at the variant's current weighted-
    // average cost, a decrease is a shrinkage/miscount correction. A genuinely different cost
    // belongs in the full editor or the dedicated Restock action below.
    await prisma.$transaction((tx) => applyStockEdit(tx, variantId, c.stock));
    res.json({ success: true, message: "Stock updated" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/stock/receive — restock a variant, at whatever cost it actually came in at ──
// Mirrors ownerCatalog's equivalent endpoint — see its comment for why this is separate from the
// quick stepper above. The optional vendor-bill link (below) is HOUSE-ONLY — vendors/purchase bills
// are the STORE's own bookkeeping (kirana-billing), not a per-seller ledger; a genuine third-party
// seller has their own suppliers outside this system, same "house-only" gate as add-category above.
const receiveStockSchema = z.object({
  variantId: z.string().min(1),
  qty: z.number().positive(),
  unitCost: z.number().min(0),
  note: z.string().max(200).optional(),
  vendorId: z.string().min(1).optional(),
  billNumber: z.string().min(1).max(100).optional(),
  paymentDueDate: z.string().optional().nullable(),
});

router.post("/:id/stock/receive", async (req: SellerRequest, res: Response) => {
  try {
    const productId = req.params.id as string;
    const { variantId, qty, unitCost, note, vendorId, billNumber, paymentDueDate } = receiveStockSchema.parse(req.body);

    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId, product: { sellerId: req.sellerId } },
      include: { product: { select: { productType: true, name: true, hsnCode: true, gstRate: true } } },
    });
    if (!variant) throw new NotFoundError("Variant", variantId);

    let vendor = null;
    if (vendorId && req.sellerIsHouse) {
      vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor || !vendor.isActive) throw new NotFoundError("Vendor", vendorId);
    }

    const isLoose = isLooseType(variant.product.productType);
    const c = fromAppFormat(
      {
        mrp: Number(variant.mrp), sellingPrice: Number(variant.sellingPrice),
        costPrice: unitCost, stock: qty,
        bulkPrice: variant.bulkPrice ? Number(variant.bulkPrice) : undefined,
        packageSize: Number(variant.packageSize),
      },
      isLoose,
    );

    await prisma.$transaction(async (tx) => {
      if (vendor && billNumber) {
        const tax = calculateLineItemTax({
          unitPrice: c.costPrice ?? 0,
          quantity: c.stock,
          gstRate: Number(variant.product.gstRate ?? 0),
          isTaxInclusive: false,
        });
        const totals = calculateInvoiceTotals([tax]);

        const bill = await tx.purchaseBill.create({
          data: {
            vendorId: vendor.id,
            billNumber,
            billDate: new Date(),
            receivedDate: new Date(),
            vendorGstin: vendor.gstin,
            subtotal: totals.subtotal,
            totalCgst: totals.totalCgst,
            totalSgst: totals.totalSgst,
            totalIgst: 0,
            totalCess: totals.totalCess,
            totalAmount: totals.totalAmount,
            tdsAmount: 0,
            netPayable: totals.totalAmount,
            itcEligible: true,
            isReverseCharge: false,
            status: "APPROVED",
            paymentDueDate: paymentDueDate ? new Date(paymentDueDate) : null,
          },
        });
        const line = await tx.purchaseBillLine.create({
          data: {
            purchaseBillId: bill.id,
            variantId,
            description: variant.product.name,
            hsnCode: variant.product.hsnCode || "0000",
            quantity: c.stock,
            unitPrice: c.costPrice ?? 0,
            taxableValue: tax.taxableValue,
            gstRate: tax.gstRate,
            cgstAmount: tax.cgstAmount,
            sgstAmount: tax.sgstAmount,
            igstAmount: 0,
            totalAmount: tax.totalAmount,
          },
        });
        await receiveBatch(tx, variantId, c.stock, c.costPrice ?? 0, `Bill ${billNumber}${note ? ` — ${note}` : ""}`, line.id);
        await tx.vendor.update({ where: { id: vendor.id }, data: { outstandingBalance: { increment: totals.totalAmount } } });
      } else {
        await receiveBatch(tx, variantId, c.stock, c.costPrice ?? 0, note);
      }
    });

    res.json({ success: true, message: "Stock received" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /vendors/search — vendor picker for the house co-manager's Restock dialog ─────
// HOUSE-ONLY (see the note above) — a non-house seller gets an empty list rather than a 403, so the
// Android RestockDialog's optional vendor-link section can simply not render for them without a
// special-cased error path (mirrors how the section is hidden client-side for non-house sellers too).

router.get("/vendors/search", async (req: SellerRequest, res: Response) => {
  try {
    if (!req.sellerIsHouse) { res.json({ success: true, data: [] }); return; }
    const q = String(req.query.q ?? "").trim();
    if (q.length < 1) { res.json({ success: true, data: [] }); return; }

    const vendors = await prisma.vendor.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { phone: { startsWith: q } },
          { gstin: { startsWith: q, mode: "insensitive" } },
        ],
      },
      take: 20,
      orderBy: { name: "asc" },
      select: { id: true, name: true, phone: true, gstin: true },
    });

    res.json({ success: true, data: vendors });
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
