import { describe, it, expect } from "vitest";
import {
  calculateLineItemTax,
  calculateInvoiceTotals,
  convertAmountToWords,
  backCalculateFromMRP,
} from "../taxEngine.js";

// ─── calculateLineItemTax ────────────────────────────────────────────

describe("calculateLineItemTax", () => {
  it("0% exempt item — fresh vegetables", () => {
    const result = calculateLineItemTax({
      unitPrice: 40,
      quantity: 2,
      gstRate: 0,
      isTaxInclusive: true,
    });

    expect(result.grossAmount).toBe(80);
    expect(result.taxableValue).toBe(80);
    expect(result.cgstRate).toBe(0);
    expect(result.cgstAmount).toBe(0);
    expect(result.sgstAmount).toBe(0);
    expect(result.igstAmount).toBe(0);
    expect(result.totalAmount).toBe(80);
  });

  it("5% item — branded atta (tax inclusive MRP)", () => {
    // MRP ₹100 inclusive of 5% GST
    const result = calculateLineItemTax({
      unitPrice: 100,
      quantity: 1,
      gstRate: 5,
      isTaxInclusive: true,
    });

    // taxable = 100 / 1.05 = 95.24
    expect(result.taxableValue).toBe(95.24);
    expect(result.cgstRate).toBe(2.5);
    expect(result.sgstRate).toBe(2.5);
    expect(result.cgstAmount).toBe(2.38); // 95.24 * 2.5% = 2.381
    expect(result.sgstAmount).toBe(2.38);
    expect(result.totalAmount).toBe(100);
  });

  it("18% item — toilet paper (tax inclusive)", () => {
    const result = calculateLineItemTax({
      unitPrice: 199,
      quantity: 1,
      gstRate: 18,
      isTaxInclusive: true,
    });

    // taxable = 199 / 1.18 = 168.64
    expect(result.taxableValue).toBe(168.64);
    expect(result.cgstRate).toBe(9);
    expect(result.sgstRate).toBe(9);
    expect(result.cgstAmount).toBe(15.18); // 168.64 * 9%
    expect(result.sgstAmount).toBe(15.18);
    // total = 168.64 + 15.18 + 15.18 = 199.00
    expect(result.totalAmount).toBe(199);
  });

  it("40% item — aerated drinks (sin goods, tax inclusive)", () => {
    const result = calculateLineItemTax({
      unitPrice: 40,
      quantity: 3,
      gstRate: 40,
      isTaxInclusive: true,
    });

    // gross = 120, taxable = 120 / 1.40 = 85.71
    expect(result.grossAmount).toBe(120);
    expect(result.taxableValue).toBe(85.71);
    expect(result.cgstRate).toBe(20);
    expect(result.sgstRate).toBe(20);
    expect(result.cgstAmount).toBe(17.14); // 85.71 * 20%
    expect(result.sgstAmount).toBe(17.14);
    // total = 85.71 + 17.14 + 17.14 = 119.99 (rounding at line level)
    expect(result.totalAmount).toBe(119.99);
  });

  it("5% item with cess", () => {
    const result = calculateLineItemTax({
      unitPrice: 200,
      quantity: 1,
      gstRate: 5,
      cessRate: 12,
      isTaxInclusive: false,
    });

    expect(result.taxableValue).toBe(200);
    expect(result.cgstAmount).toBe(5); // 200 * 2.5%
    expect(result.sgstAmount).toBe(5);
    expect(result.cessAmount).toBe(24); // 200 * 12%
    expect(result.totalAmount).toBe(234);
  });

  it("tax-exclusive pricing (B2B)", () => {
    const result = calculateLineItemTax({
      unitPrice: 500,
      quantity: 10,
      gstRate: 18,
      isTaxInclusive: false,
    });

    expect(result.grossAmount).toBe(5000);
    expect(result.taxableValue).toBe(5000);
    expect(result.cgstAmount).toBe(450); // 5000 * 9%
    expect(result.sgstAmount).toBe(450);
    expect(result.totalAmount).toBe(5900);
  });

  it("discount by percentage", () => {
    const result = calculateLineItemTax({
      unitPrice: 100,
      quantity: 2,
      discountPercent: 10,
      gstRate: 5,
      isTaxInclusive: true,
    });

    // gross = 200, discount = 20, after = 180
    // taxable = 180 / 1.05 = 171.43
    expect(result.grossAmount).toBe(200);
    expect(result.discount).toBe(20);
    expect(result.taxableValue).toBe(171.43);
    expect(result.cgstAmount).toBe(4.29); // 171.43 * 2.5%
    expect(result.sgstAmount).toBe(4.29);
  });

  it("discount by fixed amount", () => {
    const result = calculateLineItemTax({
      unitPrice: 100,
      quantity: 2,
      discountAmount: 50,
      gstRate: 5,
      isTaxInclusive: true,
    });

    // gross = 200, discount = 50, after = 150
    // taxable = 150 / 1.05 = 142.86
    expect(result.grossAmount).toBe(200);
    expect(result.discount).toBe(50);
    expect(result.taxableValue).toBe(142.86);
  });

  it("zero quantity", () => {
    const result = calculateLineItemTax({
      unitPrice: 100,
      quantity: 0,
      gstRate: 18,
    });

    expect(result.grossAmount).toBe(0);
    expect(result.taxableValue).toBe(0);
    expect(result.cgstAmount).toBe(0);
    expect(result.sgstAmount).toBe(0);
    expect(result.totalAmount).toBe(0);
  });

  it("100% discount — free item (still has taxable value of 0)", () => {
    const result = calculateLineItemTax({
      unitPrice: 100,
      quantity: 1,
      discountPercent: 100,
      gstRate: 18,
      isTaxInclusive: true,
    });

    // Gross = 100, discount = 100, after = 0
    expect(result.discount).toBe(100);
    expect(result.taxableValue).toBe(0);
    expect(result.cgstAmount).toBe(0);
    expect(result.sgstAmount).toBe(0);
    expect(result.totalAmount).toBe(0);
  });

  it("large wholesale quantity (B2B)", () => {
    const result = calculateLineItemTax({
      unitPrice: 45.50,
      quantity: 5000,
      gstRate: 5,
      isTaxInclusive: false,
    });

    // gross = 45.50 * 5000 = 227500
    expect(result.grossAmount).toBe(227500);
    expect(result.taxableValue).toBe(227500);
    expect(result.cgstAmount).toBe(5687.50); // 227500 * 2.5%
    expect(result.sgstAmount).toBe(5687.50);
    expect(result.totalAmount).toBe(238875);
  });

  it("IGST is always 0 (intra-state only)", () => {
    const result = calculateLineItemTax({
      unitPrice: 500,
      quantity: 1,
      gstRate: 18,
      isTaxInclusive: false,
    });

    expect(result.igstRate).toBe(0);
    expect(result.igstAmount).toBe(0);
  });
});

