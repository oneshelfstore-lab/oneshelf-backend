import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, sendError } from "../lib/errors.js";
import { amountSchema, nonNegativeAmountSchema, dateStringSchema, paginationSchema } from "../validators/index.js";

const router = Router();

// ─── Validation ──────────────────────────────────────────────────────

const expenseCategorySchema = z.enum([
  "RENT",
  "UTILITIES",
  "TRANSPORT",
  "OFFICE_SUPPLIES",
  "PACKAGING",
  "MAINTENANCE",
  "OTHER",
]);

const paymentModeSchema = z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "NEFT", "RTGS", "CREDIT"]);

const expenseBaseSchema = z.object({
  expenseDate: dateStringSchema,
  category: expenseCategorySchema,
  description: z.string().min(1).max(500),
  amount: amountSchema,
  gstApplicable: z.boolean().default(false),
  gstAmount: nonNegativeAmountSchema.optional().nullable(),
  vendorId: z.string().min(1).optional().nullable(),
  tdsApplicable: z.boolean().default(false),
  tdsSection: z.string().max(20).optional().nullable(),
  tdsAmount: nonNegativeAmountSchema.default(0),
  paymentMode: paymentModeSchema,
  referenceNumber: z.string().max(100).optional().nullable(),
  documentUrl: z.string().url().optional().nullable(),
});

const createExpenseSchema = expenseBaseSchema;
const updateExpenseSchema = expenseBaseSchema.partial();

const listExpenseSchema = paginationSchema.extend({
  category: expenseCategorySchema.optional(),
  fromDate: dateStringSchema.optional(),
  toDate: dateStringSchema.optional(),
  vendorId: z.string().optional(),
});

// ─── POST /api/expenses ──────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid expense data", parsed.error.errors);
    }
    const input = parsed.data;

    if (input.vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId } });
      if (!vendor) throw new ValidationError(`Vendor '${input.vendorId}' not found`);
    }

    const expense = await prisma.expense.create({
      data: {
        expenseDate: new Date(input.expenseDate),
        category: input.category,
        description: input.description,
        amount: input.amount,
        gstApplicable: input.gstApplicable,
        gstAmount: input.gstAmount ?? undefined,
        vendorId: input.vendorId ?? undefined,
        tdsApplicable: input.tdsApplicable,
        tdsSection: input.tdsSection ?? undefined,
        tdsAmount: input.tdsAmount,
        paymentMode: input.paymentMode,
        referenceNumber: input.referenceNumber ?? undefined,
        documentUrl: input.documentUrl ?? undefined,
      },
    });

    res.status(201).json({ success: true, data: expense });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/expenses ───────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = listExpenseSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, category, fromDate, toDate, vendorId } = parsed.data;

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (vendorId) where.vendorId = vendorId;
    if (fromDate || toDate) {
      const range: Record<string, Date> = {};
      if (fromDate) range.gte = new Date(fromDate);
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        range.lte = to;
      }
      where.expenseDate = range;
    }

    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        include: { vendor: { select: { id: true, name: true } } },
        orderBy: { expenseDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.expense.count({ where }),
    ]);

    res.json({
      success: true,
      data: expenses,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/expenses/:id ───────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const expense = await prisma.expense.findUnique({
      where: { id: req.params.id },
      include: { vendor: { select: { id: true, name: true } } },
    });
    if (!expense) throw new NotFoundError("Expense", req.params.id!);
    res.json({ success: true, data: expense });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── PUT /api/expenses/:id ───────────────────────────────────────────

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Expense", req.params.id!);

    const parsed = updateExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid expense data", parsed.error.errors);
    }
    const input = parsed.data;

    if (input.vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId } });
      if (!vendor) throw new ValidationError(`Vendor '${input.vendorId}' not found`);
    }

    const expense = await prisma.expense.update({
      where: { id: req.params.id },
      data: {
        ...input,
        expenseDate: input.expenseDate ? new Date(input.expenseDate) : undefined,
        gstAmount: input.gstAmount === null ? null : input.gstAmount,
        vendorId: input.vendorId === null ? null : input.vendorId,
        tdsSection: input.tdsSection === null ? null : input.tdsSection,
        referenceNumber: input.referenceNumber === null ? null : input.referenceNumber,
        documentUrl: input.documentUrl === null ? null : input.documentUrl,
      },
    });

    res.json({ success: true, data: expense });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── DELETE /api/expenses/:id ────────────────────────────────────────
// Expense has no isActive flag (unlike Vendor/Employee) — a mis-entered expense is hard-deleted.
// The global audit-logger middleware records the delete regardless.

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Expense", req.params.id!);

    await prisma.expense.delete({ where: { id: req.params.id } });

    res.json({ success: true, message: "Expense deleted" });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
