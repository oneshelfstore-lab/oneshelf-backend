import PDFDocument from "pdfkit";
import prisma from "../lib/prisma.js";
import { stateNameFromCode, stateCodeFromGstin } from "../lib/stateCodes.js";

// ─── Types ───────────────────────────────────────────────────────────

interface InvoiceData {
  // Company
  companyName: string;
  companyAddress: string;
  companyGstin: string;
  companyPan: string;
  companyPhone: string;
  companyEmail: string;
  companyState: string;
  companyStateCode: string;

  // Invoice
  invoiceTitle: string;
  invoiceNumber: string;
  invoiceDate: string;

  // Customer
  customerName: string;
  customerAddress: string;
  customerGstin: string;
  customerState: string;
  customerStateCode: string;

  // Supply
  placeOfSupply: string;
  isReverseCharge: boolean;

  // Line items
  lineItems: Array<{
    sno: number;
    description: string;
    hsnCode: string;
    qty: string;
    unit: string;
    rate: string;
    discount: string;
    taxableValue: string;
    cgstRate: string;
    cgstAmount: string;
    sgstRate: string;
    sgstAmount: string;
    total: string;
  }>;

  // Totals
  subtotal: string;
  totalCgst: string;
  totalSgst: string;
  totalCess: string;
  roundOff: string;
  grandTotal: string;
  amountInWords: string;

  // Tax breakup
  taxBreakup: Array<{
    rate: string;
    taxable: string;
    cgst: string;
    sgst: string;
    totalTax: string;
  }>;

  // Credit note reference
  originalInvoiceNumber?: string;
}

// ─── Format helpers ──────────────────────────────────────────────────

function fmt(n: number | string): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  return (isNaN(num) ? 0 : num).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function num(s: string): number {
  return Number(String(s).replace(/,/g, "").replace("−", "-")) || 0;
}

// ─── Colours / layout constants ──────────────────────────────────────

const GREEN = "#2E7D32";
const GREY = "#555555";
const LIGHT = "#EEEEEE";
const DARK = "#1A1A1A";

type Align = "left" | "right" | "center";
interface Col {
  text: string;
  width: number;
  align?: Align;
}

// ─── PDF drawing ─────────────────────────────────────────────────────

