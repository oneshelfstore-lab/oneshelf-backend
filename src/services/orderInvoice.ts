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

type OrderItemRow = {
  variantId: string | null;
  productName: string;
  hsnCode: string | null;
  unitPrice: any;
  quantity: number;
  gstRate: any;
  isLoose: boolean;
  stepUnit: string | null;
  packageUnit: string | null;
};

type SupplierSnapshot = {
  supplierName: string | null;
  supplierGstin: string | null;
  supplierPan: string | null;
  supplierAddress: string | null;
  supplierPhone: string | null;
};

const HOUSE_SUPPLIER: SupplierSnapshot = {
  supplierName: null,
  supplierGstin: null,
  supplierPan: null,
  supplierAddress: null,
  supplierPhone: null,
};

/**
 * Snapshots an external seller's identity onto the invoice so the PDF/GSTR-1 are issued under
 * THE SELLER's GSTIN (Phase 6, CA-gated). The house seller returns all-null → the PDF falls back
 * to the store Company (the pre-Phase-6 behaviour, unchanged).
 */
function supplierFromSeller(seller: any | null): SupplierSnapshot {
  if (!seller || seller.isHouse) return HOUSE_SUPPLIER;
  const addr = [seller.shopAddress, seller.city, seller.pincode].filter(Boolean).join(", ") || null;
  return {
    supplierName: seller.name ?? null,
    supplierGstin: seller.gstin ?? null,
    supplierPan: seller.pan ?? null,
    supplierAddress: addr,
    supplierPhone: seller.phone ?? null,
  };
}

/**
 * Creates ONE invoice over the supplied order items, billed by [supplier] (house ⇒ store Company).
 * For house invoices a payment RECEIPT is recorded (store revenue); external-seller invoices record
 * NO store payment — the money is a pass-through liability settled via the seller payout ledger.
 */
