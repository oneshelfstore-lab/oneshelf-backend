import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, sendError } from "../lib/errors.js";
import { isUpGstin } from "../validators/index.js";

const router = Router();

// ─── Validation ──────────────────────────────────────────────────────

const vendorBaseSchema = z.object({
  name: z.string().min(1).max(200),
  gstin: z.string().max(15).optional().nullable(),
  vendorType: z.enum(["REGISTERED", "UNREGISTERED", "COMPOSITION"]).default("REGISTERED"),
  pan: z.string().max(10).optional().nullable(),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Invalid Indian phone number"),
  email: z.string().email().optional().or(z.literal("")).nullable(),
  address: z.any().optional().nullable(),
  bankDetails: z.any().optional().nullable(),
  isMsme: z.boolean().default(false),
  msmeNumber: z.string().optional().nullable(),
  paymentTermsDays: z.number().int().min(0).default(30),
});

const createVendorSchema = vendorBaseSchema.refine(
  (data) => {
    if (data.vendorType === "REGISTERED" && !data.gstin) return false;
    return true;
  },
  { message: "GSTIN is required for registered vendors", path: ["gstin"] },
).refine(
  (data) => {
    if (!data.gstin) return true;
    return isUpGstin(data.gstin).valid;
  },
  (data) => ({ message: data.gstin ? isUpGstin(data.gstin).error || "Invalid GSTIN" : "", path: ["gstin"] }),
);

const updateVendorSchema = vendorBaseSchema.partial().refine(
  (data) => {
    if (!data.gstin) return true;
    return isUpGstin(data.gstin).valid;
  },
  (data) => ({ message: data.gstin ? isUpGstin(data.gstin).error || "Invalid GSTIN" : "", path: ["gstin"] }),
);

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(["REGISTERED", "UNREGISTERED", "COMPOSITION"]).optional(),
  search: z.string().max(100).optional(),
});

// ─── POST /api/vendors ───────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid vendor data", parsed.error.errors);
    }
    const data = parsed.data;
    if (data.email === "") data.email = undefined;

    const vendor = await prisma.vendor.create({ data });

    const response: Record<string, unknown> = { success: true, data: vendor };

    // MSME warning
    if (data.isMsme && data.paymentTermsDays > 45) {
      response.warning =
        "MSME vendor: payment terms exceed 45 days. Under MSMED Act, payments to MSMEs must be made within 45 days to avoid interest liability.";
    }

    res.status(201).json(response);
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/vendors ────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, type, search } = parsed.data;

    const where: Record<string, unknown> = { isActive: true };
    if (type) where.vendorType = type;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
        { gstin: { contains: search, mode: "insensitive" } },
      ];
    }

    const [vendors, total] = await Promise.all([
      prisma.vendor.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.vendor.count({ where }),
    ]);

    res.json({
      success: true,
      data: vendors,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/vendors/search ─────────────────────────────────────────

router.get("/search", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 1) {
      res.json({ success: true, data: [] });
      return;
    }

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
    });

    res.json({ success: true, data: vendors });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/vendors/:id ────────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const vendor = await prisma.vendor.findUnique({
      where: { id: req.params.id },
    });
    if (!vendor || !vendor.isActive) {
      throw new NotFoundError("Vendor", req.params.id!);
    }

    // Outstanding summary
    const billStats = await prisma.purchaseBill.aggregate({
      where: { vendorId: vendor.id, status: { not: "DRAFT" } },
      _sum: { totalAmount: true, netPayable: true },
      _count: true,
    });

    res.json({
      success: true,
      data: {
        ...vendor,
        billSummary: {
          totalBills: billStats._count,
          totalAmount: billStats._sum.totalAmount ?? 0,
          totalPayable: billStats._sum.netPayable ?? 0,
        },
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── PUT /api/vendors/:id ────────────────────────────────────────────

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!existing || !existing.isActive) {
      throw new NotFoundError("Vendor", req.params.id!);
    }

    const parsed = updateVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid vendor data", parsed.error.errors);
    }
    const data = parsed.data;

    // B2B type check
    const finalType = data.vendorType ?? existing.vendorType;
    const finalGstin = data.gstin !== undefined ? data.gstin : existing.gstin;
    if (finalType === "REGISTERED" && !finalGstin) {
      throw new ValidationError("GSTIN is required for registered vendors");
    }

    if (data.email === "") data.email = undefined;

    const vendor = await prisma.vendor.update({
      where: { id: req.params.id },
      data,
    });

    const response: Record<string, unknown> = { success: true, data: vendor };
    const finalMsme = data.isMsme ?? existing.isMsme;
    const finalTerms = data.paymentTermsDays ?? existing.paymentTermsDays;
    if (finalMsme && finalTerms > 45) {
      response.warning =
        "MSME vendor: payment terms exceed 45 days. Under MSMED Act, payments to MSMEs must be made within 45 days.";
    }

    res.json(response);
  } catch (error) {
    sendError(res, error);
  }
});

// ─── DELETE /api/vendors/:id — Soft delete ───────────────────────────

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Vendor", req.params.id!);

    await prisma.vendor.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true, message: "Vendor deactivated" });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