function drawInvoice(doc: PDFKit.PDFDocument, data: InvoiceData): void {
  const LEFT = doc.page.margins.left;
  const RIGHT = doc.page.width - doc.page.margins.right;
  const CONTENT_W = RIGHT - LEFT;
  const PAGE_BOTTOM = doc.page.height - doc.page.margins.bottom;

  let y = doc.page.margins.top;

  // ── Header ──────────────────────────────────────────────────────
  doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(20);
  doc.text(data.companyName, LEFT, y, { width: CONTENT_W * 0.62 });
  const afterName = doc.y;

  // Right-side invoice meta (drawn at the same top y)
  doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(13);
  doc.text(data.invoiceNumber, LEFT + CONTENT_W * 0.62, y, {
    width: CONTENT_W * 0.38,
    align: "right",
  });
  doc.fillColor(DARK).font("Helvetica").fontSize(10);
  doc.text(`Date: ${data.invoiceDate}`, LEFT + CONTENT_W * 0.62, doc.y + 2, {
    width: CONTENT_W * 0.38,
    align: "right",
  });
  doc.text(`State: ${data.companyState} (${data.companyStateCode})`, {
    width: CONTENT_W * 0.38,
    align: "right",
  });

  // Company details (left, continuing below the name)
  doc.fillColor(GREY).font("Helvetica").fontSize(9);
  doc.text(data.companyAddress, LEFT, afterName + 2, { width: CONTENT_W * 0.62 });
  doc.text(`Phone: ${data.companyPhone}   Email: ${data.companyEmail}`, {
    width: CONTENT_W * 0.62,
  });
  doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(10);
  doc.text(
    `GSTIN: ${data.companyGstin}    PAN: ${data.companyPan}`,
    { width: CONTENT_W * 0.62 },
  );

  y = Math.max(doc.y, afterName) + 6;
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(1.5).strokeColor(GREEN).stroke();
  y += 10;

  // ── Title bar ───────────────────────────────────────────────────
  doc.rect(LEFT, y, CONTENT_W, 22).fillColor("#F5F5F5").fill();
  doc.rect(LEFT, y, CONTENT_W, 22).lineWidth(0.5).strokeColor("#DDDDDD").stroke();
  doc.fillColor(DARK).font("Helvetica-Bold").fontSize(14);
  doc.text(data.invoiceTitle.toUpperCase(), LEFT, y + 4, {
    width: CONTENT_W,
    align: "center",
    characterSpacing: 2,
  });
  y += 28;

  if (data.originalInvoiceNumber) {
    doc.fillColor(DARK).font("Helvetica").fontSize(10);
    doc.text(`Against Invoice: ${data.originalInvoiceNumber}`, LEFT, y);
    y += 16;
  }

  // ── Bill To / Supply Details ────────────────────────────────────
  const colW = CONTENT_W / 2 - 6;
  const billX = LEFT;
  const supX = LEFT + CONTENT_W / 2 + 6;
  const boxTop = y;

  doc.fillColor("#888888").font("Helvetica-Bold").fontSize(9);
  doc.text("BILL TO", billX, boxTop, { width: colW, characterSpacing: 1 });
  doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11);
  doc.text(data.customerName, billX, doc.y + 2, { width: colW });
  doc.font("Helvetica").fontSize(10);
  if (data.customerAddress) doc.text(data.customerAddress, { width: colW });
  if (data.customerGstin) doc.text(`GSTIN: ${data.customerGstin}`, { width: colW });
  doc.text(`State: ${data.customerState} (${data.customerStateCode})`, { width: colW });
  const billBottom = doc.y;

  doc.fillColor("#888888").font("Helvetica-Bold").fontSize(9);
  doc.text("SUPPLY DETAILS", supX, boxTop, { width: colW, characterSpacing: 1 });
  doc.fillColor(DARK).font("Helvetica").fontSize(10);
  doc.text(`Place of Supply: ${data.placeOfSupply}`, supX, doc.y + 2, { width: colW });
  doc.text(`Reverse Charge: ${data.isReverseCharge ? "Yes" : "No"}`, { width: colW });
  const supBottom = doc.y;

  y = Math.max(billBottom, supBottom) + 12;

  // ── Line items table ────────────────────────────────────────────
  // Column widths (sum must be <= CONTENT_W ~ 539 on A4)
  const widths = {
    sno: 16,
    desc: 104,
    hsn: 34,
    qty: 28,
    unit: 26,
    rate: 42,
    disc: 34,
    taxable: 48,
    cgstR: 30,
    cgstA: 42,
    sgstR: 30,
    sgstA: 42,
    total: 50,
  };

  const headerCols: Col[] = [
    { text: "#", width: widths.sno, align: "center" },
    { text: "Description", width: widths.desc, align: "left" },
    { text: "HSN", width: widths.hsn, align: "center" },
    { text: "Qty", width: widths.qty, align: "right" },
    { text: "Unit", width: widths.unit, align: "center" },
    { text: "Rate", width: widths.rate, align: "right" },
    { text: "Disc", width: widths.disc, align: "right" },
    { text: "Taxable", width: widths.taxable, align: "right" },
    { text: "CGST%", width: widths.cgstR, align: "center" },
    { text: "CGST", width: widths.cgstA, align: "right" },
    { text: "SGST%", width: widths.sgstR, align: "center" },
    { text: "SGST", width: widths.sgstA, align: "right" },
    { text: "Total", width: widths.total, align: "right" },
  ];

  const drawTableHeader = (atY: number): number => {
    const h = 16;
    doc.rect(LEFT, atY, CONTENT_W, h).fillColor(GREEN).fill();
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(6.5);
    let x = LEFT;
    for (const c of headerCols) {
      doc.text(c.text, x + 2, atY + 5, { width: c.width - 4, align: c.align ?? "left" });
      x += c.width;
    }
    return atY + h;
  };

  y = drawTableHeader(y);

  doc.font("Helvetica").fontSize(7).fillColor(DARK);
  for (const li of data.lineItems) {
    const cells: Col[] = [
      { text: String(li.sno), width: widths.sno, align: "center" },
      { text: li.description, width: widths.desc, align: "left" },
      { text: li.hsnCode, width: widths.hsn, align: "center" },
      { text: li.qty, width: widths.qty, align: "right" },
      { text: li.unit, width: widths.unit, align: "center" },
      { text: li.rate, width: widths.rate, align: "right" },
      { text: li.discount, width: widths.disc, align: "right" },
      { text: li.taxableValue, width: widths.taxable, align: "right" },
      { text: li.cgstRate, width: widths.cgstR, align: "center" },
      { text: li.cgstAmount, width: widths.cgstA, align: "right" },
      { text: li.sgstRate, width: widths.sgstR, align: "center" },
      { text: li.sgstAmount, width: widths.sgstA, align: "right" },
      { text: li.total, width: widths.total, align: "right" },
    ];

    // Row height driven by the (potentially wrapping) description
    const descH = doc.heightOfString(li.description, { width: widths.desc - 4 });
    const rowH = Math.max(13, descH + 6);

    // Page break if needed
    if (y + rowH > PAGE_BOTTOM) {
      doc.addPage();
      y = doc.page.margins.top;
      y = drawTableHeader(y);
      doc.font("Helvetica").fontSize(7).fillColor(DARK);
    }

    let x = LEFT;
    for (const c of cells) {
      doc.text(c.text, x + 2, y + 3, { width: c.width - 4, align: c.align ?? "left" });
      x += c.width;
    }
    y += rowH;
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(LIGHT).stroke();
  }

  y += 10;

  // ── Totals (right aligned) ──────────────────────────────────────
  const totalsW = 230;
  const totalsX = RIGHT - totalsW;
  const labelW = totalsW * 0.55;
  const valW = totalsW * 0.45;

  const totalRow = (label: string, value: string, opts?: { grand?: boolean }) => {
    const rowH = opts?.grand ? 22 : 16;
    if (y + rowH > PAGE_BOTTOM) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (opts?.grand) {
      doc.moveTo(totalsX, y).lineTo(RIGHT, y).lineWidth(1.2).strokeColor(GREEN).stroke();
      doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(13);
      doc.text(label, totalsX, y + 5, { width: labelW });
      doc.text(value, totalsX + labelW, y + 5, { width: valW, align: "right" });
      doc.moveTo(totalsX, y + rowH).lineTo(RIGHT, y + rowH).lineWidth(1.2).strokeColor(GREEN).stroke();
    } else {
      doc.fillColor(DARK).font("Helvetica").fontSize(10);
      doc.text(label, totalsX, y + 3, { width: labelW });
      doc.text(value, totalsX + labelW, y + 3, { width: valW, align: "right" });
    }
    y += rowH;
  };

  totalRow("Taxable Value", `Rs. ${data.subtotal}`);
  totalRow("CGST", `Rs. ${data.totalCgst}`);
  totalRow("SGST", `Rs. ${data.totalSgst}`);
  if (num(data.totalCess) > 0) totalRow("Cess", `Rs. ${data.totalCess}`);
  if (num(data.roundOff) !== 0) totalRow("Round Off", `Rs. ${data.roundOff}`);
  totalRow("Grand Total", `Rs. ${data.grandTotal}`, { grand: true });

  y += 10;

  // ── Amount in words ─────────────────────────────────────────────
  if (y + 30 > PAGE_BOTTOM) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.rect(LEFT, y, CONTENT_W, 26).fillColor("#FAFAFA").fill();
  doc.rect(LEFT, y, CONTENT_W, 26).lineWidth(0.5).strokeColor(LIGHT).stroke();
  doc.fillColor(DARK).font("Helvetica").fontSize(10);
  doc.text("Amount in words: ", LEFT + 8, y + 7, { continued: true });
  doc.font("Helvetica-Bold").text(data.amountInWords, { width: CONTENT_W - 16 });
  y += 36;

  // ── Tax breakup ─────────────────────────────────────────────────
  if (y + 60 > PAGE_BOTTOM) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.fillColor("#888888").font("Helvetica-Bold").fontSize(9);
  doc.text("TAX BREAKUP", LEFT, y, { characterSpacing: 1 });
  y += 14;

  const tbWidths = [90, 130, 100, 100, 100]; // sum 520, fits
  const tbHeaders = ["GST Rate", "Taxable (Rs.)", "CGST (Rs.)", "SGST (Rs.)", "Total Tax (Rs.)"];
  const tbAligns: Align[] = ["center", "right", "right", "right", "right"];

  const tbHeaderH = 15;
  doc.rect(LEFT, y, tbWidths.reduce((a, b) => a + b, 0), tbHeaderH).fillColor(GREEN).fill();
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8);
  let tx = LEFT;
  tbHeaders.forEach((h, i) => {
    doc.text(h, tx + 2, y + 4, { width: tbWidths[i] - 4, align: tbAligns[i] });
    tx += tbWidths[i];
  });
  y += tbHeaderH;

  doc.font("Helvetica").fontSize(9).fillColor(DARK);
  for (const tb of data.taxBreakup) {
    const cells = [tb.rate, tb.taxable, tb.cgst, tb.sgst, tb.totalTax];
    if (y + 14 > PAGE_BOTTOM) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    tx = LEFT;
    cells.forEach((c, i) => {
      doc.text(c, tx + 2, y + 3, { width: tbWidths[i] - 4, align: tbAligns[i] });
      tx += tbWidths[i];
    });
    y += 14;
    doc.moveTo(LEFT, y).lineTo(LEFT + tbWidths.reduce((a, b) => a + b, 0), y)
      .lineWidth(0.5).strokeColor(LIGHT).stroke();
  }

  y += 20;

  // ── Footer (terms + signatory) ──────────────────────────────────
  if (y + 80 > PAGE_BOTTOM) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor("#DDDDDD").stroke();
  y += 10;

  const footTop = y;
  doc.fillColor(GREY).font("Helvetica-Bold").fontSize(9);
  doc.text("Terms & Conditions:", LEFT, footTop, { width: CONTENT_W * 0.55 });
  doc.font("Helvetica").fontSize(8);
  doc.text("1. Goods once sold will not be taken back or exchanged.", { width: CONTENT_W * 0.55 });
  doc.text("2. Interest @ 18% p.a. will be charged on overdue payments.", { width: CONTENT_W * 0.55 });
  doc.text(`3. Subject to ${data.companyState} jurisdiction only.`, { width: CONTENT_W * 0.55 });

  doc.fillColor(DARK).font("Helvetica").fontSize(10);
  doc.text(`For ${data.companyName}`, LEFT + CONTENT_W * 0.6, footTop, {
    width: CONTENT_W * 0.4,
    align: "right",
  });
  doc.font("Helvetica-Bold").fontSize(10);
  doc.text("Authorized Signatory", LEFT + CONTENT_W * 0.6, footTop + 48, {
    width: CONTENT_W * 0.4,
    align: "right",
  });

  y = Math.max(doc.y, footTop + 60) + 14;
  doc.fillColor("#AAAAAA").font("Helvetica").fontSize(8);
  doc.text(
    "This is a computer-generated invoice and does not require a physical signature.",
    LEFT,
    y,
    { width: CONTENT_W, align: "center" },
  );
}

