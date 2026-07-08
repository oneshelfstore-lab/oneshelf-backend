import prisma from "../lib/prisma.js";
import ExcelJS from "exceljs";
import { resolveStoreState, stateLabel, stateCodeFromGstin } from "../lib/stateCodes.js";
import { isValidGstin } from "../validators/index.js";

// ─── Invoice scope (house vs external seller) — COMPLIANCE_PLAN.md P0-2 ───────────────────────────
//
// The house store (identity B) and each external seller (identity C) are DISTINCT GST suppliers. The
// store's own GSTR-1/3B/HSN/sales must contain ONLY the store's supplies; an external seller's
// invoices belong in THEIR return. These reports therefore default to house-only.
//
// Discriminator: a house/store-issued invoice has NO supplier snapshot → `supplierName IS NULL`
// (supplierName is set only for external-seller invoices, and always set for them since Seller.name is
// required). This is more reliable than `sellerId` (which holds the *house seller's* id on marketplace
// house orders, not null) or `supplierGstin` (which is null for a GSTIN-less external seller).

export type InvoiceScope =
  | { kind: "house" }                      // the store's own supplies (identity B) — DEFAULT
  | { kind: "seller"; sellerId: string }   // one external seller's supplies (identity C)
  | { kind: "all" };                       // everything (internal reconciliation only)

export const HOUSE_SCOPE: InvoiceScope = { kind: "house" };

/** Prisma `where` fragment selecting the invoices in a given scope. */
function scopeFilter(scope: InvoiceScope): Record<string, unknown> {
  switch (scope.kind) {
    case "house": return { supplierName: null };
    case "seller": return { sellerId: scope.sellerId };
    case "all": return {};
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function num(v: unknown): number {
  if (typeof v === "number") return v;
  return parseFloat(String(v)) || 0;
}

function periodToDateRange(period: string): { from: Date; to: Date } {
  // period format: "MMYYYY" e.g. "032026" = March 2026
  const month = parseInt(period.slice(0, 2), 10) - 1; // 0-indexed
  const year = parseInt(period.slice(2), 10);
  const from = new Date(year, month, 1);
  const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
  return { from, to };
}

// ─── 1. Sales Register ───────────────────────────────────────────────

const MAX_REPORT_ROWS = 5000;

export async function getSalesRegister(from: Date, to: Date, scope: InvoiceScope = HOUSE_SCOPE) {
  const invoices = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: from, lte: to },
      status: { not: "CANCELLED" },
      ...scopeFilter(scope),
    },
    orderBy: { invoiceDate: "asc" },
    include: { lineItems: true },
    take: MAX_REPORT_ROWS,
  });

  return invoices.map((inv) => ({
    date: inv.invoiceDate.toISOString().slice(0, 10),
    invoiceNumber: inv.invoiceNumber,
    invoiceType: inv.invoiceType,
    customer: inv.customerName,
    gstin: inv.customerGstin || "",
    supplyType: inv.supplyType,
    taxable: num(inv.subtotal),
    cgst: num(inv.totalCgst),
    sgst: num(inv.totalSgst),
    cess: num(inv.totalCess),
    total: num(inv.totalAmount),
    status: inv.status,
    paymentStatus: inv.paymentStatus,
  }));
}

// ─── 2. Purchase Register ────────────────────────────────────────────

export async function getPurchaseRegister(from: Date, to: Date) {
  const bills = await prisma.purchaseBill.findMany({
    where: { billDate: { gte: from, lte: to } },
    orderBy: { billDate: "asc" },
    include: { vendor: { select: { name: true, gstin: true } } },
    take: MAX_REPORT_ROWS,
  });

  return bills.map((b) => ({
    date: b.billDate.toISOString().slice(0, 10),
    billNumber: b.billNumber,
    vendor: b.vendor.name,
    vendorGstin: b.vendorGstin || "",
    taxable: num(b.subtotal),
    cgst: num(b.totalCgst),
    sgst: num(b.totalSgst),
    igst: num(b.totalIgst),
    total: num(b.totalAmount),
    tds: num(b.tdsAmount),
    netPayable: num(b.netPayable),
    itcEligible: b.itcEligible,
    status: b.status,
  }));
}

// ─── 3. GSTR-1 Summary ──────────────────────────────────────────────

