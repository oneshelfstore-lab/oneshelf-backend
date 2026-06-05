import prisma from "../lib/prisma.js";
import { getNextInvoiceNumber } from "./invoiceNumbering.js";
import {
  calculateLineItemTax,
  calculateInvoiceTotals,
  convertAmountToWords,
  type LineItemTaxResult,
} from "./taxEngine.js";

/**
 * Ensures an app User has a corresponding billing Customer record.
 * Matches by phone number. Creates if not found.
 * Returns the Customer ID for use in invoices.
 */
export async function ensureBillingCustomer(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error(`User not found: ${userId}`);

  // Try to find existing Customer by phone
  if (user.phone) {
    const existing = await prisma.customer.findFirst({
      where: { phone: user.phone },
    });
    if (existing) return existing.id;
  }

  // Create new Customer from User
  const customer = await prisma.customer.create({
    data: {
      name: user.name || "App Customer",
      phone: user.phone || "",
      email: user.email,
      customerType: "B2C",
      paymentTermsDays: 0,
    },
  });

  return customer.id;
}

/**
 * Generates a GST invoice from a placed order.
 * - Auto-creates a billing Customer from the app User if needed
 * - Links the invoice to the order via orderId/invoiceId
 * - Idempotent: skips if the order already has an invoice
 *
 * Called after order creation (COD) or payment verification (online).
 */
export async function generateOrderInvoice(orderId: string): Promise<string | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, customer: true },
  });

  if (!order) return null;
  if (order.invoiceId) return order.invoiceId;

  // Ensure the app user has a billing Customer record
  const customerId = await ensureBillingCustomer(order.customerId);
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new Error("Failed to resolve billing customer");

  // Calculate tax per line item using the snapshotted order data
  const lineItemTaxResults: LineItemTaxResult[] = order.items.map((item) => {
    return calculateLineItemTax({
      unitPrice: Number(item.unitPrice),
      quantity: item.quantity,
      gstRate: Number(item.gstRate),
      cessRate: 0,
      isTaxInclusive: true,
    });
  });

  const totals = calculateInvoiceTotals(lineItemTaxResults);
  const invoiceNumber = await getNextInvoiceNumber("INV");
  const supplyType = customer.gstin ? "B2B" : "B2CS";
  const allExempt = lineItemTaxResults.every((r) => r.gstRate === 0);
  const invoiceType = allExempt ? "BILL_OF_SUPPLY" : "TAX_INVOICE";

  const isPaid = order.paymentStatus === "PAID";

  const invoice = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.create({
      data: {
        invoiceNumber,
        invoiceDate: order.createdAt,
        invoiceType: invoiceType as any,
        supplyType: supplyType as any,
        orderId: order.id,

        customerId: customer.id,
        customerName: order.shippingName ?? order.customer?.name ?? customer.name,
        customerGstin: customer.gstin,
        billingAddress: order.shippingAddress
          ? { address: order.shippingAddress, pincode: order.shippingPincode }
          : undefined,
        shippingAddress: order.shippingAddress
          ? { address: order.shippingAddress, pincode: order.shippingPincode }
          : undefined,

        supplierStateCode: "09",
        placeOfSupplyCode: "09",
        isInterState: false,

        subtotal: totals.subtotal,
        totalCgst: totals.totalCgst,
        totalSgst: totals.totalSgst,
        totalIgst: 0,
        totalCess: totals.totalCess,
        totalDiscount: Number(order.discount),
        roundOff: totals.roundOff,
        totalAmount: totals.totalAmount,
        amountInWords: convertAmountToWords(totals.totalAmount),

        status: isPaid ? "PAID" : "APPROVED",
        paymentStatus: isPaid ? "PAID" : "UNPAID",
        amountPaid: isPaid ? totals.totalAmount : 0,
        amountDue: isPaid ? 0 : totals.totalAmount,

        createdBy: "system",

        lineItems: {
          create: order.items.map((item, idx) => {
            const taxResult = lineItemTaxResults[idx]!;
            return {
              lineNumber: idx + 1,
              variantId: item.variantId,
              description: item.productName,
              hsnCode: item.hsnCode || "0000",
              quantity: item.quantity,
              unit: item.isLoose ? (item.stepUnit ?? "KG") : (item.packageUnit ?? "PCS"),
              unitPrice: Number(item.unitPrice),
              discountPercent: 0,
              discountAmount: 0,
              taxableValue: taxResult.taxableValue,
              gstRate: taxResult.gstRate,
              cgstRate: taxResult.cgstRate,
              cgstAmount: taxResult.cgstAmount,
              sgstRate: taxResult.sgstRate,
              sgstAmount: taxResult.sgstAmount,
              igstRate: 0,
              igstAmount: 0,
              cessRate: 0,
              cessAmount: 0,
              totalAmount: taxResult.totalAmount,
            };
          }),
        },
      },
    });

    // Link order → invoice
    await tx.order.update({
      where: { id: order.id },
      data: { invoiceId: inv.id },
    });

    // Create Payment record so daily summary + payment reports include app orders
    if (isPaid) {
      const paymentMode = order.paymentMethod === "COD" ? "CASH"
        : order.paymentMethod === "UPI" ? "UPI"
        : "BANK_TRANSFER";
      await tx.payment.create({
        data: {
          paymentType: "RECEIPT",
          relatedType: "INVOICE",
          relatedId: inv.id,
          amount: totals.totalAmount,
          paymentMode: paymentMode as any,
          paymentDate: order.createdAt,
          status: "COMPLETED",
        },
      });
    }

    return inv;
  });

  return invoice.id;
}

/**
 * Syncs the order's payment status to the linked invoice.
 * Called when order status changes (e.g. DELIVERED → COD becomes PAID).
 */
export async function syncInvoicePaymentStatus(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order?.invoiceId) return;

  const isPaid = order.paymentStatus === "PAID";
  const isCancelled = order.status === "CANCELLED";

  if (isCancelled) {
    await prisma.invoice.update({
      where: { id: order.invoiceId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationReason: "Order cancelled",
      },
    });
  } else if (isPaid) {
    const invoice = await prisma.invoice.findUnique({ where: { id: order.invoiceId } });
    if (invoice && invoice.paymentStatus !== "PAID") {
      const paymentMode = order.paymentMethod === "COD" ? "CASH"
        : order.paymentMethod === "UPI" ? "UPI"
        : "BANK_TRANSFER";
      await prisma.$transaction(async (tx) => {
        await tx.invoice.update({
          where: { id: order.invoiceId! },
          data: {
            status: "PAID",
            paymentStatus: "PAID",
            amountPaid: invoice.totalAmount,
            amountDue: 0,
          },
        });
        const existingPayment = await tx.payment.findFirst({
          where: { relatedType: "INVOICE", relatedId: order.invoiceId! },
        });
        if (!existingPayment) {
          await tx.payment.create({
            data: {
              paymentType: "RECEIPT",
              relatedType: "INVOICE",
              relatedId: order.invoiceId!,
              amount: Number(invoice.totalAmount),
              paymentMode: paymentMode as any,
              paymentDate: new Date(),
              status: "COMPLETED",
            },
          });
        }
      });
    }
  }
}
