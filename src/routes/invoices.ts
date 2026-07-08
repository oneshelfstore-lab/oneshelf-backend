import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError, AppError, sendError } from "../lib/errors.js";
import {
  calculateLineItemTax,
  calculateInvoiceTotals,
  convertAmountToWords,
  CURRENT_TAX_RULE_VERSION,
  type LineItemTaxResult,
} from "../services/taxEngine.js";
import { getNextInvoiceNumber } from "../services/invoiceNumbering.js";
import { generateInvoicePdf } from "../services/pdfGenerator.js";
import { resolveStoreState, stateCodeFromGstin } from "../lib/stateCodes.js";
import { consumeFifo, recordConsumption } from "../services/stockBatches.js";
import type { AuthRequest } from "../middleware/auth.js";

const router = Router();

const WALKIN_CUSTOMER_ID = "walkin-customer";

function getUserId(req: Request): string {
  return (req as AuthRequest).user?.email || "system";
}

// ─── Validation Schemas ──────────────────────────────────────────────

const createLineItemSchema = z.object({
  productId: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
  quantity: z.number().positive("Quantity must be > 0"),
  unitPrice: z.number().positive().optional(),
  discountPercent: z.number().min(0).max(100).default(0),
  discountAmount: z.number().min(0).default(0),
}).refine(data => data.productId || data.variantId, {
  message: "Either productId or variantId is required",
});

const createInvoiceSchema = z.object({
  customerId: z.string().nullable().default(null),
  invoiceType: z.enum(["TAX_INVOICE", "BILL_OF_SUPPLY"]).optional(),
  invoiceDate: z.string().optional(),
  lineItems: z.array(createLineItemSchema).min(1, "At least one line item is required"),
  paymentMode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "NEFT", "RTGS", "CREDIT"]).optional(),
  notes: z.string().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["DRAFT", "APPROVED", "SENT", "PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED"]).optional(),
  customerId: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  invoiceType: z.enum(["TAX_INVOICE", "BILL_OF_SUPPLY", "CREDIT_NOTE", "DEBIT_NOTE"]).optional(),
  supplyType: z.enum(["B2B", "B2CS"]).optional(),
  search: z.string().max(100).optional(),
});

const cancelSchema = z.object({
  cancellationReason: z.string().min(1, "Cancellation reason is required"),
});

const creditNoteLineSchema = z.object({
  originalLineId: z.string().min(1),
  returnQuantity: z.number().positive("Return quantity must be > 0"),
  returnReason: z.string().default(""),
});