export async function getGstr1Summary(period: string, scope: InvoiceScope = HOUSE_SCOPE) {
  const { from, to } = periodToDateRange(period);
  const store = await resolveStoreState(); // for intra-state B2CS place-of-supply

  const invoices = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: from, lte: to },
      status: { not: "CANCELLED" },
      ...scopeFilter(scope),
    },
    include: { lineItems: true },
    take: MAX_REPORT_ROWS,
  });

  // B2B: invoices where customer has GSTIN. Place of supply = the invoice's own snapshotted code.
  const b2b = invoices
    .filter((inv) => inv.supplyType === "B2B" && inv.invoiceType !== "CREDIT_NOTE" && inv.invoiceType !== "DEBIT_NOTE")
    .map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
      customerGstin: inv.customerGstin,
      customerName: inv.customerName,
      invoiceValue: num(inv.totalAmount),
      taxableValue: num(inv.subtotal),
      cgst: num(inv.totalCgst),
      sgst: num(inv.totalSgst),
      placeOfSupplyCode: inv.placeOfSupplyCode,
      placeOfSupply: stateLabel(inv.placeOfSupplyCode),
      reverseCharge: "N",
    }));

  // B2CS: B2C intra-state, rate-wise summary
  const b2csInvoices = invoices.filter((inv) => inv.supplyType === "B2CS" && inv.invoiceType !== "CREDIT_NOTE");
  const b2csRateMap = new Map<number, { taxable: number; cgst: number; sgst: number; cess: number }>();
  for (const inv of b2csInvoices) {
    for (const li of inv.lineItems) {
      const rate = num(li.gstRate);
      const existing = b2csRateMap.get(rate) ?? { taxable: 0, cgst: 0, sgst: 0, cess: 0 };
      existing.taxable += num(li.taxableValue);
      existing.cgst += num(li.cgstAmount);
      existing.sgst += num(li.sgstAmount);
      existing.cess += num(li.cessAmount);
      b2csRateMap.set(rate, existing);
    }
  }
  const b2cs = Array.from(b2csRateMap.entries()).map(([rate, vals]) => ({
    rate,
    taxableValue: Math.round(vals.taxable * 100) / 100,
    cgst: Math.round(vals.cgst * 100) / 100,
    sgst: Math.round(vals.sgst * 100) / 100,
    cess: Math.round(vals.cess * 100) / 100,
    placeOfSupplyCode: store.code,
    placeOfSupply: stateLabel(store.code),
    supplyType: "INTRA",
  }));

  // Credit/Debit notes
  const creditDebitNotes = invoices
    .filter((inv) => inv.invoiceType === "CREDIT_NOTE" || inv.invoiceType === "DEBIT_NOTE")
    .map((inv) => ({
      noteNumber: inv.invoiceNumber,
      noteDate: inv.invoiceDate.toISOString().slice(0, 10),
      noteType: inv.invoiceType === "CREDIT_NOTE" ? "C" : "D",
      originalInvoiceNumber: inv.originalInvoiceNumber,
      customerGstin: inv.customerGstin,
      taxableValue: num(inv.subtotal),
      cgst: num(inv.totalCgst),
      sgst: num(inv.totalSgst),
      placeOfSupplyCode: inv.placeOfSupplyCode,
    }));

  // HSN summary
  const hsnMap = new Map<string, { description: string; qty: number; taxable: number; cgst: number; sgst: number; total: number; rate: number }>();
  for (const inv of invoices) {
    if (inv.invoiceType === "CREDIT_NOTE" || inv.invoiceType === "DEBIT_NOTE") continue;
    for (const li of inv.lineItems) {
      const key = `${li.hsnCode}_${num(li.gstRate)}`;
      const existing = hsnMap.get(key) ?? { description: li.description, qty: 0, taxable: 0, cgst: 0, sgst: 0, total: 0, rate: num(li.gstRate) };
      existing.qty += num(li.quantity);
      existing.taxable += num(li.taxableValue);
      existing.cgst += num(li.cgstAmount);
      existing.sgst += num(li.sgstAmount);
      existing.total += num(li.totalAmount);
      hsnMap.set(key, existing);
    }
  }
  const hsnSummary = Array.from(hsnMap.entries()).map(([key, vals]) => ({
    hsnCode: key.split("_")[0],
    description: vals.description,
    rate: vals.rate,
    totalQuantity: Math.round(vals.qty * 1000) / 1000,
    taxableValue: Math.round(vals.taxable * 100) / 100,
    cgst: Math.round(vals.cgst * 100) / 100,
    sgst: Math.round(vals.sgst * 100) / 100,
    totalTax: Math.round((vals.cgst + vals.sgst) * 100) / 100,
  }));

  // Document summary
  const taxInvoices = invoices.filter((inv) => inv.invoiceType === "TAX_INVOICE");
  const cancelledInPeriod = await prisma.invoice.findMany({
    where: { invoiceDate: { gte: from, lte: to }, status: "CANCELLED", ...scopeFilter(scope) },
    select: { invoiceNumber: true },
  });

  const docSummary = {
    invoices: {
      from: taxInvoices.length > 0 ? taxInvoices[0].invoiceNumber : null,
      to: taxInvoices.length > 0 ? taxInvoices[taxInvoices.length - 1].invoiceNumber : null,
      totalIssued: taxInvoices.length,
      cancelled: cancelledInPeriod.map((c) => c.invoiceNumber),
      netIssued: taxInvoices.length - cancelledInPeriod.length,
    },
  };

  return { period, b2b, b2cs, creditDebitNotes, hsnSummary, documentSummary: docSummary };
}

// ─── 4. GSTR-3B Summary ─────────────────────────────────────────────

