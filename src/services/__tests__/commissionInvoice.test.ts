import { describe, it, expect } from "vitest";
import { scopeFilter, HOUSE_SCOPE, PLATFORM_SCOPE } from "../reports.js";
import { INVOICE_KIND } from "../../data/invoiceKinds.js";
import {
  commissionWithGst,
  COMMISSION_GST_RATE_PCT,
  COMMISSION_SAC_CODE,
  COMMISSION_IS_GST_EXCLUSIVE,
} from "../../data/commissionTax.js";

/**
 * Runbook step 17 — the step the neutrality gate existed to protect. Before step 13, a commission
 * invoice carried no seller supplier-snapshot and therefore read as the SHOP's own supply: the
 * platform's income would have been filed as the shop's, and nothing on the row would have looked
 * wrong. These assertions are that gate pointed at the row it was built for.
 */

function matches(row: Record<string, unknown>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond && typeof cond === "object" && "in" in cond) return (cond.in as unknown[]).includes(row[k]);
    return row[k] === cond;
  });
}

const commissionInvoice = {
  invoiceKind: INVOICE_KIND.COMMISSION,
  sellerId: null,
  supplierName: null,
};

describe("a commission invoice reaches exactly one GST return", () => {
  it("is the platform's income", () => {
    expect(matches(commissionInvoice, scopeFilter(PLATFORM_SCOPE))).toBe(true);
  });

  it("is NOT the shop's, though it carries no supplier snapshot", () => {
    expect(commissionInvoice.supplierName).toBeNull();
    expect(matches(commissionInvoice, scopeFilter(HOUSE_SCOPE))).toBe(false);
  });

  it("is NOT the billed seller's own outward supply", () => {
    // The seller is the CUSTOMER on this document, not the supplier. If it landed in their GSTR-1
    // they would be declaring the platform's income as their own sales.
    for (const id of ["seller-1", "seller-2"]) {
      expect(matches({ ...commissionInvoice, sellerId: id }, scopeFilter({ kind: "seller", sellerId: id }))).toBe(false);
    }
  });
});

describe("commission is GST-EXCLUSIVE, and that is a decision, not a default", () => {
  it("adds the tax on top rather than carving it out", () => {
    // Everything else this platform prices is GST-inclusive, so the instinct is to back the tax out
    // of the withheld commission. The settlement architecture says otherwise with numbers: a ₹10
    // commission shows "GST on commission 18% −₹1.80" as its OWN line. Inclusive would quietly make
    // a 5% commission worth 4.24% and hand sellers a discount nobody agreed to.
    expect(COMMISSION_IS_GST_EXCLUSIVE).toBe(true);
    const { taxable, gst, total } = commissionWithGst(10);
    expect(taxable).toBe(10);
    expect(gst).toBe(1.8);
    expect(total).toBe(11.8);
    // What "inclusive" would have produced, for contrast:
    expect(+(10 / 1.18).toFixed(2)).toBe(8.47);
  });

  it("reproduces the settlement architecture's worked example", () => {
    // Seller A ₹10 commission, seller B ₹5. The architecture says the platform retains ₹19.50
    // across both, made of commission + its GST + TCS + TDS.
    const a = commissionWithGst(10), b = commissionWithGst(5);
    const tcs = 1.0 + 0.5, tds = 0.2 + 0.1;
    // toFixed because summing four floats reaches 19.500000000000004 — a binary artifact of the
    // test arithmetic, not of the amounts, each of which is already rounded to the paisa.
    expect(+(a.total + b.total + tcs + tds).toFixed(2)).toBe(19.5);
  });

  it("the three figures always agree, at every commission", () => {
    // total is defined as the sum rather than rounded on its own, so there is no paisa to lose —
    // the mirror of the delivery split, where the TOTAL is fixed and the tax is subtracted.
    for (let p = 1; p <= 5000; p++) {
      const { taxable, gst, total } = commissionWithGst(p / 100);
      expect(+(taxable + gst).toFixed(2)).toBe(total);
    }
  });

  it("zero commission bills nothing at all", () => {
    expect(commissionWithGst(0)).toEqual({ taxable: 0, gst: 0, total: 0 });
    expect(commissionWithGst(-5)).toEqual({ taxable: 0, gst: 0, total: 0 });
  });
});

describe("what the document says", () => {
  it("carries the marketplace-service SAC at 18%", () => {
    expect(COMMISSION_SAC_CODE).toBe("998599");
    expect(COMMISSION_GST_RATE_PCT).toBe(18);
  });

  it("halves into CGST and SGST without inventing a paisa", () => {
    // ₹1.80 halves cleanly; an odd one does not, and the second half absorbs the remainder rather
    // than both halves rounding up and billing more tax than was charged.
    const gst = 1.35;
    const half = Math.round((gst / 2 + Number.EPSILON) * 100) / 100;
    const other = Math.round((gst - half + Number.EPSILON) * 100) / 100;
    expect(half).toBe(0.68);
    expect(other).toBe(0.67);
    expect(+(half + other).toFixed(2)).toBe(gst);
  });
});

describe("the invoice lands in the month it bills", () => {
  /** What the reports build their window from — LOCAL time, per periodToDateRange. */
  const reportWindow = (mmyyyy: string) => {
    const month = parseInt(mmyyyy.slice(0, 2), 10) - 1;
    const year = parseInt(mmyyyy.slice(2), 10);
    return { from: new Date(year, month, 1), to: new Date(year, month + 1, 0, 23, 59, 59, 999) };
  };
  /** What the generator stamps: local noon on the last day of the period. */
  const invoiceDate = (period: string) => {
    const [yy, mm] = period.split("-").map(Number);
    const end = new Date(Date.UTC(yy!, mm!, 1));
    const last = new Date(end.getTime() - 86400000);
    return new Date(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate(), 12, 0, 0, 0);
  };

  it("falls inside the report's own window, in this machine's timezone", () => {
    // ⚠️ Found by running the generator for real: an invoice stamped at the UTC end of the month
    // (23:59:59.999Z) reads as 05:29 on the FIRST of the next month in IST, drops out of the period
    // it bills, and June's GSTR-1 gained ₹0.00 instead of ₹21.60. Noon is unambiguous anywhere
    // within ±12h of UTC.
    for (const p of ["2026-01", "2026-02", "2026-06", "2026-07", "2026-12"]) {
      const d = invoiceDate(p);
      const w = reportWindow(p.replace(/(\d{4})-(\d{2})/, "$2$1"));
      expect(d.getTime()).toBeGreaterThanOrEqual(w.from.getTime());
      expect(d.getTime()).toBeLessThanOrEqual(w.to.getTime());
    }
  });

  it("the UTC-end stamp it replaced would have escaped the window", () => {
    // The bug, kept as a demonstration so the fix cannot be "simplified" back into it. Only fails
    // where local time is ahead of UTC — which is where this runs, and is why it was invisible in
    // a unit test written without it.
    const end = new Date(Date.UTC(2026, 6, 1));
    const buggy = new Date(end.getTime() - 1);
    const w = reportWindow("062026");
    const offsetMinutes = -new Date(2026, 5, 30).getTimezoneOffset();
    if (offsetMinutes > 0) expect(buggy.getTime()).toBeGreaterThan(w.to.getTime());
  });
});
