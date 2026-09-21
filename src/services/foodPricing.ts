// ─── Food order pricing (MULTIVERTICAL_PLAN.md §4) ───────────────────────────────────────────────
// Pure — no Prisma, no config reads — so it's unit-testable, matching every other service test here.
//
// ⚠️ Menu prices are GST-INCLUSIVE, the same convention as the grocery catalog. The tax is BACKED
// OUT of the price (taxable = gross ÷ (1 + rate)), never added on top. Getting this backwards
// silently overcharges every customer by the GST rate and the totals still look self-consistent.

export interface FoodLineInput {
  menuItemId: string;
  name: string;
  imageUrl: string | null;
  /** GST-inclusive price per unit, read from the DB — never from the client. */
  unitPrice: number;
  quantity: number;
  gstRate: number;
  sacCode: string | null;
}

export interface FoodLineTotals extends FoodLineInput {
  lineTotal: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
}

export interface FoodOrderTotals {
  lines: FoodLineTotals[];
  subtotal: number;
  taxableValue: number;
  totalTax: number;
  deliveryCharge: number;
  /** Platform-funded coupon discount. 0 when none applied. */
  discount: number;
  appliedCoupon: string | null;
  totalAmount: number;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Per-line totals with GST backed out of the inclusive price.
 *
 * ⚠️ Intra-state only (CGST + SGST split evenly), matching the rest of this codebase. An inter-state
 * food order would be IGST — not modelled, and not reachable today since a restaurant delivers
 * locally by definition.
 */
export function priceFoodLines(lines: FoodLineInput[]): FoodLineTotals[] {
  return lines.map((l) => {
    const lineTotal = round2(l.unitPrice * l.quantity);
    const taxableValue = round2(lineTotal / (1 + l.gstRate / 100));
    const tax = round2(lineTotal - taxableValue);
    // Halve the ALREADY-ROUNDED tax so cgst + sgst always reconciles back to it exactly; rounding
    // each half independently can leave a 1-paisa gap that makes an invoice fail to foot.
    const cgst = round2(tax / 2);
    return { ...l, lineTotal, taxableValue, cgst, sgst: round2(tax - cgst) };
  });
}

/**
 * Order-level totals.
 *
 * ⚠️ The delivery charge is NOT taxed here, matching how the grocery path treats it — the order's
 * taxableValue/totalTax describe the goods/service supplied, and `totalAmount` is simply
 * subtotal + delivery. ⚠️ GST/CA: confirm whether the delivery leg should carry its own GST line
 * once the Sec 9(5) position is settled (MULTIVERTICAL_PLAN.md §4.4).
 */
/**
 * ⚠️ GST/CA: menu prices are GST-INCLUSIVE and tax is backed OUT, so `taxableValue` is derived from
 * the pre-discount subtotal and a coupon reduces only the amount DUE. That mirrors how grocery treats
 * an order-level discount (CBIC Circular 92/11/2019 precedent, as used for BOGO) — but food is
 * Sec 9(5), where the PLATFORM is the deemed supplier of the service, so confirm the treatment with
 * the CA before this carries real money. The code is small either way; the tax position is not.
 *
 * ⚠️ The discount is PLATFORM-funded and never reaches the restaurant: SubOrder.subtotal is written
 * gross (pre-coupon) and netPayable = subtotal − commission − tcs, so a coupon cannot reduce a
 * seller payout. Verified, not assumed.
 */
export function computeFoodOrderTotals(
  lines: FoodLineInput[],
  deliveryCharge: number,
  discountInput = 0,
  appliedCoupon: string | null = null,
): FoodOrderTotals {
  const priced = priceFoodLines(lines);
  const subtotal = round2(priced.reduce((s, l) => s + l.lineTotal, 0));
  const taxableValue = round2(priced.reduce((s, l) => s + l.taxableValue, 0));
  const totalTax = round2(subtotal - taxableValue);
  const delivery = round2(deliveryCharge);
  // Clamped to the food subtotal: a coupon must never eat the delivery fee (the rider is paid for
  // that trip either way) and can never drive the order negative.
  const discount = round2(Math.min(Math.max(0, discountInput), subtotal));
  return {
    lines: priced,
    subtotal,
    taxableValue,
    totalTax,
    deliveryCharge: delivery,
    discount,
    appliedCoupon: discount > 0 ? appliedCoupon : null,
    totalAmount: round2(subtotal - discount + delivery),
  };
}
