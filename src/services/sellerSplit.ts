/**
 * The seller split — how one seller's slice of an order turns into money.
 *
 * This arithmetic used to live inline in three places (routes/orders.ts, routes/foodOrders.ts,
 * services/subscriptionEngine.ts), which meant a rate change had to be made three times and could
 * not be tested at all. It is lifted here BYTE-IDENTICALLY: every number this produces is the same
 * number those three sites produced before, to the paise.
 *
 * ⚠️ Rounding is `+(x).toFixed(2)`, NOT the `round2()` helper several other services define as
 * `Math.round((n + EPSILON) * 100) / 100`. The two disagree on some values. The split has always
 * used toFixed and must keep using it, or existing rows stop reconciling.
 *
 * Two functions, because the TDS base is needed before the split can run: the caller sums the lines,
 * uses that subtotal to ask the database for the financial-year 194-O cumulative, then splits. TDS
 * stays OUTSIDE this file on purpose — it needs a transaction, and a pure function must not.
 */

/** One order line, as far as the money is concerned. Prisma Decimals must be Number()'d first. */
export interface SellerLine {
  lineTotal: number;
  /** GST-exclusive. Prices are GST-inclusive, so this is lineTotal backed out of its own rate. */
  taxableValue: number;
}

export interface SellerSplitInput {
  subtotal: number;
  taxableValue: number;
  /** The seller's agreed rate. Applied to subtotal (GST-INCLUSIVE — step 07 moves it to taxable). */
  commissionPct: number;
  /**
   * Sec-52 TCS. The CALLER decides this, not the function: food is 0 because Sec 9(5) makes the
   * platform the deemed supplier, and that reasoning has to stay visible at the food call site
   * rather than hiding behind a flag in here.
   */
  tcsRatePct: number;
  /** Sec 194-O, already resolved against the FY cumulative by computeSubOrderTds194o. */
  tdsAmount: number;
  /**
   * The house store is the platform's own catalog, so it collects no tax on its own supply.
   * Step 09 makes this `isHouse && !config.houseSellerIsSeparateEntity` at every call site —
   * keeping it a plain boolean input is what makes that a caller-side change.
   */
  isHouse: boolean;
}

/** Exactly the money fields of a SubOrder row, ready to spread into a create. */
export interface SellerSplit {
  subtotal: number;
  commissionPct: number;
  commissionAmount: number;
  tcsAmount: number;
  tdsAmount: number;
  netPayable: number;
}

const r2 = (n: number): number => +n.toFixed(2);

/** Fan a seller's lines in. Separate from the split because the TDS lookup needs `subtotal` first. */
export function sumSellerLines(lines: SellerLine[]): { subtotal: number; taxableValue: number } {
  return {
    subtotal: r2(lines.reduce((sum, l) => sum + Number(l.lineTotal), 0)),
    taxableValue: r2(lines.reduce((sum, l) => sum + Number(l.taxableValue), 0)),
  };
}

export function computeSellerSplit(input: SellerSplitInput): SellerSplit {
  const { subtotal, taxableValue, commissionPct, tcsRatePct, tdsAmount, isHouse } = input;
  const commissionAmount = r2((subtotal * commissionPct) / 100);
  const tcsAmount = isHouse ? 0 : r2((taxableValue * tcsRatePct) / 100);
  return {
    subtotal,
    commissionPct,
    commissionAmount,
    tcsAmount,
    tdsAmount,
    netPayable: r2(subtotal - commissionAmount - tcsAmount - tdsAmount),
  };
}
