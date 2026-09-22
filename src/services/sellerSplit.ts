import { commissionWithGst, COMMISSION_GST_RATE_PCT } from "../data/commissionTax.js";

/**
 * The seller split — how one seller's slice of an order turns into money.
 *
 * This arithmetic used to live inline in three places (routes/orders.ts, routes/foodOrders.ts,
 * services/subscriptionEngine.ts), which meant a rate change had to be made three times and could
 * not be tested at all. It was lifted here byte-identically; the numbers have since moved, twice,
 * deliberately and each time as its own decision:
 *
 *   step 06 - Sec-52 TCS from the superseded 1% to the notified 0.5%.
 *   step 07 - commission off the GST-INCLUSIVE lineTotal and onto taxableValue, and the GST on that
 *             commission WITHHELD from the payout rather than left as a receivable.
 *
 * ⚠️ Rounding is `+(x).toFixed(2)`, NOT the `round2()` helper several other services define as
 * `Math.round((n + EPSILON) * 100) / 100`. The two disagree on some values. The split has always
 * used toFixed and must keep using it, or existing rows stop reconciling. The ONE exception is the
 * commission GST, which goes through `commissionWithGst` on round2 so that placement and the
 * monthly commission invoice cannot disagree about it - see the note at that line.
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
  /**
   * CatalogProduct.commissionPctOverride — a rate negotiated for this one product, because a flat
   * rate across a seller's whole catalog is wrong wherever their own margin is thin.
   * ⚠️ NULL/UNDEFINED MEANS "USE THE SELLER'S RATE", NOT "ZERO COMMISSION". Coalescing it to 0 is
   * how a seller stops being charged at all. Go through resolveCommissionPct.
   */
  commissionPctOverride?: number | null;
}

/**
 * The rate that applies to ONE line: the product's negotiated override if it has one, otherwise the
 * seller's default (runbook step 08).
 *
 * ⚠️ The nullish coalesce is the whole function and it is deliberate — `??` not `||`, because a
 * genuine 0% override (a product the platform carries at no cut) must survive as 0 rather than fall
 * through to the seller's 5%.
 */
export function resolveCommissionPct(line: SellerLine, sellerCommissionPct: number): number {
  return line.commissionPctOverride ?? sellerCommissionPct;
}

export interface SellerSplitInput {
  subtotal: number;
  taxableValue: number;
  /**
   * The BLENDED effective rate across this slice, from sumSellerLines — not "the seller's agreed
   * rate". With no overrides in play the two are the same number, which is why this reads as the
   * seller's rate everywhere today.
   */
  commissionPct: number;
  /**
   * ⚠️ Passed IN rather than computed from `commissionPct`, and that is the point of step 08. Once
   * a single product can carry its own rate, one rate times one subtotal is no longer the answer —
   * the amount is the sum of per-line amounts, and only sumSellerLines has seen the lines.
   * Recomputing it here as subtotal × pct would quietly discard every override.
   */
  commissionAmount: number;
  /**
   * ⚠️ WITHHELD FROM THE PAYOUT, not merely recorded (runbook step 07). Until step 07 netPayable was
   * subtotal - commission - tcs - tds, so the platform billed the seller 11.80 having only taken
   * 10.00 out of their money and carried the 1.80 as a receivable it would never realistically
   * collect. The settlement architecture's worked example has always shown it as its own deduction
   * line; this is where that becomes true.
   */
  commissionGstAmount: number;
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
  /**
   * Echoed straight back out, so that spreading this into the create WRITES it to the row. It is an
   * input rather than a computed value, and that is the point: SubOrder.taxableValue is the base TCS
   * was charged on, so a report that has it stored never has to reconstruct it by dividing a stored
   * amount by whatever the rate constant says today.
   */
  taxableValue: number;
  /**
   * Echoed back for the same reason. This is the rate the row was ACTUALLY computed at, so a later
   * rate change cannot rewrite history — the trap halving TCS from 1% to 0.5% (runbook step 06)
   * would otherwise have sprung on every row written before it.
   */
  tcsRatePct: number;
  commissionPct: number;
  commissionAmount: number;
  /**
   * GST the PLATFORM charges the SELLER on that commission - its own outward supply, SAC 998599,
   * billed monthly as a COMMISSION invoice (runbook step 17). Snapshotted per slice so a later rate
   * change cannot rewrite what a row was charged.
   */
  commissionGstPct: number;
  commissionGstAmount: number;
  tcsAmount: number;
  tdsAmount: number;
  netPayable: number;
}

const r2 = (n: number): number => +n.toFixed(2);

/** What one line ends up owing, snapshotted onto OrderItem so the rate that applied stays readable. */
export interface LineCommission {
  commissionPct: number;
  commissionAmount: number;
}

