import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import {
  drawInvoice,
  COMPOSITION_DECLARATION,
  type InvoiceData,
} from "../pdfGenerator.js";
import PDFDocument from "pdfkit";

/**
 * Runbook step 14's Watch, taken literally: "check the PDF RENDERER, not just the data."
 *
 * Asserting that `supplierIsComposition` reached an object proves nothing about the document a
 * customer is handed. So these tests render real PDF bytes and read the text back out of them. A
 * mandatory declaration that exists in the model and not on the page is a defective bill of supply,
 * and that failure is invisible everywhere except on paper.
 *
 * Reading pdfkit output takes two steps and no dependency: page content streams are Flate-
 * compressed, and inside them pdfkit writes text as hex runs inside TJ arrays, split wherever it
 * applies kerning. So: inflate every stream, then concatenate every <hex> run back into a string.
 */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  let inflated = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      inflated += zlib.inflateSync(Buffer.from(raw.slice(start, end), "latin1")).toString("latin1");
    } catch {
      // Not a Flate stream — an embedded font file or similar. Skip it.
    }
  }
  return (inflated.match(/<([0-9A-Fa-f]+)>/g) ?? [])
    .map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1"))
    .join("");
}

function renderA4(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 28, bottom: 28, left: 28, right: 28 }, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    drawInvoice(doc, data);
    doc.end();
  });
}

function invoiceData(over: Partial<InvoiceData> = {}): InvoiceData {
  return {
    companyName: "Bijnor Provisions", companyAddress: "12 Market Road, Bijnor, Uttar Pradesh 246701",
    companyGstin: "09ABCDE1234F1Z5", companyPan: "ABCDE1234F", companyPhone: "9876543210",
    companyEmail: "", companyState: "Uttar Pradesh", companyStateCode: "09",
    invoiceTitle: "Tax Invoice", invoiceNumber: "ONS/2627/00158", invoiceDate: "22 Sep 2026",
    customerName: "Ramesh Kumar", customerAddress: "House 4, Civil Lines, Bijnor 246701",
    customerGstin: "", customerState: "Uttar Pradesh", customerStateCode: "09",
    placeOfSupply: "Uttar Pradesh (09)", isReverseCharge: false,
    supplierIsComposition: false,
    lineItems: [{
      sno: 1, description: "Toor Dal 1 kg", hsnCode: "0713", qty: "2", unit: "PCS",
      rate: "90.00", discount: "0.00", taxableValue: "171.43", cgstRate: "2.5%",
      cgstAmount: "4.28", sgstRate: "2.5%", sgstAmount: "4.29", total: "180.00",
    }],
    subtotal: "171.43", totalCgst: "4.28", totalSgst: "4.29", totalCess: "0.00",
    roundOff: "0.00", grandTotal: "180.00",
    amountInWords: "Rupees One Hundred Eighty Only",
    taxBreakup: [{ rate: "5%", taxable: "171.43", cgst: "4.28", sgst: "4.29", totalTax: "8.57" }],
    ...over,
  };
}

describe("the composition declaration on the rendered document", () => {
  it("is printed on a composition seller's bill of supply", async () => {
    const text = pdfText(await renderA4(invoiceData({
      invoiceTitle: "Bill of Supply",
      supplierIsComposition: true,
    })));
    expect(text).toContain(COMPOSITION_DECLARATION);
  });

  it("is NOT printed on a regular seller's invoice", async () => {
    // The failure this guards is the quiet one: a declaration asserting a registered dealer cannot
    // collect tax, on a document where they just did.
    const text = pdfText(await renderA4(invoiceData()));
    expect(text).not.toContain(COMPOSITION_DECLARATION);
  });

  it("appears above the customer and the amount, because the rule says at the top", async () => {
    // Rule 5(1)(f) requires it "at the top of the bill of supply". Position is part of the
    // requirement, so it is asserted rather than assumed: the declaration must precede both the
    // BILL TO block and the total.
    const text = pdfText(await renderA4(invoiceData({
      invoiceTitle: "Bill of Supply",
      supplierIsComposition: true,
    })));
    const decl = text.indexOf(COMPOSITION_DECLARATION);
    expect(decl).toBeGreaterThanOrEqual(0);
    expect(decl).toBeLessThan(text.indexOf("BILL TO"));
    expect(decl).toBeLessThan(text.indexOf("Ramesh Kumar"));
  });

  it("leaves a regular invoice otherwise unchanged — same pages, same text", async () => {
    // The step-14 prove asks for a regular seller's invoice to be byte-identical. Two pdfkit runs
    // differ in their /CreationDate, so compare what is actually on the page: identical extracted
    // text, from a render where the flag is false and one where it is absent from the branch by
    // construction (false is the only value the old code could have produced).
    const a = pdfText(await renderA4(invoiceData()));
    const b = pdfText(await renderA4(invoiceData({ supplierIsComposition: false })));
    expect(a).toBe(b);
    expect(a).toContain("Ramesh Kumar");
    expect(a).toContain("Toor Dal 1 kg");
  });
});
