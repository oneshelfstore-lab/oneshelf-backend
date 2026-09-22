/**
 * GST on marketplace commission (runbook step 17).
 *
 * The platform supplies a SERVICE to each seller — listing, order routing, collection — and charges
 * a percentage of their sales for it. That is the platform's own outward supply, billed to the
 * seller, and it belongs in the platform's GSTR-1 and nobody else's.
 */

/**
 * ⚠️ CA-GATED, though far less contentious than the delivery rate. 18% is the residual rate for a
 * service with no lower notified rate, and marketplace commission has none. Confirm alongside the
 * SAC below.
 */
export const COMMISSION_GST_RATE_PCT = 18;

/**
 * SAC 998599 — "other support services n.e.c.", the code marketplace commission is conventionally
 * billed under. A SERVICE code, so it has no HSN.
 *
 * ⚠️ The platform's own GST registration should declare this SAC (Settlement Architecture, the
 * external step that constitutes the platform entity). Billing under a code the registration does
 * not carry is the kind of mismatch that surfaces in a scrutiny notice rather than in software.
 */
export const COMMISSION_SAC_CODE = "998599";

/**
 * ⚠️ COMMISSION IS GST-EXCLUSIVE, AND THIS IS THE ONE DECISION IN THIS FILE WORTH ARGUING ABOUT.
 *
 * Everything else the platform prices is GST-INCLUSIVE — product prices, menu prices, the delivery
 * fee — so the instinct is to treat the withheld commission the same way and back the tax out of
 * it. The settlement architecture's worked example says otherwise, explicitly and with numbers: a
 * ₹10 commission shows "GST on commission 18% −₹1.80" as its OWN deduction line, and the platform
 * retains ₹19.50 across two sellers, which only adds up if the commission GST is retained on top of
 * the commission rather than carved out of it.
 *
 * That is also the commercial reading. "5% commission" means the platform keeps 5%; treating it as
 * inclusive would quietly make the real rate 4.24% and hand sellers a discount nobody agreed to.
 *
 * ⚠️ THE CONSEQUENCE, AND IT IS A REAL GAP: `SubOrder.netPayable` is
 * `subtotal − commission − tcs − tds`. It does NOT withhold the commission GST. So the invoice this
 * module describes bills ₹11.80 while only ₹10.00 was ever taken out of the payout, and the ₹1.80
 * is a genuine receivable from the seller. The invoice records that honestly — amountPaid is what
 * was withheld, amountDue is the rest — rather than pretending it was collected.
 *
 * Closing the gap means withholding the GST at placement too, which changes what every seller is
 * paid. That is a Stage C money change, not a documents change, and doing it here would have moved
 * real money inside a step whose job is to produce a piece of paper.
 */
export const COMMISSION_IS_GST_EXCLUSIVE = true;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface CommissionTaxSplit {
  /** The commission itself — the value of the platform's supply. */
  taxable: number;
  /** GST charged ON TOP of it. */
  gst: number;
  /** What the seller is billed in total. */
  total: number;
}

/**
 * Commission → what the seller is billed.
 *
 * ⚠️ Note the asymmetry with `splitInclusiveDeliveryFee`, which derives its tax by SUBTRACTION
 * because its total is fixed. Here the BASE is fixed and the tax is added, so multiplying is the
 * correct direction and there is no paisa to lose — `total` is defined as the sum rather than
 * rounded independently, so the three always agree.
 */
export function commissionWithGst(
  commission: number,
  ratePct: number = COMMISSION_GST_RATE_PCT,
): CommissionTaxSplit {
  if (!(commission > 0)) return { taxable: 0, gst: 0, total: 0 };
  const taxable = round2(commission);
  const gst = round2((taxable * ratePct) / 100);
  return { taxable, gst, total: round2(taxable + gst) };
}
