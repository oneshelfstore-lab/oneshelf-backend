import { haversineKm } from "../lib/distance.js";

/**
 * The rider's road route to the customer, from Google's Routes API.
 *
 * ⚠️ This is called from `GET /orders/:id`, which the customer's app POLLS EVERY 30 SECONDS while
 * an order is out for delivery. A route call per poll would be ~40 calls per delivery — enough to
 * burn the whole free monthly allowance in a couple of hundred orders and then cost real money for
 * a decorative line. So the route is cached per order and only re-fetched when the rider has
 * actually moved somewhere new (see `shouldRefetch`). Every other poll re-serves the cached
 * polyline for free. Do not "simplify" this by calling Google on each request.
 *
 * ⚠️ The key is deliberately a SEPARATE credential from the app's `MAPS_API_KEY`: an
 * Android-restricted key (package + SHA-1) cannot call a web service, and shipping an unrestricted
 * key in the APK would let anyone spend the account's quota. `ROUTES_API_KEY` lives only in the
 * backend environment and is restricted to the Routes API.
 *
 * Unset key, a Google error, a timeout — all return null, and the app falls back to the dashed
 * straight line it drew before this existed. A map feature must never break order details.
 */

/** Re-route once the rider is this far from where the current route was computed. */
const REROUTE_METRES = 250;
/** …or this long since the last route, so a rider stuck in traffic still gets a fresh ETA. */
const REROUTE_MS = 3 * 60 * 1000;
/** Drop cached routes this old — the delivery is long over. */
const CACHE_TTL_MS = 30 * 60 * 1000;
/** Google gets this long before we give up and serve whatever we already had. */
const REQUEST_TIMEOUT_MS = 3_500;

export interface RiderRoute {
  /** Google's encoded polyline; the app decodes it into the line it draws. */
  polyline: string;
  /** Driving time remaining, in whole minutes (never 0 — "0 min away" reads as broken). */
  etaMinutes: number;
}

interface CachedRoute extends RiderRoute {
  fromLat: number;
  fromLng: number;
  destLat: number;
  destLng: number;
  at: number;
}

// ponytail: in-process cache, fine on Railway's single instance. Scale to multiple replicas and
// each one keeps its own copy, so the call count multiplies by the replica count — move it onto the
// Order row (or Redis) if that ever happens.
const cache = new Map<string, CachedRoute>();

/**
 * Whether a new Routes call is worth paying for.
 *
 * Pure on purpose: this one predicate decides the entire API bill, and every way it can be wrong is
 * silent — too eager and the invoice climbs with nothing on screen to show for it, too lazy and the
 * customer watches a line that no longer matches where the rider is.
 */
export function shouldRefetch(
  cached: { fromLat: number; fromLng: number; destLat: number; destLng: number; at: number } | undefined,
  riderLat: number,
  riderLng: number,
  destLat: number,
  destLng: number,
  now: number,
): boolean {
  if (!cached) return true;
  // The customer changed where it's going — the old route is about a different trip.
  if (cached.destLat !== destLat || cached.destLng !== destLng) return true;
  if (now - cached.at >= REROUTE_MS) return true;
  return haversineKm(cached.fromLat, cached.fromLng, riderLat, riderLng) * 1000 >= REROUTE_METRES;
}

/** Evicts finished deliveries so the cache can't grow for the life of the process. */
function sweep(now: number): void {
  if (cache.size < 50) return;
  for (const [key, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(key);
  }
}

async function fetchRoute(
  key: string,
  riderLat: number,
  riderLng: number,
  destLat: number,
  destLng: number,
): Promise<RiderRoute | null> {
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      // Asking for fewer fields bills a cheaper SKU. Don't widen this casually.
      "X-Goog-FieldMask": "routes.polyline.encodedPolyline,routes.duration",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: riderLat, longitude: riderLng } } },
      destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
      // Riders are on two-wheelers and legitimately use lanes a car can't.
      travelMode: "TWO_WHEELER",
      // ⚠️ No routingPreference: TRAFFIC_AWARE moves this onto a pricier SKU, and for a rider who
      // is 2 km away the traffic model changes the ETA by less than the 60s position lag already does.
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    console.error(`[riderRoute] Routes API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return null;
  }

  const body = (await res.json()) as {
    routes?: { polyline?: { encodedPolyline?: string }; duration?: string }[];
  };
  const route = body.routes?.[0];
  const polyline = route?.polyline?.encodedPolyline;
  if (!polyline) return null;

  // duration comes back as a protobuf duration string, e.g. "845s".
  const seconds = Number.parseInt(route?.duration ?? "", 10);
  const etaMinutes = Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : 0;
  return { polyline, etaMinutes };
}

/**
 * The rider's route to this order's address, or null when there's nothing trustworthy to draw.
 * Never throws — the caller is an order-detail response.
 */
export async function getRiderRoute(
  orderId: string,
  riderLat: number,
  riderLng: number,
  destLat: number,
  destLng: number,
): Promise<RiderRoute | null> {
  const key = process.env.ROUTES_API_KEY;
  if (!key) return null;

  const now = Date.now();
  sweep(now);
  const cached = cache.get(orderId);
  if (!shouldRefetch(cached, riderLat, riderLng, destLat, destLng, now)) {
    return { polyline: cached!.polyline, etaMinutes: cached!.etaMinutes };
  }

  try {
    const fresh = await fetchRoute(key, riderLat, riderLng, destLat, destLng);
    if (!fresh) {
      // Serve the last good route rather than blanking the line on one bad response.
      return cached ? { polyline: cached.polyline, etaMinutes: cached.etaMinutes } : null;
    }
    cache.set(orderId, { ...fresh, fromLat: riderLat, fromLng: riderLng, destLat, destLng, at: now });
    return fresh;
  } catch (e) {
    console.error("[riderRoute] route fetch failed", e);
    return cached ? { polyline: cached.polyline, etaMinutes: cached.etaMinutes } : null;
  }
}
