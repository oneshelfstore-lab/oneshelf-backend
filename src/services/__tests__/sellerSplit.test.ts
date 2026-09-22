import { describe, it, expect } from "vitest";
import {
  sumSellerLines,
  computeSellerSplit,
  resolveCommissionPct,
  type SellerLine,
} from "../sellerSplit.js";
import { TCS_RATE_PCT } from "../../data/taxRates.js";

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
 * ⚠️ They run the WHOLE pipeline — sumSellerLines, then computeSellerSplit — because since runbook
 * step 08 the commission is resolved line by line and handed to the split rather than computed
 * inside it. Testing the split alone would leave the half that decides the rate untested.
 *
 * One assertion below pins behaviour that is KNOWN WRONG and scheduled to change (commission on the
 * GST-inclusive figure, runbook step 07). That is deliberate: it should break loudly rather than
 * move money quietly. It is marked.
 */

/** The real placement pipeline, as routes/orders.ts runs it. */
function placeSlice(
  lines: SellerLine[],
  sellerCommissionPct: number,
  opts: { tcsRatePct: number; tdsAmount?: number; isHouse?: boolean },
) {
  const totals = sumSellerLines(lines, sellerCommissionPct);
  return {
    totals,
    split: computeSellerSplit({
      subtotal: totals.subtotal,
      taxableValue: totals.taxableValue,
      commissionPct: totals.commissionPct,
      commissionAmount: totals.commissionAmount,
      tcsRatePct: opts.tcsRatePct,
      tdsAmount: opts.tdsAmount ?? 0,
      isHouse: opts.isHouse ?? false,
    }),
  };
}

describe("the split — real production rows", () => {
  // ONS/2627/00013 · bansal stationary. 0% GST stationery, so gross equals taxable.
  // ⚠️ Replayed at tcsRatePct 1, the rate the row was ACTUALLY written at. Replaying it at today's
  // 0.5% would not reproduce the ₹1.26 that is stored — which is the whole reason the rate is
  // snapshotted per row rather than read from the constant (runbook step 06).
  it("reproduces ONS/2627/00013 exactly", () => {
    expect(placeSlice([{ lineTotal: 126, taxableValue: 126 }], 5, { tcsRatePct: 1 }).split).toEqual({
      subtotal: 126,
      taxableValue: 126,
      tcsRatePct: 1,
      commissionPct: 5,
      commissionAmount: 6.3,
      tcsAmount: 1.26,
      tdsAmount: 0,
      netPayable: 118.44,
    });
  });

  it("reproduces ONS/2627/00026 exactly", () => {
    const { split } = placeSlice([{ lineTotal: 72, taxableValue: 72 }], 5, { tcsRatePct: 1 });
    expect(split.commissionAmount).toBe(3.6);
    expect(split.tcsAmount).toBe(0.72);
    expect(split.netPayable).toBe(67.68);
  });

  // ONS/2627/00439 · Chandpur Bakehouse, the one food order placed so far. Gross 210, taxable 200 —
  // the only live row where the two differ, which makes it the one row that can tell the two
  // candidate commission bases apart.
  it("reproduces ONS/2627/00439 exactly, including its zero TCS", () => {
    expect(placeSlice([{ lineTotal: 210, taxableValue: 200 }], 5, { tcsRatePct: 0 }).split).toEqual({
      subtotal: 210,
      taxableValue: 200,
      tcsRatePct: 0,
      commissionPct: 5,
      commissionAmount: 10.5,
      tcsAmount: 0,
      tdsAmount: 0,
      netPayable: 199.5,
    });
  });
});

