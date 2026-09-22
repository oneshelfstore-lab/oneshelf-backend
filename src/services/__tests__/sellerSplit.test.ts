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
 * The first block replays REAL PRODUCTION ROWS, read from the live database on 21 Sep 2026. It
 * began life as proof that lifting this arithmetic out of the route handlers changed nothing. Steps
 * 06 and 07 then changed it ON PURPOSE, so each row now states what is STORED and what the same
 * inputs produce today, and the gap between the two is the whole point of those steps.
 *
 * ⚠️ Reproducing what is stored is scripts/replaySellerSplit.ts's job, not this file's — it knows
 * which rule each row was written under. These are about the rule in force NOW.
 *
 * ⚠️ They run the WHOLE pipeline — sumSellerLines, then computeSellerSplit — because since runbook
 * step 08 the commission is resolved line by line and handed to the split rather than computed
 * inside it. Testing the split alone would leave the half that decides the rate untested.
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
      commissionGstAmount: totals.commissionGstAmount,
      tcsRatePct: opts.tcsRatePct,
      tdsAmount: opts.tdsAmount ?? 0,
      isHouse: opts.isHouse ?? false,
    }),
  };
}

describe("real production rows, under the rules now in force", () => {
  // ONS/2627/00013 · bansal stationary. 0% GST stationery, so gross equals taxable — which means
  // step 07's change of base cannot move its commission. Only the withholding moved.
  // ⚠️ Replayed at tcsRatePct 1, the rate the row was ACTUALLY written at (it has since been
  // corrected to 0.5% in the database by scripts/repairTcsRate.ts). Replaying it at today's rate
  // would not reproduce the ₹1.26 it was written with — the reason the rate is snapshotted per row.
  // STORED: commission 6.30 · tcs 1.26 · net 118.44.
  it("ONS/2627/00013 — same commission, ₹1.13 less payable now the commission GST is withheld", () => {
    expect(placeSlice([{ lineTotal: 126, taxableValue: 126 }], 5, { tcsRatePct: 1 }).split).toEqual({
      subtotal: 126,
      taxableValue: 126,
      tcsRatePct: 1,
      commissionPct: 5,
      commissionAmount: 6.3, // unchanged: gross and taxable are the same number here
      commissionGstPct: 18,
      commissionGstAmount: 1.13,
      tcsAmount: 1.26,
      tdsAmount: 0,
      netPayable: 117.31, // stored 118.44, less the 1.13 of GST that used to go uncollected
    });
  });

  // ONS/2627/00439 · Chandpur Bakehouse, the one food order placed so far. Gross 210, taxable 200 —
  // the only live row where the two differ, which makes it THE row that tells the two candidate
  // commission bases apart. STORED: commission 10.50 · net 199.50.
  it("ONS/2627/00439 — commission is ₹10.00 on the taxable 200, not ₹10.50 on the gross 210", () => {
    expect(placeSlice([{ lineTotal: 210, taxableValue: 200 }], 5, { tcsRatePct: 0 }).split).toEqual({
      subtotal: 210,
      taxableValue: 200,
      tcsRatePct: 0,
      commissionPct: 5,
      commissionAmount: 10, // stored 10.50 — the ₹0.50 the old base charged on the customer's GST
      commissionGstPct: 18,
      commissionGstAmount: 1.8,
      tcsAmount: 0,
      tdsAmount: 0,
      netPayable: 198.2,
    });
  });
});

/**
 * Runbook step 07's prove, and the settlement architecture's own worked example: one regular seller,
 * one composition seller, and the four deductions that turn a gross into a payout.
 *
 * ⚠️ IT ONLY ADDS UP IF THE COMMISSION GST IS WITHHELD. ₹223.00 is 236 − 10 − 1.80 − 1.00 − 0.20;
 * leaving the 1.80 as a receivable gives 224.80 and the platform's ₹19.50 becomes ₹16.80. That is
 * why step 07 closes the gap rather than step 17, which only produced the piece of paper.
 */
