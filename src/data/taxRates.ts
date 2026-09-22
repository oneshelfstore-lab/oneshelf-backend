/**
 * Statutory rates the platform applies, in one place.
 *
 * These lived as four separate `const TCS_RATE_PCT = 1` declarations — in routes/orders.ts,
 * routes/ownerGstr8.ts, services/reports.ts and services/subscriptionEngine.ts — each carrying a
 * comment telling the reader it "must match" the others. That instruction is the whole problem: a
 * rate that has to be changed in four files is a rate that eventually gets changed in three.
 */

/**
 * GST Sec-52 TCS — what the platform, as an e-commerce operator, collects on an EXTERNAL seller's
 * net taxable supplies and remits in GSTR-8. Split half CGST, half SGST on an intra-state supply.
 * It is withheld from the seller's payout, never charged to the customer. The house store is the
 * platform's own catalog, so it collects nothing on its own supply.
 *
 * 0.5% since Notification 15/2024-Central Tax, with effect from 10 July 2024 — halved from the
 * original 1%. On an intra-state supply that is 0.25% CGST + 0.25% SGST.
 *
 * ⚠️ THIS CONSTANT IS THE RATE FOR NEW ROWS ONLY. Nothing that reads history may use it. Every
 * SubOrder snapshots the rate it was actually computed at in `SubOrder.tcsRatePct`, and the two
 * reports that need a liable value (routes/ownerGstr8.ts, services/reports.ts) read the stored
 * `SubOrder.taxableValue` — the base TCS was charged on — rather than reconstructing it by dividing
 * a stored amount by whatever this constant happens to say today. Reintroducing that division is
 * how halving this number doubles every historical row's liable value in a filed return.
 */
export const TCS_RATE_PCT = 0.5;
