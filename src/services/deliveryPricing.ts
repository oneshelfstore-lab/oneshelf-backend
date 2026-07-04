import prisma from "../lib/prisma.js";
import { memoCache } from "../lib/httpCache.js";
import { haversineKm } from "../lib/distance.js";
import {
  DEFAULT_DELIVERY_SLABS,
  deliverySlabsInputSchema,
  chargeForDistance,
  type DeliverySlab,
} from "../data/deliveryPricing.js";

// The owner's slab/location config changes rarely; keep it hot but bust it the instant the owner saves.
const CONFIG_TTL_MS = 30 * 1000;
const CONFIG_KEY = "deliveryPricing:config";

interface DeliveryPricingConfig {
  storeLat: number | null;
  storeLng: number | null;
  slabs: DeliverySlab[];
  deliveryRadius: number | null; // km; null = unenforced
  flatCharge: number; // fallback when store or address location is unknown
}

/**
 * The active delivery-pricing config: the owner's `StoreConfig.deliverySlabs` when present and valid,
 * else the code-defined default ladder. An invalid stored value logs and falls back rather than ever
 * crashing the pricing path (same discipline as `resolveLoyaltyConfig`).
 */
export async function resolveDeliveryPricingConfig(): Promise<DeliveryPricingConfig> {
  return memoCache.get(CONFIG_KEY, CONFIG_TTL_MS, async () => {
    const cfg = await prisma.storeConfig.findFirst({
      select: { storeLat: true, storeLng: true, deliverySlabs: true, deliveryRadius: true, deliveryCharge: true },
    });

    let slabs = DEFAULT_DELIVERY_SLABS;
    if (cfg?.deliverySlabs != null) {
      const parsed = deliverySlabsInputSchema.safeParse(cfg.deliverySlabs);
      if (parsed.success) slabs = parsed.data;
      else console.error("Invalid StoreConfig.deliverySlabs — falling back to defaults:", parsed.error.errors);
    }

    return {
      storeLat: cfg?.storeLat != null ? Number(cfg.storeLat) : null,
      storeLng: cfg?.storeLng != null ? Number(cfg.storeLng) : null,
      slabs,
      deliveryRadius: cfg?.deliveryRadius != null ? Number(cfg.deliveryRadius) : null,
      flatCharge: cfg ? Number(cfg.deliveryCharge) : 30,
    };
  });
}

/** Drop the cached config so an owner edit (location / slabs / radius) is reflected server-instantly. */
export function bustDeliveryPricingConfig(): void {
  memoCache.bust(CONFIG_KEY);
}

export interface DistanceDeliveryResult {
  charge: number;
  // null when distance couldn't be computed (store or address has no saved coordinates) — the flat
  // fallback charge is used instead, so pre-rollout orders / addresses without lat-lng are unaffected.
  distanceKm: number | null;
  // true only when distance exceeds StoreConfig.deliveryRadius — the caller (order placement) should
  // block the order in this case; the /cart/quote preview just surfaces it as a warning.
  outOfRange: boolean;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Distance-based delivery charge for a DELIVERY order. Falls back to the flat
 * `StoreConfig.deliveryCharge` whenever the store's own location or the destination address has no
 * coordinates — so this is a safe drop-in: nothing changes until the owner sets the store's location
 * (Store Settings → "Set store location") AND the customer's address has lat/lng.
 */
export async function computeDistanceDelivery(
  addressLat: number | null | undefined,
  addressLng: number | null | undefined,
): Promise<DistanceDeliveryResult> {
  const cfg = await resolveDeliveryPricingConfig();

  if (cfg.storeLat == null || cfg.storeLng == null || addressLat == null || addressLng == null) {
    return { charge: cfg.flatCharge, distanceKm: null, outOfRange: false };
  }

  const distanceKm = haversineKm(cfg.storeLat, cfg.storeLng, addressLat, addressLng);
  const outOfRange = cfg.deliveryRadius != null && distanceKm > cfg.deliveryRadius;
  const charge = chargeForDistance(distanceKm, cfg.slabs) ?? cfg.slabs[cfg.slabs.length - 1]!.charge;

  return { charge, distanceKm: round1(distanceKm), outOfRange };
}
