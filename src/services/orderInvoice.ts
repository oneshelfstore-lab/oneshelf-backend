import prisma from "../lib/prisma.js";
import { resolveStoreState, stateCodeFromGstin } from "../lib/stateCodes.js";
import { getNextInvoiceNumber } from "./invoiceNumbering.js";
import {
  calculateLineItemTax,
  calculateInvoiceTotals,
  convertAmountToWords,
  CURRENT_TAX_RULE_VERSION,
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
  quantity: any; // Prisma Decimal at runtime — wrapped with Number(...) where used numerically
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

  // Supplier state = the ISSUING party's state (the store for a house invoice; the seller's own GSTIN
  // state for an external-seller invoice). Inter-state when the customer's state differs (P0-3): the full
  // GST rate then goes to IGST instead of CGST+SGST, and place of supply is the customer's state. A B2C
  // customer (no GSTIN) is treated as intra-state (local delivery).
  const supplierStateCode = isHouse
    ? (await resolveStoreState()).code
    : stateCodeFromGstin(seller?.gstin);
  const customerStateCode = customer.gstin ? stateCodeFromGstin(customer.gstin) : supplierStateCode;
  const isInterState = customerStateCode !== supplierStateCode;

  const lineItemTaxResults: LineItemTaxResult[] = items.map((item) =>
    calculateLineItemTax({
      unitPrice: Number(item.unitPrice),
      quantity: Number(item.quantity),
      gstRate: Number(item.gstRate),
      cessRate: 0,
      isTaxInclusive: true,
      isInterState,
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

  // Snapshot the store's OWN Company details at creation time for a house invoice — the same reason
  // supplierFromSeller snapshots an external seller's identity above, just for the store's own
  // identity instead (see Invoice.houseCompanySnapshot's doc comment on the schema).
  const houseCompanySnapshot = isHouse
    ? await prisma.company.findFirst({
        select: { legalName: true, tradeName: true, gstin: true, pan: true, address: true, phone: true, email: true },
      })
    : null;

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
        houseCompanySnapshot: houseCompanySnapshot ? (houseCompanySnapshot as any) : undefined,

        customerId: customer.id,
        customerName: order.shippingName ?? order.customer?.name ?? customer.name,
        customerGstin: customer.gstin,
        billingAddress: order.shippingAddress
          ? { address: order.shippingAddress, pincode: order.shippingPincode }
          : undefined,
        shippingAddress: order.shippingAddress
          ? { address: order.shippingAddress, pincode: order.shippingPincode }
          : undefined,

        supplierStateCode: supplierStateCode,
        placeOfSupplyCode: customerStateCode,
        isInterState: isInterState,
        taxRuleVersion: CURRENT_TAX_RULE_VERSION,

        subtotal: totals.subtotal,
        totalCgst: totals.totalCgst,
        totalSgst: totals.totalSgst,
        totalIgst: totals.totalIgst,
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
              igstRate: taxResult.igstRate,
              igstAmount: taxResult.igstAmount,
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
 * Generates ONE consolidated GST tax invoice for a monthly subscription statement, aggregating all
 * of the statement's DELIVERED MONTHLY orders' items into a single house-issued invoice. Identical
 * lines (same variant + unit price + GST rate) are collapsed (a month of daily milk → "Milk 500ml ×30").
 *
 * ⚠️ GST/CA: this is house-billed (store GSTIN) and consolidates a month of GST-inclusive lines into
 * one tax invoice. If a subscription ever covers an EXTERNAL seller's product, those lines are still
 * billed here under the store's GSTIN (v1 limitation — subscriptions are house products in practice).
 * Confirm the consolidated-invoice treatment + invoice presentation with the CA.
 *
 * Idempotent: returns the existing invoice id if the statement already has one.
 */
export async function generateStatementInvoice(statementId: string): Promise<string | null> {
  const statement = await prisma.subscriptionStatement.findUnique({
    where: { id: statementId },
    include: { orders: { include: { items: true } } },
  });
  if (!statement) return null;
  if (statement.invoiceId) return statement.invoiceId; // idempotent
  if (statement.orders.length === 0) return null;

  const customerId = await ensureBillingCustomer(statement.customerId);
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new Error("Failed to resolve billing customer");

  // Consolidate identical lines across the month (variant + unit price + GST rate).
  const lineMap = new Map<string, OrderItemRow & { quantity: number }>();
  for (const order of statement.orders) {
    for (const it of order.items) {
      const key = `${it.variantId}|${Number(it.unitPrice)}|${Number(it.gstRate)}`;
      const existing = lineMap.get(key);
      if (existing) {
        existing.quantity = +(existing.quantity + Number(it.quantity)).toFixed(6);
      } else {
        lineMap.set(key, { ...(it as OrderItemRow), quantity: Number(it.quantity) });
      }
    }
  }
  const items = [...lineMap.values()];

  const storeStateCode = (await resolveStoreState()).code; // house-billed statement → store's own state
  const customerStateCode = customer.gstin ? stateCodeFromGstin(customer.gstin) : storeStateCode;
  const isInterState = customerStateCode !== storeStateCode;

  const lineItemTaxResults: LineItemTaxResult[] = items.map((item) =>
    calculateLineItemTax({
      unitPrice: Number(item.unitPrice),
      quantity: Number(item.quantity),
      gstRate: Number(item.gstRate),
      cessRate: 0,
      isTaxInclusive: true,
      isInterState,
    }),
  );
  const totals = calculateInvoiceTotals(lineItemTaxResults);
  const invoiceNumber = await getNextInvoiceNumber("INV"); // house series
  const supplyType = customer.gstin ? "B2B" : "B2CS";
  const allExempt = lineItemTaxResults.every((r) => r.gstRate === 0);
  const invoiceType = allExempt ? "BILL_OF_SUPPLY" : "TAX_INVOICE";
  const firstOrder = statement.orders[0];

  // Always a house invoice (a consolidated monthly khata statement) — snapshot Company now, same as
  // createOneInvoice above, so a later Settings edit can't retroactively change this PDF.
  const houseCompanySnapshot = await prisma.company.findFirst({
    select: { legalName: true, tradeName: true, gstin: true, pan: true, address: true, phone: true, email: true },
  });

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      invoiceDate: new Date(),
      invoiceType: invoiceType as any,
      supplyType: supplyType as any,
      orderId: null,
      subOrderId: null,
      sellerId: null, // house-billed consolidated statement
      ...HOUSE_SUPPLIER,
      houseCompanySnapshot: houseCompanySnapshot ? (houseCompanySnapshot as any) : undefined,

      customerId: customer.id,
      customerName: firstOrder?.shippingName ?? customer.name,
      customerGstin: customer.gstin,
      billingAddress: firstOrder?.shippingAddress
        ? { address: firstOrder.shippingAddress, pincode: firstOrder.shippingPincode }
        : undefined,
      shippingAddress: firstOrder?.shippingAddress
        ? { address: firstOrder.shippingAddress, pincode: firstOrder.shippingPincode }
        : undefined,

      supplierStateCode: storeStateCode,
      placeOfSupplyCode: customerStateCode,
      isInterState: isInterState,
      taxRuleVersion: CURRENT_TAX_RULE_VERSION,

      subtotal: totals.subtotal,
      totalCgst: totals.totalCgst,
      totalSgst: totals.totalSgst,
      totalIgst: totals.totalIgst,
      totalCess: totals.totalCess,
      totalDiscount: 0,
      roundOff: totals.roundOff,
      totalAmount: totals.totalAmount,
      amountInWords: convertAmountToWords(totals.totalAmount),

      status: "APPROVED",
      paymentStatus: "UNPAID",
      amountPaid: 0,
      amountDue: totals.totalAmount,
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
            igstRate: taxResult.igstRate,
            igstAmount: taxResult.igstAmount,
            cessRate: 0,
            cessAmount: 0,
            totalAmount: taxResult.totalAmount,
          };
        }),
      },
    },
  });

  await prisma.subscriptionStatement.update({ where: { id: statementId }, data: { invoiceId: invoice.id } });
  return invoice.id;
}

