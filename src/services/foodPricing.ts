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
export function computeFoodOrderTotals(
  lines: FoodLineInput[],
  deliveryCharge: number,
): FoodOrderTotals {
  const priced = priceFoodLines(lines);
  const subtotal = round2(priced.reduce((s, l) => s + l.lineTotal, 0));
  const taxableValue = round2(priced.reduce((s, l) => s + l.taxableValue, 0));
  const totalTax = round2(subtotal - taxableValue);
  const delivery = round2(deliveryCharge);
  return {
    lines: priced,
    subtotal,
    taxableValue,
    totalTax,
    deliveryCharge: delivery,
    totalAmount: round2(subtotal + delivery),
  };
}
