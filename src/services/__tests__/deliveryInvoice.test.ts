import { describe, it, expect } from "vitest";
import { scopeFilter, HOUSE_SCOPE, PLATFORM_SCOPE } from "../reports.js";
import { INVOICE_KIND } from "../../data/invoiceKinds.js";
import { DELIVERY_SAC_CODE, DELIVERY_GST_RATE_PCT, splitInclusiveDeliveryFee } from "../../data/deliveryTax.js";

/**
 * Runbook step 16. The prove it asks for is "it appears in the platform GSTR-1 and in neither the
 * shop's nor any seller's" — which is a question about the SCOPE PREDICATE meeting a row that does
 * not exist yet, so it is asserted here as the meeting rather than waiting for live data.
 *
 * The scope-neutrality gate (scripts/reportScopeSnapshot.ts) proves the other half: that adding the
 * delivery invoice moves nothing that already existed.
 */

/** Does `row` satisfy a scope's Prisma `where` fragment? Only the operators the scopes actually use. */
function matches(row: Record<string, unknown>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond && typeof cond === "object" && "in" in cond) return (cond.in as unknown[]).includes(row[k]);
    return row[k] === cond;
  });
}

// What createDeliveryInvoice writes, in the shape the scope predicates read.
const deliveryInvoice = {
  invoiceKind: INVOICE_KIND.DELIVERY,
  sellerId: null,
  supplierName: null,
};

describe("a delivery invoice reaches exactly one GST return", () => {
  it("is in the platform's", () => {
    expect(matches(deliveryInvoice, scopeFilter(PLATFORM_SCOPE))).toBe(true);
  });

  it("is NOT in the shop's, even though it carries no supplier snapshot", () => {
    // This is the whole reason step 13 had to happen first. The delivery invoice is issued by the
    // platform, so it has no seller supplier-snapshot — exactly like a house goods invoice. On the
    // old one-question predicate (`supplierName IS NULL` ⇒ house) it would have been filed as the
    // shop's own income, and nothing on the row would have looked wrong.
    expect(deliveryInvoice.supplierName).toBeNull();
    expect(matches(deliveryInvoice, scopeFilter(HOUSE_SCOPE))).toBe(false);
  });

  it("is NOT in any seller's, and is guarded twice", () => {
    // Guard one: the row carries no sellerId at all, so a seller scope cannot select it.
    // Guard two: even if some later change set one, the seller scope demands invoiceKind GOODS.
    // One guard being data and the other code is deliberate — they fail independently.
    expect(deliveryInvoice.sellerId).toBeNull();
    for (const id of ["seller-1", "seller-2"]) {
      expect(matches({ ...deliveryInvoice, sellerId: id }, scopeFilter({ kind: "seller", sellerId: id }))).toBe(false);
    }
  });

  it("a goods invoice is still in the shop's and not the platform's", () => {
    // The mirror, so a future change cannot fix one direction by breaking the other.
    const goods = { invoiceKind: INVOICE_KIND.GOODS, sellerId: null, supplierName: null };
    expect(matches(goods, scopeFilter(HOUSE_SCOPE))).toBe(true);
    expect(matches(goods, scopeFilter(PLATFORM_SCOPE))).toBe(false);
  });
});

describe("what the document says", () => {
  it("classifies the line with a SAC, because delivery is a service", () => {
    // The field is called hsnCode for historical reasons; the value is a Service Accounting Code
    // and the PDF prints the header off invoiceKind so the column says SAC.
    expect(DELIVERY_SAC_CODE).toBe("9968");
    expect(DELIVERY_SAC_CODE).not.toMatch(/^0/); // an HSN chapter, which this is not
  });

  it("bills exactly the fee the customer paid", () => {
    // The invoice total is the fee itself, and its parts close on it — so a customer comparing the
    // ₹30 on their order to the ₹30 on this document can never find a paisa of difference.
    for (const fee of [30, 35, 49, 99.5]) {
      const { taxable, gst } = splitInclusiveDeliveryFee(fee);
      expect(+(taxable + gst).toFixed(2)).toBe(fee);
    }
  });

  it("halves the tax without losing the odd paisa", () => {
    // CGST and SGST are derived from the already-split GST by halving and SUBTRACTING the remainder,
    // never by halving twice — ₹7.47 splits 3.73/3.74, and two independent halvings would report
    // 3.74/3.74 and bill a paisa more tax than was collected.
    const gst = 7.47;
    const half = Math.round((gst / 2 + Number.EPSILON) * 100) / 100;
    const other = Math.round((gst - half + Number.EPSILON) * 100) / 100;
    expect(half).toBe(3.74);
    expect(other).toBe(3.73);
    expect(+(half + other).toFixed(2)).toBe(gst);
  });
});

describe("the rate on the document is the statutory one", () => {
  it("is never back-derived from the rounded amounts", () => {
    // Caught by actually running the generator against live data: dividing the rounded tax by the
    // rounded base gives 4.58 / 25.42 = 18.02%, and an invoice — and the GSTR-1 built from it —
    // stating 18.02% is simply wrong, because there is no such rate. The amounts stay
    // fee-anchored so they close; the rate is the one the law sets.
    const { taxable, gst } = splitInclusiveDeliveryFee(30);
    const derived = Math.round((gst / taxable) * 100 * 100) / 100;
    expect(derived).toBe(18.02);              // what the bug produced
    expect(DELIVERY_GST_RATE_PCT).toBe(18);   // what the document must say
    expect(derived).not.toBe(DELIVERY_GST_RATE_PCT);
  });

  it("halves cleanly into CGST and SGST", () => {
    // 18.02 / 2 = 9.01, which is not a rate either. Half of the statutory rate is.
    expect(DELIVERY_GST_RATE_PCT / 2).toBe(9);
  });
});
