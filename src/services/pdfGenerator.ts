import PDFDocument from "pdfkit";
import { INVOICE_KIND } from "../data/invoiceKinds.js";
import prisma from "../lib/prisma.js";
import { stateNameFromCode, stateCodeFromGstin } from "../lib/stateCodes.js";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Rule 5(1)(f), CGST Rules 2017 — a composition taxable person must carry these exact words on the
 * bill of supply it issues.
 *
 * ⚠️ Quoted wording, not copy. Do not reword, shorten or "improve" it; the rule prescribes the
 * phrase. And ⚠️ it goes AT THE TOP of the document, which the rule also specifies — not in the
 * footer with the terms, where a reader would reach it after the amount.
 */
export const COMPOSITION_DECLARATION =
  "composition taxable person, not eligible to collect tax on supplies";

export interface InvoiceData {
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

  /**
   * The supplier traded under the GST composition scheme when this document was issued, so it must
   * carry [COMPOSITION_DECLARATION]. Read from the invoice's own SNAPSHOT, never from the seller's
   * current scheme — a seller who later moves to the regular scheme must not have their already
   * issued bills of supply quietly lose the declaration.
   *
   * ⚠️ Not the same question as "is this a BILL_OF_SUPPLY". A regular dealer selling only exempt
   * goods gets one too, and must NOT carry this line — it would assert something untrue about a
   * registered business.
   */
  supplierIsComposition: boolean;

