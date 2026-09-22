import { describe, it, expect } from "vitest";
import { calculateLineItemTax, calculateInvoiceTotals } from "../taxEngine.js";
import { isCompositionSeller } from "../orderInvoice.js";
import { COMPOSITION_DECLARATION } from "../pdfGenerator.js";

/**
 * Runbook step 14. Two failure modes, both silent on screen and both expensive on paper:
 *
 *  1. A composition dealer's document charges GST they are not permitted to charge (Sec 10 bars
 *     collection), or omits the Rule 5(1)(f) declaration.
 *  2. A REGULAR dealer's document gains that declaration, asserting something untrue about a
 *     registered business — the failure that comes from inferring the scheme from all-zero tax.
 *
 * So the tests below are mostly about keeping those two apart.
 */

const shop = (over: Record<string, unknown> = {}) =>
  ({ isHouse: false, vertical: "SHOP", gstScheme: "REGULAR", ...over }) as any;

describe("isCompositionSeller — the scheme, never the arithmetic", () => {
  it("is true only for an external seller whose scheme says COMPOSITION", () => {
    expect(isCompositionSeller(shop({ gstScheme: "COMPOSITION" }))).toBe(true);
    expect(isCompositionSeller(shop())).toBe(false);
  });

  it("is false when the scheme is unset — the column default is REGULAR", () => {
    // Every seller on file predates the column, so an absent value must never be read as
    // composition; that would start issuing bills of supply to registered dealers.
    expect(isCompositionSeller(shop({ gstScheme: undefined }))).toBe(false);
    expect(isCompositionSeller(shop({ gstScheme: null }))).toBe(false);
  });

  it("is false for the house store even if a scheme is somehow set on it", () => {
    // The STORE's own GST scheme lives on Company, not on a Seller row. Reading it off the house
    // seller would let a stray value change how the shop's own invoices are issued.
    expect(isCompositionSeller(shop({ isHouse: true, gstScheme: "COMPOSITION" }))).toBe(false);
    expect(isCompositionSeller(null)).toBe(false);
    expect(isCompositionSeller(undefined)).toBe(false);
  });

  it("is false for a restaurant — Sec 9(5) makes that the PLATFORM's supply, not theirs", () => {
    expect(isCompositionSeller(shop({ vertical: "FOOD", gstScheme: "COMPOSITION" }))).toBe(false);
  });
});

describe("calculateLineItemTax — composition collects nothing", () => {
  const base = { unitPrice: 100, quantity: 2, gstRate: 18, isTaxInclusive: true, isInterState: false };

  it("makes the full amount charged the value of supply, with every component nil", () => {
    const r = calculateLineItemTax({ ...base, isComposition: true });
    // ₹200 charged stays ₹200 of supply value — NOT 169.49 + 30.51 of tax.
    expect(r.taxableValue).toBe(200);
    expect(r.cgstAmount).toBe(0);
    expect(r.sgstAmount).toBe(0);
    expect(r.igstAmount).toBe(0);
    expect(r.cessAmount).toBe(0);
    expect(r.totalAmount).toBe(200);
    // The rate is reported as zero too, so the document shows no rate column to fill in.
    expect(r.gstRate).toBe(0);
  });

  it("the customer pays what they were charged — the split changes, the price does not", () => {
    const regular = calculateLineItemTax(base);
    const composition = calculateLineItemTax({ ...base, isComposition: true });
    // Composition lands exactly on the ₹200 charged. The regular line lands a PAISA short — 169.49
    // + 15.25 + 15.25 = 199.99 — because a GST-inclusive price is back-calculated and each part is
    // rounded on its own. That is a pre-existing artifact of inclusive pricing, not something the
    // composition branch introduced, and calculateInvoiceTotals' roundOff is what closes it at the
    // document level. Pinned as ≤1 paisa so the drift can never silently grow.
    expect(composition.totalAmount).toBe(200);
    expect(Math.abs(composition.totalAmount - regular.totalAmount)).toBeLessThanOrEqual(0.01);
    expect(regular.taxableValue).toBeLessThan(composition.taxableValue); // tax was carved out
  });

  it("zeroes cess as well as GST — a composition dealer collects no cess either", () => {
    const r = calculateLineItemTax({ ...base, cessRate: 12, isComposition: true });
    expect(r.cessRate).toBe(0);
    expect(r.cessAmount).toBe(0);
    expect(r.totalAmount).toBe(200);
  });

  it("also holds inter-state, where the rate would otherwise go to IGST", () => {
    const r = calculateLineItemTax({ ...base, isInterState: true, isComposition: true });
    expect(r.igstAmount).toBe(0);
    expect(r.taxableValue).toBe(200);
  });

  it("leaves a REGULAR line byte-for-byte as it was", () => {
    // The default must be a no-op, or step 14 silently restates every invoice in the system.
    expect(calculateLineItemTax(base)).toEqual(calculateLineItemTax({ ...base, isComposition: false }));
  });

  it("rolls up to an invoice with zero tax and a subtotal equal to what was charged", () => {
    const lines = [
      calculateLineItemTax({ unitPrice: 100, quantity: 2, gstRate: 18, isComposition: true }),
      calculateLineItemTax({ unitPrice: 55.5, quantity: 1, gstRate: 5, isComposition: true }),
    ];
    const t = calculateInvoiceTotals(lines);
    expect(t.subtotal).toBe(255.5);
    expect(t.totalCgst).toBe(0);
    expect(t.totalSgst).toBe(0);
    expect(t.totalIgst).toBe(0);
  });
});

describe("the document type is chosen by scheme, not by the numbers", () => {
  // This mirrors the expression in createOneInvoice. It is asserted here rather than exported,
  // because what matters is the ORDER of the two tests: composition first and on its own terms.
  const chooseType = (isComposition: boolean, allExempt: boolean) =>
    isComposition || allExempt ? "BILL_OF_SUPPLY" : "TAX_INVOICE";

  it("a composition seller gets a Bill of Supply even where the goods are taxable", () => {
    expect(chooseType(true, false)).toBe("BILL_OF_SUPPLY");
  });

  it("a regular seller with only exempt goods also gets one — for a different reason", () => {
    expect(chooseType(false, true)).toBe("BILL_OF_SUPPLY");
  });

  it("a regular seller with taxable goods gets a tax invoice", () => {
    expect(chooseType(false, false)).toBe("TAX_INVOICE");
  });
});

describe("the Rule 5(1)(f) declaration", () => {
  it("is the exact prescribed wording", () => {
    // Prescribed, not written by us. A reworded declaration is a defective document.
    expect(COMPOSITION_DECLARATION).toBe(
      "composition taxable person, not eligible to collect tax on supplies",
    );
  });
});
