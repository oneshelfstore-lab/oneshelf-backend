import prisma from "../lib/prisma.js";
import { haversineKm } from "../lib/distance.js";
import { getRiderRoute } from "./riderRoute.js";
import { notifyRiderEta } from "./fcmNotifier.js";

/**
 * Pushes the rider's progress to the customers waiting on it, so an ongoing notification can show
 * "Arriving in 8 min" without the app being open.
 *
 * ⚠️ This runs off the rider heartbeat, which fires every 60 seconds. Pushing on every beat would
 * be ~40 notifications per delivery — the exact high-frequency pattern FCM throttles, and pure
 * battery cost for a number that mostly has not changed. So a push only goes out when the MINUTE
 * COUNT actually changes, or when the last one is old enough that its freshness stamp needs
 * refreshing.
 *
 * ⚠️ The gate is deliberately NOT on distance. Distance is reported to 0.1 km and therefore moves
 * on nearly every beat, so gating on it would be the same as not gating at all. Distance still
 * rides along in the payload; it just does not get a vote on whether to send.
 */

/** Re-send this often even when nothing changed, so the "updated N min ago" stamp stays honest. */
const PUSH_REFRESH_MS = 3 * 60 * 1000;
/** Forget an order's gate once its delivery is long over. */
const GATE_TTL_MS = 30 * 60 * 1000;

interface Gate {
  etaMinutes: number | null;
  at: number;
}

const lastPush = new Map<string, Gate>();

function sweep(now: number): void {
  for (const [orderId, gate] of lastPush) {
    if (now - gate.at > GATE_TTL_MS) lastPush.delete(orderId);
  }
}

/**
 * Drop an order's gate. Called when a trip ends, so the next delivery to the same order id (a
 * re-attempt after a failed drop) starts by pushing rather than inheriting a stale "unchanged".
 */
export function clearRiderEtaGate(orderId: string): void {
  lastPush.delete(orderId);
}

/**
 * Fire-and-forget: never throws, because the caller is the rider's heartbeat and a failed push must
 * not turn a stored position into an error on their screen.
 */
export async function pushRiderEta(
  riderId: string,
  riderName: string,
  riderLat: number,
  riderLng: number,
  fixAt: number,
): Promise<void> {
  try {
    const orders = await prisma.order.findMany({
      where: { deliveryBoyId: riderId, status: "OUT_FOR_DELIVERY" },
      select: { id: true, orderNumber: true, customerId: true, addressId: true },
    });
    if (orders.length === 0) return;

    const now = Date.now();
    sweep(now);

    for (const order of orders) {
      // Same shape as the rider-status block in routes/orders.ts: the destination pin is read
      // directly rather than through the relation, and is null for every address saved before the
      // Sep 17 2026 lat/lng fix. Without it there is no route and no distance — the push then
      // carries a bare "on the way", which is all we can honestly say.
      const dest = order.addressId
        ? await prisma.address.findUnique({
            where: { id: order.addressId },
            select: { lat: true, lng: true },
          })
        : null;
      const destLat = dest?.lat != null ? Number(dest.lat) : null;
      const destLng = dest?.lng != null ? Number(dest.lng) : null;

      // Reuses the SAME cache the order-detail screen fills, so this adds no Routes API spend of
      // its own — it re-serves whatever that gate last computed.
      const route =
        destLat != null && destLng != null
          ? await getRiderRoute(order.id, riderLat, riderLng, destLat, destLng)
          : null;
      const etaMinutes = route?.etaMinutes ?? null;
      const distanceKm =
        destLat != null && destLng != null
          ? Math.round(haversineKm(riderLat, riderLng, destLat, destLng) * 10) / 10
          : null;

      const prev = lastPush.get(order.id);
      const etaChanged = prev == null || prev.etaMinutes !== etaMinutes;
      const stampStale = prev == null || now - prev.at > PUSH_REFRESH_MS;
      if (!etaChanged && !stampStale) continue;

      lastPush.set(order.id, { etaMinutes, at: now });
      await notifyRiderEta({
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        riderName,
        etaMinutes,
        distanceKm,
        fixAt,
      });
    }
  } catch (e) {
    console.error("[background task failed] rider ETA push", e);
  }
}