export async function getGstr3bSummary(period: string, scope: InvoiceScope = HOUSE_SCOPE) {
  const { from, to } = periodToDateRange(period);

  // Outward supplies
  const invoices = await prisma.invoice.findMany({
    where: { invoiceDate: { gte: from, lte: to }, status: { not: "CANCELLED" }, invoiceType: { in: ["TAX_INVOICE", "BILL_OF_SUPPLY"] }, ...scopeFilter(scope) },
    include: { lineItems: true },
  });

  let taxableSupply = 0, exemptSupply = 0, nilSupply = 0;
  let outCgst = 0, outSgst = 0, outCess = 0;
  for (const inv of invoices) {
    for (const li of inv.lineItems) {
      const rate = num(li.gstRate);
      if (rate === 0) { exemptSupply += num(li.taxableValue); }
      else { taxableSupply += num(li.taxableValue); }
      outCgst += num(li.cgstAmount);
      outSgst += num(li.sgstAmount);
      outCess += num(li.cessAmount);
    }
  }

  // ITC from purchase bills — these are the STORE's inward supplies, so ITC only applies to the house
  // (and "all") view. An external seller's own purchases aren't tracked in this system → their 3B ITC is 0.
  let itcCgst = 0, itcSgst = 0, itcIgst = 0;
  if (scope.kind !== "seller") {
    const purchases = await prisma.purchaseBill.findMany({
      where: { billDate: { gte: from, lte: to }, itcEligible: true, status: { not: "DRAFT" } },
    });
    for (const b of purchases) {
      itcCgst += num(b.totalCgst);
      itcSgst += num(b.totalSgst);
      itcIgst += num(b.totalIgst);
    }
  }

  // Credit notes reduce liability
  const creditNotes = await prisma.invoice.findMany({
    where: { invoiceDate: { gte: from, lte: to }, invoiceType: "CREDIT_NOTE", status: { not: "CANCELLED" }, ...scopeFilter(scope) },
  });
  let cnCgst = 0, cnSgst = 0;
  for (const cn of creditNotes) {
    cnCgst += num(cn.totalCgst);
    cnSgst += num(cn.totalSgst);
  }

  const r = (n: number) => Math.round(n * 100) / 100;

  return {
    period,
    table3_1: {
      taxableOutward: r(taxableSupply),
      exemptOutward: r(exemptSupply),
      nilRated: r(nilSupply),
      outwardCgst: r(outCgst - cnCgst),
      outwardSgst: r(outSgst - cnSgst),
      outwardCess: r(outCess),
    },
    table4_itc: {
      cgst: r(itcCgst),
      sgst: r(itcSgst),
      igst: r(itcIgst),
    },
    taxPayable: {
      cgst: r(Math.max(0, outCgst - cnCgst - itcCgst)),
      sgst: r(Math.max(0, outSgst - cnSgst - itcSgst)),
      total: r(Math.max(0, outCgst - cnCgst - itcCgst) + Math.max(0, outSgst - cnSgst - itcSgst)),
    },
  };
}

// ─── 5. GSTR-1 JSON (GSTN schema format) ────────────────────────────

export async function getGstr1Json(period: string, scope: InvoiceScope = HOUSE_SCOPE) {
  const summary = await getGstr1Summary(period, scope);
  const company = await prisma.company.findFirst({ select: { gstin: true } });
  // The return is filed under the SUPPLIER's GSTIN: the store's for a house return, the seller's own
  // for a per-seller return (identity C).
  const seller = scope.kind === "seller"
    ? await prisma.seller.findUnique({ where: { id: scope.sellerId }, select: { gstin: true } })
    : null;
  const filerGstin = seller ? seller.gstin : company?.gstin;
  const storeCode = stateCodeFromGstin(filerGstin);

  return {
    gstin: filerGstin || `${storeCode}XXXXXXXXXXX`,
    fp: period,
    gt: 0, // will be filled by portal
    cur_gt: 0,
    // B2B invoices
    b2b: summary.b2b.map((inv) => ({
      ctin: inv.customerGstin,
      inv: [{
        inum: inv.invoiceNumber,
        idt: inv.invoiceDate.split("-").reverse().join("-"), // DD-MM-YYYY
        val: inv.invoiceValue,
        pos: inv.placeOfSupplyCode,
        rchrg: inv.reverseCharge,
        itms: [{
          num: 1,
          itm_det: {
            txval: inv.taxableValue,
            camt: inv.cgst,
            samt: inv.sgst,
            csamt: 0,
          },
        }],
      }],
    })),
    // B2CS
    b2cs: summary.b2cs.map((r) => ({
      sply_ty: r.supplyType,
      pos: r.placeOfSupplyCode,
      rt: r.rate,
      txval: r.taxableValue,
      camt: r.cgst,
      samt: r.sgst,
      csamt: r.cess,
    })),
    // Credit/Debit notes
    cdnr: summary.creditDebitNotes
      .filter((n) => n.customerGstin)
      .map((n) => ({
        ctin: n.customerGstin,
        nt: [{
          ntty: n.noteType,
          nt_num: n.noteNumber,
          nt_dt: n.noteDate.split("-").reverse().join("-"),
          val: n.taxableValue + n.cgst + n.sgst,
          pos: n.placeOfSupplyCode,
          rchrg: "N",
          itms: [{
            num: 1,
            itm_det: { txval: n.taxableValue, camt: n.cgst, samt: n.sgst, csamt: 0 },
          }],
        }],
      })),
    // HSN summary (Table 12)
    hsn: {
      data: summary.hsnSummary.map((h) => ({
        hsn_sc: h.hsnCode,
        desc: h.description,
        uqc: "NOS",
        qty: h.totalQuantity,
        rt: h.rate,
        txval: h.taxableValue,
        camt: h.cgst,
        samt: h.sgst,
        csamt: 0,
      })),
    },
    // Document summary (Table 13)
    doc_issue: {
      doc_det: [{
        doc_num: 1,
        docs: [{
          num: 1,
          from: summary.documentSummary.invoices.from,
          to: summary.documentSummary.invoices.to,
          totnum: summary.documentSummary.invoices.totalIssued,
          cancel: summary.documentSummary.invoices.cancelled.length,
          net_issue: summary.documentSummary.invoices.netIssued,
        }],
      }],
    },
  };
}

