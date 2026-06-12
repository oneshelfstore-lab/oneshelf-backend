import prisma from "../lib/prisma.js";

export interface OrderEta {
  estimatedReadyAt: Date | null;
  etaLabel: string;
}

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

/**
 * Honest order ETA. We are a single store doing manual fulfillment, NOT a dark-store
 * network — so we never promise a hard "12 min". We render a RANGE derived from the
 * store-configured average, or echo the customer's chosen delivery slot.
 *
 *  - DELIVERY with a chosen slot → show the slot (no minutes estimate).
 *  - DELIVERY / PICKUP otherwise → now + avg{Delivery,Pickup}Minutes, labelled as a
 *    ±window range ("Arriving in about 30–50 min").
 */
export async function computeOrderEta(
  fulfillmentType: string,
  deliverySlot?: string | null,
): Promise<OrderEta> {
  // A customer-selected slot wins — it's the most concrete promise we can make.
  if (fulfillmentType === "DELIVERY" && deliverySlot) {
    return { estimatedReadyAt: null, etaLabel: `Arriving ${deliverySlot}` };
  }

  const config = await prisma.storeConfig.findFirst();
  const isPickup = fulfillmentType === "PICKUP";
  const avg = isPickup
    ? config?.avgPickupMinutes ?? 20
    : config?.avgDeliveryMinutes ?? 40;

  const estimatedReadyAt = new Date(Date.now() + avg * 60_000);

  // Build a friendly ±window range, clamped so the low end never drops below 5 min.
  const window = avg <= 20 ? 5 : 10;
  const low = Math.max(5, round5(avg - window));
  const high = round5(avg + window);
  const verb = isPickup ? "Ready for pickup in about" : "Arriving in about";

  return { estimatedReadyAt, etaLabel: `${verb} ${low}–${high} min` };
}
