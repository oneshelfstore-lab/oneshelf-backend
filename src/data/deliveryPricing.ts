/**
 * Distance-based delivery pricing — the code-defined DEFAULT slab ladder + the validation schema for
 * the owner-tunable override stored in `StoreConfig.deliverySlabs` (see services/deliveryPricing.ts
 * `resolveDeliveryPricingConfig`). Mirrors the loyaltyTiers.ts pattern: validated on write AND read,
 * an invalid stored value logs and falls back rather than ever crashing the pricing hot path.
 */
import { z } from "zod";

export interface DeliverySlab {
  uptoKm: number;
  charge: number;
}

export const DEFAULT_DELIVERY_SLABS: DeliverySlab[] = [
  { uptoKm: 2, charge: 20 },
  { uptoKm: 5, charge: 30 },
  { uptoKm: 8, charge: 50 },
];

// ─── Safety rails the owner cannot cross, even through the API ───────────
export const MAX_SLABS = 6;
export const MAX_SLAB_CHARGE = 500; // hard cap on any single slab's delivery fee
export const MAX_SLAB_KM = 50;

export const deliverySlabInputSchema = z.object({
  uptoKm: z.number().positive().max(MAX_SLAB_KM),
  charge: z.number().min(0).max(MAX_SLAB_CHARGE),
});

export const deliverySlabsInputSchema = z
  .array(deliverySlabInputSchema)
  .min(1)
  .max(MAX_SLABS)
  .superRefine((slabs, ctx) => {
    let prev = 0;
    slabs.forEach((s, i) => {
      if (s.uptoKm <= prev) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each slab's distance must be higher than the one before it",
          path: [i, "uptoKm"],
        });
      }
      prev = s.uptoKm;
    });
  });

export type DeliverySlabsInput = z.infer<typeof deliverySlabsInputSchema>;

/** Charge for a slab covering `distanceKm`, or null if it exceeds every defined slab (the caller
 *  applies the top slab's charge as a ceiling — see computeDistanceDelivery). */
export function chargeForDistance(distanceKm: number, slabs: DeliverySlab[] = DEFAULT_DELIVERY_SLABS): number | null {
  for (const s of slabs) if (distanceKm <= s.uptoKm) return s.charge;
  return null;
}