// ─── PDF Generation ──────────────────────────────────────────────────

export async function generateInvoicePdf(invoiceId: string): Promise<Buffer> {
  // Fetch invoice with all data
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lineItems: { orderBy: { lineNumber: "asc" } },
      customer: true,
    },
  });

  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);

  // Phase 6: a marketplace invoice snapshots the EXTERNAL seller as the supplier so the document
  // is issued under their GSTIN. When those fields are set they OVERRIDE the store identity.
  const isSellerIssued = !!invoice.supplierName;

  // For a house invoice, prefer its OWN Company snapshot (frozen at creation time — see
  // Invoice.houseCompanySnapshot) over the LIVE Company row, so editing GSTIN/address/PAN in
  // Settings later can never retroactively change an already-issued invoice's PDF. Only an invoice
  // created before this field existed (houseCompanySnapshot null) falls back to live Company —
  // exactly the pre-existing behaviour for those older rows.
  const snapshot = invoice.houseCompanySnapshot as {
    legalName?: string; tradeName?: string; gstin?: string; pan?: string;
    address?: unknown; phone?: string; email?: string;
  } | null;
  const company = isSellerIssued || snapshot ? null : await prisma.company.findFirst();

  const companyName = isSellerIssued
    ? invoice.supplierName!
    : (snapshot?.tradeName ?? snapshot?.legalName ?? company?.tradeName ?? company?.legalName ?? "Oneshelf Store");
  const companyAddress = isSellerIssued
    ? (invoice.supplierAddress ?? "Address not configured")
    : (snapshot?.address ?? company?.address)
      ? typeof (snapshot?.address ?? company?.address) === "string"
        ? ((snapshot?.address ?? company?.address) as string)
        : JSON.stringify(snapshot?.address ?? company?.address)
      : "Address not configured";
  const companyGstin = isSellerIssued
    ? (invoice.supplierGstin ?? "Unregistered")
    : (snapshot?.gstin ?? company?.gstin ?? "09XXXXXXXXXXX");
  const companyPan = isSellerIssued
    ? (invoice.supplierPan ?? "")
    : (snapshot?.pan ?? company?.pan ?? "XXXXXXXXXX");
  const companyPhone = isSellerIssued ? (invoice.supplierPhone ?? "") : (snapshot?.phone ?? company?.phone ?? "");
  const companyEmail = isSellerIssued ? "" : (snapshot?.email ?? company?.email ?? "");

  // Build line items
  const lineItems = invoice.lineItems.map((li, idx) => ({
    sno: idx + 1,
    description: li.description,
    hsnCode: li.hsnCode,
    qty: Number(li.quantity).toString(),
    unit: li.unit,
    rate: fmt(Number(li.unitPrice)),
    discount: fmt(Number(li.discountAmount)),
    taxableValue: fmt(Number(li.taxableValue)),
    cgstRate: Number(li.cgstRate).toFixed(1),
    cgstAmount: fmt(Number(li.cgstAmount)),
    sgstRate: Number(li.sgstRate).toFixed(1),
    sgstAmount: fmt(Number(li.sgstAmount)),
    total: fmt(Number(li.totalAmount)),
  }));

  // Tax breakup — group by GST rate
  const rateMap = new Map<number, { taxable: number; cgst: number; sgst: number }>();
  for (const li of invoice.lineItems) {
    const rate = Number(li.gstRate);
    const existing = rateMap.get(rate) ?? { taxable: 0, cgst: 0, sgst: 0 };
    existing.taxable += Number(li.taxableValue);
    existing.cgst += Number(li.cgstAmount);
    existing.sgst += Number(li.sgstAmount);
    rateMap.set(rate, existing);
  }
  const taxBreakup = Array.from(rateMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([rate, vals]) => ({
      rate: rate === 0 ? "Exempt" : `${rate}%`,
      taxable: fmt(vals.taxable),
      cgst: fmt(vals.cgst),
      sgst: fmt(vals.sgst),
      totalTax: fmt(vals.cgst + vals.sgst),
    }));

  // Customer address
  let customerAddress = "";
  if (invoice.billingAddress) {
    const addr = invoice.billingAddress;
    if (typeof addr === "string") {
      customerAddress = addr;
    } else if (typeof addr === "object" && addr !== null) {
      const a = addr as Record<string, string>;
      customerAddress = [a.line1, a.line2, a.city, a.state, a.pincode]
        .filter(Boolean)
        .join(", ");
    }
  }

  // Invoice title
  const titleMap: Record<string, string> = {
    TAX_INVOICE: "Tax Invoice",
    BILL_OF_SUPPLY: "Bill of Supply",
    CREDIT_NOTE: "Credit Note",
    DEBIT_NOTE: "Debit Note",
  };

  // A registered customer's state comes from their GSTIN; an unregistered (B2C) customer is billed at
  // the place of supply (intra-state today), so mirror the invoice's snapshotted place-of-supply code.
  const customerStateCode = invoice.customerGstin
    ? stateCodeFromGstin(invoice.customerGstin)
    : invoice.placeOfSupplyCode;

  const data: InvoiceData = {
    companyName,
    companyAddress,
    companyGstin,
    companyPan,
    companyPhone,
    companyEmail,
    companyState: stateNameFromCode(invoice.supplierStateCode),
    companyStateCode: invoice.supplierStateCode,

    invoiceTitle: titleMap[invoice.invoiceType] ?? "Tax Invoice",
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: fmtDate(invoice.invoiceDate),

    customerName: invoice.customerName,
    customerAddress,
    customerGstin: invoice.customerGstin ?? "",
    // Registered customer → their own state; unregistered (B2C) → the place of supply (intra-state).
    customerState: stateNameFromCode(customerStateCode),
    customerStateCode: customerStateCode,

    placeOfSupply: `${stateNameFromCode(invoice.placeOfSupplyCode)} (${invoice.placeOfSupplyCode})`,
    isReverseCharge: false,

    lineItems,

    subtotal: fmt(Number(invoice.subtotal)),
    totalCgst: fmt(Number(invoice.totalCgst)),
    totalSgst: fmt(Number(invoice.totalSgst)),
    totalCess: fmt(Number(invoice.totalCess)),
    roundOff: fmt(Number(invoice.roundOff)),
    grandTotal: fmt(Number(invoice.totalAmount)),
    amountInWords: invoice.amountInWords,

    taxBreakup,

    originalInvoiceNumber: invoice.originalInvoiceNumber ?? undefined,
  };

  // ── Render with pdfkit (pure JS — no Chromium/Puppeteer needed) ──
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 28, bottom: 28, left: 28, right: 28 },
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      drawInvoice(doc, data);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
