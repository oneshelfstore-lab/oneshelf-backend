import prisma from "../lib/prisma.js";
import { resolveStoreState, stateCodeFromGstin } from "../lib/stateCodes.js";
import { getNextInvoiceNumber } from "./invoiceNumbering.js";
import { INVOICE_KIND } from "../data/invoiceKinds.js";
import { DELIVERY_SAC_CODE, DELIVERY_GST_RATE_PCT } from "../data/deliveryTax.js";
import {
  calculateLineItemTax,
  calculateInvoiceTotals,
  convertAmountToWords,
  round2,
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
 * ⚠️ TWO DIFFERENT QUESTIONS, and conflating them is the bug this pair exists to prevent.
 *
 *  • isStoreOwnSupply  — "are these the STORE's own goods?" → drives store REVENUE (the Payment
 *    RECEIPT and therefore the Daily Summary). An external seller's money is a pass-through
 *    liability settled via the payout ledger, never store revenue.
 *
 *  • isPlatformIssuedInvoice — "who ISSUES the tax invoice, under whose GSTIN?" → drives the
 *    supplier snapshot, supplier state code, invoice number series and the Company snapshot.
 *
 * For a SHOP seller the two answers agree (the seller both owns the supply and issues the invoice),
 * which is why one `isHouse` flag was enough before food existed. For a RESTAURANT they diverge:
 * under **GST Sec 9(5)** restaurant service supplied through an e-commerce operator makes the
 * PLATFORM the deemed supplier — the platform issues the invoice and pays the 5% itself, while the
 * money is still the restaurant's. That is also why `foodOrders.ts` sets `tcsAmount = 0` on food
 * sub-orders: Sec 9(5) and the Sec 52 / 1% TCS path are alternatives, not additions.
 */
/**
 * ⚠️ DELIBERATELY NOT GATED ON StoreConfig.houseSellerIsSeparateEntity, unlike the commission, TCS
 * and TDS exemptions that runbook step 09 moved onto that flag (services/entitySplit.ts).
 *
 * Splitting the platform off does not move the shop's sales onto a different GSTIN. The shop keeps
 * invoicing its own customers under Company, exactly as it does today; what changes is that a new
 * platform entity starts charging the shop for selling through it. So the customer invoice's
 * supplier, its number series and its revenue recognition all stay where they are.
 *
 * Gating this on the flag would swap the customer invoice's supplier onto the house Seller row the
 * moment the flag moved — a row that carries no GSTIN, no PAN and no address — and every house
 * invoice issued after that would be a defective tax invoice. Step 23 owns that question, and it
 * owns it only after a real second entity with a real registration exists.
 */
export function isStoreOwnSupply(seller: { isHouse: boolean } | null | undefined): boolean {
  return !seller || seller.isHouse;
}

export function isPlatformIssuedInvoice(
  seller: { isHouse: boolean; vertical?: string | null } | null | undefined,
): boolean {
  return isStoreOwnSupply(seller) || seller!.vertical === "FOOD";
}

/**
 * Does this seller trade under the GST COMPOSITION scheme (Sec 10, CGST Act)?
 *
 * A composition dealer pays a flat percentage of turnover and MAY NOT collect tax on its supplies.
 * So its document is a BILL OF SUPPLY carrying the Rule 5(1)(f) declaration, never a tax invoice,
 * and every tax component on it is nil.
 *
 * ⚠️ Answered from `gstScheme` and NOTHING ELSE — specifically not from "did every line come out at
 * 0% tax", which is what the invoice type used to be inferred from. Those two coincide numerically
 * and mean different things: a REGULAR dealer selling only exempt goods also reaches all-zero tax,
 * and stamping the composition declaration on that dealer's document would assert something untrue
 * about a registered business. The numbers agreeing is a coincidence; the scheme is the fact.
 *
 * ⚠️ Deliberately false for the house store and for anything the platform issues. The store's own
 * GST scheme is a property of `Company`, not of a `Seller` row, and a Sec 9(5) restaurant supply is
 * the platform's deemed supply rather than the restaurant's — so neither can be resolved from a
 * seller's `gstScheme` even when one is set.
 */
export function isCompositionSeller(
  seller: { isHouse: boolean; vertical?: string | null; gstScheme?: string | null } | null | undefined,
): boolean {
  if (isPlatformIssuedInvoice(seller)) return false;
  return seller!.gstScheme === "COMPOSITION";
}

/**
 * Snapshots an external seller's identity onto the invoice so the PDF/GSTR-1 are issued under
 * THE SELLER's GSTIN (Phase 6, CA-gated). The house seller — and, per Sec 9(5), any restaurant —
 * returns all-null → the PDF falls back to the store Company.
 */
function supplierFromSeller(seller: any | null): SupplierSnapshot {
  if (isPlatformIssuedInvoice(seller)) return HOUSE_SUPPLIER;
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
  const isHouse = isStoreOwnSupply(seller);
  const issuedByPlatform = isPlatformIssuedInvoice(seller);
  const isComposition = isCompositionSeller(seller);
  const supplier = supplierFromSeller(seller);

  // Supplier state = the ISSUING party's state (the store for a platform-issued invoice — house goods
  // or Sec 9(5) restaurant service; the seller's own GSTIN state for an external SHOP seller).
  // Inter-state when the customer's state differs (P0-3): the full GST rate then goes to IGST instead
  // of CGST+SGST, and place of supply is the customer's state. A B2C customer (no GSTIN) is treated as
  // intra-state (local delivery).
  const supplierStateCode = issuedByPlatform
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
      // A composition seller collects no tax, so the engine zeroes every component and the full
      // amount charged becomes the value of supply. The customer pays the same rupees either way —
      // the price was always GST-inclusive — only its composition on the document changes.
      isComposition,
    }),
  );

  const totals = calculateInvoiceTotals(lineItemTaxResults);
  // Per-seller invoice numbering: each external seller keeps its own consecutive series under its
  // GSTIN (a GST requirement). Everything the PLATFORM issues — house goods and Sec 9(5) restaurant
  // service alike — shares the one "INV" series, because it is all one GSTIN.
  const seriesPrefix = issuedByPlatform ? "INV" : `INV-${seller.slug}`;
  const invoiceNumber = await getNextInvoiceNumber(seriesPrefix);
  const supplyType = customer.gstin ? "B2B" : "B2CS";
  // A Bill of Supply for either of two INDEPENDENT reasons, and they are tested separately on
  // purpose. `isComposition` — the supplier may not collect tax at all — is checked FIRST and from
  // the scheme, so the document type no longer depends on the arithmetic happening to come out at
  // zero. `allExempt` remains for a REGULAR dealer whose lines are all 0%-GST, which is a different
  // document for a different reason and carries no composition declaration.
  //
  // ⚠️ Without the explicit first test this would still "work", because the engine zeroes a
  // composition seller's rates and `allExempt` would then be true — incidental correctness of
  // exactly the kind this codebase has been bitten by twice. Anyone later changing how composition
  // rates are handled would silently turn these into tax invoices.
  const allExempt = lineItemTaxResults.every((r) => r.gstRate === 0);
  const invoiceType = isComposition || allExempt ? "BILL_OF_SUPPLY" : "TAX_INVOICE";
  const isPaid = order.paymentStatus === "PAID";

  // Snapshot the store's OWN Company details at creation time for anything the platform issues — the
  // same reason supplierFromSeller snapshots an external seller's identity above, just for the store's
  // own identity instead (see Invoice.houseCompanySnapshot's doc comment on the schema).
  const houseCompanySnapshot = issuedByPlatform
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
        // Snapshotted, not looked up at render time: if this seller later moves to the regular
        // scheme, every bill of supply already issued must still carry its declaration. Null for a
        // regular seller and for anything the platform issues (see Invoice.supplierGstScheme).
        supplierGstScheme: isComposition ? "COMPOSITION" : null,
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
    // ⚠️ Deliberately keyed on isStoreOwnSupply, NOT issuedByPlatform: a Sec 9(5) food invoice is
    // issued by the platform but the money is still the restaurant's, settled through the payout
    // ledger. Recording a receipt would inflate store revenue by the full order value.
    // ⚠️ GST/CA: 9(5) makes the platform the deemed supplier, so the OUTPUT TAX on that invoice is
    // the platform's liability even though the revenue is not. Confirm with the CA how that tax is
    // to be presented in the store's own books before changing this line.
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
 * The PLATFORM's invoice to the customer for the delivery fee (runbook step 16).
 *
 * Delivery is the platform's own service, not the seller's and not part of the goods — which is why
 * it gets its own document rather than a line on somebody else's. Until now the fee was charged and
 * invoiced to nobody: the goods invoices are built from order ITEMS, so the delivery charge appeared
 * in no invoice at all and the GST inside it was never declared.
 *
 * ⚠️ WHERE THIS HANGS, AND A CORRECTION TO THE RUNBOOK. The runbook says to hang it off
 * `markOrderPaid`, "the same convergence point the goods invoice uses". markOrderPaid is not that
 * point — it is the ONLINE-payment path only, and it reaches invoicing by CALLING
 * generateOrderInvoice. A COD order invoices at placement, food at its own confirmation, bulk from
 * quoteToOrder, subscriptions from the engine; none of them pass through markOrderPaid. So the real
 * convergence point is generateOrderInvoice, and hanging it there is what makes a COD customer's
 * delivery fee get a document too. The runbook's INTENT — never in a route handler, where it would
 * only exist if the app survived the round trip — is honoured exactly.
 *
 * ⚠️ ONLY when a fee was actually charged. That is the CHARGED case from step 15; a fee waived by a
 * coupon or a member tier is a supply whose value a discount reduced to nil (Sec 15(3)(a)), and
 * whether that warrants a ₹0 document is a question for the CA rather than something to guess at by
 * emitting one. A basket over the free-delivery threshold is not a supply at all — delivery is
 * bundled into the goods, a composite supply — and must never produce a document.
 */