describe("the two-seller worked example", () => {
  // Seller A — regular, 18% GST goods. Gross 236.00 carrying 200.00 of taxable value.
  const A = placeSlice([{ lineTotal: 236, taxableValue: 200 }], 5, {
    tcsRatePct: 0.5,
    tdsAmount: 0.2, // 0.1% of the TAXABLE 200, resolved by the caller inside a transaction
  }).split;

  // Seller B — composition, so there is no GST inside the price and gross equals taxable.
  const B = placeSlice([{ lineTotal: 100, taxableValue: 100 }], 5, {
    tcsRatePct: 0.5,
    tdsAmount: 0.1,
  }).split;

  it("seller A nets ₹223.00", () => {
    expect(A.commissionAmount).toBe(10); // 5% of 200, not of 236
    expect(A.commissionGstAmount).toBe(1.8); // 18% on top
    expect(A.tcsAmount).toBe(1); // 0.5% of 200
    expect(A.tdsAmount).toBe(0.2); // 0.1% of 200
    expect(A.netPayable).toBe(223);
  });

  it("seller B, on composition, nets ₹93.50", () => {
    expect(B.commissionAmount).toBe(5);
    expect(B.commissionGstAmount).toBe(0.9);
    expect(B.tcsAmount).toBe(0.5);
    expect(B.tdsAmount).toBe(0.1);
    expect(B.netPayable).toBe(93.5);
    // ⚠️ A composition seller still pays GST on the platform's commission. It is the PLATFORM's
    // outward supply, not theirs — they simply cannot claim credit for it.
    expect(B.commissionGstPct).toBe(18);
  });

  it("the platform retains ₹19.50 from the two sellers", () => {
    const retained = [A, B].reduce(
      (t, x) => t + x.commissionAmount + x.commissionGstAmount + x.tcsAmount + x.tdsAmount,
      0,
    );
    expect(+retained.toFixed(2)).toBe(19.5);
    // ...and every rupee of it is accounted for: 15.00 is income, 4.50 is held for the government.
    expect(+(A.commissionAmount + B.commissionAmount).toFixed(2)).toBe(15);
    expect(
      +[A, B].reduce((t, x) => t + x.commissionGstAmount + x.tcsAmount + x.tdsAmount, 0).toFixed(2),
    ).toBe(4.5);
  });

  // What the base change is worth to a seller, in rupees, on one ₹236 order. Each component is
  // rounded the way the code rounds it, so this is the real difference rather than a float artifact.
  it("charging seller A on the gross instead would cost them ₹2.16 more", () => {
    const onGross = 11.8 + 2.12 + 0.24; // 5% of 236 · 18% of that · 0.1% of 236
    const onTaxable = A.commissionAmount + A.commissionGstAmount + A.tdsAmount; // 10 + 1.80 + 0.20
    expect(+onTaxable.toFixed(2)).toBe(12);
    expect(+(onGross - onTaxable).toFixed(2)).toBe(2.16);
  });
});

describe("the base each rate is applied to", () => {
  // Runbook step 07. Commission is charged on the GST-EXCLUSIVE taxable value: 210 gross carrying
  // 200 taxable pays 10.00, not 10.50. The ₹0.50 difference is commission the platform used to
  // charge on tax the seller collects for the government and never keeps.
  it("charges commission on the taxable value, not the GST-inclusive line total", () => {
    const { commissionAmount } = sumSellerLines([{ lineTotal: 210, taxableValue: 200 }], 5);
    expect(commissionAmount).toBe(10);
    expect(commissionAmount).not.toBe(10.5);
  });

  // ⚠️ The receivable step 17 had to record because netPayable did not withhold it. It does now.
  it("withholds the GST on that commission from the payout", () => {
    const { split } = placeSlice([{ lineTotal: 210, taxableValue: 200 }], 5, { tcsRatePct: 0 });
    expect(split.commissionGstAmount).toBe(1.8);
    expect(split.netPayable).toBe(+(210 - 10 - 1.8).toFixed(2));
  });

  // A slice charged no commission is charged no rate either — a rate beside a zero amount claims a
  // rate applied and came to nothing.
  it("charges no commission GST where there is no commission", () => {
    const { split } = placeSlice([{ lineTotal: 500, taxableValue: 500 }], 0, { tcsRatePct: 0 });
    expect(split.commissionAmount).toBe(0);
    expect(split.commissionGstAmount).toBe(0);
    expect(split.commissionGstPct).toBe(0);
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
    expect(split.netPayable).toBe(1000 - 50 - 9 - 10 - 1); // commission 50, its GST 9, tcs 10, tds 1
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
    // 33.33 − 2.23 − 0.40 − 0.30 − 0.03. Commission is 2.232 on the TAXABLE 29.76, its GST 0.4014
    // and TCS 0.2976 before rounding, so this also pins that each component is rounded before the
    // subtraction, not after.
    expect(split.netPayable).toBe(30.37);
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
