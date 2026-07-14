import type { Prisma } from "@prisma/client";

// ─── Income Tax Sec 194-O — TDS an e-commerce operator withholds from a marketplace seller ───
//
// This is the Income Tax mirror of the GST Sec-52 TCS in routes/orders.ts (TCS_RATE_PCT): same
// shape ("withheld from the seller, not charged to the customer"), different tax head, different
// filing (quarterly TDS return / Form 16A, not GSTR-8). See CA_COMPLIANCE_BRIEF.md §2.1.
//
// ⚠️ CA-gated — confirm before turning StoreConfig.tds194oEnabled on:
//  1. The CURRENT rate. 0.1% since 1 Oct 2024 (was 1% before that — Budget 2024 amendment). Rates
//     are legislated and can change again; StoreConfig.tds194oRatePct is the live, owner/CA-tunable
//     source of truth — DEFAULT_RATE_PCT below is only the seed value for a fresh StoreConfig row.
//  2. The ₹5L individual/HUF threshold reading. Implemented here as "no TDS on the first ₹5,00,000
//     of cumulative FY gross sales through the platform; TDS only on the amount above it" — the
//     standard practitioner interpretation (mirrors how Sec 206C(1H) TCS is commonly applied), NOT
//     the only possible reading. Have the CA confirm.
//  3. The deduction POINT. Sec 194-O(1) triggers "at the time of credit of such amount to the
//     account of an e-commerce participant, or at the time of payment thereof... whichever is
//     earlier." This computes/withholds at SubOrder creation (order placement) — the same moment
//     Seller.outstandingBalance is credited with netPayable (see routes/orders.ts) — on the
//     reasoning that THAT is the "credit to account" trigger, not the later manual payout. Confirm
//     with the CA; if they read it differently, the deduction point moves, not the rate logic.
//
// Off by default (StoreConfig.tds194oEnabled=false). Flipping it on is a real withholding decision
// for real money owed to real sellers — not a toggle to flip casually before CA sign-off.

const DEFAULT_RATE_PCT = 0.1;
const DEFAULT_THRESHOLD = 500000;
const DEFAULT_NO_PAN_RATE_PCT = 5; // Sec 206AA floor when no PAN is on file

export interface Tds194oSeller {
  id: string;
  isHouse: boolean;
  pan: string | null;
  entityType: string; // "INDIVIDUAL_HUF" | "OTHER"
}

export interface Tds194oResult {
  tdsAmount: number;
  rateApplied: number; // 0 when the exemption fully covers this order
}

/** April 1 (UTC midnight) of the financial year `now` falls in — Apr–Mar Indian FY. */
export function fyStartDate(now: Date = new Date()): Date {
  const month = now.getMonth() + 1; // 1-indexed
  const fyStartYear = month >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(Date.UTC(fyStartYear, 3, 1));
}

/** Indian FY quarter (Apr–Mar): Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar. Small local copy —
 *  routes/tdsRecords.ts has its own (route-file-private) copy of the same pure function; duplicated
 *  rather than imported across the route/service boundary, matching this codebase's existing
 *  precedent for tiny pure helpers (see CLAUDE.md's sellerIstMidnightUtc/sellerRangeSince note). */
export function quarterFor(date: Date): "Q1" | "Q2" | "Q3" | "Q4" {
  const month = date.getMonth() + 1;
  if (month >= 4 && month <= 6) return "Q1";
  if (month >= 7 && month <= 9) return "Q2";
  if (month >= 10 && month <= 12) return "Q3";
  return "Q4";
}

/** Sum of this seller's SubOrder.subtotal so far this FY, excluding CANCELLED sub-orders (a
 *  cancelled sale never really "paid" the seller — same exclusion GSTR-8/TCS reporting already
 *  uses) and excluding the order currently being placed (it doesn't exist yet at call time). */
async function cumulativeFyGross(
  tx: Prisma.TransactionClient,
  sellerId: string,
  fyStart: Date,
): Promise<number> {
  const agg = await tx.subOrder.aggregate({
    where: { sellerId, createdAt: { gte: fyStart }, status: { not: "CANCELLED" } },
    _sum: { subtotal: true },
  });
  return Number(agg._sum.subtotal ?? 0);
}

/**
 * Computes the Sec 194-O TDS to withhold on ONE seller's sub-order at placement time. Returns
 * {tdsAmount: 0} whenever the feature is off, the seller is the house store, or the exemption
 * fully covers this order. Must be called from WITHIN the same transaction that creates the
 * SubOrder, so the cumulative-FY-gross read is consistent with concurrent order placements.
 */
export async function computeSubOrderTds194o(
  tx: Prisma.TransactionClient,
  seller: Tds194oSeller,
  subtotal: number,
): Promise<Tds194oResult> {
  if (seller.isHouse || subtotal <= 0) return { tdsAmount: 0, rateApplied: 0 };

  const config = await tx.storeConfig.findFirst({
    select: {
      tds194oEnabled: true,
      tds194oRatePct: true,
      tds194oThreshold: true,
      tds194oNoPanRatePct: true,
    },
  });
  if (!config?.tds194oEnabled) return { tdsAmount: 0, rateApplied: 0 };

  const baseRate = Number(config.tds194oRatePct ?? DEFAULT_RATE_PCT);
  const noPanRate = Number(config.tds194oNoPanRatePct ?? DEFAULT_NO_PAN_RATE_PCT);
  const threshold = Number(config.tds194oThreshold ?? DEFAULT_THRESHOLD);
  // Sec 206AA: no PAN on file → deduct at the higher rate (the ₹5L exemption's own text requires
  // PAN/Aadhaar to have been furnished, so a PAN-less seller can never qualify for it either).
  const rate = seller.pan ? baseRate : Math.max(baseRate, noPanRate);

  const exemptionEligible = seller.entityType === "INDIVIDUAL_HUF" && !!seller.pan;
  if (!exemptionEligible) {
    // Companies/partnerships/firms get NO threshold exemption under 194-O — TDS from rupee one.
    const tdsAmount = +((subtotal * rate) / 100).toFixed(2);
    return { tdsAmount, rateApplied: rate };
  }

  const priorGross = await cumulativeFyGross(tx, seller.id, fyStartDate());
  const newTotal = priorGross + subtotal;
  if (newTotal <= threshold) return { tdsAmount: 0, rateApplied: 0 };

  // Only the slice above ₹5L is taxed: either the whole order (already past threshold before this
  // order) or just the portion that crosses it (this is the order that tips the seller over ₹5L).
  const taxableSlice = priorGross >= threshold ? subtotal : newTotal - threshold;
  const tdsAmount = +((taxableSlice * rate) / 100).toFixed(2);
  return { tdsAmount, rateApplied: rate };
}