async function createOneInvoice(opts: {
  order: any;
  customer: any;
  items: OrderItemRow[];
  seller: any | null;
  subOrderId: string | null;
  applyOrderDiscount: boolean; // only the single-invoice (whole-order) case carries order.discount
}): Promise<{ id: string; isHouse: boolean }> {
  const { order, customer, items, seller, subOrderId, applyOrderDiscount } = opts;
  const isHouse = !seller || seller.isHouse;
  const supplier = supplierFromSeller(seller);

  const lineItemTaxResults: LineItemTaxResult[] = items.map((item) =>
    calculateLineItemTax({
      unitPrice: Number(item.unitPrice),
      quantity: item.quantity,
      gstRate: Number(item.gstRate),
      cessRate: 0,
      isTaxInclusive: true,
    }),
  );

  const totals = calculateInvoiceTotals(lineItemTaxResults);
  // Per-seller invoice numbering: each external seller keeps its own consecutive series under its
  // GSTIN (a GST requirement); house keeps the shared "INV" series.
  const seriesPrefix = isHouse ? "INV" : `INV-${seller.slug}`;
  const invoiceNumber = await getNextInvoiceNumber(seriesPrefix);
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
        subOrderId: subOrderId,
        sellerId: seller?.id ?? null,
        ...supplier,

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
        totalDiscount: applyOrderDiscount ? Number(order.discount) : 0,
        roundOff: totals.roundOff,
        totalAmount: totals.totalAmount,
        amountInWords: convertAmountToWords(totals.totalAmount),

        status: isPaid ? "PAID" : "APPROVED",
        paymentStatus: isPaid ? "PAID" : "UNPAID",
        amountPaid: isPaid ? totals.totalAmount : 0,
        amountDue: isPaid ? 0 : totals.totalAmount,

        createdBy: "system",

        lineItems: {
          create: items.map((item, idx) => {
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

    // Store revenue is only the house store's own supplies. An external seller's invoice is the
    // seller's revenue (the platform merely collected on their behalf), so no store Payment is
    // recorded for it — the daily summary / payment reports stay the store's own books.
    if (isPaid && isHouse) {
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

  return { id: invoice.id, isHouse };
}

/**
 * Generates GST invoice(s) from a placed order — ONE per seller sub-order (Phase 6).
 * - A single-seller (house-only) order produces exactly one invoice (the pre-Phase-6 behaviour).
 * - A multi-seller order produces one invoice per seller, each billed under that seller's GSTIN.
 * - Idempotent: a sub-order that already has an invoice is skipped; legacy orders (no sub-orders)
 *   key idempotency off Order.invoiceId.
 * - Auto-creates a billing Customer from the app User if needed.
 * - Returns the "primary" invoice id (the house invoice, else the first) and points Order.invoiceId
 *   at it, so the existing single-invoice UI/PDF endpoint keeps resolving an invoice.
 *
 * Called after order creation (COD) or payment verification (online).
 */
export async function generateOrderInvoice(orderId: string): Promise<string | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      customer: true,
      subOrders: { include: { seller: true } },
    },
  });

  if (!order) return null;

  // Ensure the app user has a billing Customer record
  const customerId = await ensureBillingCustomer(order.customerId);
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new Error("Failed to resolve billing customer");

  // Group items by sub-order. Legacy items with no subOrderId fall into one null group → one
  // store-issued invoice over the whole order (the original behaviour, unchanged).
  const groups = new Map<string | null, OrderItemRow[]>();
  for (const it of order.items) {
    const key = it.subOrderId ?? null;
    const arr = groups.get(key) ?? [];
    arr.push(it as OrderItemRow);
    groups.set(key, arr);
  }

  const subOrderById = new Map(order.subOrders.map((s) => [s.id, s]));
  const singleGroup = groups.size === 1;

  let primaryInvoiceId: string | null = order.invoiceId ?? null;

  for (const [subOrderId, items] of groups) {
    const subOrder = subOrderId ? subOrderById.get(subOrderId) : null;
    const seller = subOrder?.seller ?? null;
    const isHouse = !seller || seller.isHouse;

    // Idempotency: skip a sub-order already invoiced; for the legacy null group, skip if the order
    // already has its single invoice.
    if (subOrderId) {
      const existing = await prisma.invoice.findUnique({ where: { subOrderId } });
      if (existing) {
        if (isHouse || !primaryInvoiceId) primaryInvoiceId = existing.id;
        continue;
      }
    } else if (order.invoiceId) {
      primaryInvoiceId = order.invoiceId;
      continue;
    }

    const created = await createOneInvoice({
      order,
      customer,
      items,
      seller,
      subOrderId,
      applyOrderDiscount: singleGroup,
    });
    if (created.isHouse || !primaryInvoiceId) primaryInvoiceId = created.id;
  }

  // Keep Order.invoiceId pointing at the house/primary invoice (back-compat single-invoice UI/PDF).
  if (primaryInvoiceId && primaryInvoiceId !== order.invoiceId) {
    await prisma.order.update({
      where: { id: order.id },
      data: { invoiceId: primaryInvoiceId },
    });
  }

  return primaryInvoiceId;
}

/**
 * Syncs the order's payment status to ALL the order's invoices (one per seller in Phase 6).
 * Called when order status changes (e.g. DELIVERED → COD becomes PAID).
 */
export async function syncInvoicePaymentStatus(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;

  const invoices = await prisma.invoice.findMany({ where: { orderId: order.id } });
  if (invoices.length === 0) return;

  const isPaid = order.paymentStatus === "PAID";
  const isCancelled = order.status === "CANCELLED";

  for (const invoice of invoices) {
    const isHouse = !invoice.sellerId; // only house invoices represent store revenue
    if (isCancelled) {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancellationReason: "Order cancelled",
        },
      });
    } else if (isPaid && invoice.paymentStatus !== "PAID") {
      const paymentMode = order.paymentMethod === "COD" ? "CASH"
        : order.paymentMethod === "UPI" ? "UPI"
        : "BANK_TRANSFER";
      await prisma.$transaction(async (tx) => {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            status: "PAID",
            paymentStatus: "PAID",
            amountPaid: invoice.totalAmount,
            amountDue: 0,
          },
        });
        if (isHouse) {
          const existingPayment = await tx.payment.findFirst({
            where: { relatedType: "INVOICE", relatedId: invoice.id },
          });
          if (!existingPayment) {
            await tx.payment.create({
              data: {
                paymentType: "RECEIPT",
                relatedType: "INVOICE",
                relatedId: invoice.id,
                amount: Number(invoice.totalAmount),
                paymentMode: paymentMode as any,
                paymentDate: new Date(),
                status: "COMPLETED",
              },
            });
          }
        }
      });
    }
  }
}
