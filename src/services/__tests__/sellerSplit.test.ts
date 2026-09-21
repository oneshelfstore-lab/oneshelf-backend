import { describe, it, expect } from "vitest";
import { sumSellerLines, computeSellerSplit } from "../sellerSplit.js";

/**
 * This split decides what a seller is actually paid, and until now it was inline in three route
 * handlers with no test at all. Every failure mode here is silent money: a rate applied to the wrong
 * base, a rounding helper swapped for its near-twin, a house slice quietly accruing tax on the
 * platform's own supply. None of it shows up on a screen.
 *
 * The first block pins REAL PRODUCTION ROWS, read from the live database on 21 Sep 2026. They are
 * the proof that lifting this arithmetic out of the route handlers changed nothing — if the
 * extraction had drifted by a paise, these fail.
 *
 * Several assertions below pin behaviour that is KNOWN WRONG and scheduled to change (TCS at 1%,
 * commission on the GST-inclusive figure). That is deliberate: steps 06 and 07 of the migration
 * runbook should break them loudly rather than move money quietly. Each one is marked.
 */

describe("computeSellerSplit — real production rows", () => {
  // ONS/2627/00013 · bansal stationary. 0% GST stationery, so gross equals taxable.
  it("reproduces ONS/2627/00013 exactly", () => {
    expect(
      computeSellerSplit({
        subtotal: 126,
        taxableValue: 126,
        commissionPct: 5,
        tcsRatePct: 1,
        tdsAmount: 0,
        isHouse: false,
      }),
    ).toEqual({
      subtotal: 126,
      commissionPct: 5,
      commissionAmount: 6.3,
      tcsAmount: 1.26,
      tdsAmount: 0,
      netPayable: 118.44,
    });
  });

  it("reproduces ONS/2627/00026 exactly", () => {
    const split = computeSellerSplit({
      subtotal: 72,
      taxableValue: 72,
      commissionPct: 5,
      tcsRatePct: 1,
      tdsAmount: 0,
      isHouse: false,
    });
    expect(split.commissionAmount).toBe(3.6);
    expect(split.tcsAmount).toBe(0.72);
    expect(split.netPayable).toBe(67.68);
  });

  // ONS/2627/00439 · Chandpur Bakehouse, the one food order placed so far. Gross 210, taxable 200 —
  // the only live row where the two differ, which makes it the one row that can tell the two
  // candidate commission bases apart.
  it("reproduces ONS/2627/00439 exactly, including its zero TCS", () => {
    expect(
      computeSellerSplit({
        subtotal: 210,
        taxableValue: 200,
        commissionPct: 5,
        tcsRatePct: 0, // Sec 9(5): the platform is the deemed supplier, so it collects no TCS
        tdsAmount: 0,
        isHouse: false,
      }),
    ).toEqual({
      subtotal: 210,
      commissionPct: 5,
      commissionAmount: 10.5,
      tcsAmount: 0,
      tdsAmount: 0,
      netPayable: 199.5,
    });
  });
});

describe("computeSellerSplit — the base each rate is applied to", () => {
  // STEP 07 WILL BREAK THIS, ON PURPOSE. Commission is charged on the GST-INCLUSIVE subtotal today:
  // 210 gross carrying 200 taxable pays 10.50, not 10.00. When step 07 moves the base, change this
  // to 10 in the same commit. Do not "fix" it before then, or the change ships unannounced.
  it("charges commission on the GST-inclusive subtotal, not the taxable value", () => {
    const { commissionAmount } = computeSellerSplit({
      subtotal: 210,
      taxableValue: 200,
      commissionPct: 5,
      tcsRatePct: 0,
      tdsAmount: 0,
      isHouse: false,
    });
    expect(commissionAmount).toBe(10.5);
    expect(commissionAmount).not.toBe(10);
  });

  it("charges TCS on the taxable value, not the gross", () => {
    const { tcsAmount } = computeSellerSplit({
      subtotal: 210,
      taxableValue: 200,
      commissionPct: 0,
      tcsRatePct: 1,
      tdsAmount: 0,
      isHouse: false,
    });
    expect(tcsAmount).toBe(2); // 1% of 200, not of 210
  });

  // STEP 06 WILL BREAK THIS, ON PURPOSE. The notified rate has been 0.5% since 10 Jul 2024
  // (Notification 15/2024-Central Tax); we are still at 1%. Step 06 changes the constant and this
  // expectation together.
  it("is still on the superseded 1% TCS rate", () => {
    const { tcsAmount } = computeSellerSplit({
      subtotal: 200,
      taxableValue: 200,
      commissionPct: 0,
      tcsRatePct: 1,
      tdsAmount: 0,
      isHouse: false,
    });
    expect(tcsAmount).toBe(2);
  });

  it("subtracts TDS from the payout without recomputing it", () => {
    const { netPayable, tdsAmount } = computeSellerSplit({
      subtotal: 1000,
      taxableValue: 1000,
      commissionPct: 5,
      tcsRatePct: 1,
      tdsAmount: 1, // resolved against the FY cumulative by the caller, inside a transaction
      isHouse: false,
    });
    expect(tdsAmount).toBe(1);
    expect(netPayable).toBe(1000 - 50 - 10 - 1);
  });
});

