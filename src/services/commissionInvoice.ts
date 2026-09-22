import prisma from "../lib/prisma.js";
import { houseSellerIsSeparateEntity, isSameLegalEntity } from "./entitySplit.js";
import { getNextInvoiceNumber } from "./invoiceNumbering.js";
import { convertAmountToWords, round2, CURRENT_TAX_RULE_VERSION } from "./taxEngine.js";
import { resolveStoreState, stateCodeFromGstin } from "../lib/stateCodes.js";
import { INVOICE_KIND } from "../data/invoiceKinds.js";
import {
  COMMISSION_GST_RATE_PCT,
  COMMISSION_SAC_CODE,
  commissionWithGst,
} from "../data/commissionTax.js";

/**
 * The platform's MONTHLY commission invoice to a seller (runbook step 17).
 *
 * This is the step the neutrality gate existed to protect. Commission is the platform's income for
 * a service it supplies to the seller; before step 13 rewrote the scope predicate, an invoice with
 * no seller supplier-snapshot read as the SHOP's own supply, and this document would have been
 * filed as the shop's income in the shop's GSTR-1. That gate was clean, so it is safe to issue.
 *
 * ⚠️ SUMMARY LINES, NOT ONE PER ORDER. A 500-order month must not produce a 500-line tax invoice.
 * Rule 46 asks for an adequate description of the service, not an itemisation of it — "Marketplace
 * commission, 1-31 Oct 2026" under SAC 998599 is sufficient, and the per-order detail belongs in
 * the settlement statement (step 19), where a seller can actually reconcile it.
 *
 * Grouped BY RATE rather than collapsed into a single untyped line, because a tax invoice has to
 * show the rate its tax was computed at. Today there is exactly one rate, so there is one line.
 */

/** YYYY-MM to the UTC half-open month window the aggregate runs over. */
function monthWindow(period: string): { start: Date; end: Date } {
  const [yy, mm] = period.split("-").map(Number);
  return {
    start: new Date(Date.UTC(yy!, mm! - 1, 1)),
    end: new Date(Date.UTC(yy!, mm!, 1)),
  };
}

/** "1-31 Oct 2026", for the line description. */
function periodLabel(period: string): string {
  const { start, end } = monthWindow(period);
  const last = new Date(end.getTime() - 86400000);
  const mon = start.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `1-${last.getUTCDate()} ${mon} ${start.getUTCFullYear()}`;
}

/**
 * The billing Customer that REPRESENTS a seller, created on first use.
 *
 * ⚠️ Deliberately separate from ensureBillingCustomer, which resolves an app USER by phone. A seller
 * is a different party wearing a different hat: here they are the platform's customer, and what
 * matters is their LEGAL name and GSTIN, not the phone their login happens to use. Matching on
 * phone would also merge a seller with their own personal shopping account — the same person, and
 * emphatically not the same taxable entity.
 *
 * ⚠️ The GSTIN is what makes the invoice B2B, which is what puts it in the right GSTR-1 table
 * (B2B rather than B2CS). It is kept in step with the seller's own record on every call, because a
 * seller who registers for GST after onboarding must not keep receiving B2CS invoices.
 */
export async function ensureSellerBillingCustomer(seller: {
  id: string; name: string; phone: string | null; gstin: string | null; pan: string | null;
}): Promise<{ id: string; gstin: string | null; name: string }> {
  const existing = await prisma.customer.findFirst({
    where: { sellerAccountId: seller.id },
    select: { id: true, gstin: true, name: true },
  });

  const desired = {
    name: seller.name,
    gstin: seller.gstin,
    panNumber: seller.pan,
    customerType: (seller.gstin ? "B2B" : "B2C") as any,
  };

  if (existing) {
    if (existing.gstin !== seller.gstin || existing.name !== seller.name) {
      return prisma.customer.update({
        where: { id: existing.id },
        data: desired,
        select: { id: true, gstin: true, name: true },
      });
    }
    return existing;
  }

  return prisma.customer.create({
    data: { ...desired, phone: seller.phone ?? "", sellerAccountId: seller.id, paymentTermsDays: 0 },
    select: { id: true, gstin: true, name: true },
  });
}

export interface CommissionInvoiceResult {
  sellerId: string;
  sellerName: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  commission: number;
  gst: number;
  total: number;
  subOrderCount: number;
  skipped?: string;
}

