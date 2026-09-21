/**
 * Statutory rates the platform applies, in one place.
 *
 * These lived as four separate `const TCS_RATE_PCT = 1` declarations — in routes/orders.ts,
 * routes/ownerGstr8.ts, services/reports.ts and services/subscriptionEngine.ts — each carrying a
 * comment telling the reader it "must match" the others. That instruction is the whole problem: a
 * rate that has to be changed in four files is a rate that eventually gets changed in three.
 *
 * ⚠️ NO NUMBER MOVED when these were collapsed here. The rate below is still the superseded one;
 * correcting it is its own change, so that it shows up in a diff as a decision rather than as a
 * side effect of a refactor.
 */

/**
 * GST Sec-52 TCS — what the platform, as an e-commerce operator, collects on an EXTERNAL seller's
 * net taxable supplies and remits in GSTR-8. Split half CGST, half SGST on an intra-state supply.
 * It is withheld from the seller's payout, never charged to the customer. The house store is the
 * platform's own catalog, so it collects nothing on its own supply.
 *
 * ⚠️ THIS VALUE IS OUT OF DATE. Notification 15/2024-Central Tax cut the rate from 1% to 0.5%
 * with effect from 10 July 2024. We are still collecting 1%, i.e. withholding roughly twice what
 * the law asks for, from every external seller. Correcting it is step 06 of the migration runbook,
 * and it is deliberately not done here.
 *
 * ⚠️ AND WHEN IT IS CORRECTED, READ THIS FIRST. Two reports — ownerGstr8.ts and reports.ts — recover
 * the taxable value a historical row was based on by dividing its stored tcsAmount by this rate.
 * That arithmetic silently assumes every row was written at the CURRENT rate. Halve the constant
 * and every pre-existing row's liable value doubles in those reports. The rows written at 1% need
 * correcting in the same change, or the reports need to read a per-row rate instead of this
 * constant — which is what SubOrder.tcsRatePct (runbook step 04) exists for.
 */
export const TCS_RATE_PCT = 1;
