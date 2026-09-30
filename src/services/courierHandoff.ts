import crypto from "crypto";
import { haversineKm } from "../lib/distance.js";
import { OTP_LOCK_SECONDS } from "../lib/otp.js";

/**
 * The decision at each courier handoff — PURE, so the rules that stop a fake pickup/delivery are
 * testable without a database (COURIER_PLAN.md §3 rules 5-6).
 *
 * A handoff needs THREE things at once: the right code, a rider position inside the geofence, and a
 * position we can actually trust. Any one alone is spoofable (a code can be read out over the phone;
 * a GPS fix can be faked) — together, a fake handoff has to fool both.
 *
 * ⚠️ Order matters. Location is judged BEFORE the code and a location refusal does NOT count as a wrong
 * attempt: a rider tapping "verify" from the wrong street should be told to go there, not be locked
 * out of the real handoff by their own mistake. Only a wrong code burns an attempt.
 */

/** How close the rider must be to the pickup/drop pin. Wide enough for tier-3-town GPS and a big gate. */
export const GEOFENCE_M = 200;
/** A fix worse than this says where the rider is only to the nearest street — refuse rather than guess. */
export const MAX_ACCURACY_M = 150;
export const MAX_ATTEMPTS = 5;

export type HandoffRefusal = "LOCKED" | "POOR_GPS" | "TOO_FAR" | "WRONG_CODE";

export type HandoffResult =
  | { ok: true; distanceM: number }
  | { ok: false; reason: HandoffRefusal; distanceM?: number; retryInSec?: number; attemptsLeft?: number };

export interface HandoffInput {
  expectedCode: string;
  code: string;
  attempts: number;
  lockedUntil: Date | null;
  now: number;
  fix: { lat: number; lng: number; accuracyM?: number | null };
  target: { lat: number; lng: number };
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function checkHandoff(i: HandoffInput): HandoffResult {
  if (i.lockedUntil && i.lockedUntil.getTime() > i.now) {
    return { ok: false, reason: "LOCKED", retryInSec: Math.ceil((i.lockedUntil.getTime() - i.now) / 1000) };
  }
  if (i.fix.accuracyM != null && i.fix.accuracyM > MAX_ACCURACY_M) {
    return { ok: false, reason: "POOR_GPS" };
  }
  const distanceM = Math.round(haversineKm(i.fix.lat, i.fix.lng, i.target.lat, i.target.lng) * 1000);
  if (distanceM > GEOFENCE_M) return { ok: false, reason: "TOO_FAR", distanceM };
  if (!sameCode(i.expectedCode, i.code)) {
    return { ok: false, reason: "WRONG_CODE", distanceM, attemptsLeft: Math.max(0, MAX_ATTEMPTS - (i.attempts + 1)) };
  }
  return { ok: true, distanceM };
}

/**
 * State after one WRONG code. On the Nth miss the code locks for a cooldown and the counter resets —
 * never a permanent lock, which would let one bad afternoon strand a real handoff (same rule as OrderSecret).
 */
export function afterWrongCode(attempts: number, now: number): { attempts: number; lockedUntil: Date | null } {
  const next = attempts + 1;
  if (next >= MAX_ATTEMPTS) return { attempts: 0, lockedUntil: new Date(now + OTP_LOCK_SECONDS * 1000) };
  return { attempts: next, lockedUntil: null };
}

/** What the rider is told. Deliberately specific about location (fixable) and vague about nothing else. */
export function refusalMessage(r: Extract<HandoffResult, { ok: false }>): string {
  switch (r.reason) {
    case "LOCKED": return `Too many wrong codes. Try again in ${r.retryInSec ?? OTP_LOCK_SECONDS} seconds.`;
    case "POOR_GPS": return "Your GPS signal is too weak. Move to an open area and try again.";
    case "TOO_FAR": return `You're about ${r.distanceM} m away. Get to the address, then enter the code.`;
    case "WRONG_CODE": return `That code is wrong. ${r.attemptsLeft} attempt${r.attemptsLeft === 1 ? "" : "s"} left.`;
  }
}
