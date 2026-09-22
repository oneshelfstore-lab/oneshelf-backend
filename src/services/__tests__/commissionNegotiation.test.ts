import { describe, it, expect } from "vitest";
import { resolveDecision } from "../commissionNegotiation.js";
import { resolveCommissionPct } from "../sellerSplit.js";

/**
 * Runbook step 20 — what a commission decision actually grants.
 *
 * This is the one step in the negotiation where a mistake writes a WRONG RATE onto a product and
 * nothing anywhere says so: the seller keeps selling, the platform keeps charging, and the only
 * evidence is a number in a column nobody looks at until a settlement statement stops matching.
 *
 * The live half — the transaction, the compare-and-swap, the override actually landing on the
 * product — is scripts/proveCommissionRequest.ts.
 */

describe("resolveDecision", () => {
  it("approves exactly what was asked", () => {
    expect(resolveDecision("APPROVE", 2, null)).toEqual({ status: "APPROVED", granted: 2 });
  });

  it("counters at the owner's number, not the seller's", () => {
    expect(resolveDecision("COUNTER", 2, 3.5)).toEqual({ status: "COUNTERED", granted: 3.5 });
  });

  // ⚠️ THE ONE THAT MATTERS MOST. A rejection must leave the product on the seller's default rate.
  // Granting 0 would put it on zero commission — the platform working that product for free —
  // written by the code path whose entire purpose was to decline.
  it("grants NOTHING on a rejection, not zero", () => {
    expect(resolveDecision("REJECT", 2, null)).toEqual({ status: "REJECTED", granted: null });
    expect(resolveDecision("REJECT", 2, 3)).toEqual({ status: "REJECTED", granted: null });
  });

  // A genuine 0% grant is a real thing — a product the platform carries at no cut — and must be
  // distinguishable from a rejection. It is: one is 0, the other is null.
  it("can grant a real 0% without that meaning rejected", () => {
    expect(resolveDecision("APPROVE", 0, null)).toEqual({ status: "APPROVED", granted: 0 });
    const d = resolveDecision("COUNTER", 2, 0);
    expect(d).toEqual({ status: "COUNTERED", granted: 0 });
    // ...and the money math reads that 0 as 0, not as "fall back to the seller's rate".
    expect(resolveCommissionPct({ lineTotal: 100, taxableValue: 100, commissionPctOverride: d.granted }, 5)).toBe(0);
  });

  it("refuses a counter with no rate attached", () => {
    expect(() => resolveDecision("COUNTER", 2, null)).toThrow(/needs the rate/i);
  });

  // ⚠️ Bounded here for a readable message; the rule itself is a database CHECK. A negative
  // commission is the platform paying the seller a fee — a supply in the opposite direction that
  // the payout, the commission invoice and GSTR-1 are all built the wrong way round for.
  it("refuses a negative rate", () => {
    expect(() => resolveDecision("COUNTER", 2, -1)).toThrow(/between 0 and 100/i);
  });

  it("refuses a rate above 100", () => {
    expect(() => resolveDecision("COUNTER", 2, 101)).toThrow(/between 0 and 100/i);
  });

  // A "counter" at the asked rate is an approval wearing the wrong label, and it would land in the
  // seller's history as a negotiation that never happened.
  it("refuses a counter that matches the ask", () => {
    expect(() => resolveDecision("COUNTER", 2, 2)).toThrow(/approve it instead/i);
    expect(() => resolveDecision("COUNTER", 2, 2.004)).toThrow(/approve it instead/i); // same to the paise
  });

  it("rounds a granted rate to the paise, like every other money figure", () => {
    expect(resolveDecision("COUNTER", 2, 3.456).granted).toBe(3.46);
  });
});