// ─── 6. HSN Summary ─────────────────────────────────────────────────

export async function getHsnSummary(from: Date, to: Date, scope: InvoiceScope = HOUSE_SCOPE) {
  const invoices = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: from, lte: to },
      status: { not: "CANCELLED" },
      invoiceType: { in: ["TAX_INVOICE", "BILL_OF_SUPPLY"] },
      ...scopeFilter(scope),
    },
    include: { lineItems: true },
  });

  const hsnMap = new Map<string, { description: string; qty: number; taxable: number; cgst: number; sgst: number; cess: number; rate: number }>();
  for (const inv of invoices) {
    for (const li of inv.lineItems) {
      const key = li.hsnCode;
      const e = hsnMap.get(key) ?? { description: li.description, qty: 0, taxable: 0, cgst: 0, sgst: 0, cess: 0, rate: num(li.gstRate) };
      e.qty += num(li.quantity);
      e.taxable += num(li.taxableValue);
      e.cgst += num(li.cgstAmount);
      e.sgst += num(li.sgstAmount);
      e.cess += num(li.cessAmount);
      hsnMap.set(key, e);
    }
  }

  const r = (n: number) => Math.round(n * 100) / 100;
  return Array.from(hsnMap.entries())
    .map(([code, v]) => ({
      hsnCode: code, description: v.description, rate: v.rate,
      totalQuantity: Math.round(v.qty * 1000) / 1000,
      taxableValue: r(v.taxable), cgst: r(v.cgst), sgst: r(v.sgst), cess: r(v.cess),
      totalTax: r(v.cgst + v.sgst + v.cess),
    }))
    .sort((a, b) => a.hsnCode.localeCompare(b.hsnCode));
}

// ─── 7. Outstanding Receivables ──────────────────────────────────────

export async function getOutstandingReceivables() {
  // Receivables = money owed TO the store, so only the store's own (house) invoices count. An external
  // seller's unpaid invoice is the seller's receivable, not the store's (COMPLIANCE_PLAN.md P0-2).
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { notIn: ["CANCELLED", "PAID"] },
      amountDue: { gt: 0 },
      ...scopeFilter(HOUSE_SCOPE),
    },
    orderBy: { invoiceDate: "asc" },
  });

  const now = Date.now();
  const buckets = { current: [] as any[], days30: [] as any[], days60: [] as any[], days90: [] as any[], over90: [] as any[] };

  for (const inv of invoices) {
    const age = Math.floor((now - inv.invoiceDate.getTime()) / 86400000);
    const entry = {
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
      customer: inv.customerName,
      customerGstin: inv.customerGstin,
      totalAmount: num(inv.totalAmount),
      amountDue: num(inv.amountDue),
      ageDays: age,
    };
    if (age <= 30) buckets.current.push(entry);
    else if (age <= 60) buckets.days30.push(entry);
    else if (age <= 90) buckets.days60.push(entry);
    else buckets.over90.push(entry);
  }

  return {
    summary: {
      current: buckets.current.reduce((s, e) => s + e.amountDue, 0),
      days31_60: buckets.days30.reduce((s, e) => s + e.amountDue, 0),
      days61_90: buckets.days60.reduce((s, e) => s + e.amountDue, 0),
      over90: buckets.over90.reduce((s, e) => s + e.amountDue, 0),
      total: invoices.reduce((s, inv) => s + num(inv.amountDue), 0),
    },
    detail: [...buckets.current, ...buckets.days30, ...buckets.days60, ...buckets.over90],
  };
}

// ─── 8. Outstanding Payables ─────────────────────────────────────────

