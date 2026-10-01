import { toAppFormat } from "../utils/looseUnitConverter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Routine run planning — PURE (no DB). Given a routine's items and the LIVE variant rows, decide what a
// run would deliver and what it would cost, and whether the cost is within the customer's price ceiling.
// The engine (subscriptionEngine.ts) does the I/O; keeping this pure is what makes it unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function isLooseType(t: string): boolean {
  return t === "LOOSE" || t === "PRODUCE";
}

// ─── Pricing (the 🩹 delivery-charge fix) ─────────────────────────────────────

export interface PricedVariant {
  packageSize: unknown;
  packageUnit: string;
  sellingPrice: unknown;
  mrp: unknown;
  bulkMinQty: number;
  bulkPrice: unknown;
  gstRateOverride: unknown;
  product: { productType: string; gstRate: unknown };
}

export interface SubscriptionPricing {
  unitPrice: number;
  mrp: number;
  lineTotal: number;
  gstRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  totalTax: number;
  subtotal: number;
  deliveryCharge: 0;
  totalAmount: number;
  savedAmount: number;
}

/**
 * Prices ONE routine line at face value: GST-inclusive line total, NO delivery, NO coupon,
 * NO loyalty, NO wallet, NO bulk (D9). Mirrors the per-line GST math in cartPricing.ts:99-107.
 */
export function priceSubscriptionDelivery(variant: PricedVariant, quantity: number): SubscriptionPricing {
  const isLoose = isLooseType(variant.product.productType);
  const converted = toAppFormat(variant as never, isLoose);
  const unitPrice = converted.sellingPrice; // never bulkPrice
  const mrp = converted.mrp;
  const lineTotal = round2(unitPrice * quantity);

  const gstRate =
    variant.gstRateOverride != null
      ? Number(variant.gstRateOverride)
      : variant.product.gstRate != null
        ? Number(variant.product.gstRate)
        : 0;

  const taxableValue = gstRate > 0 ? round2(lineTotal / (1 + gstRate / 100)) : lineTotal;
  const totalTax = round2(lineTotal - taxableValue);
  const cgst = round2(totalTax / 2);
  const sgst = round2(totalTax - cgst);
  const savedAmount = round2(Math.max(0, mrp - unitPrice) * quantity);

  return {
    unitPrice,
    mrp,
    lineTotal,
    gstRate,
    taxableValue,
    cgst,
    sgst,
    totalTax,
    subtotal: lineTotal,
    deliveryCharge: 0,
    totalAmount: lineTotal,
    savedAmount,
  };
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

/** A routine line as the engine sees it (from SubscriptionItem, or a legacy single-product row). */
export interface RoutineItemRow {
  id: string;
  variantId: string;
  productName: string;
  imageUrl: string | null;
  quantity: number;
  /** "Normal" unit price in app format — the ceiling baseline. null = none yet. */
  unitPriceSnapshot: number | null;
  /** What to do if it cannot be delivered today. Absent = SKIP. */
  substitution?: "SKIP" | "SIMILAR";
}

/** The live variant row for an item: pricing fields + availability. null/inactive ⇒ unavailable. */
export interface LiveVariant extends PricedVariant {
  isActive: boolean;
  /** Base-unit stock rollup (ProductVariant.stock). */
  stock: unknown;
}

export interface PlanLine<V extends LiveVariant = LiveVariant> {
  item: RoutineItemRow;
  variant: V;
  isLoose: boolean;
  /** Base-unit demand — mirrors routes/orders.ts exactly (loose: qty × packageSize). */
  needed: number;
  pricing: SubscriptionPricing;
}

export interface SkippedItem {
  item: RoutineItemRow;
  reason: "OOS" | "UNAVAILABLE";
}

export type CeilingPolicy = { type: "ABSOLUTE" | "PERCENT"; value: number };

export interface RoutinePlan<V extends LiveVariant = LiveVariant> {
  lines: PlanLine<V>[];
  skipped: SkippedItem[];
  subtotal: number;
  taxableValue: number;
  totalTax: number;
  savedAmount: number;
  totalAmount: number;
  /** What the delivered lines "normally" cost (snapshot × qty; current price where there's no snapshot). */
  estimate: number;
  /** totalAmount − estimate (negative = cheaper than normal). */
  drift: number;
  /** Largest increase over `estimate` the policy tolerates. */
  allowedIncrease: number;
  withinCeiling: boolean;
}

/**
 * Plan one run. Unavailable (missing/inactive) and out-of-stock items are SKIPPED, not fatal — the rest
 * of the basket still goes. The estimate and the total are both computed over the DELIVERED lines only,
 * so dropping an out-of-stock item can never masquerade as a price change.
 */
export function planRoutineRun<V extends LiveVariant>(
  items: RoutineItemRow[],
  variants: Map<string, V>,
  ceiling: CeilingPolicy,
): RoutinePlan<V> {
  const lines: PlanLine<V>[] = [];
  const skipped: SkippedItem[] = [];

  for (const item of items) {
    const variant = variants.get(item.variantId);
    if (!variant || !variant.isActive) {
      skipped.push({ item, reason: "UNAVAILABLE" });
      continue;
    }
    const isLoose = isLooseType(variant.product.productType);
    const needed = isLoose ? item.quantity * Number(variant.packageSize) : item.quantity;
    if (Number(variant.stock) + 1e-9 < needed) {
      skipped.push({ item, reason: "OOS" });
      continue;
    }
    lines.push({ item, variant, isLoose, needed, pricing: priceSubscriptionDelivery(variant, item.quantity) });
  }

  const sum = (f: (l: PlanLine<V>) => number) => round2(lines.reduce((s, l) => s + f(l), 0));
  const totalAmount = sum((l) => l.pricing.totalAmount);
  const estimate = sum((l) =>
    l.item.unitPriceSnapshot != null ? round2(l.item.unitPriceSnapshot * l.item.quantity) : l.pricing.totalAmount,
  );
  const allowedIncrease = ceiling.type === "PERCENT" ? round2((estimate * ceiling.value) / 100) : ceiling.value;
  const drift = round2(totalAmount - estimate);

  return {
    lines,
    skipped,
    subtotal: sum((l) => l.pricing.subtotal),
    taxableValue: sum((l) => l.pricing.taxableValue),
    totalTax: sum((l) => l.pricing.totalTax),
    savedAmount: sum((l) => l.pricing.savedAmount),
    totalAmount,
    estimate,
    drift,
    allowedIncrease,
    withinCeiling: drift <= allowedIncrease + 0.005,
  };
}