describe("computeSellerSplit — the house store", () => {
  // The house seller IS the platform. Collecting Sec-52 TCS here would be the platform withholding
  // tax from itself on its own supply. Step 09 makes this conditional on a second legal entity
  // existing; until that entity does, it must stay unconditional.
  it("collects no TCS from the house store even at a live rate", () => {
    expect(
      computeSellerSplit({
        subtotal: 500,
        taxableValue: 500,
        commissionPct: 0,
        tcsRatePct: 1,
        tdsAmount: 0,
        isHouse: true,
      }).tcsAmount,
    ).toBe(0);
  });

  it("leaves the whole subtotal payable when the house store has no commission", () => {
    expect(
      computeSellerSplit({
        subtotal: 500,
        taxableValue: 500,
        commissionPct: 0,
        tcsRatePct: 1,
        tdsAmount: 0,
        isHouse: true,
      }).netPayable,
    ).toBe(500);
  });
});

describe("computeSellerSplit — rounding", () => {
  // The split has always rounded with toFixed. Several sibling services define
  // round2 = Math.round((n + EPSILON) * 100) / 100, and on this input the two disagree by a paise:
  // toFixed gives 1.00, round2 gives 1.01. Swapping them would silently restate every payout.
  it("rounds with toFixed, not the round2 helper other services use", () => {
    const { commissionAmount } = computeSellerSplit({
      subtotal: 20.1,
      taxableValue: 20.1,
      commissionPct: 5,
      tcsRatePct: 0,
      tdsAmount: 0,
      isHouse: false,
    });
    expect(commissionAmount).toBe(1);
    expect(Math.round((1.005 + Number.EPSILON) * 100) / 100).toBe(1.01); // the twin, for contrast
  });

  it("leaves no floating-point tail on the payout", () => {
    const { netPayable } = computeSellerSplit({
      subtotal: 33.33,
      taxableValue: 29.76,
      commissionPct: 7.5,
      tcsRatePct: 1,
      tdsAmount: 0.03,
      isHouse: false,
    });
    expect(netPayable).toBe(+netPayable.toFixed(2));
    // 33.33 − 2.50 − 0.30 − 0.03. Commission is 2.49975 and TCS 0.2976 before rounding, so this
    // also pins that each component is rounded before the subtraction, not after.
    expect(netPayable).toBe(30.5);
  });
});

describe("sumSellerLines", () => {
  it("sums a seller's lines into a gross and a taxable total", () => {
    expect(
      sumSellerLines([
        { lineTotal: 126, taxableValue: 120 },
        { lineTotal: 72, taxableValue: 68.57 },
      ]),
    ).toEqual({ subtotal: 198, taxableValue: 188.57 });
  });

  it("rounds the sum, not each line", () => {
    const { subtotal } = sumSellerLines([
      { lineTotal: 10.005, taxableValue: 0 },
      { lineTotal: 10.005, taxableValue: 0 },
      { lineTotal: 10.005, taxableValue: 0 },
    ]);
    expect(subtotal).toBe(30.02); // the running sum is 30.015; rounding each line first gives 30.03
  });

  it("returns zeroes for a seller with no lines rather than NaN", () => {
    expect(sumSellerLines([])).toEqual({ subtotal: 0, taxableValue: 0 });
  });

  // A free gift is a real order line at zero. It lands in the house seller's bucket at placement and
  // must not move any of the money — that is what makes folding it in there safe.
  it("is unmoved by a zero-value free-gift line", () => {
    expect(
      sumSellerLines([
        { lineTotal: 126, taxableValue: 126 },
        { lineTotal: 0, taxableValue: 0 },
      ]),
    ).toEqual({ subtotal: 126, taxableValue: 126 });
  });
});