export async function getOutstandingPayables() {
  const bills = await prisma.purchaseBill.findMany({
    where: { status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
    include: { vendor: { select: { name: true, gstin: true, isMsme: true, paymentTermsDays: true } } },
    orderBy: { billDate: "asc" },
  });

  if (bills.length === 0) return { summary: { total: 0, msmeOverdue: 0 }, detail: [] };

  // Batch-fetch all payments for these bills in one query (fixes N+1)
  const billIds = bills.map((b) => b.id);
  const allPayments = await prisma.payment.groupBy({
    by: ["relatedId"],
    where: { relatedType: "PURCHASE_BILL", relatedId: { in: billIds }, status: "COMPLETED" },
    _sum: { amount: true },
  });
  const paidMap = new Map(allPayments.map((p) => [p.relatedId, num(p._sum.amount)]));

  const now = Date.now();
  const results = [];
  for (const b of bills) {
    const paid = paidMap.get(b.id) || 0;
    const due = Math.round((num(b.netPayable) - paid) * 100) / 100;
    if (due <= 0) continue;

    const ageDays = Math.floor((now - b.billDate.getTime()) / 86400000);
    const msmeWarning = b.vendor.isMsme && ageDays > 45;

    results.push({
      billNumber: b.billNumber,
      billDate: b.billDate.toISOString().slice(0, 10),
      vendor: b.vendor.name,
      vendorGstin: b.vendorGstin,
      totalAmount: num(b.totalAmount),
      amountDue: due,
      ageDays,
      isMsme: b.vendor.isMsme,
      msmeWarning,
    });
  }

  return {
    summary: { total: results.reduce((s, r) => s + r.amountDue, 0), msmeOverdue: results.filter((r) => r.msmeWarning).length },
    detail: results,
  };
}

// ─── 9. TDS Register ─────────────────────────────────────────────────

export async function getTdsRegister(quarter: string, fy: string) {
  const records = await prisma.tdsRecord.findMany({
    where: { quarter: quarter as any, financialYear: fy },
    orderBy: { paymentDate: "asc" },
  });

  return records.map((r) => ({
    deducteeName: r.deducteeName,
    deducteeType: r.deducteeType,
    pan: r.deducteePan,
    section: r.section,
    paymentDate: r.paymentDate.toISOString().slice(0, 10),
    paymentAmount: num(r.paymentAmount),
    tdsRate: num(r.tdsRate),
    tdsAmount: num(r.tdsAmount),
    deposited: r.depositedToGovt,
    challanNumber: r.challanNumber,
  }));
}

// ─── 10. Daily Summary ───────────────────────────────────────────────

export async function getDailySummary(date: string, scope: InvoiceScope = HOUSE_SCOPE) {
  const from = new Date(date);
  from.setHours(0, 0, 0, 0);
  const to = new Date(date);
  to.setHours(23, 59, 59, 999);

  // Daily till = the store's own sales. Payments are only recorded for house invoices anyway, so
  // byPaymentMode was already house-only; this aligns totalSales/byTaxRate with it.
  const invoices = await prisma.invoice.findMany({
    where: { invoiceDate: { gte: from, lte: to }, status: { not: "CANCELLED" }, invoiceType: { in: ["TAX_INVOICE", "BILL_OF_SUPPLY"] }, ...scopeFilter(scope) },
    include: { lineItems: true },
  });

  const payments = await prisma.payment.findMany({
    where: { paymentDate: { gte: from, lte: to }, relatedType: "INVOICE", status: "COMPLETED" },
  });

  // By payment mode
  const byMode: Record<string, number> = {};
  for (const p of payments) { byMode[p.paymentMode] = (byMode[p.paymentMode] || 0) + num(p.amount); }

  // By tax rate
  const byRate: Record<number, { taxable: number; tax: number }> = {};
  for (const inv of invoices) {
    for (const li of inv.lineItems) {
      const rate = num(li.gstRate);
      const e = byRate[rate] ?? { taxable: 0, tax: 0 };
      e.taxable += num(li.taxableValue);
      e.tax += num(li.cgstAmount) + num(li.sgstAmount);
      byRate[rate] = e;
    }
  }

  // By category
  const byCat: Record<string, number> = {};
  for (const inv of invoices) {
    for (const li of inv.lineItems) {
      const cat = li.hsnCode.slice(0, 2); // rough grouping
      byCat[cat] = (byCat[cat] || 0) + num(li.totalAmount);
    }
  }

  return {
    date,
    invoiceCount: invoices.length,
    totalSales: invoices.reduce((s, inv) => s + num(inv.totalAmount), 0),
    totalTax: invoices.reduce((s, inv) => s + num(inv.totalCgst) + num(inv.totalSgst), 0),
    byPaymentMode: byMode,
    byTaxRate: Object.entries(byRate).map(([rate, v]) => ({ rate: parseFloat(rate), ...v })),
    byHsnGroup: byCat,
  };
}

// ─── Income-tax reports (P1b) ────────────────────────────────────────

/** Round to 2 dp (money). */
function money(v: number): number {
  return Math.round(v * 100) / 100;
}

// Products the STORE owns (house/legacy) vs external sellers' — for asset valuation.
const HOUSE_PRODUCT_FILTER = { OR: [{ product: { sellerId: null } }, { product: { seller: { isHouse: true } } }] };

/**
 * P&L / income summary for the store's own books (identity B, house-only). Net revenue (taxable, ex-GST,
 * less sales returns) − purchases − operating expenses − salaries. A directional accountant's summary,
 * not audited financials.
 */
export async function getProfitAndLoss(from: Date, to: Date) {
  const houseFilter = scopeFilter(HOUSE_SCOPE);

  const invoices = await prisma.invoice.findMany({
    where: { invoiceDate: { gte: from, lte: to }, status: { not: "CANCELLED" }, invoiceType: { in: ["TAX_INVOICE", "BILL_OF_SUPPLY"] }, ...houseFilter },
    select: { subtotal: true },
  });
  const revenue = invoices.reduce((s, i) => s + num(i.subtotal), 0);

  const creditNotes = await prisma.invoice.findMany({
    where: { invoiceDate: { gte: from, lte: to }, invoiceType: "CREDIT_NOTE", status: { not: "CANCELLED" }, ...houseFilter },
    select: { subtotal: true },
  });
  const salesReturns = creditNotes.reduce((s, i) => s + num(i.subtotal), 0);
  const netRevenue = revenue - salesReturns;

  const purchases = await prisma.purchaseBill.findMany({
    where: { billDate: { gte: from, lte: to }, status: { not: "DRAFT" } },
    select: { subtotal: true },
  });
  const purchaseTotal = purchases.reduce((s, b) => s + num(b.subtotal), 0);

  const expenses = await prisma.expense.findMany({
    where: { expenseDate: { gte: from, lte: to } },
    select: { category: true, amount: true },
  });
  const expenseByCategory: Record<string, number> = {};
  let expenseTotal = 0;
  for (const e of expenses) {
    const a = num(e.amount);
    expenseByCategory[e.category] = money((expenseByCategory[e.category] || 0) + a);
    expenseTotal += a;
  }

  const salaries = await prisma.salaryRecord.findMany({
    where: { status: "PAID", paymentDate: { gte: from, lte: to } },
    select: { netSalary: true },
  });
  const salaryTotal = salaries.reduce((s, r) => s + num(r.netSalary), 0);

  const grossProfit = netRevenue - purchaseTotal;
  const netProfit = grossProfit - expenseTotal - salaryTotal;

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    revenue: money(revenue),
    salesReturns: money(salesReturns),
    netRevenue: money(netRevenue),
    purchases: money(purchaseTotal),
    grossProfit: money(grossProfit),
    expenseTotal: money(expenseTotal),
    expenseByCategory,
    salaries: money(salaryTotal),
    netProfit: money(netProfit),
  };
}

