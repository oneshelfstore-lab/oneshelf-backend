import puppeteer from "puppeteer";
import prisma from "../lib/prisma.js";

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
  return num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── HTML Template ───────────────────────────────────────────────────

function buildInvoiceHtml(data: InvoiceData): string {
  const lineRows = data.lineItems
    .map(
      (li) => `
    <tr>
      <td class="center">${li.sno}</td>
      <td>${escHtml(li.description)}</td>
      <td class="center">${li.hsnCode}</td>
      <td class="right">${li.qty}</td>
      <td class="center">${li.unit}</td>
      <td class="right">${li.rate}</td>
      <td class="right">${li.discount}</td>
      <td class="right">${li.taxableValue}</td>
      <td class="center">${li.cgstRate}</td>
      <td class="right">${li.cgstAmount}</td>
      <td class="center">${li.sgstRate}</td>
      <td class="right">${li.sgstAmount}</td>
      <td class="right bold">${li.total}</td>
    </tr>`,
    )
    .join("");

  const taxBreakupRows = data.taxBreakup
    .map(
      (tb) => `
    <tr>
      <td class="center">${tb.rate}</td>
      <td class="right">${tb.taxable}</td>
      <td class="right">${tb.cgst}</td>
      <td class="right">${tb.sgst}</td>
      <td class="right bold">${tb.totalTax}</td>
    </tr>`,
    )
    .join("");

  const cnRef = data.originalInvoiceNumber
    ? `<p style="margin:4px 0;font-size:11px;">Against Invoice: <strong>${escHtml(data.originalInvoiceNumber)}</strong></p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #1a1a1a; padding: 24px 28px; }

  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #2E7D32; padding-bottom: 12px; margin-bottom: 14px; }
  .company-name { font-size: 20px; font-weight: 700; color: #2E7D32; }
  .company-details { font-size: 10px; color: #555; line-height: 1.5; margin-top: 4px; }
  .gstin-badge { display: inline-block; background: #E8F5E9; border: 1px solid #A5D6A7; border-radius: 3px; padding: 2px 8px; font-size: 11px; font-weight: 600; color: #2E7D32; margin-top: 4px; }

  .invoice-title { text-align: center; font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 10px 0; padding: 6px; background: #F5F5F5; border: 1px solid #DDD; }

  .meta-row { display: flex; justify-content: space-between; margin-bottom: 14px; }
  .meta-box { width: 48%; }
  .meta-box h4 { font-size: 10px; text-transform: uppercase; color: #888; letter-spacing: 1px; margin-bottom: 4px; }
  .meta-box p { font-size: 11px; line-height: 1.5; }

  .inv-details { text-align: right; }
  .inv-details p { font-size: 11px; line-height: 1.7; }
  .inv-number { font-size: 13px; font-weight: 700; color: #2E7D32; }

  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  table th { background: #2E7D32; color: white; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 4px; text-align: center; }
  table td { padding: 5px 4px; border-bottom: 1px solid #EEE; font-size: 10px; }
  .right { text-align: right; }
  .center { text-align: center; }
  .bold { font-weight: 600; }

  .totals { display: flex; justify-content: flex-end; margin: 8px 0; }
  .totals-table { width: 320px; }
  .totals-table tr td { padding: 4px 8px; font-size: 11px; }
  .totals-table tr td:last-child { text-align: right; font-weight: 500; }
  .grand-total td { font-size: 14px !important; font-weight: 700 !important; color: #2E7D32; border-top: 2px solid #2E7D32; border-bottom: 2px solid #2E7D32; padding: 8px !important; }

  .words { background: #FAFAFA; border: 1px solid #EEE; border-radius: 4px; padding: 8px 12px; margin: 8px 0; font-size: 11px; }
  .words span { font-weight: 600; }

  .tax-breakup { margin: 12px 0; }
  .tax-breakup h4 { font-size: 10px; text-transform: uppercase; color: #888; letter-spacing: 1px; margin-bottom: 6px; }
  .tax-breakup table th { font-size: 9px; }

  .footer { margin-top: 20px; border-top: 1px solid #DDD; padding-top: 12px; display: flex; justify-content: space-between; }
  .footer-left { width: 55%; font-size: 9px; color: #777; line-height: 1.6; }
  .footer-right { width: 40%; text-align: right; }
  .signatory { margin-top: 40px; border-top: 1px solid #333; display: inline-block; padding-top: 4px; font-size: 10px; font-weight: 600; }
  .computer-gen { text-align: center; font-size: 9px; color: #AAA; margin-top: 16px; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="company-name">${escHtml(data.companyName)}</div>
    <div class="company-details">
      ${escHtml(data.companyAddress)}<br>
      Phone: ${escHtml(data.companyPhone)} | Email: ${escHtml(data.companyEmail)}
    </div>
    <div class="gstin-badge">GSTIN: ${escHtml(data.companyGstin)}</div>
    <span style="margin-left:8px;font-size:10px;color:#555;">PAN: ${escHtml(data.companyPan)}</span>
  </div>
  <div class="inv-details">
    <p class="inv-number">${escHtml(data.invoiceNumber)}</p>
    <p>Date: <strong>${escHtml(data.invoiceDate)}</strong></p>
    <p>State: ${escHtml(data.companyState)} (${escHtml(data.companyStateCode)})</p>
  </div>
</div>

<div class="invoice-title">${escHtml(data.invoiceTitle)}</div>
${cnRef}

<div class="meta-row">
  <div class="meta-box">
    <h4>Bill To</h4>
    <p>
      <strong>${escHtml(data.customerName)}</strong><br>
      ${data.customerAddress ? escHtml(data.customerAddress) + "<br>" : ""}
      ${data.customerGstin ? "GSTIN: <strong>" + escHtml(data.customerGstin) + "</strong><br>" : ""}
      State: ${escHtml(data.customerState)} (${escHtml(data.customerStateCode)})
    </p>
  </div>
  <div class="meta-box">
    <h4>Supply Details</h4>
    <p>
      Place of Supply: <strong>${escHtml(data.placeOfSupply)}</strong><br>
      Reverse Charge: <strong>${data.isReverseCharge ? "Yes" : "No"}</strong>
    </p>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th style="width:30px">#</th>
      <th style="text-align:left">Description</th>
      <th>HSN</th>
      <th>Qty</th>
      <th>Unit</th>
      <th>Rate (₹)</th>
      <th>Disc (₹)</th>
      <th>Taxable (₹)</th>
      <th>CGST %</th>
      <th>CGST (₹)</th>
      <th>SGST %</th>
      <th>SGST (₹)</th>
      <th>Total (₹)</th>
    </tr>
  </thead>
  <tbody>
    ${lineRows}
  </tbody>
</table>

<div class="totals">
  <table class="totals-table">
    <tr><td>Taxable Value</td><td>₹${data.subtotal}</td></tr>
    <tr><td>CGST</td><td>₹${data.totalCgst}</td></tr>
    <tr><td>SGST</td><td>₹${data.totalSgst}</td></tr>
    ${Number(data.totalCess.replace(/,/g, "")) > 0 ? `<tr><td>Cess</td><td>₹${data.totalCess}</td></tr>` : ""}
    ${Number(data.roundOff.replace(/,/g, "").replace("−", "-")) !== 0 ? `<tr><td>Round Off</td><td>₹${data.roundOff}</td></tr>` : ""}
    <tr class="grand-total"><td>Grand Total</td><td>₹${data.grandTotal}</td></tr>
  </table>
</div>

<div class="words">Amount in words: <span>${escHtml(data.amountInWords)}</span></div>

<div class="tax-breakup">
  <h4>Tax Breakup</h4>
  <table>
    <thead>
      <tr>
        <th>GST Rate</th>
        <th>Taxable Value (₹)</th>
        <th>CGST (₹)</th>
        <th>SGST (₹)</th>
        <th>Total Tax (₹)</th>
      </tr>
    </thead>
    <tbody>${taxBreakupRows}</tbody>
  </table>
</div>

<div class="footer">
  <div class="footer-left">
    <strong>Terms & Conditions:</strong><br>
    1. Goods once sold will not be taken back or exchanged.<br>
    2. Interest @ 18% p.a. will be charged on overdue payments.<br>
    3. Subject to ${escHtml(data.companyState)} jurisdiction only.
  </div>
  <div class="footer-right">
    <p style="font-size:10px;">For <strong>${escHtml(data.companyName)}</strong></p>
    <div class="signatory">Authorized Signatory</div>
  </div>
</div>

<div class="computer-gen">This is a computer-generated invoice and does not require a physical signature.</div>

</body>
</html>`;
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

  // Fetch company info
  const company = await prisma.company.findFirst();

  const companyName = company?.tradeName ?? company?.legalName ?? "Oneshelf Store";
  const companyAddress = company?.address
    ? typeof company.address === "string"
      ? company.address
      : JSON.stringify(company.address)
    : "Address not configured";
  const companyGstin = company?.gstin ?? "09XXXXXXXXXXX";
  const companyPan = company?.pan ?? "XXXXXXXXXX";
  const companyPhone = company?.phone ?? "";
  const companyEmail = company?.email ?? "";

  // Build line items
  const lineItems = invoice.lineItems.map((li, idx) => ({
    sno: idx + 1,
    description: li.description,
    hsnCode: li.hsnCode,
    qty: Number(li.quantity).toString(),
    unit: li.unit,
    rate: fmt(li.unitPrice),
    discount: fmt(li.discountAmount),
    taxableValue: fmt(li.taxableValue),
    cgstRate: Number(li.cgstRate).toFixed(1),
    cgstAmount: fmt(li.cgstAmount),
    sgstRate: Number(li.sgstRate).toFixed(1),
    sgstAmount: fmt(li.sgstAmount),
    total: fmt(li.totalAmount),
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

  const data: InvoiceData = {
    companyName,
    companyAddress,
    companyGstin,
    companyPan,
    companyPhone,
    companyEmail,
    companyState: "Uttar Pradesh",
    companyStateCode: "09",

    invoiceTitle: titleMap[invoice.invoiceType] ?? "Tax Invoice",
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: fmtDate(invoice.invoiceDate),

    customerName: invoice.customerName,
    customerAddress,
    customerGstin: invoice.customerGstin ?? "",
    customerState: "Uttar Pradesh",
    customerStateCode: "09",

    placeOfSupply: "Uttar Pradesh (09)",
    isReverseCharge: false,

    lineItems,

    subtotal: fmt(invoice.subtotal),
    totalCgst: fmt(invoice.totalCgst),
    totalSgst: fmt(invoice.totalSgst),
    totalCess: fmt(invoice.totalCess),
    roundOff: fmt(invoice.roundOff),
    grandTotal: fmt(invoice.totalAmount),
    amountInWords: invoice.amountInWords,

    taxBreakup,

    originalInvoiceNumber: invoice.originalInvoiceNumber ?? undefined,
  };

  const html = buildInvoiceHtml(data);

  // Launch Puppeteer — prefer system Chrome to avoid needing a separate download
  const fs = await import("fs");
  const platform = process.platform;
  const systemChromePaths: string[] = [
    ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
    ...(platform === "win32" ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ] : platform === "darwin" ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ] : [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ]),
  ];

  const launchOpts: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };

  for (const p of systemChromePaths) {
    if (fs.existsSync(p)) {
      launchOpts.executablePath = p;
      break;
    }
  }

  const browser = await puppeteer.launch(launchOpts);

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" },
    });

    // Return as Buffer
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