describe("the base each rate is applied to", () => {
  // STEP 07 WILL BREAK THIS, ON PURPOSE. Commission is charged on the GST-INCLUSIVE subtotal today:
  // 210 gross carrying 200 taxable pays 10.50, not 10.00. When step 07 moves the base, change this
  // to 10 in the same commit. Do not "fix" it before then, or the change ships unannounced.
  it("charges commission on the GST-inclusive line total, not the taxable value", () => {
    const { commissionAmount } = sumSellerLines([{ lineTotal: 210, taxableValue: 200 }], 5);
    expect(commissionAmount).toBe(10.5);
    expect(commissionAmount).not.toBe(10);
  });

  it("charges TCS on the taxable value, not the gross", () => {
    const { split } = placeSlice([{ lineTotal: 210, taxableValue: 200 }], 0, { tcsRatePct: 1 });
    expect(split.tcsAmount).toBe(2); // 1% of 200, not of 210
  });

  it("subtracts TDS from the payout without recomputing it", () => {
    const { split } = placeSlice([{ lineTotal: 1000, taxableValue: 1000 }], 5, {
      tcsRatePct: 1,
      tdsAmount: 1, // resolved against the FY cumulative by the caller, inside a transaction
    });
    expect(split.tdsAmount).toBe(1);
    expect(split.netPayable).toBe(1000 - 50 - 10 - 1);
  });
});

describe("TCS rate — runbook step 06", () => {
  // Step 06's own prove, as a test. The notified rate has been 0.5% since 10 Jul 2024
  // (Notification 15/2024-Central Tax). ₹200 taxable from an external seller withholds ₹1.00.
  it("withholds 0.5% — ₹1.00 on ₹200 taxable, not ₹2.00", () => {
    const { split } = placeSlice([{ lineTotal: 200, taxableValue: 200 }], 0, {
      tcsRatePct: TCS_RATE_PCT,
    });
    expect(split.tcsAmount).toBe(1);
    expect(split.tcsAmount).not.toBe(2);
  });

  it("is the notified 0.5%, which splits 0.25% CGST + 0.25% SGST", () => {
    expect(TCS_RATE_PCT).toBe(0.5);
    // GSTR-8 halves the collected amount for the intra-state split; each half is a quarter percent.
    const { split } = placeSlice([{ lineTotal: 200, taxableValue: 200 }], 0, {
      tcsRatePct: TCS_RATE_PCT,
    });
    expect(split.tcsAmount / 2).toBe(0.5); // ₹0.50 each side
    expect(((split.tcsAmount / 2) / 200) * 100).toBe(0.25);
  });

  // ⚠️ The snapshot is what makes a rate change safe. Without it, every report that recovered a
  // liable value as tcsAmount ÷ the current constant would have doubled every pre-existing row the
  // day the rate halved — in a return that goes to the government.
  it("snapshots the rate it actually applied, so history cannot be rewritten", () => {
    expect(
      placeSlice([{ lineTotal: 200, taxableValue: 200 }], 0, { tcsRatePct: 1 }).split,
    ).toMatchObject({ tcsAmount: 2, tcsRatePct: 1 });
    expect(
      placeSlice([{ lineTotal: 200, taxableValue: 200 }], 0, { tcsRatePct: 0.5 }).split,
    ).toMatchObject({ tcsAmount: 1, tcsRatePct: 0.5 });
  });
});