const creditNoteSchema = z.object({
  originalInvoiceId: z.string().min(1),
  reason: z.enum(["return", "defective", "overcharged", "cancellation"]),
  lineItems: z.array(creditNoteLineSchema).min(1, "At least one line item is required"),
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function logAudit(
  userId: string,
  action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "CANCEL" | "EXPORT" | "LOGIN",
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

// ─── POST /api/invoices — Create invoice ─────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createInvoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid invoice data", parsed.error.errors);
    }
    const input = parsed.data;

    // 1. Resolve customer
    const customerId = input.customerId ?? WALKIN_CUSTOMER_ID;
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      throw new NotFoundError("Customer", customerId);
    }

    // Store-issued invoice → supplier state = store's own (from Company GSTIN). Inter-state when the
    // customer's GSTIN state differs; B2C (no GSTIN) is intra-state (P0-1/P0-3).
    const storeStateCode = (await resolveStoreState()).code;
    const customerStateCode = customer.gstin ? stateCodeFromGstin(customer.gstin) : storeStateCode;
    const isInterState = customerStateCode !== storeStateCode;

    // 2. Validate products — support both variantId (unified catalog) and productId (legacy)
    interface ResolvedLineItem {
      input: (typeof input.lineItems)[number];
      name: string;
      hsnCode: string;
      unit: string;
      unitPrice: number;
      gstRate: number;
      cessRate: number;
      isTaxInclusive: boolean;
      variantId: string | null;
      legacyProductId: string | null;
      trackInventory: boolean;
      tax: LineItemTaxResult;
    }

    const calculatedLines: ResolvedLineItem[] = [];
    let allExempt = true;

    for (const li of input.lineItems) {
      let name: string, hsnCode: string, unit: string, unitPrice: number,
          gstRate: number, cessRate: number, isTaxInclusive: boolean,
          resolvedVariantId: string | null = null,
          resolvedProductId: string | null = null,
          trackInventory = true;

      if (li.variantId) {
        // Unified catalog path — ProductVariant + CatalogProduct
        const variant = await prisma.productVariant.findUnique({
          where: { id: li.variantId },
          include: { product: true },
        });
        if (!variant || !variant.isActive) throw new ValidationError(`Variant ${li.variantId} not found or inactive`);

        name = `${variant.product.name} (${Number(variant.packageSize)} ${variant.packageUnit})`;
        hsnCode = variant.product.hsnCode || "0000";
        unit = variant.packageUnit;
        unitPrice = li.unitPrice ?? Number(variant.sellingPrice);
        gstRate = variant.gstRateOverride != null ? Number(variant.gstRateOverride) : Number(variant.product.gstRate ?? 0);
        cessRate = 0;
        isTaxInclusive = true;
        resolvedVariantId = variant.id;
      } else if (li.productId) {
        // Legacy path — billing Product table
        const product = await prisma.product.findUnique({ where: { id: li.productId } });
        if (!product || !product.isActive) throw new ValidationError(`Product ${li.productId} not found or inactive`);

        name = product.name;
        hsnCode = product.hsnCode;
        unit = product.unit;
        unitPrice = li.unitPrice ?? Number(product.sellingPrice);
        gstRate = Number(product.gstRate);
        cessRate = Number(product.cessRate);
        isTaxInclusive = product.isTaxInclusive;
        resolvedProductId = product.id;
        trackInventory = product.trackInventory;
      } else {
        throw new ValidationError("Either productId or variantId is required");
      }

      if (gstRate > 0) allExempt = false;

      const tax = calculateLineItemTax({
        unitPrice,
        quantity: li.quantity,
        discountPercent: li.discountPercent,
        discountAmount: li.discountAmount,
        gstRate,
        cessRate,
        isTaxInclusive,
        isInterState,
      });

      calculatedLines.push({
        input: li, name, hsnCode, unit, unitPrice, gstRate, cessRate,
        isTaxInclusive, variantId: resolvedVariantId, legacyProductId: resolvedProductId,
        trackInventory, tax,
      });
    }

    // 4. Calculate invoice totals
    const taxResults = calculatedLines.map((cl) => cl.tax);
    const totals = calculateInvoiceTotals(taxResults);

    // 5. Amount in words already in totals

    // 6. Generate invoice number
    const invoiceNumber = await getNextInvoiceNumber("INV");

    // 7. Determine supply type
    const supplyType = customer.gstin ? "B2B" : "B2CS";

    // 8. Determine invoice type
    const invoiceType = input.invoiceType ?? (allExempt ? "BILL_OF_SUPPLY" : "TAX_INVOICE");

    // 9. Parse invoice date
    const invoiceDate = input.invoiceDate ? new Date(input.invoiceDate) : new Date();

    // Determine initial status and payment
    const isPaidNow = input.paymentMode && input.paymentMode !== "CREDIT";
    const status = isPaidNow ? "PAID" : "DRAFT";
    const paymentStatus = isPaidNow ? "PAID" : "UNPAID";
    const amountPaid = isPaidNow ? totals.totalAmount : 0;
    const amountDue = isPaidNow ? 0 : totals.totalAmount;
    const paymentDueDate =
      !isPaidNow && customer.paymentTermsDays > 0
        ? new Date(invoiceDate.getTime() + customer.paymentTermsDays * 86400000)
        : null;

    const currentUser = getUserId(req);

    // 9. Save in transaction
    const invoice = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          invoiceNumber,
          invoiceDate,
          invoiceType: invoiceType as "TAX_INVOICE" | "BILL_OF_SUPPLY",
          supplyType: supplyType as "B2B" | "B2CS",

          customerId: customer.id,
          customerName: customer.name,
          customerGstin: customer.gstin,
          billingAddress: customer.billingAddress ?? undefined,
          shippingAddress: customer.shippingAddress ?? undefined,

          supplierStateCode: storeStateCode,
          placeOfSupplyCode: customerStateCode,
          isInterState: isInterState,
          taxRuleVersion: CURRENT_TAX_RULE_VERSION,

          subtotal: totals.subtotal,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: totals.totalIgst,
          totalCess: totals.totalCess,
          totalDiscount: totals.totalDiscount,
          roundOff: totals.roundOff,
          totalAmount: totals.totalAmount,
          amountInWords: totals.amountInWords,

          status,
          paymentStatus,
          amountPaid,
          amountDue,
          paymentDueDate,

          createdBy: currentUser,

          lineItems: {
            create: calculatedLines.map((cl, idx) => ({
              lineNumber: idx + 1,
              productId: cl.legacyProductId,
              variantId: cl.variantId,
              description: cl.name,
              hsnCode: cl.hsnCode,
              quantity: cl.input.quantity,
              unit: cl.unit,
              unitPrice: cl.unitPrice,
              discountPercent: cl.input.discountPercent,
              discountAmount: cl.tax.discount,
              taxableValue: cl.tax.taxableValue,
              gstRate: cl.tax.gstRate,
              cgstRate: cl.tax.cgstRate,
              cgstAmount: cl.tax.cgstAmount,
              sgstRate: cl.tax.sgstRate,
              sgstAmount: cl.tax.sgstAmount,
              igstRate: cl.tax.igstRate,
              igstAmount: cl.tax.igstAmount,
              cessRate: cl.tax.cessRate,
              cessAmount: cl.tax.cessAmount,
              totalAmount: cl.tax.totalAmount,
              isFreeItem: cl.input.discountPercent === 100,
            })),
          },
        },
        include: { lineItems: true },
      });

      // 10. Auto-create payment if paid now
      if (isPaidNow && input.paymentMode) {
        await tx.payment.create({
          data: {
            paymentType: "RECEIPT",
            relatedType: "INVOICE",
            relatedId: inv.id,
            amount: totals.totalAmount,
            paymentMode: input.paymentMode as any,
            paymentDate: invoiceDate,
            status: "COMPLETED",
          },
        });
      }

      // 11. Consume stock — unified ProductVariant draws FIFO batches (recorded against the real
      // InvoiceLineItem id, matched by lineNumber since that's the one deterministic correlation
      // key regardless of Prisma's nested-create return order); legacy Product keeps its flat
      // currentStock decrement (that table predates and sits outside the batch system entirely).
      for (let idx = 0; idx < calculatedLines.length; idx++) {
        const cl = calculatedLines[idx];
        if (cl.variantId) {
          const consumeResult = await consumeFifo(tx, cl.variantId, cl.input.quantity);
          const lineItem = inv.lineItems.find((li) => li.lineNumber === idx + 1);
          if (lineItem) await recordConsumption(tx, { invoiceLineItemId: lineItem.id }, consumeResult.consumed);
        } else if (cl.legacyProductId && cl.trackInventory) {
          await tx.product.update({
            where: { id: cl.legacyProductId },
            data: { currentStock: { decrement: Math.ceil(cl.input.quantity) } },
          });
        }
      }

      return inv;
    });

    // 12. Audit log (outside transaction — non-critical)
    await logAudit(currentUser, "CREATE", "Invoice", invoice.id, null, {
      invoiceNumber,
      totalAmount: totals.totalAmount,
      customerId: customer.id,
      lineItemCount: calculatedLines.length,
    });

    // 12. Return
    res.status(201).json({ success: true, data: invoice });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/invoices — List ────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.errors);
    }
    const { page, limit, status, customerId, fromDate, toDate, invoiceType, supplyType, search } =
      parsed.data;

    const where: Record<string, unknown> = {};

    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (invoiceType) where.invoiceType = invoiceType;
    if (supplyType) where.supplyType = supplyType;
    if (search) {
      where.invoiceNumber = { contains: search, mode: "insensitive" };
    }
    if (fromDate || toDate) {
      const dateFilter: Record<string, Date> = {};
      if (fromDate) dateFilter.gte = new Date(fromDate);
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        dateFilter.lte = to;
      }
      where.invoiceDate = dateFilter;
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { invoiceDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { lineItems: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({
      success: true,
      data: invoices,
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

// ─── GET /api/invoices/:id — Full invoice ────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        lineItems: { orderBy: { lineNumber: "asc" } },
        customer: true,
        creditDebitNotes: {
          select: { id: true, invoiceNumber: true, totalAmount: true, status: true },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundError("Invoice", req.params.id!);
    }

    // Fetch related payments
    const payments = await prisma.payment.findMany({
      where: { relatedType: "INVOICE", relatedId: invoice.id },
      orderBy: { paymentDate: "desc" },
    });

    res.json({
      success: true,
      data: { ...invoice, payments },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── POST /api/invoices/:id/cancel — Cancel invoice ──────────────────

router.post("/:id/cancel", async (req: Request, res: Response) => {
  try {
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid cancellation data", parsed.error.errors);
    }
    const { cancellationReason } = parsed.data;

    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { creditDebitNotes: { select: { id: true, invoiceNumber: true, status: true } } },
    });

    if (!invoice) {
      throw new NotFoundError("Invoice", req.params.id!);
    }

    if (invoice.status === "CANCELLED") {
      throw new AppError(400, "ALREADY_CANCELLED", "Invoice is already cancelled");
    }

    if (invoice.status === "PAID" || invoice.status === "PARTIALLY_PAID") {
      throw new AppError(
        400,
        "CANNOT_CANCEL_PAID",
        "Cannot cancel a paid invoice. Create a credit note instead.",
      );
    }

    // Once an invoice is in a FILED GSTR-1 it cannot be un-issued — GST requires a credit note (P0-4).
    if (invoice.gstr1Filed) {
      throw new AppError(
        400,
        "ALREADY_FILED",
        "This invoice is already reported in a filed GSTR-1 and cannot be cancelled. Create a credit note instead.",
      );
    }

    if (invoice.status !== "DRAFT" && invoice.status !== "APPROVED" && invoice.status !== "SENT") {
      throw new AppError(
        400,
        "CANNOT_CANCEL",
        `Cannot cancel invoice with status '${invoice.status}'`,
      );
    }

    const activeCreditNotes = invoice.creditDebitNotes.filter((cn) => cn.status !== "CANCELLED");
    if (activeCreditNotes.length > 0) {
      throw new AppError(
        400,
        "HAS_CREDIT_NOTES",
        `Cannot cancel: ${activeCreditNotes.length} active credit/debit note(s) exist against this invoice (${activeCreditNotes.map((cn) => cn.invoiceNumber).join(", ")})`,
      );
    }

    const updated = await prisma.invoice.update({
      where: { id: req.params.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationReason,
      },
    });

    await logAudit(getUserId(req), "CANCEL", "Invoice", invoice.id, { status: invoice.status }, {
      status: "CANCELLED",
      cancellationReason,
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── POST /api/invoices/credit-note — Create credit note ─────────────

router.post("/credit-note", async (req: Request, res: Response) => {
  try {
    const parsed = creditNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid credit note data", parsed.error.errors);
    }
    const input = parsed.data;

    // Fetch original invoice with line items
    const originalInvoice = await prisma.invoice.findUnique({
      where: { id: input.originalInvoiceId },
      include: { lineItems: true },
    });

    if (!originalInvoice) {
      throw new NotFoundError("Invoice", input.originalInvoiceId);
    }

    if (originalInvoice.status === "CANCELLED") {
      throw new AppError(400, "INVOICE_CANCELLED", "Cannot create credit note for a cancelled invoice");
    }

    // Build a map of original line items
    const origLineMap = new Map(originalInvoice.lineItems.map((li) => [li.id, li]));

    // Check for duplicate line IDs in request
    const lineIds = input.lineItems.map((li) => li.originalLineId);
    const dupes = lineIds.filter((id, i) => lineIds.indexOf(id) !== i);
    if (dupes.length > 0) {
      throw new ValidationError(`Duplicate line items in credit note: ${[...new Set(dupes)].join(", ")}`);
    }

    // Validate and calculate credit note lines
    const cnLines: Array<{
      origLine: (typeof originalInvoice.lineItems)[number];
      returnQty: number;
      returnReason: string;
      tax: LineItemTaxResult;
    }> = [];

    for (const cnInput of input.lineItems) {
      const origLine = origLineMap.get(cnInput.originalLineId);
      if (!origLine) {
        throw new ValidationError(
          `Original line item '${cnInput.originalLineId}' not found on invoice ${originalInvoice.invoiceNumber}`,
        );
      }

      if (cnInput.returnQuantity > Number(origLine.quantity)) {
        throw new ValidationError(
          `Return quantity (${cnInput.returnQuantity}) exceeds original quantity (${origLine.quantity}) for '${origLine.description}'`,
        );
      }

      // Calculate tax using the ORIGINAL rates (critical for compliance)
      // unitPrice stored on the line item is the pre-tax price (what the customer paid per unit),
      // so we compute tax exclusive to avoid double back-calculation
      const tax = calculateLineItemTax({
        unitPrice: Number(origLine.unitPrice),
        quantity: cnInput.returnQuantity,
        discountPercent: Number(origLine.discountPercent),
        gstRate: Number(origLine.gstRate),
        cessRate: Number(origLine.cessRate),
        isTaxInclusive: false,
        isInterState: originalInvoice.isInterState, // credit note mirrors the original's CGST/SGST vs IGST
      });

      cnLines.push({
        origLine,
        returnQty: cnInput.returnQuantity,
        returnReason: cnInput.returnReason,
        tax,
      });
    }

    // Calculate totals
    const taxResults = cnLines.map((cl) => cl.tax);
    const totals = calculateInvoiceTotals(taxResults);

    // Generate CN number
    const cnNumber = await getNextInvoiceNumber("CN");

    // Create credit note in transaction
    const creditNote = await prisma.$transaction(async (tx) => {
      const cn = await tx.invoice.create({
        data: {
          invoiceNumber: cnNumber,
          invoiceDate: new Date(),
          invoiceType: "CREDIT_NOTE",
          supplyType: originalInvoice.supplyType,

          customerId: originalInvoice.customerId,
          customerName: originalInvoice.customerName,
          customerGstin: originalInvoice.customerGstin,
          billingAddress: originalInvoice.billingAddress ?? undefined,
          shippingAddress: originalInvoice.shippingAddress ?? undefined,

          // A credit note mirrors the state / place-of-supply of the invoice it reverses.
          supplierStateCode: originalInvoice.supplierStateCode,
          placeOfSupplyCode: originalInvoice.placeOfSupplyCode,
          isInterState: originalInvoice.isInterState,
          taxRuleVersion: CURRENT_TAX_RULE_VERSION,

          subtotal: totals.subtotal,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: totals.totalIgst,
          totalCess: totals.totalCess,
          totalDiscount: totals.totalDiscount,
          roundOff: totals.roundOff,
          totalAmount: totals.totalAmount,
          amountInWords: totals.amountInWords,

          originalInvoiceId: originalInvoice.id,
          originalInvoiceNumber: originalInvoice.invoiceNumber,

          status: "APPROVED",
          paymentStatus: "UNPAID",
          amountPaid: 0,
          amountDue: totals.totalAmount,

          createdBy: getUserId(req),

          lineItems: {
            create: cnLines.map((cl, idx) => ({
              lineNumber: idx + 1,
              productId: cl.origLine.productId,
              description: `${cl.origLine.description} (Return: ${cl.returnReason || input.reason})`,
              hsnCode: cl.origLine.hsnCode,
              quantity: cl.returnQty,
              unit: cl.origLine.unit,
              unitPrice: Number(cl.origLine.unitPrice),
              discountPercent: Number(cl.origLine.discountPercent),
              discountAmount: cl.tax.discount,
              taxableValue: cl.tax.taxableValue,
              gstRate: cl.tax.gstRate,
              cgstRate: cl.tax.cgstRate,
              cgstAmount: cl.tax.cgstAmount,
              sgstRate: cl.tax.sgstRate,
              sgstAmount: cl.tax.sgstAmount,
              igstRate: cl.tax.igstRate,
              igstAmount: cl.tax.igstAmount,
              cessRate: cl.tax.cessRate,
              cessAmount: cl.tax.cessAmount,
              totalAmount: cl.tax.totalAmount,
            })),
          },
        },
        include: { lineItems: true },
      });

      return cn;
    });

    await logAudit(getUserId(req), "CREATE", "CreditNote", creditNote.id, null, {
      creditNoteNumber: cnNumber,
      originalInvoiceNumber: originalInvoice.invoiceNumber,
      totalAmount: totals.totalAmount,
      reason: input.reason,
    });

    res.status(201).json({ success: true, data: creditNote });
  } catch (error) {
    sendError(res, error);
  }
});

// ─── GET /api/invoices/:id/pdf — Generate PDF ───────────────────────

router.get("/:id/pdf", async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
    });
    if (!invoice) {
      throw new NotFoundError("Invoice", req.params.id!);
    }

    const pdfBuffer = await generateInvoicePdf(invoice.id);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${invoice.invoiceNumber.replace(/\//g, "-")}.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