/**
 * Bills one seller for one month. Idempotent: a period already invoiced returns that document
 * untouched, and Invoice.commissionPeriodKey is unique, so a concurrent second press loses at the
 * database rather than producing a second invoice.
 */
export async function generateCommissionInvoice(
  sellerId: string,
  period: string,
): Promise<CommissionInvoiceResult> {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, name: true, phone: true, gstin: true, pan: true, isHouse: true },
  });
  if (!seller) throw new Error(`Seller not found: ${sellerId}`);

  const base: CommissionInvoiceResult = {
    sellerId, sellerName: seller.name, invoiceId: null, invoiceNumber: null,
    commission: 0, gst: 0, total: 0, subOrderCount: 0,
  };

  // ⚠️ The house store is the platform's own catalog. Billing it commission today would be the
  // platform invoicing itself: one legal entity, one GSTIN, a supply to nobody. That changes the
  // day StoreConfig.houseSellerIsSeparateEntity is turned on (step 23), which is exactly why the
  // test is on that flag rather than on isHouse alone.
  if (isSameLegalEntity(seller, await houseSellerIsSeparateEntity())) {
    return { ...base, skipped: "house seller - the platform and the shop are one entity" };
  }

  const key = `${sellerId}:${period}`;
  const already = await prisma.invoice.findUnique({
    where: { commissionPeriodKey: key },
    select: {
      id: true, invoiceNumber: true, subtotal: true,
      totalCgst: true, totalSgst: true, totalIgst: true, totalAmount: true,
    },
  });
  if (already) {
    return {
      ...base,
      invoiceId: already.id,
      invoiceNumber: already.invoiceNumber,
      commission: Number(already.subtotal),
      gst: Number(already.totalCgst) + Number(already.totalSgst) + Number(already.totalIgst),
      total: Number(already.totalAmount),
      skipped: "already invoiced",
    };
  }

  const { start, end } = monthWindow(period);
  // ⚠️ Cancelled orders are excluded: the platform supplied no service on an order that never
  // happened. A cancellation arriving AFTER this month is filed is step 18's problem, not this
  // one's — this aggregate is correct at the moment it runs.
  const slices = await prisma.subOrder.findMany({
    where: {
      sellerId,
      createdAt: { gte: start, lt: end },
      status: { not: "CANCELLED" },
      order: { is: { status: { not: "CANCELLED" } } },
    },
    select: { id: true, commissionAmount: true },
  });

  const commission = round2(slices.reduce((sum, s) => sum + Number(s.commissionAmount), 0));
  if (!(commission > 0)) {
    return { ...base, subOrderCount: slices.length, skipped: "no commission in this period" };
  }

  const { taxable, gst, total } = commissionWithGst(commission);
  const customer = await ensureSellerBillingCustomer(seller);

  // The platform supplies from its own place of business; the seller is the recipient. Inter-state
  // when their registrations sit in different states — and a seller with no GSTIN has no state to
  // compare, so it reads as local, matching what the goods path does for an unregistered buyer.
  const supplierStateCode = (await resolveStoreState()).code;
  const recipientStateCode = customer.gstin ? stateCodeFromGstin(customer.gstin) : supplierStateCode;
  const isInterState = recipientStateCode !== supplierStateCode;

  const half = round2(gst / 2);
  const cgstAmount = isInterState ? 0 : half;
  const sgstAmount = isInterState ? 0 : round2(gst - half); // absorbs the odd paisa
  const igstAmount = isInterState ? gst : 0;

  // Its OWN series. The platform may keep several and each must be consecutive; sharing the shop's
  // "INV" would have to be untangled the day step 23 splits the entities.
  const invoiceNumber = await getNextInvoiceNumber("COM");
  const houseCompanySnapshot = await prisma.company.findFirst({
    select: { legalName: true, tradeName: true, gstin: true, pan: true, address: true, phone: true, email: true },
  });
  // Dated the last day of the period it covers, not today: a commission invoice for October belongs
  // in October's return however late it is raised.
  //
  // ⚠️ LOCAL NOON, and both halves of that matter. The reports build their month window with
  // `new Date(year, month, 1)` — LOCAL time — so an invoice stamped at the UTC end of the month
  // (23:59:59.999Z) reads as 05:29 on the FIRST of the next month in IST and drops out of the
  // period it belongs to. Caught by running this for real: June's GSTR-1 gained ₹0.00 instead of
  // ₹21.60. Noon is unambiguous in every timezone within ±12h, and building it locally means it
  // lands inside the same window the report constructs, by construction rather than by luck.
  const lastDay = new Date(end.getTime() - 86400000);
  const invoiceDate = new Date(
    lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate(), 12, 0, 0, 0,
  );

  const invoice = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.create({
      data: {
        invoiceNumber,
        invoiceDate,
        invoiceType: "TAX_INVOICE",
        invoiceKind: INVOICE_KIND.COMMISSION,
        // B2B the moment the seller has a GSTIN, which is what lands it in the right GSTR-1 table.
        supplyType: (customer.gstin ? "B2B" : "B2CS") as any,
        commissionPeriodKey: key,
        gstr1Period: period,
        // ⚠️ NULL, like the delivery invoice. This is the platform's supply TO the seller, not the
        // seller's supply of anything; a sellerId here would be the one field standing between the
        // platform's income and that seller's own GSTR-1.
        sellerId: null,
        orderId: null,
        subOrderId: null,
        houseCompanySnapshot: houseCompanySnapshot ? (houseCompanySnapshot as any) : undefined,

        customerId: customer.id,
        customerName: customer.name,
        customerGstin: customer.gstin,

        supplierStateCode,
        placeOfSupplyCode: recipientStateCode,
        isInterState,
        taxRuleVersion: CURRENT_TAX_RULE_VERSION,

        subtotal: taxable,
        totalCgst: cgstAmount,
        totalSgst: sgstAmount,
        totalIgst: igstAmount,
        totalCess: 0,
        totalDiscount: 0,
        roundOff: 0,
        totalAmount: total,
        amountInWords: convertAmountToWords(total),

        // ⚠️ PARTIAL, not PAID, and the split is the honest part. The commission itself was
        // already recovered by withholding it from the payout; the GST on top was NOT, because
        // netPayable is subtotal - commission - tcs - tds. So the seller genuinely still owes the
        // tax, and the invoice records that instead of claiming money nobody took.
        status: "APPROVED",
        paymentStatus: (gst > 0 ? "PARTIAL" : "PAID") as any,
        amountPaid: taxable,
        amountDue: gst,

        createdBy: "system",

        lineItems: {
          create: [{
            lineNumber: 1,
            description: `Marketplace commission, ${periodLabel(period)} - per settlement statement`,
            // A SAC. The column is named hsnCode because it predates the platform supplying a
            // service; the PDF prints the right header off invoiceKind.
            hsnCode: COMMISSION_SAC_CODE,
            quantity: 1,
            unit: "NOS",
            unitPrice: taxable,
            discountPercent: 0,
            discountAmount: 0,
            taxableValue: taxable,
            gstRate: COMMISSION_GST_RATE_PCT,
            cgstRate: isInterState ? 0 : COMMISSION_GST_RATE_PCT / 2,
            cgstAmount,
            sgstRate: isInterState ? 0 : COMMISSION_GST_RATE_PCT / 2,
            sgstAmount,
            igstRate: isInterState ? COMMISSION_GST_RATE_PCT : 0,
            igstAmount,
            cessRate: 0,
            cessAmount: 0,
            totalAmount: total,
          }],
        },
      },
      select: { id: true, invoiceNumber: true },
    });

    // Snapshot what each slice was billed at, so a later rate change cannot rewrite what this
    // invoice charged — the same reason SubOrder.tcsRatePct exists. These columns were added by
    // step 04 and have been unwritten until now.
    await tx.subOrder.updateMany({
      where: { id: { in: slices.map((s) => s.id) } },
      data: { commissionGstPct: COMMISSION_GST_RATE_PCT },
    });
    for (const s of slices) {
      await tx.subOrder.update({
        where: { id: s.id },
        data: { commissionGstAmount: round2((Number(s.commissionAmount) * COMMISSION_GST_RATE_PCT) / 100) },
        select: { id: true },
      });
    }

    return inv;
  });

  return {
    ...base,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    commission: taxable,
    gst,
    total,
    subOrderCount: slices.length,
  };
}

/** Bills every seller that earned the platform commission in the period. */
export async function generateCommissionInvoicesForPeriod(
  period: string,
): Promise<CommissionInvoiceResult[]> {
  const sellers = await prisma.seller.findMany({ select: { id: true }, orderBy: { name: "asc" } });
  const out: CommissionInvoiceResult[] = [];
  for (const s of sellers) out.push(await generateCommissionInvoice(s.id, period));
  return out;
}
