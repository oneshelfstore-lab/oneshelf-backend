import type { Decimal } from "@prisma/client/runtime/library";

/**
 * Loose unit conversion between API and Android app formats.
 *
 * API (clean model):
 *   sellingPrice/mrp = per BASE unit (₹/kg, ₹/L)
 *   stock = quantity in BASE units (500 = 500 kg)
 *   packageSize = minimum sellable increment (0.25 = 250g steps)
 *
 * App (increment model):
 *   sellingPrice/mrp = per INCREMENT (₹ for one 250g portion)
 *   stock = number of INCREMENTS (2000 = 500kg / 0.25kg)
 *   packageSize = same (0.25)
 */

interface VariantLike {
  packageSize: Decimal | number;
  mrp: Decimal | number;
  sellingPrice: Decimal | number;
  costPrice?: Decimal | number | null;
  saleFloor?: Decimal | number | null;
  stock: Decimal | number;
  bulkPrice?: Decimal | number | null;
}

function toNum(v: Decimal | number): number {
  return typeof v === "number" ? v : Number(v);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface AppVariantFormat {
  mrp: number;
  sellingPrice: number;
  costPrice: number | null;
  saleFloor: number | null;
  stock: number;
  bulkPrice: number | null;
  packageSize: number;
}

export function toAppFormat(variant: VariantLike, isLoose: boolean): AppVariantFormat {
  const packageSize = toNum(variant.packageSize);
  const mrp = toNum(variant.mrp);
  const sellingPrice = toNum(variant.sellingPrice);
  const costPrice = variant.costPrice != null ? toNum(variant.costPrice) : null;
  const saleFloor = variant.saleFloor != null ? toNum(variant.saleFloor) : null;
  const stock = toNum(variant.stock);
  const bulkPrice = variant.bulkPrice != null ? toNum(variant.bulkPrice) : null;

  if (!isLoose) {
    return { mrp, sellingPrice, costPrice, saleFloor, stock, bulkPrice, packageSize };
  }

  // API: per-base-unit → App: per-increment
  return {
    mrp: round2(mrp * packageSize),
    sellingPrice: round2(sellingPrice * packageSize),
    costPrice: costPrice != null ? round2(costPrice * packageSize) : null,
    saleFloor: saleFloor != null ? round2(saleFloor * packageSize) : null,
    stock: Math.round(stock / packageSize),
    bulkPrice: bulkPrice != null ? round2(bulkPrice * packageSize) : null,
    packageSize,
  };
}

export function fromAppFormat(
  appData: { mrp: number; sellingPrice: number; costPrice?: number | null; saleFloor?: number | null; stock: number; bulkPrice?: number | null; packageSize: number },
  isLoose: boolean,
): { mrp: number; sellingPrice: number; costPrice: number | null; saleFloor: number | null; stock: number; bulkPrice: number | null } {
  if (!isLoose) {
    return {
      mrp: appData.mrp,
      sellingPrice: appData.sellingPrice,
      costPrice: appData.costPrice ?? null,
      saleFloor: appData.saleFloor ?? null,
      stock: appData.stock,
      bulkPrice: appData.bulkPrice ?? null,
    };
  }

  const packageSize = appData.packageSize;
  return {
    mrp: round2(appData.mrp / packageSize),
    sellingPrice: round2(appData.sellingPrice / packageSize),
    costPrice: appData.costPrice != null ? round2(appData.costPrice / packageSize) : null,
    saleFloor: appData.saleFloor != null ? round2(appData.saleFloor / packageSize) : null,
    stock: round3(appData.stock * packageSize),
    bulkPrice: appData.bulkPrice != null ? round2(appData.bulkPrice / packageSize) : null,
  };
}

/**
 * Validate the merchant pricing chain on a variant (values in any consistent scale — app-format request
 * values work since the comparison is scale-invariant). Returns a human error string, or null if OK.
 *
 * `allowBelowCost` = true for the house seller / owner (they may legitimately run loss-leaders), so the
 * below-cost checks become advisory (skipped here; the editor still warns). For external sellers it's the
 * seller's own guardrail against an accidental loss — NOT a platform-imposed price (FDI: seller owns price).
 */
export function assertVariantFloors(
  v: { mrp: number; sellingPrice: number; costPrice?: number | null; saleFloor?: number | null },
  allowBelowCost: boolean,
): string | null {
  const cost = v.costPrice ?? null;
  const floor = v.saleFloor ?? null;
  if (floor != null && floor > v.sellingPrice) {
    return `Sale floor (₹${floor}) can't be higher than the selling price (₹${v.sellingPrice}).`;
  }
  if (!allowBelowCost && cost != null) {
    if (floor != null && floor < cost) {
      return `Sale floor (₹${floor}) is below your cost (₹${cost}) — you'd lose money on a sale.`;
    }
    if (v.sellingPrice < cost) {
      return `Selling price (₹${v.sellingPrice}) is below your cost (₹${cost}) — you'd lose money.`;
    }
  }
  return null;
}

/**
 * Format a variant for app-facing API responses.
 * Applies loose conversion and adds computed display fields.
 */
export function formatVariantForApp(
  variant: VariantLike & { id: string; sku: string; barcode?: string | null; packageUnit: string; lowStockThreshold: number; bulkMinQty: number; gstRateOverride?: Decimal | number | null; isActive: boolean },
  isLoose: boolean,
) {
  const converted = toAppFormat(variant, isLoose);
  return {
    id: variant.id,
    sku: variant.sku,
    barcode: variant.barcode ?? null,
    packageSize: toNum(variant.packageSize),
    packageUnit: variant.packageUnit,
    mrp: converted.mrp,
    sellingPrice: converted.sellingPrice,
    stock: converted.stock,
    lowStockThreshold: variant.lowStockThreshold,
    bulkMinQty: variant.bulkMinQty,
    bulkPrice: converted.bulkPrice,
    gstRateOverride: variant.gstRateOverride != null ? toNum(variant.gstRateOverride) : null,
    isActive: variant.isActive,
    isLoose,
  };
}