  /**
   * The lines are SERVICES, so their classification codes are SACs and the column must say so.
   * Printing "HSN" over a Service Accounting Code is a small defect on a real GST document, and the
   * only reason the underlying field is called hsnCode is that it predates the platform supplying
   * anything but goods.
   */
  codeLabel: string;

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

/**
 * Exported ONLY so a test can render real bytes and read the text back off the page. A mandatory
 * declaration that exists in the data and not on the document is still a defective bill of supply,
 * and nothing but rendering catches that.
 */
export function drawInvoice(doc: PDFKit.PDFDocument, data: InvoiceData): void {
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

  // Rule 5(1)(f) declaration, immediately under the title because the rule says "at the top of the
  // bill of supply" — a footer would put it after the amount, which is not the top of anything.
  if (data.supplierIsComposition) {
    doc.rect(LEFT, y, CONTENT_W, 18).fillColor("#FFF8E1").fill();
    doc.rect(LEFT, y, CONTENT_W, 18).lineWidth(0.5).strokeColor("#E0C77A").stroke();
    doc.fillColor("#6B5300").font("Helvetica-Bold").fontSize(9);
    doc.text(COMPOSITION_DECLARATION, LEFT, y + 5, { width: CONTENT_W, align: "center" });
    y += 24;
  }

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
    { text: data.codeLabel, width: widths.hsn, align: "center" },
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

// ─── 80mm thermal receipt layout ─────────────────────────────────────

/** 80mm roll = 226.77pt. Thermal printers can't print the outer ~2mm, hence the side margins. */
const THERMAL_WIDTH_PT = 226.77;
const THERMAL_MARGIN_PT = 10;

/**
 * The SAME tax invoice, rendered onto an 80mm thermal roll — the seller's copy that goes on the bag.
 * Returns the final y so the caller can size the page to its content (see generateInvoicePdf).
 *
 * ⚠️ A separate renderer rather than a narrower A4, on purpose: drawInvoice's line-item table is 13
 * columns and 526pt wide, and there is no font size at which that survives a ~207pt roll. Same
 * particulars, STACKED instead of tabled — which is what every retail and restaurant thermal
 * invoice already does.
 *
 * ⚠️ This is still a full Rule-46 TAX INVOICE, not a delivery note. Supplier name/address/GSTIN,
 * invoice number and date, recipient, per-line HSN + qty + rate + taxable value, CGST/SGST rate AND
 * amount, place of supply and reverse-charge status are all retained. Roll is cheap; a defective
 * tax invoice is not — do not drop fields here to shorten the slip.
 */
function drawThermalInvoice(doc: PDFKit.PDFDocument, data: InvoiceData): number {
  const L = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = doc.page.margins.top;

  // Every writer goes through these three, so the vertical rhythm can't drift between sections.
  const write = (
    text: string,
    opts: { size?: number; bold?: boolean; align?: Align; color?: string; width?: number; gap?: number } = {},
  ): void => {
    const size = opts.size ?? 7;
    const width = opts.width ?? W;
    const align = opts.align ?? "left";
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(opts.color ?? DARK);
    const h = doc.heightOfString(text, { width, align });
    doc.text(text, L, y, { width, align });
    y += h + (opts.gap ?? 0);
  };

  // A label/amount pair sharing one baseline. BOTH columns are measured and the taller wins, so an
  // item name that wraps to three lines can never overlap the amount beside it.
  const pair = (
    left: string,
    right: string,
    opts: { size?: number; bold?: boolean; color?: string; leftRatio?: number } = {},
  ): void => {
    const size = opts.size ?? 7;
    const lw = W * (opts.leftRatio ?? 0.62);
    const rw = W - lw;
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(opts.color ?? DARK);
    const lh = doc.heightOfString(left, { width: lw });
    const rh = doc.heightOfString(right, { width: rw, align: "right" });
    doc.text(left, L, y, { width: lw });
    doc.text(right, L + lw, y, { width: rw, align: "right" });
    y += Math.max(lh, rh);
  };

  const rule = (opts: { heavy?: boolean; gap?: number } = {}): void => {
    y += 3;
    doc.moveTo(L, y).lineTo(L + W, y)
      .lineWidth(opts.heavy ? 1 : 0.5)
      .strokeColor(opts.heavy ? "#555555" : "#CCCCCC")
      .stroke();
    y += opts.gap ?? 4;
  };

  // ── Supplier ───────────────────────────────────────────────────
  write(data.companyName, { size: 11, bold: true, align: "center", color: GREEN, gap: 1 });
  write(data.companyAddress, { size: 6.5, align: "center", color: GREY, gap: 1 });
  if (data.companyGstin) write("GSTIN: " + data.companyGstin, { size: 7, bold: true, align: "center" });
  const contact = [data.companyPhone, data.companyEmail].filter(Boolean).join("  ·  ");
  if (contact) write(contact, { size: 6.5, align: "center", color: GREY });

  rule({ heavy: true });
  write(data.invoiceTitle, { size: 9, bold: true, align: "center", color: GREEN, gap: 2 });
  // Same Rule 5(1)(f) line as the A4 copy. The slip is a full tax document, not a delivery note, so
  // a mandatory declaration belongs on it too. Safe to add here: drawThermalInvoice is pure layout
  // and runs identically in the measure pass, so the roll still grows to exactly fit.
  if (data.supplierIsComposition) {
    write(COMPOSITION_DECLARATION, { size: 6, bold: true, align: "center", color: DARK, gap: 3 });
  }
  pair("No.", data.invoiceNumber, { size: 7, bold: true });
  pair("Date", data.invoiceDate, { size: 7 });
  if (data.originalInvoiceNumber) pair("Against invoice", data.originalInvoiceNumber, { size: 7 });

  // ── Recipient ──────────────────────────────────────────────────
  rule();
  write("BILL TO", { size: 6.5, bold: true, color: GREY, gap: 1 });
  write(data.customerName, { size: 8, bold: true });
  if (data.customerAddress) write(data.customerAddress, { size: 6.5, color: GREY });
  if (data.customerGstin) write("GSTIN: " + data.customerGstin, { size: 6.5 });
  pair("Place of supply", data.placeOfSupply, { size: 6.5, color: GREY });
  pair("Reverse charge", data.isReverseCharge ? "Yes" : "No", { size: 6.5, color: GREY });

  // ── Line items ─────────────────────────────────────────────────
  rule({ heavy: true });
  for (const li of data.lineItems) {
    write(li.sno + ". " + li.description, { size: 7.5, bold: true });
    // Qty × rate on the left, line total on the right — the two numbers a packer actually checks.
    const qty = [li.qty, li.unit].filter(Boolean).join(" ");
    pair("   " + qty + " x " + li.rate, li.total, { size: 7.5, bold: true, leftRatio: 0.58 });
    // The tax particulars Rule 46 requires, kept small: read by an accountant, not by the packer.
    const hsn = li.hsnCode ? data.codeLabel + " " + li.hsnCode + "  ·  " : "";
    write(
      "   " + hsn + "Taxable " + li.taxableValue +
        "  ·  CGST " + li.cgstRate + " " + li.cgstAmount +
        "  ·  SGST " + li.sgstRate + " " + li.sgstAmount,
      { size: 6, color: GREY, gap: 2 },
    );
  }

  // ── Totals ─────────────────────────────────────────────────────
  rule();
  pair("Taxable value", data.subtotal, { size: 7.5 });
  pair("CGST", data.totalCgst, { size: 7.5 });
  pair("SGST", data.totalSgst, { size: 7.5 });
  if (num(data.totalCess) !== 0) pair("Cess", data.totalCess, { size: 7.5 });
  if (num(data.roundOff) !== 0) pair("Round off", data.roundOff, { size: 7.5 });
  rule({ heavy: true });
  pair("TOTAL", "Rs. " + data.grandTotal, { size: 11, bold: true, color: GREEN, leftRatio: 0.45 });
  rule({ heavy: true });
  write("Amount in words: " + data.amountInWords, { size: 6, color: GREY, gap: 2 });

  // ── Rate-wise tax summary ──────────────────────────────────────
  // One line per GST rate. Redundant with the per-line figures on a single-rate order, kept anyway
  // so the slip carries the same summary the A4 copy does and nobody re-adds it by hand.
  if (data.taxBreakup.length > 0) {
    rule();
    write("TAX SUMMARY", { size: 6.5, bold: true, color: GREY, gap: 1 });
    for (const tb of data.taxBreakup) {
      pair(
        tb.rate + "  on " + tb.taxable,
        "CGST " + tb.cgst + "   SGST " + tb.sgst,
        { size: 6, color: GREY, leftRatio: 0.42 },
      );
    }
  }

  // ── Footer ─────────────────────────────────────────────────────
  rule();
  write("1. Goods once sold will not be taken back or exchanged.", { size: 5.5, color: GREY });
  write("2. Interest @ 18% p.a. on overdue payments.", { size: 5.5, color: GREY });
  write("3. Subject to " + data.companyState + " jurisdiction only.", { size: 5.5, color: GREY, gap: 5 });
  write("For " + data.companyName, { size: 7, bold: true, align: "center", gap: 2 });
  // ⚠️ No blank signature box, unlike the A4 copy: the line below already states the invoice is
  // computer-generated, so ruling off empty roll for a signature nobody adds is pure waste.
  write("Computer-generated invoice — no physical signature required.", {
    size: 5.5, align: "center", color: "#AAAAAA",
  });

  return y;
}

// ─── PDF Generation ──────────────────────────────────────────────────

/**
 * Renders [data] onto a single continuous 80mm slip sized to exactly fit its content.
 *
 * ⚠️ Two passes, and that is the whole point. A receipt roll is continuous but pdfkit still needs a
 * fixed page height, and picking a generous one would spit out a long tail of blank roll on every
 * order — precisely the waste this format exists to stop. So: draw once into a throwaway tall
 * document purely to learn the content height, then create the real page at that height and draw
 * again. drawThermalInvoice is pure layout with no side effects, so both passes are identical.
 *
 * Exported so the page geometry can be asserted without a database — see pdfThermal.test.ts. Both
 * failure modes here are SILENT on a printer: a slip that runs onto a second, blank page, or one
 * rendered at the wrong width that the printer then scales.
 */
export async function renderThermalInvoice(data: InvoiceData): Promise<Buffer> {
  const margins = {
    top: THERMAL_MARGIN_PT, bottom: THERMAL_MARGIN_PT,
    left: THERMAL_MARGIN_PT, right: THERMAL_MARGIN_PT,
  };

  const probe = new PDFDocument({ size: [THERMAL_WIDTH_PT, 20000], margins });
  const contentBottom = drawThermalInvoice(probe, data);
  probe.end(); // never piped anywhere — it exists only to be measured

  // +2pt of slack: a page height exactly equal to the content can round the last baseline onto a
  // second page, which on a roll prints as an extra, entirely blank slip.
  const height = contentBottom + THERMAL_MARGIN_PT + 2;

  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [THERMAL_WIDTH_PT, height], margins });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      drawThermalInvoice(doc, data);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Paper the invoice is rendered onto. "a4" is the filing/archive copy (customer, owner, dashboard);
 * "thermal80" is the seller's 80mm roll slip that goes on the bag. Same document and the same
 * Rule-46 particulars either way — only the sheet differs.
 */
export type InvoiceFormat = "a4" | "thermal80";

export async function generateInvoicePdf(
  invoiceId: string,
  format: InvoiceFormat = "a4",
): Promise<Buffer> {
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
    supplierIsComposition: invoice.supplierGstScheme === "COMPOSITION",
    // Goods carry an HSN, services a SAC. Keyed on what the invoice IS rather than on whether the
    // code happens to look like one, so a goods invoice can never be relabelled by a stray value.
    codeLabel: invoice.invoiceKind === INVOICE_KIND.GOODS ? "HSN" : "SAC",
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
  if (format === "thermal80") return await renderThermalInvoice(data);

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