export interface SellerLineTotals {
  subtotal: number;
  taxableValue: number;
  /**
   * ⚠️ The BLENDED effective rate across the slice, not "the seller's agreed rate". With one rate
   * in play it equals that rate exactly; with an override in the basket it is the weighted mean.
   * Anything that displays this as a seller's headline rate becomes subtly wrong the first time an
   * override is granted. Nothing does today — Seller.commissionPct is what every screen reads.
   */
  commissionPct: number;
  /** Sum of the per-line amounts below, so the lines and the slice reconcile exactly. */
  commissionAmount: number;
  /** GST the platform charges the seller ON TOP of that commission, withheld from the payout. */
  commissionGstPct: number;
  commissionGstAmount: number;
  /** In input order, for the OrderItem snapshot. */
  lineCommissions: LineCommission[];
}

/**
 * Fan a seller's lines in and resolve commission line by line. Separate from the split because the
 * TDS lookup needs `subtotal` before the split can run.
 *
 * ⚠️ THE ROUNDING ORDER IS THE DECISION HERE. Each line is rounded to the paise and then summed,
 * rather than summing exact products and rounding once at the end. Rounding once would match the
 * old flat calculation on every possible input; rounding per line can differ from it by a paise on
 * some. The per-line figure is what goes in OrderItem.commissionAmount, so summing anything else
 * would leave a slice whose own lines do not add up to it — an audit trail that contradicts itself
 * is worth less than a paise of continuity. Replayed against all 17 live money-bearing slices: not
 * one of them moves (scripts/replaySellerSplit.ts).
 *
 * ⚠️ The blended rate is the weighted mean of the UNROUNDED products, never commissionAmount ÷
 * subtotal. Back-deriving a rate from two rounded amounts produces things like 18.02%, which is not
 * a rate anybody agreed to — the same trap that shipped once already on the delivery invoice.
 */
export function sumSellerLines(lines: SellerLine[], sellerCommissionPct: number): SellerLineTotals {
  const subtotal = r2(lines.reduce((sum, l) => sum + Number(l.lineTotal), 0));
  const taxableValue = r2(lines.reduce((sum, l) => sum + Number(l.taxableValue), 0));
  const lineCommissions = lines.map((l) => {
    const commissionPct = resolveCommissionPct(l, sellerCommissionPct);
    return { commissionPct, commissionAmount: r2((Number(l.taxableValue) * commissionPct) / 100) };
  });
  const weighted = lines.reduce(
    (sum, l, i) => sum + Number(l.taxableValue) * lineCommissions[i]!.commissionPct,
    0,
  );
  const commissionAmount = r2(lineCommissions.reduce((sum, c) => sum + c.commissionAmount, 0));
  return {
    subtotal,
    taxableValue,
    // ⚠️ Weighted by the base the rate is charged ON, which since step 07 is taxableValue. Weighting
    // by lineTotal would blend two rates by the wrong quantity and produce a percentage that is not
    // any seller's rate and not the effective one either.
    // No lines, or lines that are all free gifts, leave nothing to weight - report the rate that
    // would have applied rather than a 0 that reads as "this seller is on zero commission".
    commissionPct: taxableValue > 0 ? r2(weighted / taxableValue) : r2(sellerCommissionPct),
    commissionAmount,
    // ⚠️ commissionWithGst, NOT a local multiplication, and the crossing of rounding helpers is
    // deliberate. services/commissionInvoice.ts bills the seller using that same function; if
    // placement rounded with toFixed and the invoice with round2 they would disagree by a paise and
    // the invoice's "already withheld" figure would stop matching what was actually withheld.
    commissionGstPct: COMMISSION_GST_RATE_PCT,
    commissionGstAmount: commissionWithGst(commissionAmount).gst,
    lineCommissions,
  };
}

export function computeSellerSplit(input: SellerSplitInput): SellerSplit {
  const { subtotal, taxableValue, commissionPct, commissionAmount, commissionGstAmount,
          tcsRatePct, tdsAmount, isHouse } = input;
  const tcsAmount = isHouse ? 0 : r2((taxableValue * tcsRatePct) / 100);
  return {
    subtotal,
    taxableValue,
    // ⚠️ The EFFECTIVE rate, not the rate asked for. A house slice collects nothing, so the rate
    // that applied to it is 0 — the same rule the step-04 backfill used on every historical row
    // (house → 0, food → 0, anything else → the rate of the day). Storing 0.5 beside a tcsAmount of
    // 0 would say a rate was applied and came to nothing, which is a different and untrue claim.
    tcsRatePct: isHouse ? 0 : tcsRatePct,
    commissionPct,
    commissionAmount,
    // A rate beside a zero amount would claim a rate applied and came to nothing, so a slice that
    // was charged no commission is charged no rate either - the same rule as tcsRatePct above.
    commissionGstPct: commissionAmount > 0 ? COMMISSION_GST_RATE_PCT : 0,
    commissionGstAmount,
    tcsAmount,
    tdsAmount,
    netPayable: r2(subtotal - commissionAmount - commissionGstAmount - tcsAmount - tdsAmount),
  };
}
