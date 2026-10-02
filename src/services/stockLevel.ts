// When does a drop in stock deserve a message to the seller?
//
// Pure so it can be tested without a database. The rule is about the CROSSING, not the level: alert
// the sale that takes stock from above the line to at/below it, not every sale after that — a seller
// whose milk sits at 3 units all afternoon must not get a push per carton.
//
// `threshold` is ProductVariant.lowStockThreshold (default 5, editable per variant), so the "default
// with a per-product override" design already exists in the schema.

export type StockCrossing = "OUT" | "LOW" | null;

export function stockCrossing(before: number, after: number, threshold: number): StockCrossing {
  if (after <= 0 && before > 0) return "OUT";
  // A threshold of 0 means "only tell me when it's gone" — OUT above already covers that.
  if (threshold > 0 && after > 0 && after <= threshold && before > threshold) return "LOW";
  return null;
}
