import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, sendError } from "../lib/errors.js";
import { calculateLineItemTax, calculateInvoiceTotals } from "../services/taxEngine.js";

const router = Router();

// ─── Validation ──────────────────────────────────────────────────────

const billLineSchema = z.object({
  description: z.string().min(1),
  hsnCode: z.string().min(4).max(8),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0),
  gstRate: z.number().min(0).max(100),
});

const createBillSchema = z.object({
  vendorId: z.string().min(1),
  billNumber: z.string().min(1, "Vendor bill number is required"),
  billDate: z.string(),
  receivedDate: z.string().optional(),
  lineItems: z.array(billLineSchema).min(1),
  tdsAmount: z.number().min(0).default(0),
  itcEligible: z.boolean().default(true),
  isReverseCharge: z.boolean().default(false),
  paymentDueDate: z.string().optional().nullable(),
  documentUrl: z.string().optional().nullable(),
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  vendorId: z.string().optional(),
  status: z.enum(["DRAFT", "APPROVED", "PAID", "PARTIALLY_PAID"]).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

// ─── POST /api/purchase-bills ────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createBillSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid purchase bill data", parsed.error.errors);
    }
    const input = parsed.data;

    // Validate vendor
    const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId } });
    if (!vendor || !vendor.isActive) {
      throw new NotFoundError("Vendor", input.vendorId);
    }

    // Validate HSN codes against master
    const hsnCodes = [...new Set(input.lineItems.map((li) => li.hsnCode))];
    const hsnRecords = await prisma.hsnMaster.findMany({
      where: { code: { in: hsnCodes } },
      select: { code: true },
    });
    const validHsn = new Set(hsnRecords.map((h) => h.code));
    const invalidHsn = hsnCodes.filter((c) => !validHsn.has(c));
    if (invalidHsn.length > 0) {
      throw new ValidationError(`Unknown HSN codes: ${invalidHsn.join(", ")}. Add them to HSN master first.`);
    }

    // Calculate tax for each line (purchase bills are tax-exclusive from vendor)
    const calculatedLines = input.lineItems.map((li) => {
      const tax = calculateLineItemTax({
        unitPrice: li.unitPrice,
        quantity: li.quantity,
        gstRate: li.gstRate,
        isTaxInclusive: false,
      });
      return { input: li, tax };
    });

    const taxResults = calculatedLines.map((cl) => cl.tax);
    const totals = calculateInvoiceTotals(taxResults);

    const billDate = new Date(input.billDate);
    const receivedDate = input.receivedDate ? new Date(input.receivedDate) : new Date();
    const netPayable = Math.round((totals.totalAmount - input.tdsAmount) * 100) / 100;

    const bill = await prisma.$transaction(async (tx) => {
      return tx.purchaseBill.create({
        data: {
          vendorId: vendor.id,
          billNumber: input.billNumber,
          billDate,
          receivedDate,
          vendorGstin: vendor.gstin,

          subtotal: totals.subtotal,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: 0,
          totalCess: totals.totalCess,
          totalAmount: totals.totalAmount,
          tdsAmount: input.tdsAmount,
          netPayable,

          itcEligible: input.itcEligible,
          isReverseCharge: input.isReverseCharge,
          status: "APPROVED",
          paymentDueDate: input.paymentDueDate ? new Date(input.paymentDueDate) : null,
          documentUrl: input.documentUrl,

          lineItems: {
            create: calculatedLines.map((cl) => ({
              description: cl.input.description,
              hsnCode: cl.input.hsnCode,
              quantity: cl.input.quantity,
              unitPrice: cl.input.unitPrice,
              taxableValue: cl.tax.taxableValue,
              gstRate: cl.tax.gstRate,
              cgstAmount: cl.tax.cgstAmount,
              sgstAmount: cl.tax.sgstAmount,
              igstAmount: 0,
              totalAmount: cl.tax.totalAmount,
            })),
          },
        },
        include: { lineItems: true },
      });
    });

    // MSME warning
    const response: Record<string, unknown> = { success: true, data: bill };
    if (vendor.isMsme && vendor.paymentTermsDays > 45) {
      response.warning =
        "MSME vendor — payment must be made within 45 days under MSMED Act to avoid interest.";
    }

    res.status(201).json(response);
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/purchase-bills ─────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, vendorId, status, fromDate, toDate } = parsed.data;

    const where: Record<string, unknown> = {};
    if (vendorId) where.vendorId = vendorId;
    if (status) where.status = status;
    if (fromDate || toDate) {
      const dateFilter: Record<string, Date> = {};
      if (fromDate) dateFilter.gte = new Date(fromDate);
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        dateFilter.lte = to;
      }
      where.billDate = dateFilter;
    }

    const [bills, total] = await Promise.all([
      prisma.purchaseBill.findMany({
        where,
        orderBy: { billDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          vendor: { select: { id: true, name: true, gstin: true } },
          _count: { select: { lineItems: true } },
        },
      }),
      prisma.purchaseBill.count({ where }),
    ]);

    res.json({
      success: true,
      data: bills,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/purchase-bills/:id ─────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const bill = await prisma.purchaseBill.findUnique({
      where: { id: req.params.id },
      include: {
        vendor: true,
        lineItems: true,
      },
    });
    if (!bill) throw new NotFoundError("PurchaseBill", req.params.id!);

    const payments = await prisma.payment.findMany({
      where: { relatedType: "PURCHASE_BILL", relatedId: bill.id },
      orderBy: { paymentDate: "desc" },
    });

    res.json({ success: true, data: { ...bill, payments } });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── POST /api/purchase-bills/:id/payment — Quick payment ───────────

router.post("/:id/payment", async (req: Request, res: Response) => {
  try {
    const paymentSchema = z.object({
      amount: z.number().positive(),
      paymentMode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "NEFT", "RTGS"]),
      paymentDate: z.string().optional(),
      referenceNumber: z.string().optional(),
      narration: z.string().optional(),
    });

    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid payment data", parsed.error.errors);
    }
    const input = parsed.data;

    const bill = await prisma.purchaseBill.findUnique({
      where: { id: req.params.id },
    });
    if (!bill) throw new NotFoundError("PurchaseBill", req.params.id!);

    // Calculate remaining
    const existingPayments = await prisma.payment.aggregate({
      where: {
        relatedType: "PURCHASE_BILL",
        relatedId: bill.id,
        status: "COMPLETED",
      },
      _sum: { amount: true },
    });
    const alreadyPaid = Number(existingPayments._sum.amount ?? 0);
    const remaining = Math.round((Number(bill.netPayable) - alreadyPaid) * 100) / 100;

    if (input.amount > remaining) {
      throw new ValidationError(
        `Payment ₹${input.amount} exceeds remaining ₹${remaining}`,
      );
    }

    const newStatus = remaining - input.amount <= 0 ? "PAID" : "PARTIALLY_PAID";
    const paymentDate = input.paymentDate ? new Date(input.paymentDate) : new Date();

    const payment = await prisma.$transaction(async (tx) => {
      const pmt = await tx.payment.create({
        data: {
          paymentType: "PAYMENT",
          relatedType: "PURCHASE_BILL",
          relatedId: bill.id,
          amount: input.amount,
          paymentMode: input.paymentMode,
          paymentDate,
          referenceNumber: input.referenceNumber,
          narration: input.narration,
          status: "COMPLETED",
        },
      });

      await tx.purchaseBill.update({
        where: { id: bill.id },
        data: { status: newStatus },
      });

      return pmt;
    });

    res.status(201).json({ success: true, data: payment });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
