import { z } from "zod";
import { haversineKm } from "../lib/distance.js";
import { chargeForDistance, deliverySlabsInputSchema, type DeliverySlab } from "../data/deliveryPricing.js";

/**
 * Courier quote + eligibility — PURE (no Prisma), so every failure mode is testable. The same
 * function prices the quote screen and the booking, so what the customer is shown is what is charged.
 */

export const PARCEL_TYPES = ["DOCUMENT", "SMALL_PACKAGE", "GROCERY_BAG", "BOX", "OTHER"] as const;
export const WEIGHT_BANDS = ["UPTO_1", "KG_1_3", "KG_3_5", "KG_5_10"] as const;
// v1 caps declared value at ₹5,000 (no insurance; liability limited in the terms — COURIER_PLAN.md §7).
export const VALUE_BANDS = ["UPTO_500", "B500_2000", "B2000_5000"] as const;
export const SPEEDS = ["STANDARD", "EXPRESS"] as const;

export type WeightBand = (typeof WEIGHT_BANDS)[number];
export type Speed = (typeof SPEEDS)[number];

/** Estimate windows shown to the customer. Estimates, not promises — live ETA only exists once a rider is assigned. */
export const SPEED_WINDOW: Record<Speed, string> = { STANDARD: "30–60 min", EXPRESS: "20–30 min" };

export const DEFAULT_COURIER_SLABS: DeliverySlab[] = [
  { uptoKm: 2, charge: 30 },
  { uptoKm: 5, charge: 40 },
  { uptoKm: 8, charge: 49 },
  { uptoKm: 10, charge: 59 },
];

export const DEFAULT_WEIGHT_SURCHARGE: Record<WeightBand, number> = {
  UPTO_1: 0,
  KG_1_3: 0,
  KG_3_5: 10,
  KG_5_10: 20,
};

export const courierSlabsSchema = deliverySlabsInputSchema;
export const weightSurchargeSchema = z.object({
  UPTO_1: z.number().min(0).max(500),
  KG_1_3: z.number().min(0).max(500),
  KG_3_5: z.number().min(0).max(500),
  KG_5_10: z.number().min(0).max(500),
});

export interface CourierPricingConfig {
  maxKm: number;
  slabs: DeliverySlab[];
  weightSurcharge: Record<WeightBand, number>;
  expressFee: number;
  platformFee: number;
  storeLat: number | null;
  storeLng: number | null;
  /** Pickup must be within this many km of the store; null = unenforced. */
  pickupRadiusKm: number | null;
}

export type Point = { lat: number; lng: number };

export type Ineligible = "SAME_LOCATION" | "DROP_TOO_FAR" | "PICKUP_OUT_OF_AREA";

/** Under ~50 m apart is not a delivery — it's a typo. */
const MIN_KM = 0.05;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function checkCourierEligibility(
  pickup: Point,
  drop: Point,
  cfg: CourierPricingConfig,
): { eligible: true; distanceKm: number } | { eligible: false; reason: Ineligible; distanceKm: number } {
  const distanceKm = round2(haversineKm(pickup.lat, pickup.lng, drop.lat, drop.lng));

  if (cfg.storeLat != null && cfg.storeLng != null && cfg.pickupRadiusKm != null) {
    if (haversineKm(pickup.lat, pickup.lng, cfg.storeLat, cfg.storeLng) > cfg.pickupRadiusKm) {
      return { eligible: false, reason: "PICKUP_OUT_OF_AREA", distanceKm };
    }
  }
  if (distanceKm < MIN_KM) return { eligible: false, reason: "SAME_LOCATION", distanceKm };
  if (distanceKm > cfg.maxKm) return { eligible: false, reason: "DROP_TOO_FAR", distanceKm };
  return { eligible: true, distanceKm };
}

export interface CourierPrice {
  deliveryFee: number;
  platformFee: number;
  total: number;
}

/**
 * delivery fee = distance slab (beyond the last slab the top slab applies as a ceiling, same rule as
 * shop delivery) + weight surcharge + express fee. Platform fee is a separate line.
 */
export function computeCourierPrice(
  distanceKm: number,
  weightBand: WeightBand,
  speed: Speed,
  cfg: CourierPricingConfig,
): CourierPrice {
  const slab = chargeForDistance(distanceKm, cfg.slabs) ?? cfg.slabs[cfg.slabs.length - 1].charge;
  const deliveryFee = slab + cfg.weightSurcharge[weightBand] + (speed === "EXPRESS" ? cfg.expressFee : 0);
  return { deliveryFee, platformFee: cfg.platformFee, total: deliveryFee + cfg.platformFee };
}

/** A stored JSON knob that fails validation falls back to the default (logged) instead of breaking pricing. */
export function parseOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T, label: string): T {
  if (value == null) return fallback;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  console.error(`Invalid StoreConfig.${label} — falling back to defaults:`, r.error.errors);
  return fallback;
}
