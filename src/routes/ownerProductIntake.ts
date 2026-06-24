import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Owner-facing review queue for the product-intake form (tools/add-products.html). The owner sees
// pending submissions inside the Android admin console and taps Approve to push them live, Reject to
// dismiss, or Delete. Firebase OWNER auth (the owner is logged into the app), distinct from the
// shared-secret web admin in productIntake.ts.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

const VALID_PRODUCT_TYPES = new Set(["PACKAGED", "LOOSE", "PRODUCE", "DAIRY"]);
const VALID_PACKAGE_UNITS = new Set(["KG", "GRAM", "LITRE", "ML", "PIECE", "PACKET", "BOX", "DOZEN", "BUNDLE"]);

function isLooseType(productType: string): boolean {
  return productType === "LOOSE" || productType === "PRODUCE";
}

function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Parse "12", "12.5", 12, "" → number | null. Blank/garbage → null.
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// ─── GET / — list submissions (default PENDING) ───────────────────────────────

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const where: any = {};
    if (status === "PENDING" || status === "IMPORTED" || status === "REJECTED") {
      where.status = status;
    } else {
      where.status = "PENDING"; // default view = the work queue
    }

    const rows = await prisma.productIntake.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json({
      success: true,
      data: rows.map((r: any) => ({
        id: r.id,
        submittedBy: r.submittedBy,
        productCount: r.productCount,
        variantCount: r.variantCount,
        status: r.status,
        notes: r.notes,
        payload: r.payload, // array of products in the HTML-form shape
        createdAt: r.createdAt.getTime(),
      })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Transform one HTML-form product → catalog create input ───────────────────
// IMPORTANT: the form already collects values in the DB's STORAGE format:
//   • packaged → per-pack price + pack count
//   • loose/produce → per-base-unit price (₹/kg) + stock in base units (kg)
// The DB stores loose prices per-base-unit and stock in base units, so we write the brother's values
// DIRECTLY to the columns — NO fromAppFormat() conversion (that is only for the Android increment
// editor). Running it here would wrongly divide loose prices by the increment.

interface BuildResult {
  data: any; // prisma create input for catalogProduct
}

async function buildCreateInput(p: any, indexLabel: string): Promise<BuildResult> {
  const name = String(p?.name ?? "").trim();
  if (!name) throw new Error("Missing product name");

  const productType = String(p?.productType ?? "PACKAGED").toUpperCase();
  if (!VALID_PRODUCT_TYPES.has(productType)) {
    throw new Error(`Invalid product type "${p?.productType}"`);
  }

  const categorySlug = String(p?.categorySlug ?? "").trim();
  if (!categorySlug) throw new Error("Missing category");
  const cat = await prisma.category.findUnique({ where: { slug: categorySlug } });
  if (!cat) throw new Error(`Category "${categorySlug}" does not exist`);

  // Unique handle.
  let handle = slugify(p?.handle || name) || `product-${indexLabel}`;
  const existingHandle = await prisma.catalogProduct.findUnique({ where: { handle } });
  if (existingHandle) handle = `${handle}-${Date.now().toString(36)}`;

  const variantsIn = Array.isArray(p?.variants) ? p.variants : [];
  if (variantsIn.length === 0) throw new Error("No sizes/variants");

  const variants: any[] = [];
  for (let i = 0; i < variantsIn.length; i++) {
    const v = variantsIn[i];
    const label = String(v?.label ?? "").trim() || `Size ${i + 1}`;

    const packageUnit = String(v?.unit ?? "PIECE").toUpperCase();
    if (!VALID_PACKAGE_UNITS.has(packageUnit)) {
      throw new Error(`"${label}": invalid unit "${v?.unit}"`);
    }

    const packageSize = num(v?.size);
    if (packageSize === null || packageSize <= 0) throw new Error(`"${label}": package size must be a positive number`);

    const mrp = num(v?.mrp);
    if (mrp === null || mrp <= 0) throw new Error(`"${label}": MRP must be a positive number`);

    const sellingPrice = num(v?.price);
    if (sellingPrice === null || sellingPrice <= 0) throw new Error(`"${label}": selling price must be a positive number`);

    const stock = num(v?.stock) ?? 0;
    const costPrice = num(v?.cost);
    const bulkPrice = num(v?.bulkprice);
    const lowStockThreshold = Math.max(0, Math.round(num(v?.lowstock) ?? 5));
    const bulkMinQty = Math.max(0, Math.round(num(v?.bulkqty) ?? 0));

    // Unique SKU.
    let sku = String(v?.sku ?? "").trim() || `${handle}-${i + 1}`.toUpperCase().slice(0, 50);
    const existingSku = await prisma.productVariant.findFirst({ where: { sku }, select: { id: true } });
    if (existingSku) sku = `${sku}-${Date.now().toString(36)}${i}`.slice(0, 50);

    variants.push({
      sku,
      barcode: String(v?.barcode ?? "").trim() || null,
      packageSize,
      packageUnit,
      mrp,
      sellingPrice,
      costPrice: costPrice ?? null,
      stock,
      lowStockThreshold,
      bulkMinQty,
      bulkPrice: bulkPrice ?? null,
    });
  }

  const keywords = String(p?.searchKeywords ?? "")
    .split(/[,;]/)
    .map((s: string) => s.trim())
    .filter(Boolean);

  const gstRate = num(p?.gstRate);
  const cessRate = num(p?.cessRate) ?? 0;

  const data = {
    handle,
    name,
    nameHi: String(p?.nameHi ?? "").trim() || null,
    brand: String(p?.brand ?? "").trim() || null,
    categoryId: cat.id,
    subcategory: String(p?.subcategory ?? "").trim() || null,
    productType,
    description: String(p?.description ?? "").trim() || null,
    hsnCode: String(p?.hsnCode ?? "").trim() || null,
    gstRate: gstRate, // null = use category default
    cessRate,
    isPackaged: !isLooseType(productType),
    isTaxInclusive: p?.isTaxInclusive !== false,
    isExempt: p?.isExempt === true,
    isBranded: p?.isBranded === true,
    isSampleEligible: p?.isSampleEligible === true,
    featuredIn99Store: p?.featuredIn99Store === true,
    isSubscribable: p?.isSubscribable === true,
    imageUrls: [] as string[], // photos added later in-app
    searchKeywords: keywords,
    isActive: p?.isActive !== false,
    variants: { create: variants },
  };

  return { data };
}

// ─── POST /:id/approve — create products, partial-tolerant ────────────────────

router.post("/:id/approve", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const submission = await prisma.productIntake.findUnique({ where: { id } });
    if (!submission) throw new NotFoundError("Submission", id);
    if (submission.status === "IMPORTED") {
      throw new ValidationError("This submission was already imported");
    }

    const products: any[] = Array.isArray(submission.payload) ? (submission.payload as any[]) : [];
    if (products.length === 0) throw new ValidationError("Submission has no products");

    const created: string[] = [];
    const failed: { name: string; reason: string }[] = [];
    const leftover: any[] = []; // original product objects that failed, kept for retry

    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const displayName = String(p?.name ?? `Product ${i + 1}`);
      try {
        const { data } = await buildCreateInput(p, String(i + 1));
        await prisma.catalogProduct.create({ data });
        created.push(displayName);
      } catch (err: any) {
        const reason = err?.message ? String(err.message).slice(0, 200) : "Unknown error";
        failed.push({ name: displayName, reason });
        leftover.push(p);
      }
    }

    // Reduce the submission to only what failed, so re-approving retries just those.
    const allDone = leftover.length === 0;
    const leftoverVariants = leftover.reduce(
      (sum, p) => sum + (Array.isArray(p?.variants) ? p.variants.length : 0),
      0,
    );
    const noteParts: string[] = [];
    noteParts.push(`${created.length} imported`);
    if (failed.length > 0) noteParts.push(`${failed.length} failed`);

    await prisma.productIntake.update({
      where: { id },
      data: {
        payload: leftover as any,
        productCount: leftover.length,
        variantCount: leftoverVariants,
        status: allDone ? "IMPORTED" : "PENDING",
        notes: noteParts.join(", "),
      },
    });

    res.json({
      success: true,
      data: {
        created: created.length,
        createdNames: created,
        failed,        // [{name, reason}]
        remaining: leftover.length,
        status: allDone ? "IMPORTED" : "PENDING",
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/reject — dismiss without importing ─────────────────────────────

router.post("/:id/reject", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const parsed = z.object({ notes: z.string().max(500).optional() }).safeParse(req.body ?? {});
    const submission = await prisma.productIntake.findUnique({ where: { id } });
    if (!submission) throw new NotFoundError("Submission", id);

    await prisma.productIntake.update({
      where: { id },
      data: { status: "REJECTED", notes: parsed.success ? parsed.data.notes ?? null : null },
    });
    res.json({ success: true, message: "Submission rejected" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    await prisma.productIntake.delete({ where: { id } });
    res.json({ success: true, message: "Submission deleted" });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
