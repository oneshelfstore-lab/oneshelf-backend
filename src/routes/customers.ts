import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, sendError } from "../lib/errors.js";
import { isUpGstin, extractPanFromGstin } from "../validators/index.js";

const router = Router();

// ─── Validation Schemas ──────────────────────────────────────────────

const phoneSchema = z
  .string()
  .regex(/^[6-9]\d{9}$/, "Invalid Indian phone number (must be 10 digits starting with 6-9)");

const customerBaseSchema = z.object({
  name: z.string().min(1, "Customer name is required").max(200),
  phone: phoneSchema,
  email: z.string().email().optional().or(z.literal("")),
  gstin: z.string().max(15).optional().nullable(),
  customerType: z.enum(["B2B", "B2C"]).default("B2C"),
  panNumber: z.string().max(10).optional().nullable(),
  billingAddress: z.any().optional().nullable(),
  shippingAddress: z.any().optional().nullable(),
  creditLimit: z.number().min(0).optional().nullable(),
  paymentTermsDays: z.number().int().min(0).default(0),
});

const createCustomerSchema = customerBaseSchema.refine(
  (data) => {
    if (data.customerType === "B2B") return !!data.gstin;
    return true;
  },
  { message: "GSTIN is required for B2B customers", path: ["gstin"] },
).refine(
  (data) => {
    if (!data.gstin) return true;
    const result = isUpGstin(data.gstin);
    return result.valid;
  },
  (data) => ({ message: data.gstin ? isUpGstin(data.gstin).error || "Invalid GSTIN" : "", path: ["gstin"] }),
).refine(
  (data) => {
    if (data.gstin && data.panNumber) return extractPanFromGstin(data.gstin) === data.panNumber;
    return true;
  },
  { message: "PAN does not match GSTIN (positions 3-12)", path: ["panNumber"] },
);

const updateCustomerSchema = customerBaseSchema.partial().refine(
  (data) => {
    if (!data.gstin) return true;
    return isUpGstin(data.gstin).valid;
  },
  (data) => ({ message: data.gstin ? isUpGstin(data.gstin).error || "Invalid GSTIN" : "", path: ["gstin"] }),
);

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(["B2B", "B2C"]).optional(),
  search: z.string().max(100).optional(),
});

// ─── POST /api/customers — Create ────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createCustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid customer data", parsed.error.errors);
    }
    const data = parsed.data;

    // Auto-extract PAN from GSTIN if not provided
    if (data.gstin && !data.panNumber) {
      data.panNumber = extractPanFromGstin(data.gstin);
    }

    // Clean up empty email
    if (data.email === "") data.email = undefined;

    const customer = await prisma.customer.create({ data });

    res.status(201).json({ success: true, data: customer });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/customers — List with pagination ───────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, type, search } = parsed.data;

    const where: Record<string, unknown> = { isActive: true };

    if (type) {
      where.customerType = type;
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
        { gstin: { contains: search, mode: "insensitive" } },
      ];
    }

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.customer.count({ where }),
    ]);

    res.json({
      success: true,
      data: customers,
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

// ─── GET /api/customers/search — Quick search ────────────────────────

router.get("/search", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 1) {
      res.json({ success: true, data: [] });
      return;
    }

    const customers = await prisma.customer.findMany({
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

    res.json({ success: true, data: customers });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/customers/:id — With purchase summary ──────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });

    if (!customer || !customer.isActive) {
      throw new NotFoundError("Customer", req.params.id!);
    }

    // Purchase history summary
    const invoiceStats = await prisma.invoice.aggregate({
      where: { customerId: customer.id, status: { not: "CANCELLED" } },
      _sum: { totalAmount: true, amountPaid: true },
      _count: true,
    });

    const lastInvoice = await prisma.invoice.findFirst({
      where: { customerId: customer.id, status: { not: "CANCELLED" } },
      orderBy: { invoiceDate: "desc" },
      select: { invoiceNumber: true, invoiceDate: true, totalAmount: true },
    });

    res.json({
      success: true,
      data: {
        ...customer,
        purchaseSummary: {
          totalInvoices: invoiceStats._count,
          totalPurchaseAmount: invoiceStats._sum.totalAmount ?? 0,
          totalPaid: invoiceStats._sum.amountPaid ?? 0,
          lastInvoice,
        },
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── PUT /api/customers/:id — Update ─────────────────────────────────

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    if (!existing || !existing.isActive) {
      throw new NotFoundError("Customer", req.params.id!);
    }

    const parsed = updateCustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid customer data", parsed.error.errors);
    }
    const data = parsed.data;

    // If changing to B2B, require GSTIN
    const finalType = data.customerType ?? existing.customerType;
    const finalGstin = data.gstin !== undefined ? data.gstin : existing.gstin;
    if (finalType === "B2B" && !finalGstin) {
      throw new ValidationError("GSTIN is required for B2B customers");
    }

    // Auto-extract PAN from GSTIN if GSTIN changed and PAN not provided
    if (data.gstin && !data.panNumber) {
      data.panNumber = extractPanFromGstin(data.gstin);
    }

    if (data.email === "") data.email = undefined;

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data,
    });

    res.json({ success: true, data: customer });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