/**
 * Presumptive-turnover (Sec 44AD) report for an FY starting April `fyStartYear`, with the cash-vs-digital
 * split (deemed profit is 6% on digital receipts, 8% on cash). Turnover = house invoice RECEIPTS (every
 * INVOICE-related Payment is a house payment — external-seller invoices record none), so the split is exact.
 */
export async function getPresumptiveTurnover(fyStartYear: number) {
  const from = new Date(fyStartYear, 3, 1); // Apr 1
  const to = new Date(fyStartYear + 1, 2, 31, 23, 59, 59, 999); // Mar 31

  const payments = await prisma.payment.findMany({
    where: { relatedType: "INVOICE", status: "COMPLETED", paymentDate: { gte: from, lte: to } },
    select: { amount: true, paymentMode: true },
  });
  let cash = 0, digital = 0;
  for (const p of payments) {
    const a = num(p.amount);
    if (p.paymentMode === "CASH") cash += a;
    else digital += a;
  }
  const total = cash + digital;

  return {
    financialYear: `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    cashTurnover: money(cash),
    digitalTurnover: money(digital),
    totalTurnover: money(total),
    deemedProfitRatePct: { digital: 6, cash: 8 },
    deemedProfit: money(digital * 0.06 + cash * 0.08),
    within44adCeiling: total <= 20000000, // ₹2 crore — informational; CA confirms eligibility
  };
}

/**
 * Closing-stock valuation for the store's OWN inventory (house/legacy products only — an external
 * seller's stock isn't the store's asset). Values CURRENT on-hand stock at cost; there is no historical
 * stock snapshot, so this is an as-of-now figure (label it at FY close when you run it).
 */
export async function getClosingStockValuation() {
  const variants = await prisma.productVariant.findMany({
    where: { isActive: true, ...HOUSE_PRODUCT_FILTER },
    select: { stock: true, costPrice: true, sellingPrice: true },
  });

  let atCost = 0, atSelling = 0, variantsWithStock = 0, variantsMissingCost = 0;
  for (const v of variants) {
    const stock = num(v.stock);
    if (stock <= 0) continue;
    variantsWithStock++;
    atSelling += stock * num(v.sellingPrice);
    if (v.costPrice != null) atCost += stock * num(v.costPrice);
    else variantsMissingCost++;
  }

  return {
    asOf: new Date().toISOString().slice(0, 10),
    valuationAtCost: money(atCost),
    valuationAtSellingPrice: money(atSelling),
    variantsWithStock,
    variantsMissingCost,
    hasFullCostData: variantsMissingCost === 0,
    note: "Current on-hand stock (house products) valued at cost. Variants without a cost price are excluded from the cost figure.",
  };
}

// ─── GST Health readiness dashboard (P1a-2) ──────────────────────────

/**
 * Pre-filing readiness checks for a month (period = MMYYYY), house-only. Each check is pass/warn with a
 * count + message; `readyToFile` is the headline. Pure read/derive over existing data (COMPLIANCE_PLAN.md P1a-2).
 */
export async function getGstHealth(period: string) {
  const { from, to } = periodToDateRange(period);
  const houseFilter = scopeFilter(HOUSE_SCOPE);

  const invoices = await prisma.invoice.findMany({
    where: { invoiceDate: { gte: from, lte: to }, status: { not: "CANCELLED" }, ...houseFilter },
    select: { id: true, customerGstin: true, lineItems: { select: { hsnCode: true } } },
  });

  let missingHsnLines = 0;
  const missingHsnInvoices = new Set<string>();
  let invalidGstin = 0;
  for (const inv of invoices) {
    for (const li of inv.lineItems) {
      if (!li.hsnCode || li.hsnCode === "0000" || li.hsnCode.trim() === "") {
        missingHsnLines++;
        missingHsnInvoices.add(inv.id);
      }
    }
    if (inv.customerGstin && !isValidGstin(inv.customerGstin).valid) invalidGstin++;
  }

  const ordersNoInvoice = await prisma.order.count({
    where: { createdAt: { gte: from, lte: to }, status: "DELIVERED", invoiceId: null },
  });
  const purchaseCount = await prisma.purchaseBill.count({
    where: { billDate: { gte: from, lte: to }, status: { not: "DRAFT" } },
  });
  const tcsAgg = await prisma.subOrder.aggregate({
    where: { createdAt: { gte: from, lte: to }, tcsAmount: { gt: 0 }, order: { is: { status: { not: "CANCELLED" } } } },
    _sum: { tcsAmount: true },
  });
  const tcsTotal = num(tcsAgg._sum.tcsAmount);
  const salesCount = invoices.length;

  const checks = [
    {
      key: "hsn", label: "HSN codes", ok: missingHsnLines === 0, count: missingHsnLines,
      detail: missingHsnLines === 0 ? "Every line item has an HSN code"
        : `${missingHsnLines} line item(s) across ${missingHsnInvoices.size} invoice(s) have no HSN — add HSN on those products`,
    },
    {
      key: "gstin", label: "Customer GSTINs", ok: invalidGstin === 0, count: invalidGstin,
      detail: invalidGstin === 0 ? "All customer GSTINs are valid" : `${invalidGstin} invoice(s) have an invalid customer GSTIN`,
    },
    {
      key: "orderMismatch", label: "Orders invoiced", ok: ordersNoInvoice === 0, count: ordersNoInvoice,
      detail: ordersNoInvoice === 0 ? "Every delivered order has an invoice" : `${ordersNoInvoice} delivered order(s) have no invoice`,
    },
    {
      key: "purchaseBills", label: "Purchase bills / ITC", ok: !(salesCount > 0 && purchaseCount === 0), count: purchaseCount,
      detail: purchaseCount > 0 ? `${purchaseCount} purchase bill(s) recorded` : "No purchase bills this period — you may be under-claiming input tax credit",
    },
    {
      key: "tcs", label: "TCS collected (GSTR-8)", ok: true, count: 0, amount: money(tcsTotal),
      detail: tcsTotal > 0 ? `Rs.${money(tcsTotal)} TCS collected from sellers — file GSTR-8` : "No seller TCS this period",
    },
  ];

  return {
    period,
    salesInvoiceCount: salesCount,
    readyToFile: missingHsnLines === 0 && invalidGstin === 0 && ordersNoInvoice === 0,
    checks,
  };
}

// ─── Marketplace maturity (P2) ───────────────────────────────────────

const TCS_RATE_PCT = 1; // Sec-52 (0.5% CGST + 0.5% SGST) — must match routes/orders.ts + ownerGstr8.ts

/**
 * Per-seller TCS collected in a month (period MMYYYY) — the seller's own TCS statement (P2-2). The
 * operator (Oneshelf) collected this on the seller's supplies; the seller claims it as credit.
 */
export async function getSellerTcs(sellerId: string, period: string) {
  const { from, to } = periodToDateRange(period);
  const agg = await prisma.subOrder.aggregate({
    where: {
      sellerId,
      createdAt: { gte: from, lte: to },
      tcsAmount: { gt: 0 },
      order: { is: { status: { not: "CANCELLED" } } },
    },
    _sum: { subtotal: true, tcsAmount: true },
    _count: true,
  });
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { name: true, gstin: true, pan: true },
  });
  const tcs = num(agg._sum.tcsAmount);
  const half = money(tcs / 2);
  return {
    period,
    sellerName: seller?.name ?? "",
    gstin: seller?.gstin ?? null,
    pan: seller?.pan ?? null,
    tcsRatePct: TCS_RATE_PCT,
    orderCount: agg._count,
    grossSupplies: money(num(agg._sum.subtotal)),
    netLiableValue: money(tcs / (TCS_RATE_PCT / 100)),
    tcsCgst: half,
    tcsSgst: half,
    tcsTotal: money(tcs),
  };
}

/** A supplier-filed GSTR-2B row, normalized (the caller extracts these from the portal 2B). */
export interface Gstr2bRow {
  supplierGstin: string;
  invoiceNumber: string;
  taxableValue?: number;
  taxAmount?: number;
}

/**
 * GSTR-2B reconciliation (P2-4): match supplier-filed 2B rows against our PurchaseBills so the owner only
 * claims ITC that suppliers have actually reported (blind-claiming all purchase ITC is an interest/penalty
 * risk). Match key = supplierGstin + invoiceNumber (trim/upper); a taxable-value gap >₹1 is flagged.
 */
export async function getGstr2bReconciliation(from: Date, to: Date, twoBRows: Gstr2bRow[]) {
  const bills = await prisma.purchaseBill.findMany({
    where: { billDate: { gte: from, lte: to }, status: { not: "DRAFT" } },
    include: { vendor: { select: { name: true } } },
    take: MAX_REPORT_ROWS,
  });

  const key = (gstin: string | null | undefined, inum: string) =>
    `${(gstin ?? "").trim().toUpperCase()}|${inum.trim().toUpperCase()}`;
  const twoBByKey = new Map<string, Gstr2bRow>();
  for (const r of twoBRows) twoBByKey.set(key(r.supplierGstin, r.invoiceNumber), r);

  const matched: any[] = [];
  const onlyInBooks: any[] = [];
  const usedKeys = new Set<string>();
  let matchedItc = 0, unmatchedBooksItc = 0;

  for (const b of bills) {
    const k = key(b.vendorGstin, b.billNumber);
    const itc = num(b.totalCgst) + num(b.totalSgst) + num(b.totalIgst);
    const twoB = twoBByKey.get(k);
    if (twoB) {
      usedKeys.add(k);
      const bookTaxable = num(b.subtotal);
      const valueMismatch = twoB.taxableValue != null && Math.abs(twoB.taxableValue - bookTaxable) > 1;
      matched.push({ billNumber: b.billNumber, vendor: b.vendor.name, vendorGstin: b.vendorGstin, taxable: money(bookTaxable), itc: money(itc), valueMismatch });
      matchedItc += itc;
    } else {
      onlyInBooks.push({ billNumber: b.billNumber, vendor: b.vendor.name, vendorGstin: b.vendorGstin, taxable: money(num(b.subtotal)), itc: money(itc) });
      unmatchedBooksItc += itc;
    }
  }

  const onlyIn2b = twoBRows
    .filter((r) => !usedKeys.has(key(r.supplierGstin, r.invoiceNumber)))
    .map((r) => ({ supplierGstin: r.supplierGstin, invoiceNumber: r.invoiceNumber, taxable: r.taxableValue != null ? money(r.taxableValue) : null }));

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    summary: {
      billCount: bills.length,
      twoBRowCount: twoBRows.length,
      matchedCount: matched.length,
      onlyInBooksCount: onlyInBooks.length,
      onlyIn2bCount: onlyIn2b.length,
      matchedItc: money(matchedItc),               // ITC safe to claim (supplier filed)
      unmatchedBooksItc: money(unmatchedBooksItc),  // ITC to HOLD (supplier hasn't filed yet)
    },
    matched,
    onlyInBooks, // in our books, not in 2B → supplier hasn't filed; don't claim yet
    onlyIn2b,    // in 2B, not in our books → record the purchase bill
  };
}

// ─── Excel Export ────────────────────────────────────────────────────

export async function salesRegisterToExcel(data: Awaited<ReturnType<typeof getSalesRegister>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales Register");

  ws.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Invoice #", key: "invoiceNumber", width: 18 },
    { header: "Type", key: "invoiceType", width: 16 },
    { header: "Customer", key: "customer", width: 25 },
    { header: "GSTIN", key: "gstin", width: 18 },
    { header: "Supply", key: "supplyType", width: 8 },
    { header: "Taxable (₹)", key: "taxable", width: 14 },
    { header: "CGST (₹)", key: "cgst", width: 12 },
    { header: "SGST (₹)", key: "sgst", width: 12 },
    { header: "Cess (₹)", key: "cess", width: 10 },
    { header: "Total (₹)", key: "total", width: 14 },
    { header: "Status", key: "status", width: 14 },
  ];

  // Header styling
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F5E9" } };

  for (const row of data) { ws.addRow(row); }

  // Totals row
  const totalRow = ws.addRow({
    date: "", invoiceNumber: "", invoiceType: "", customer: "TOTAL", gstin: "", supplyType: "",
    taxable: data.reduce((s, r) => s + r.taxable, 0),
    cgst: data.reduce((s, r) => s + r.cgst, 0),
    sgst: data.reduce((s, r) => s + r.sgst, 0),
    cess: data.reduce((s, r) => s + r.cess, 0),
    total: data.reduce((s, r) => s + r.total, 0),
    status: "",
  });
  totalRow.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