describe("per-line commission — runbook step 08", () => {
  // The safety property the step is built on: with no override anywhere, per-line resolution is the
  // seller's flat rate and the answer is the one the flat calculation gave.
  it("falls back to the seller's rate when a product has no override", () => {
    expect(resolveCommissionPct({ lineTotal: 100, taxableValue: 100 }, 5)).toBe(5);
    expect(resolveCommissionPct({ lineTotal: 100, taxableValue: 100, commissionPctOverride: null }, 5)).toBe(5);
  });

  // ⚠️ `??` not `||`. A product the platform deliberately carries at no cut must stay at 0 rather
  // than fall through to the seller's 5%.
  it("keeps a genuine 0% override at 0 instead of falling back", () => {
    expect(resolveCommissionPct({ lineTotal: 100, taxableValue: 100, commissionPctOverride: 0 }, 5)).toBe(0);
  });

  it("uses the product's override in place of the seller's rate", () => {
    expect(resolveCommissionPct({ lineTotal: 100, taxableValue: 100, commissionPctOverride: 2 }, 5)).toBe(2);
  });

  // Step 08's prove: same numbers as before, to the paise, until a human sets an override.
  it("changes nothing while every override is null", () => {
    const lines = [
      { lineTotal: 126, taxableValue: 126 },
      { lineTotal: 54, taxableValue: 54 },
      { lineTotal: 18, taxableValue: 18 },
    ];
    const { subtotal, commissionPct, commissionAmount } = sumSellerLines(lines, 5);
    expect(subtotal).toBe(198);
    expect(commissionPct).toBe(5); // the blend of one rate is that rate
    expect(commissionAmount).toBe(9.9); // = 198 × 5%, the flat answer
  });

  // ...and step 08's second prove: set one override, and only that line moves.
  it("moves only the overridden line", () => {
    const flat = sumSellerLines(
      [
        { lineTotal: 100, taxableValue: 100 },
        { lineTotal: 100, taxableValue: 100 },
      ],
      5,
    );
    const withOverride = sumSellerLines(
      [
        { lineTotal: 100, taxableValue: 100 },
        { lineTotal: 100, taxableValue: 100, commissionPctOverride: 2 },
      ],
      5,
    );
    expect(flat.lineCommissions).toEqual([
      { commissionPct: 5, commissionAmount: 5 },
      { commissionPct: 5, commissionAmount: 5 },
    ]);
    expect(withOverride.lineCommissions).toEqual([
      { commissionPct: 5, commissionAmount: 5 }, // untouched
      { commissionPct: 2, commissionAmount: 2 },
    ]);
    expect(withOverride.commissionAmount).toBe(7);
  });

  // ⚠️ The blend is the weighted mean of the UNROUNDED products, never commissionAmount ÷ subtotal.
  // Back-deriving a rate from two rounded amounts is what produced an "18.02% GST" on a delivery
  // invoice once; a rate has to come from the rates, not from the money.
  it("blends the rate by value, not by dividing the money back out", () => {
    const { commissionPct, commissionAmount, subtotal } = sumSellerLines(
      [
        { lineTotal: 300, taxableValue: 300 },
        { lineTotal: 100, taxableValue: 100, commissionPctOverride: 1 },
      ],
      5,
    );
    // (300×5 + 100×1) / 400 = 4
    expect(commissionPct).toBe(4);
    expect(commissionAmount).toBe(16); // 15 + 1
    expect(subtotal).toBe(400);
  });

  // The lines must add up to the slice, or the audit trail contradicts itself.
  it("makes the slice total the sum of its own lines", () => {
    const { commissionAmount, lineCommissions } = sumSellerLines(
      [
        { lineTotal: 10.1, taxableValue: 10.1 },
        { lineTotal: 10.1, taxableValue: 10.1, commissionPctOverride: 3 },
      ],
      5,
    );
    const summed = +lineCommissions.reduce((t, c) => t + c.commissionAmount, 0).toFixed(2);
    expect(commissionAmount).toBe(summed);
  });

  // A slice with nothing to weight must not report 0% — that reads as "this seller is on zero
  // commission", which is a claim about the contract rather than about an empty basket.
  it("reports the seller's own rate when there is nothing to weight", () => {
    expect(sumSellerLines([], 5).commissionPct).toBe(5);
    expect(sumSellerLines([{ lineTotal: 0, taxableValue: 0 }], 5).commissionPct).toBe(5);
  });
});

