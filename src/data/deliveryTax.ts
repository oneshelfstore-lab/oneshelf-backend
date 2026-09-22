/**
 * GST on the delivery fee (runbook step 15).
 *
 * Delivery is the PLATFORM's own supply to the customer — not the seller's, and not part of the
 * goods. That is why the numbers live on the order in their own columns rather than folded into the
 * goods totals, and why step 16 invoices it separately under a SAC instead of an HSN.
 */

/**
 * ⚠️ CA-GATED. 18% is the ordinary rate for a delivery/courier service supplied for its own
 * consideration (SAC 9968), and it is what comparable platforms charge on a separately-stated
 * delivery fee. It is NOT the only defensible reading: where delivery is naturally bundled with the
 * goods and not separately charged, it can be a COMPOSITE supply taking the principal supply's rate
 * instead — which is exactly the case this file treats as "no separate supply" below.
 *
 * Get this confirmed before the first delivery invoice is issued. Changing it later is one line
 * here, but every order already split carries its own stored figures and will not move.
 */
export const DELIVERY_GST_RATE_PCT = 18;

/** SAC for courier/delivery services — a SERVICE code, so it has no HSN. Used by step 16. */
export const DELIVERY_SAC_CODE = "9968";

/**
 * Whether a delivery service was supplied for its own consideration, and if so whether it was paid
 * for. The distinction is the step-15 Watch, and it is documentary rather than arithmetic: all three
 * cases below that are not CHARGED come to zero GST, but they are not the same event.
 *
 *   CHARGED  a fee was charged. A supply for consideration → split it, invoice it.
 *   WAIVED   a fee was PRICED and then given away — a free-delivery coupon, or a member tier perk.
 *            A supply DID occur; its value is reduced to nil by a discount recorded at the time of
 *            supply (Sec 15(3)(a) CGST Act), so the tax is nil but the document is not nothing.
 *   NONE     no separate consideration was ever sought: a pickup order, a basket over the
 *            free-delivery threshold, or a store that never charges for delivery. Here delivery is
 *            bundled into the price of the goods — a composite supply — so there is no separate
 *            delivery supply to value, tax or invoice at all.
 *
 * ⚠️ WAIVED and NONE must not be collapsed, even though both are ₹0. Collapsing them means step 16
 * either issues a document for a supply that never happened, or omits one for a supply that did.
 */
export type DeliverySupplyKind = "CHARGED" | "WAIVED" | "NONE";

export interface DeliveryTaxSplit {
  /** The GST-exclusive value of the delivery supply. */
  taxable: number;
  /** The GST contained in the fee. */
  gst: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Splits a GST-INCLUSIVE delivery fee into its taxable value and the tax inside it.
 *
 * Inclusive is what makes step 15 safe: ₹30 stays ₹30 to the customer and no order total moves —
 * only the story about what the ₹30 is made of changes. What changes for the platform is that it
 * now declares the ₹4.58 it was already collecting and never reporting.
 *
 * ⚠️ THE GST IS DERIVED BY SUBTRACTION, NOT BY APPLYING THE RATE AGAIN, and that is not a style
 * choice. Rounding the base and the tax independently lets them miss each other by a paisa: a ₹49
 * fee at 18% gives a base of 41.53 and, computed from the rate, a tax of 7.48 — which sums to
 * ₹49.01, a rupee the customer never paid appearing in a GST return. Subtracting makes
 * `taxable + gst === fee` true by construction, for every fee, at every rate.
 */
export function splitInclusiveDeliveryFee(
  fee: number,
  ratePct: number = DELIVERY_GST_RATE_PCT,
): DeliveryTaxSplit {
  if (!(fee > 0)) return { taxable: 0, gst: 0 };
  if (!(ratePct > 0)) return { taxable: round2(fee), gst: 0 };
  const taxable = round2(fee / (1 + ratePct / 100));
  return { taxable, gst: round2(fee - taxable) };
}
