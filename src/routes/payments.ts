import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, AppError, sendError } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";

const router = Router();

function getUserId(req: Request): string {
  return (req as AuthRequest).user?.email || "system";
}

// ─── Validation ──────────────────────────────────────────────────────

const createPaymentSchema = z.object({
  paymentType: z.enum(["RECEIPT", "PAYMENT"]),
  relatedType: z.enum(["INVOICE", "PURCHASE_BILL", "EXPENSE", "SALARY", "TDS", "GST"]),
  relatedId: z.string().min(1),
  amount: z.number().positive("Amount must be > 0"),
  paymentMode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "NEFT", "RTGS", "CREDIT"]),
  paymentDate: z.string().optional(),
  referenceNumber: z.string().optional(),
  bankAccount: z.string().optional(),
  narration: z.string().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  relatedType: z.enum(["INVOICE", "PURCHASE_BILL", "EXPENSE", "SALARY", "TDS", "GST"]).optional(),
  paymentMode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "NEFT", "RTGS", "CREDIT"]).optional(),
  paymentType: z.enum(["RECEIPT", "PAYMENT"]).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  status: z.enum(["COMPLETED", "PENDING", "FAILED", "REVERSED"]).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function logAudit(
  userId: string,
  action: "CREATE" | "UPDATE",
  entityType: string,
  entityId: string,
  oldValues?: unknown,
  newValues?: unknown,
) {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      entityType,
      entityId,
      oldValues: oldValues ? JSON.parse(JSON.stringify(oldValues)) : undefined,
      newValues: newValues ? JSON.parse(JSON.stringify(newValues)) : undefined,
    },
  });
}

// ─── POST /api/payments — Record payment ─────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid payment data", parsed.error.errors);
    }
    const input = parsed.data;
    const paymentDate = input.paymentDate ? new Date(input.paymentDate) : new Date();

    // If it's an invoice payment, update invoice balances
    if (input.relatedType === "INVOICE") {
      const invoice = await prisma.invoice.findUnique({
        where: { id: input.relatedId },
      });
      if (!invoice) throw new NotFoundError("Invoice", input.relatedId);

      if (invoice.status === "CANCELLED") {
        throw new AppError(400, "INVOICE_CANCELLED", "Cannot record payment against a cancelled invoice");
      }

      const currentDue = Number(invoice.amountDue);
      if (input.amount > currentDue) {
        throw new ValidationError(
          `Payment amount ₹${input.amount} exceeds due amount ₹${currentDue}`,
        );
      }

      const newPaid = Number(invoice.amountPaid) + input.amount;
      const newDue = Math.round((currentDue - input.amount) * 100) / 100;
      const newPaymentStatus = newDue <= 0 ? "PAID" : "PARTIAL";
      const newStatus =
        newDue <= 0 ? "PAID" : invoice.status === "DRAFT" ? "APPROVED" : invoice.status;

      const payment = await prisma.$transaction(async (tx) => {
        const pmt = await tx.payment.create({
          data: {
            paymentType: input.paymentType,
            relatedType: input.relatedType,
            relatedId: input.relatedId,
            amount: input.amount,
            paymentMode: input.paymentMode,
            paymentDate,
            referenceNumber: input.referenceNumber,
            bankAccount: input.bankAccount,
            narration: input.narration,
            status: "COMPLETED",
          },
        });

        await tx.invoice.update({
          where: { id: input.relatedId },
          data: {
            amountPaid: newPaid,
            amountDue: newDue,
            paymentStatus: newPaymentStatus,
            status: newStatus,
          },
        });

        return pmt;
      });

      await logAudit(getUserId(req), "CREATE", "Payment", payment.id, null, {
        amount: input.amount,
        invoiceNumber: invoice.invoiceNumber,
        newPaymentStatus,
      });

      res.status(201).json({ success: true, data: payment });
      return;
    }

    // If it's a purchase bill payment, update bill balances
    if (input.relatedType === "PURCHASE_BILL") {
      const bill = await prisma.purchaseBill.findUnique({
        where: { id: input.relatedId },
      });
      if (!bill) throw new NotFoundError("PurchaseBill", input.relatedId);

      const currentPayable = Number(bill.netPayable);
      // Sum existing payments
      const existingPayments = await prisma.payment.aggregate({
        where: {
          relatedType: "PURCHASE_BILL",
          relatedId: input.relatedId,
          status: "COMPLETED",
        },
        _sum: { amount: true },
      });
      const alreadyPaid = Number(existingPayments._sum.amount ?? 0);
      const remaining = Math.round((currentPayable - alreadyPaid) * 100) / 100;

      if (input.amount > remaining) {
        throw new ValidationError(
          `Payment ₹${input.amount} exceeds remaining payable ₹${remaining}`,
        );
      }

      const newBillStatus =
        remaining - input.amount <= 0 ? "PAID" : "PARTIALLY_PAID";

      const payment = await prisma.$transaction(async (tx) => {
        const pmt = await tx.payment.create({
          data: {
            paymentType: input.paymentType,
            relatedType: input.relatedType,
            relatedId: input.relatedId,
            amount: input.amount,
            paymentMode: input.paymentMode,
            paymentDate,
            referenceNumber: input.referenceNumber,
            bankAccount: input.bankAccount,
            narration: input.narration,
            status: "COMPLETED",
          },
        });

        await tx.purchaseBill.update({
          where: { id: input.relatedId },
          data: { status: newBillStatus },
        });

        return pmt;
      });

      await logAudit(getUserId(req), "CREATE", "Payment", payment.id, null, {
        amount: input.amount,
        billNumber: bill.billNumber,
        newStatus: newBillStatus,
      });

      res.status(201).json({ success: true, data: payment });
      return;
    }

    // Validate related entity exists for generic payments
    if (input.relatedType === "EXPENSE") {
      const expense = await prisma.expense.findUnique({ where: { id: input.relatedId } });
      if (!expense) throw new NotFoundError("Expense", input.relatedId);
    } else if (input.relatedType === "SALARY") {
      const salary = await prisma.salaryRecord.findUnique({ where: { id: input.relatedId } });
      if (!salary) throw new NotFoundError("SalaryRecord", input.relatedId);
    } else if (input.relatedType === "TDS") {
      const tds = await prisma.tdsRecord.findUnique({ where: { id: input.relatedId } });
      if (!tds) throw new NotFoundError("TdsRecord", input.relatedId);
    }

    // Generic payment (expense, salary, TDS, GST)
    const payment = await prisma.payment.create({
      data: {
        paymentType: input.paymentType,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        amount: input.amount,
        paymentMode: input.paymentMode,
        paymentDate,
        referenceNumber: input.referenceNumber,
        bankAccount: input.bankAccount,
        narration: input.narration,
        status: "COMPLETED",
      },
    });

    res.status(201).json({ success: true, data: payment });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/payments — List ────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, relatedType, paymentMode, paymentType, fromDate, toDate, status } =
      parsed.data;

    const where: Record<string, unknown> = {};
    if (relatedType) where.relatedType = relatedType;
    if (paymentMode) where.paymentMode = paymentMode;
    if (paymentType) where.paymentType = paymentType;
    if (status) where.status = status;
    if (fromDate || toDate) {
      const dateFilter: Record<string, Date> = {};
      if (fromDate) dateFilter.gte = new Date(fromDate);
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        dateFilter.lte = to;
      }
      where.paymentDate = dateFilter;
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { paymentDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({
      success: true,
      data: payments,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
