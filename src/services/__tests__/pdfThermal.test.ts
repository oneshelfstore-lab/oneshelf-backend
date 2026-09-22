import { describe, it, expect } from "vitest";
import { renderThermalInvoice, type InvoiceData } from "../pdfGenerator.js";

/**
 * The seller's 80mm slip. Both failure modes guarded here are SILENT until a printer produces them:
 * a slip that spills onto a second, entirely blank page (wasting roll on every single order — the
 * exact thing this format exists to stop), and a page rendered at the wrong width, which the printer
 * then silently scales or clips.
 */

function line(sno: number, description: string) {
  return {
    sno, description, hsnCode: "1905", qty: "2", unit: "pc", rate: "45.00",
    discount: "0.00", taxableValue: "85.71", cgstRate: "2.5%", cgstAmount: "2.14",
    sgstRate: "2.5%", sgstAmount: "2.15", total: "90.00",
  };
}

function invoice(lineCount: number, overrides: Partial<InvoiceData> = {}): InvoiceData {
  return {
    companyName: "Oneshelf Store", companyAddress: "12 Market Road, Bijnor, Uttar Pradesh 246701",
    companyGstin: "09ABCDE1234F1Z5", companyPan: "ABCDE1234F", companyPhone: "9876543210",
    companyEmail: "store@example.com", companyState: "Uttar Pradesh", companyStateCode: "09",
    invoiceTitle: "TAX INVOICE", invoiceNumber: "ONS/2627/00158", invoiceDate: "19 Sep 2026",
    customerName: "Ramesh Kumar", customerAddress: "House 4, Civil Lines, Bijnor 246701",
    customerGstin: "", customerState: "Uttar Pradesh", customerStateCode: "09",
    placeOfSupply: "Uttar Pradesh (09)", isReverseCharge: false,
    supplierIsComposition: false,
    lineItems: Array.from({ length: lineCount }, (_, i) => line(i + 1, `Item number ${i + 1}`)),
    subtotal: "148.57", totalCgst: "3.71", totalSgst: "3.72", totalCess: "0.00",
    roundOff: "0.00", grandTotal: "156.00",
    amountInWords: "Rupees One Hundred Fifty Six Only",
    taxBreakup: [{ rate: "5%", taxable: "148.57", cgst: "3.71", sgst: "3.72", totalTax: "7.43" }],
    ...overrides,
  };
}

/** pdfkit writes one `/Type /Page` object per page (the catalog uses `/Type /Pages`, excluded). */
function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** First MediaBox: [x0 y0 width height] in points. */
function mediaBox(pdf: Buffer): { width: number; height: number } {
  const m = pdf.toString("latin1").match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (!m) throw new Error("no MediaBox in output");
  return { width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) };
}

describe("thermal (80mm) invoice", () => {
  it("is exactly 80mm wide", async () => {
    const { width } = mediaBox(await renderThermalInvoice(invoice(3)));
    expect(width).toBeCloseTo(226.77, 1); // 80mm
  });

  it("fits on ONE continuous slip, whatever the order size", async () => {
    // The two-pass measure has to hold at both ends: a 1-line order must not leave a blank tail,
    // and a 40-line order must not spill onto a second page.
    for (const n of [1, 3, 12, 40]) {
      const pdf = await renderThermalInvoice(invoice(n));
      expect(pageCount(pdf), `${n} line items`).toBe(1);
    }
  });

  it("grows the slip with the order instead of using a fixed height", async () => {
    const short = mediaBox(await renderThermalInvoice(invoice(1))).height;
    const long = mediaBox(await renderThermalInvoice(invoice(20))).height;
    expect(long).toBeGreaterThan(short);
    // Sanity on the measure itself: 19 extra items must add real length, not a rounding wobble.
    expect(long - short).toBeGreaterThan(200);
  });

  it("keeps the slip honest when optional fields are absent", async () => {
    // A walk-in with no GSTIN and no address is the common case; it must not throw or blank the page.
    const pdf = await renderThermalInvoice(
      invoice(2, { customerGstin: "", customerAddress: "", companyEmail: "" }),
    );
    expect(pageCount(pdf)).toBe(1);
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