describe("the house store", () => {
  // The house seller IS the platform. Collecting Sec-52 TCS here would be the platform withholding
  // tax from itself on its own supply. Step 09 makes this conditional on a second legal entity
  // existing; until that entity does, it must stay unconditional.
  it("collects no TCS from the house store even at a live rate", () => {
    expect(
      placeSlice([{ lineTotal: 500, taxableValue: 500 }], 0, { tcsRatePct: 1, isHouse: true }).split
        .tcsAmount,
    ).toBe(0);
  });

  // A house slice stores the rate that APPLIED to it, which is none — not the rate it was offered.
  // 0.5 beside a tcsAmount of 0 would claim a rate was applied and came to nothing; that is untrue,
  // and it is the opposite of what the step-04 backfill wrote onto every historical house row.
  it("snapshots a house slice's TCS rate as 0, not the rate it was handed", () => {
    expect(
      placeSlice([{ lineTotal: 500, taxableValue: 500 }], 0, {
        tcsRatePct: TCS_RATE_PCT,
        isHouse: true,
      }).split,
    ).toMatchObject({ tcsAmount: 0, tcsRatePct: 0 });
  });

  it("leaves the whole subtotal payable when the house store has no commission", () => {
    expect(
      placeSlice([{ lineTotal: 500, taxableValue: 500 }], 0, { tcsRatePct: 1, isHouse: true }).split
        .netPayable,
    ).toBe(500);
  });
});

describe("rounding", () => {
  // The split has always rounded with toFixed. Several sibling services define
  // round2 = Math.round((n + EPSILON) * 100) / 100, and on this input the two disagree by a paise:
  // toFixed gives 1.00, round2 gives 1.01. Swapping them would silently restate every payout.
  it("rounds with toFixed, not the round2 helper other services use", () => {
    const { commissionAmount } = sumSellerLines([{ lineTotal: 20.1, taxableValue: 20.1 }], 5);
    expect(commissionAmount).toBe(1);
    expect(Math.round((1.005 + Number.EPSILON) * 100) / 100).toBe(1.01); // the twin, for contrast
  });

  it("leaves no floating-point tail on the payout", () => {
    const { split } = placeSlice([{ lineTotal: 33.33, taxableValue: 29.76 }], 7.5, {
      tcsRatePct: 1,
      tdsAmount: 0.03,
    });
    expect(split.netPayable).toBe(+split.netPayable.toFixed(2));
    // 33.33 − 2.50 − 0.30 − 0.03. Commission is 2.49975 and TCS 0.2976 before rounding, so this
    // also pins that each component is rounded before the subtraction, not after.
    expect(split.netPayable).toBe(30.5);
  });
});

describe("sumSellerLines", () => {
  it("sums a seller's lines into a gross and a taxable total", () => {
    const { subtotal, taxableValue } = sumSellerLines(
      [
        { lineTotal: 126, taxableValue: 120 },
        { lineTotal: 72, taxableValue: 68.57 },
      ],
      5,
    );
    expect({ subtotal, taxableValue }).toEqual({ subtotal: 198, taxableValue: 188.57 });
  });

  it("rounds the sum, not each line", () => {
    const { subtotal } = sumSellerLines(
      [
        { lineTotal: 10.005, taxableValue: 0 },
        { lineTotal: 10.005, taxableValue: 0 },
        { lineTotal: 10.005, taxableValue: 0 },
      ],
      0,
    );
    expect(subtotal).toBe(30.02); // the running sum is 30.015; rounding each line first gives 30.03
  });

  it("returns zeroes for a seller with no lines rather than NaN", () => {
    const { subtotal, taxableValue, commissionAmount } = sumSellerLines([], 5);
    expect({ subtotal, taxableValue, commissionAmount }).toEqual({
      subtotal: 0,
      taxableValue: 0,
      commissionAmount: 0,
    });
  });

  // A free gift is a real order line at zero. It lands in the house seller's bucket at placement and
  // must not move any of the money — that is what makes folding it in there safe.
  it("is unmoved by a zero-value free-gift line", () => {
    const { subtotal, taxableValue, commissionAmount, commissionPct } = sumSellerLines(
      [
        { lineTotal: 126, taxableValue: 126 },
        { lineTotal: 0, taxableValue: 0 },
      ],
      5,
    );
    expect({ subtotal, taxableValue }).toEqual({ subtotal: 126, taxableValue: 126 });
    expect(commissionAmount).toBe(6.3);
    expect(commissionPct).toBe(5); // a zero line carries no weight in the blend
  });
});