// ─── calculateInvoiceTotals ──────────────────────────────────────────

describe("calculateInvoiceTotals", () => {
  it("sums multiple line items correctly", () => {
    const items = [
      calculateLineItemTax({ unitPrice: 100, quantity: 2, gstRate: 5, isTaxInclusive: true }),
      calculateLineItemTax({ unitPrice: 199, quantity: 1, gstRate: 18, isTaxInclusive: true }),
      calculateLineItemTax({ unitPrice: 40, quantity: 5, gstRate: 0, isTaxInclusive: true }),
    ];

    const totals = calculateInvoiceTotals(items);

    // line 1: taxable = 190.48, cgst = 4.76, sgst = 4.76
    // line 2: taxable = 168.64, cgst = 15.18, sgst = 15.18
    // line 3: taxable = 200, cgst = 0, sgst = 0
    expect(totals.subtotal).toBe(559.12);
    expect(totals.totalCgst).toBe(19.94);
    expect(totals.totalSgst).toBe(19.94);
    expect(totals.totalIgst).toBe(0);
    expect(totals.totalCess).toBe(0);

    // pre-round = 559.12 + 19.94 + 19.94 = 599.00
    expect(totals.totalAmount).toBe(599);
  });

  it("round-off within ±0.50", () => {
    // Create a scenario that results in paise
    const items = [
      calculateLineItemTax({ unitPrice: 33, quantity: 1, gstRate: 5, isTaxInclusive: true }),
    ];

    const totals = calculateInvoiceTotals(items);
    expect(Math.abs(totals.roundOff)).toBeLessThanOrEqual(0.5);
    expect(totals.totalAmount).toBe(Math.round(totals.totalAmount));
  });

  it("empty invoice", () => {
    const totals = calculateInvoiceTotals([]);

    expect(totals.subtotal).toBe(0);
    expect(totals.totalCgst).toBe(0);
    expect(totals.totalSgst).toBe(0);
    expect(totals.totalAmount).toBe(0);
    expect(totals.amountInWords).toBe("Zero Rupees Only");
  });

  it("includes amountInWords", () => {
    const items = [
      calculateLineItemTax({ unitPrice: 100, quantity: 1, gstRate: 0, isTaxInclusive: true }),
    ];

    const totals = calculateInvoiceTotals(items);
    expect(totals.amountInWords).toBe("One Hundred Rupees Only");
  });
});