/**
 * Marks a settled statement's consolidated invoice PAID and records a house Payment RECEIPT (so
 * subscription revenue shows in the store's Daily Summary). Idempotent. Called when a statement is
 * settled — wallet auto-debit or the owner's COD mark-paid.
 */
export async function markStatementInvoicePaid(
  statementId: string,
  paymentMode: "CASH" | "UPI" | "BANK_TRANSFER" = "CASH",
): Promise<void> {
  const statement = await prisma.subscriptionStatement.findUnique({
    where: { id: statementId },
    select: { invoiceId: true },
  });
  if (!statement?.invoiceId) return;
  const invoice = await prisma.invoice.findUnique({ where: { id: statement.invoiceId } });
  if (!invoice || invoice.paymentStatus === "PAID") return;

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: "PAID", paymentStatus: "PAID", amountPaid: invoice.totalAmount, amountDue: 0 },
    });
    const existing = await tx.payment.findFirst({
      where: { relatedType: "INVOICE", relatedId: invoice.id },
    });
    if (!existing) {
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
  });
}

/**
 * Full-reversal credit note for an invoice already reported in a filed GSTR-1 (P0-4). Once filed, an
 * invoice can't be un-issued — GST requires a credit note. Idempotent (one cancellation credit note per
 * invoice). Mirrors the invoice's supplier snapshot, tax heads (CGST/SGST vs IGST) and rule version, so
 * an external-seller invoice is reversed under THAT seller's identity.
 */
