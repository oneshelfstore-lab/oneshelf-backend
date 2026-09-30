import { haversineKm } from "../lib/distance.js";

/**
 * Anomaly flags for the owner's booking view (COURIER_PLAN.md §3 / brief #26) — PURE, computed from the
 * evidence log, never stored and never acted on automatically.
 *
 * ⚠️ These are PROMPTS FOR A HUMAN, not verdicts. A GPS fix can jump for innocent reasons, and "no
 * single signal bans anyone": a flag only makes the owner look at the timeline. Nothing here blocks a
 * rider or a customer, and nothing is shown to either of them.
 */

export interface FlagEvent {
  type: string;
  at: Date;
  lat: number | null;
  lng: number | null;
}

export type CourierFlag = "MANY_REFUSALS" | "IMPOSSIBLE_TRAVEL" | "INSTANT_DELIVERY";

export const FLAG_TEXT: Record<CourierFlag, string> = {
  MANY_REFUSALS: "The rider tried to verify a handoff several times and was refused (wrong place or wrong code).",
  IMPOSSIBLE_TRAVEL: "Two recorded positions are too far apart for the time between them — a GPS jump or a faked location.",
  INSTANT_DELIVERY: "Delivered very soon after pickup for this distance.",
};

/** Above this between two located events is not a scooter. */
const MAX_PLAUSIBLE_KMH = 100;
/** Ignore pairs closer than this in time or space: GPS jitter over a few seconds is noise, not travel. */
const MIN_PAIR_SECONDS = 10;
const MIN_PAIR_KM = 1;
const REFUSAL_THRESHOLD = 3;
/** Picking up and delivering this fast over a real distance means the trip didn't happen as recorded. */
const INSTANT_MINUTES = 2;
const INSTANT_MIN_KM = 2;

export function assessBooking(events: FlagEvent[], distanceKm: number): CourierFlag[] {
  const flags = new Set<CourierFlag>();
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());

  for (const kind of ["PICKUP", "DELIVERY"]) {
    if (sorted.filter((e) => e.type === `${kind}_REFUSED`).length >= REFUSAL_THRESHOLD) flags.add("MANY_REFUSALS");
  }

  const located = sorted.filter((e) => e.lat != null && e.lng != null);
  for (let i = 1; i < located.length; i++) {
    const a = located[i - 1];
    const b = located[i];
    const seconds = (b.at.getTime() - a.at.getTime()) / 1000;
    const km = haversineKm(a.lat!, a.lng!, b.lat!, b.lng!);
    if (seconds < MIN_PAIR_SECONDS || km < MIN_PAIR_KM) continue;
    if (km / (seconds / 3600) > MAX_PLAUSIBLE_KMH) flags.add("IMPOSSIBLE_TRAVEL");
  }

  const picked = sorted.find((e) => e.type === "PICKED_UP");
  const delivered = sorted.find((e) => e.type === "DELIVERED");
  if (picked && delivered && distanceKm > INSTANT_MIN_KM && delivered.at.getTime() - picked.at.getTime() < INSTANT_MINUTES * 60_000) {
    flags.add("INSTANT_DELIVERY");
  }
  return [...flags];
}