async function createDeliveryInvoice(order: any, customer: any): Promise<string | null> {
  const fee = Number(order.deliveryCharge ?? 0);
  if (!(fee > 0)) return null;

  // Written by step 15 on every new order. A NULL means the order predates that step, so we have no
  // honest split to invoice — better no document than an invented one.
  if (order.deliveryTaxable == null || order.deliveryGst == null) return null;
  const taxable = Number(order.deliveryTaxable);
  const gst = Number(order.deliveryGst);

  // Exactly-once, enforced by the DB rather than by this read (see Invoice.deliveryForOrderId).
  const existing = await prisma.invoice.findUnique({ where: { deliveryForOrderId: order.id } });
  if (existing) return existing.id;

  // The platform supplies from its own place of business. Today the platform and the shop are one
  // legal entity, so that is the store's state and the store's Company snapshot — when step 23 flips
  // houseSellerIsSeparateEntity these become the platform entity's, and nothing else here changes.
  const supplierStateCode = (await resolveStoreState()).code;
  const customerStateCode = customer.gstin ? stateCodeFromGstin(customer.gstin) : supplierStateCode;
  const isInterState = customerStateCode !== supplierStateCode;

  // Inter-state sends the whole tax to IGST; intra-state splits it in half. Both halves are derived
  // from the ALREADY-SPLIT figures rather than recomputed from a rate, so the invoice can never
  // disagree with the order about what the customer paid.
  const half = round2(gst / 2);
  const cgstAmount = isInterState ? 0 : half;
  const sgstAmount = isInterState ? 0 : round2(gst - half); // absorbs the odd paisa
  const igstAmount = isInterState ? gst : 0;
  // ⚠️ THE STATUTORY RATE, never one back-derived from the amounts. Dividing the rounded tax by
  // the rounded base gives 4.58 / 25.42 = 18.02%, and an invoice — and the GSTR-1 built from it —
  // that states 18.02% is simply wrong: there is no such rate. The AMOUNTS stay derived, so they
  // close on the fee exactly; the RATE is the one the law sets.
  //
  // The two need not reconcile to the paisa, and that is inherent to inclusive pricing rather than
  // a defect here: 18% of ₹41.53 is ₹7.4754, while the fee-anchored tax on a ₹49 delivery is ₹7.47.
  // Every inclusive-priced line in this system has the same property — calculateLineItemTax rounds
  // the goods the same way — so the delivery invoice is consistent with the rest of the book.
  const rate = gst > 0 ? DELIVERY_GST_RATE_PCT : 0;

  const isPaid = order.paymentStatus === "PAID";
  // Its OWN series, not the shop's "INV". One GSTIN may keep several series and each must be
  // consecutive; separating them now is correct today and still correct after step 23 splits the
  // entities, whereas sharing "INV" would have to be untangled then.
  const invoiceNumber = await getNextInvoiceNumber("DEL");

  const houseCompanySnapshot = await prisma.company.findFirst({
    select: { legalName: true, tradeName: true, gstin: true, pan: true, address: true, phone: true, email: true },
  });

  const invoice = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.create({
      data: {
        invoiceNumber,
        invoiceDate: order.createdAt,
        // A rate of zero means the fee carried no tax, so the document is a Bill of Supply — same
        // rule as the goods path, for the same reason.
        invoiceType: (gst > 0 ? "TAX_INVOICE" : "BILL_OF_SUPPLY") as any,
        invoiceKind: INVOICE_KIND.DELIVERY,
        supplyType: (customer.gstin ? "B2B" : "B2CS") as any,
        orderId: order.id,
        deliveryForOrderId: order.id,
        // ⚠️ NULL on purpose. This is not any seller's supply, and step 13's seller scope would
        // otherwise be the only thing keeping the platform's income out of a seller's own GSTR-1.
        // Two independent guards are right here; one of them being data is better than both of them
        // being code.
        sellerId: null,
        subOrderId: null,
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

        supplierStateCode,
        placeOfSupplyCode: customerStateCode,
        isInterState,
        taxRuleVersion: CURRENT_TAX_RULE_VERSION,

        subtotal: taxable,
        totalCgst: cgstAmount,
        totalSgst: sgstAmount,
        totalIgst: igstAmount,
        totalCess: 0,
        totalDiscount: 0,
        roundOff: 0,
        // The fee, unchanged. taxable + gst === fee exactly by construction (step 15 derives the
        // tax by subtraction precisely so this holds), so the customer is billed what they paid.
        totalAmount: fee,
        amountInWords: convertAmountToWords(fee),

        status: isPaid ? "PAID" : "APPROVED",
        paymentStatus: isPaid ? "PAID" : "UNPAID",
        amountPaid: isPaid ? fee : 0,
        amountDue: isPaid ? 0 : fee,

        createdBy: "system",

        lineItems: {
          create: [{
            lineNumber: 1,
            description: "Delivery charge",
            // ⚠️ A SAC, not an HSN — delivery is a SERVICE, and services are classified under the
            // Service Accounting Code. The column is named hsnCode because it predates the platform
            // supplying anything but goods; the PDF prints the right header off invoiceKind.
            hsnCode: DELIVERY_SAC_CODE,
            quantity: 1,
            unit: "NOS",
            unitPrice: taxable,
            discountPercent: 0,
            discountAmount: 0,
            taxableValue: taxable,
            gstRate: rate,
            cgstRate: isInterState ? 0 : round2(rate / 2),
            cgstAmount,
            sgstRate: isInterState ? 0 : round2(rate / 2),
            sgstAmount,
            igstRate: isInterState ? rate : 0,
            igstAmount,
            cessRate: 0,
            cessAmount: 0,
            totalAmount: fee,
          }],
        },
      },
    });

    // The delivery fee IS the platform's own revenue, unlike an external seller's goods, so a
    // receipt belongs in the books. It also closes a real under-count: the goods invoices are built
    // from order items and have never included the fee, so this money was collected and booked
    // nowhere.
    if (isPaid) {
      const paymentMode = order.paymentMethod === "COD" ? "CASH"
        : order.paymentMethod === "UPI" ? "UPI"
        : "BANK_TRANSFER";
      await tx.payment.create({
        data: {
          paymentType: "RECEIPT",
          relatedType: "INVOICE",
          relatedId: inv.id,
          amount: fee,
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

  // The platform's own delivery invoice, alongside whatever the sellers issued. Best-effort and
  // never allowed to take the goods invoices down with it: a failure here means one document is
  // missing and regenerating the order will create it, whereas throwing would lose the lot.
  //
  // ⚠️ NOT assigned to primaryInvoiceId below. Order.invoiceId is what the customer's single-invoice
  // PDF endpoint resolves, and pointing it at the delivery bill would show someone a ₹30 document
  // where they expected their groceries.
  try {
    await createDeliveryInvoice(order, customer);
  } catch (e) {
    console.error("Delivery invoice generation failed:", e);
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
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { subOrders: { select: { id: true, seller: { select: { isHouse: true, vertical: true } } } } },
  });
  if (!order) return;

  const invoices = await prisma.invoice.findMany({ where: { orderId: order.id } });
  if (invoices.length === 0) return;

  // Resolve each invoice back to its seller so the store-revenue test matches createOneInvoice's
  // exactly. Invoice has no `seller` relation (sellerId is a bare column), so go via the SubOrder.
  const sellerBySubOrder = new Map(order.subOrders.map((s) => [s.id, s.seller]));

  const isPaid = order.paymentStatus === "PAID";
  const isCancelled = order.status === "CANCELLED";

  for (const invoice of invoices) {
    // The store's OWN supplies represent store revenue → record a store Payment on COD→PAID.
    // ⚠️ This used to test `invoice.supplierName == null`, which was correct only while "platform
    // issued it" and "it's the store's own goods" meant the same thing. A Sec 9(5) food invoice is
    // platform-issued (supplierName IS NULL) but is the RESTAURANT's revenue — that test would have
    // booked the full value of every food order as store COD revenue in the Daily Summary.
    // Resolve the real seller instead and reuse the one shared predicate.
    // (Not `!invoice.sellerId` either: a marketplace house invoice carries the *house seller's* id,
    // which is the bug that once dropped the store's own COD revenue — COMPLIANCE_PLAN.md P0-2.)
    const invoiceSeller = invoice.subOrderId ? sellerBySubOrder.get(invoice.subOrderId) ?? null : null;
    const isHouse = isStoreOwnSupply(invoiceSeller);
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