export async function issueCancellationCreditNote(
  invoiceId: string,
  reason = "Order cancelled",
): Promise<string | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: { orderBy: { lineNumber: "asc" } } },
  });
  if (!invoice) return null;

  const existing = await prisma.invoice.findFirst({
    where: { originalInvoiceId: invoice.id, invoiceType: "CREDIT_NOTE" },
    select: { id: true },
  });
  if (existing) return existing.id; // idempotent

  const cnNumber = await getNextInvoiceNumber("CN");
  const cn = await prisma.invoice.create({
    data: {
      invoiceNumber: cnNumber,
      invoiceDate: new Date(),
      invoiceType: "CREDIT_NOTE",
      supplyType: invoice.supplyType,

      customerId: invoice.customerId,
      customerName: invoice.customerName,
      customerGstin: invoice.customerGstin,
      billingAddress: invoice.billingAddress ?? undefined,
      shippingAddress: invoice.shippingAddress ?? undefined,

      sellerId: invoice.sellerId,
      supplierName: invoice.supplierName,
      supplierGstin: invoice.supplierGstin,
      supplierPan: invoice.supplierPan,
      supplierAddress: invoice.supplierAddress,
      supplierPhone: invoice.supplierPhone,

      supplierStateCode: invoice.supplierStateCode,
      placeOfSupplyCode: invoice.placeOfSupplyCode,
      isInterState: invoice.isInterState,
      taxRuleVersion: invoice.taxRuleVersion ?? CURRENT_TAX_RULE_VERSION,

      subtotal: invoice.subtotal,
      totalCgst: invoice.totalCgst,
      totalSgst: invoice.totalSgst,
      totalIgst: invoice.totalIgst,
      totalCess: invoice.totalCess,
      totalDiscount: invoice.totalDiscount,
      roundOff: invoice.roundOff,
      totalAmount: invoice.totalAmount,
      amountInWords: invoice.amountInWords,

      originalInvoiceId: invoice.id,
      originalInvoiceNumber: invoice.invoiceNumber,

      status: "APPROVED",
      paymentStatus: "UNPAID",
      amountPaid: 0,
      amountDue: invoice.totalAmount,
      createdBy: "system",

      lineItems: {
        create: invoice.lineItems.map((li, idx) => ({
          lineNumber: idx + 1,
          productId: li.productId,
          variantId: li.variantId,
          description: `${li.description} (Cancelled: ${reason})`,
          hsnCode: li.hsnCode,
          quantity: li.quantity,
          unit: li.unit,
          unitPrice: li.unitPrice,
          discountPercent: li.discountPercent,
          discountAmount: li.discountAmount,
          taxableValue: li.taxableValue,
          gstRate: li.gstRate,
          cgstRate: li.cgstRate,
          cgstAmount: li.cgstAmount,
          sgstRate: li.sgstRate,
          sgstAmount: li.sgstAmount,
          igstRate: li.igstRate,
          igstAmount: li.igstAmount,
          cessRate: li.cessRate,
          cessAmount: li.cessAmount,
          totalAmount: li.totalAmount,
        })),
      },
    },
  });
  return cn.id;
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
    // House/store-issued invoices represent store revenue → record a store Payment on COD→PAID. Use the
    // supplier snapshot (supplierName IS NULL ⇒ house), NOT sellerId: a marketplace house invoice carries
    // the *house seller's* id (non-null), so the old `!invoice.sellerId` wrongly skipped the store Payment
    // and dropped the store's own COD revenue from the Daily Summary (COMPLIANCE_PLAN.md P0-2).
    const isHouse = invoice.supplierName == null;
    if (isCancelled) {
      if (invoice.gstr1Filed) {
        // Already reported in a filed GSTR-1 → can't cancel; issue a reversing credit note (P0-4).
        await issueCancellationCreditNote(invoice.id, "Order cancelled");
      } else {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancellationReason: "Order cancelled",
          },
        });
      }
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
