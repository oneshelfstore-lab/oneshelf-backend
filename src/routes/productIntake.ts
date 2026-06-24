import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";

// Submissions from the standalone product-intake HTML form (see tools/add-products.html).
// The brother/staff fill the form from anywhere on the web → POST lands here → owner reviews
// via tools/view-submissions.html or curl. Mounted in index.ts BEFORE the global JWT guard.
//
// Two auth modes in one router:
//  - POST /                     → fully public (the form has no user identity). Rate-limited by
//                                 the global generalLimiter (100 req/min/IP) + body size guard.
//  - GET / and DELETE /:id      → shared-secret via `X-Intake-Admin-Token` header. The owner sets
//                                 INTAKE_ADMIN_TOKEN as an env var on Render and pastes it into
//                                 the admin HTML once (stored in localStorage).
//
// Why a shared secret instead of Firebase auth on the admin endpoints: the admin view is a static
// HTML file the owner opens in any browser without the Android app — getting a Firebase ID token
// out of Firebase web SDK just for this is overkill. Shared secret is appropriate for a
// low-stakes review queue (worst case: someone with the token sees product drafts).
const router = Router();

// ─── Permissive CORS for the public POST ──────────────────────────────────────
// The form will be hosted on Netlify or sent via WhatsApp as a file (file:// origins). We can't
// know the origin ahead of time, so the public submit endpoint accepts any origin.
// The admin GET/DELETE keep using the global CORS allowlist (owner controls where they host that
// page from, so they can add it to ALLOWED_ORIGINS).
function publicCors(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const variantSchema = z.object({
  label: z.string().max(120).default(""),
  sku: z.string().max(80).default(""),
  unit: z.string().max(20).default(""),
  size: z.string().max(40).default(""),
  barcode: z.string().max(40).default(""),
  mrp: z.string().max(20).default(""),
  price: z.string().max(20).default(""),
  cost: z.string().max(20).default(""),
  stock: z.string().max(20).default(""),
  lowstock: z.string().max(20).default(""),
  bulkqty: z.string().max(20).default(""),
  bulkprice: z.string().max(20).default(""),
});

const productSchema = z.object({
  name: z.string().min(1).max(200),
  handle: z.string().max(120).default(""),
  nameHi: z.string().max(200).default(""),
  brand: z.string().max(120).default(""),
  categorySlug: z.string().max(60).default(""),
  subcategory: z.string().max(120).default(""),
  productType: z.string().max(20).default("PACKAGED"),
  description: z.string().max(1000).default(""),
  searchKeywords: z.string().max(500).default(""),
  isActive: z.boolean().default(true),
  hsnCode: z.string().max(12).default(""),
  gstRate: z.union([z.string(), z.number()]).default(""),
  cessRate: z.union([z.string(), z.number()]).default("0"),
  isTaxInclusive: z.boolean().default(true),
  isBranded: z.boolean().default(false),
  isExempt: z.boolean().default(false),
  isSampleEligible: z.boolean().default(false),
  featuredIn99Store: z.boolean().default(false),
  isSubscribable: z.boolean().default(false),
  variants: z.array(variantSchema).min(1).max(20),
});

const submitSchema = z.object({
  submittedBy: z.string().min(1).max(120),
  products: z.array(productSchema).min(1).max(200),
});

// ─── POST / — public submit ──────────────────────────────────────────────────

router.options("/", publicCors);
router.post("/", publicCors, async (req: Request, res: Response) => {
  try {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid submission", parsed.error.errors);
    }
    const { submittedBy, products } = parsed.data;
    const variantCount = products.reduce((sum, p) => sum + p.variants.length, 0);

    const created = await prisma.productIntake.create({
      data: {
        submittedBy: submittedBy.trim(),
        payload: products as any,
        productCount: products.length,
        variantCount,
      },
    });

    res.status(201).json({
      success: true,
      data: { id: created.id, productCount: products.length, variantCount },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Admin (shared-secret) ───────────────────────────────────────────────────

function adminAuth(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.INTAKE_ADMIN_TOKEN;
  if (!secret) {
    res.status(503).json({
      success: false,
      error: { code: "NOT_CONFIGURED", message: "Intake admin token is not configured" },
    });
    return;
  }
  const provided = req.headers["x-intake-admin-token"];
  if (provided !== secret) {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Invalid admin token" },
    });
    return;
  }
  next();
}

// GET /admin → list (newest first), with optional ?status= filter
router.get("/admin", adminAuth, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const where: any = {};
    if (status === "PENDING" || status === "IMPORTED" || status === "REJECTED") {
      where.status = status;
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
        payload: r.payload,
        createdAt: r.createdAt.getTime(),
        updatedAt: r.updatedAt.getTime(),
      })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// PATCH /admin/:id → mark IMPORTED/REJECTED + optional notes
router.patch("/admin/:id", adminAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const parsed = z.object({
      status: z.enum(["PENDING", "IMPORTED", "REJECTED"]).optional(),
      notes: z.string().max(2000).optional(),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid update", parsed.error.errors);

    const updated = await prisma.productIntake.update({
      where: { id },
      data: parsed.data,
    });
    res.json({ success: true, data: { id: updated.id, status: updated.status, notes: updated.notes } });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /admin/:id → hard delete (small table, no soft-delete needed)
router.delete("/admin/:id", adminAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await prisma.productIntake.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