// ─── convertAmountToWords ────────────────────────────────────────────

describe("convertAmountToWords", () => {
  it("zero", () => {
    expect(convertAmountToWords(0)).toBe("Zero Rupees Only");
  });

  it("simple amount", () => {
    expect(convertAmountToWords(100)).toBe("One Hundred Rupees Only");
  });

  it("with paise", () => {
    expect(convertAmountToWords(1234.5)).toBe(
      "One Thousand Two Hundred Thirty Four Rupees and Fifty Paise Only",
    );
  });

  it("uses Indian numbering — lakh", () => {
    expect(convertAmountToWords(150000)).toBe("One Lakh Fifty Thousand Rupees Only");
  });

  it("uses Indian numbering — crore", () => {
    expect(convertAmountToWords(12345678.9)).toBe(
      "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees and Ninety Paise Only",
    );
  });

  it("single rupee", () => {
    expect(convertAmountToWords(1)).toBe("One Rupees Only");
  });

  it("paise only", () => {
    expect(convertAmountToWords(0.75)).toBe("Seventy Five Paise Only");
  });

  it("large grocery wholesale invoice", () => {
    const words = convertAmountToWords(287450);
    expect(words).toBe("Two Lakh Eighty Seven Thousand Four Hundred Fifty Rupees Only");
  });
});

// ─── backCalculateFromMRP ────────────────────────────────────────────

describe("backCalculateFromMRP", () => {
  it("18% rate — ₹599 MRP", () => {
    const result = backCalculateFromMRP(599, 18);

    // taxable = 599 / 1.18 = 507.63
    expect(result.taxableValue).toBe(507.63);
    expect(result.cgst).toBe(45.69); // 507.63 * 9%
    expect(result.sgst).toBe(45.69);
    // total should reconstruct close to 599
    expect(result.total).toBe(599.01); // minor rounding — 507.63 + 45.69 + 45.69
  });

  it("5% rate — ₹275 atta", () => {
    const result = backCalculateFromMRP(275, 5);

    // taxable = 275 / 1.05 = 261.90
    expect(result.taxableValue).toBe(261.9);
    expect(result.cgst).toBe(6.55); // 261.90 * 2.5%
    expect(result.sgst).toBe(6.55);
  });

  it("0% rate — exempt", () => {
    const result = backCalculateFromMRP(68, 0);

    expect(result.taxableValue).toBe(68);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
    expect(result.total).toBe(68);
  });

  it("40% aerated drink", () => {
    const result = backCalculateFromMRP(40, 40);

    // taxable = 40 / 1.40 = 28.57
    expect(result.taxableValue).toBe(28.57);
    expect(result.cgst).toBe(5.71); // 28.57 * 20%
    expect(result.sgst).toBe(5.71);
  });
});
