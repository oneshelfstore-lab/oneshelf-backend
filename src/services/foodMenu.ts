import prisma from "../lib/prisma.js";
import { memoCache } from "../lib/httpCache.js";

// ─── Food vertical helpers (MULTIVERTICAL_PLAN.md §4) ────────────────────────────────────────────
// Pure functions live at the top so they're unit-testable without Prisma — this repo has no mocking
// precedent, every existing service test covers a pure function.

const IST_OFFSET_MINUTES = 330; // UTC+5:30

/**
 * Minutes past IST midnight for [now], read off UTC getters so it does NOT depend on the Node
 * process's own timezone (which is UTC on Railway but must not be relied on — the same trap that
 * made "Today" start at 5:30am IST in the analytics range helpers).
 */
export function istMinutesOfDay(now: Date = new Date()): number {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utcMinutes + IST_OFFSET_MINUTES) % 1440;
}

/** "10:00" → 600. Returns null for anything that isn't a real HH:MM. */
export function parseHhMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is the kitchen taking orders right now?
 *
 * ⚠️ Unset hours read as OPEN, not closed. A restaurant that hasn't configured its timings must
 * stay visible and orderable — failing closed would silently hide a live restaurant with nothing
 * on screen explaining why.
 *
 * ⚠️ A close time BEFORE the open time means a past-midnight close (18:00–02:00), not bad data —
 * that's the normal case for dinner service, so it must be the `else` branch, never a rejection.
 */
export function isRestaurantOpen(
  openTime: string | null | undefined,
  closeTime: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const open = parseHhMm(openTime);
  const close = parseHhMm(closeTime);
  if (open == null || close == null) return true;
  if (open === close) return true; // 24 hours

  const nowMin = istMinutesOfDay(now);
  return open < close
    ? nowMin >= open && nowMin < close
    : nowMin >= open || nowMin < close;
}

// ─── Config ─────────────────────────────────────────────────────────────────────────────────────

const CONFIG_TTL_MS = 30 * 1000;
const CONFIG_KEY = "food:config";

export interface FoodConfig {
  enabled: boolean;
  commissionPct: number;
}

/**
 * ⚠️ `enabled` is the CA gate, not a feature flag for convenience. It stays false until the Sec 9(5)
 * question is answered in writing (MULTIVERTICAL_PLAN.md §4.4) — restaurant service through an
 * e-commerce operator makes the PLATFORM the deemed supplier for GST, which is a different
 * mechanism from the Sec 52 / 1% TCS path every goods order uses. Same discipline as tds194oEnabled.
 */
export async function resolveFoodConfig(): Promise<FoodConfig> {
  return memoCache.get(CONFIG_KEY, CONFIG_TTL_MS, async () => {
    const cfg = await prisma.storeConfig.findFirst({
      select: { foodEnabled: true, foodCommissionPct: true },
    });
    return {
      enabled: cfg?.foodEnabled ?? false,
      commissionPct: cfg ? Number(cfg.foodCommissionPct) : 15,
    };
  });
}

/** Drop the cached config so an owner toggle takes effect server-instantly. */
export function bustFoodConfig(): void {
  memoCache.bust(CONFIG_KEY);
}

/**
 * A restaurant is browsable when it's a FOOD seller in good standing. Mirrors catalog.ts's
 * SELLER_TRADING, but as a direct filter — here the Seller IS the listed entity, not a relation.
 */
export const RESTAURANT_TRADING = {
  vertical: "FOOD",
  isActive: true,
  NOT: { status: "SUSPENDED" as const },
};
