import { priceSubscriptionDelivery, isLooseType, type LiveVariant } from "./routinePlan.js";

// ─────────────────────────────────────────────────────────────────────────────
// Routine intelligence — PURE (no DB), unit-tested:
//   • detectRecurring    — which things does this customer keep re-buying, how often, how much
//   • pickSubstitute     — the in-stock stand-in for an unavailable item
//   • shouldAlertPriceChange — when a "prices went up" push is worth sending
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_DAY = 24 * 60 * 60 * 1000;

/** IST calendar-day number (days since epoch, IST). */
function istDay(d: Date): number {
  return Math.floor((d.getTime() + IST_OFFSET_MS) / MS_DAY);
}
/** IST weekday 0=Sun..6=Sat for an IST day number. */
function weekdayOfDay(day: number): number {
  return new Date(day * MS_DAY).getUTCDay();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ─── Recurring-purchase detection ─────────────────────────────────────────────

/** One line of a past ordinary (non-routine) order. */
export interface Purchase {
  variantId: string;
  /** Store the line came from (null seller = house) — a routine is single-store. */
  storeKey: string;
  quantity: number;
  at: Date;
}

export interface RecurringItem {
  variantId: string;
  /** Predicted quantity per delivery: the median of what they usually buy. */
  quantity: number;
  /** Distinct days it was bought in the window. */
  timesBought: number;
  /** Median gap between purchase days. */
  everyDays: number;
  cadence: "DAILY" | "WEEKLY";
  /** For WEEKLY: the weekday(s) they usually buy on (0=Sun..6=Sat). */
  daysOfWeek: number[];
}

export interface RecurringSuggestion {
  storeKey: string;
  cadence: "DAILY" | "WEEKLY";
  daysOfWeek: number[];
  items: RecurringItem[];
}

export const MIN_PURCHASE_DAYS = 3;
export const MAX_MEDIAN_GAP_DAYS = 9; // beyond ~weekly it is not a "daily-need" rhythm

/**
 * Per variant: needs ≥3 distinct purchase days, a median gap ≤ 9 days, and to still be current (last
 * bought within ~2 gaps + 3 days of `now`). Gap ≤ 2 → DAILY; otherwise WEEKLY on the usual weekday(s).
 * Then groups by store and returns the store with the most qualifying items — and only the items sharing
 * that group's dominant cadence, because a routine has ONE schedule.
 */
export function detectRecurring(purchases: Purchase[], now: Date = new Date()): RecurringSuggestion | null {
  const byVariant = new Map<string, Purchase[]>();
  for (const p of purchases) byVariant.set(p.variantId, [...(byVariant.get(p.variantId) ?? []), p]);

  const perStore = new Map<string, RecurringItem[]>();
  for (const [variantId, rows] of byVariant) {
    // One purchase per IST day (several orders the same day are one habit-event); quantity = that day's total.
    const dayQty = new Map<number, number>();
    for (const r of rows) dayQty.set(istDay(r.at), (dayQty.get(istDay(r.at)) ?? 0) + r.quantity);
    const days = [...dayQty.keys()].sort((a, b) => a - b);
    if (days.length < MIN_PURCHASE_DAYS) continue;

    const gaps = days.slice(1).map((d, i) => d - days[i]!);
    const gap = median(gaps);
    if (gap > MAX_MEDIAN_GAP_DAYS) continue;
    if (istDay(now) - days[days.length - 1]! > gap * 2 + 3) continue; // stopped buying it

    const cadence: "DAILY" | "WEEKLY" = gap <= 2 ? "DAILY" : "WEEKLY";
    let daysOfWeek: number[] = [];
    if (cadence === "WEEKLY") {
      const counts = new Map<number, number>();
      for (const d of days) counts.set(weekdayOfDay(d), (counts.get(weekdayOfDay(d)) ?? 0) + 1);
      const top = Math.max(...counts.values());
      daysOfWeek = [...counts.entries()]
        .filter(([, c]) => c >= top * 0.6)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([d]) => d)
        .sort((a, b) => a - b);
    }
    const store = rows[0]!.storeKey;
    perStore.set(store, [
      ...(perStore.get(store) ?? []),
      {
        variantId,
        quantity: Math.max(1, Math.round(median([...dayQty.values()]))),
        timesBought: days.length,
        everyDays: gap,
        cadence,
        daysOfWeek,
      },
    ]);
  }

  let best: RecurringSuggestion | null = null;
  for (const [storeKey, items] of perStore) {
    const daily = items.filter((i) => i.cadence === "DAILY");
    const weekly = items.filter((i) => i.cadence === "WEEKLY");
    const chosen = daily.length >= weekly.length ? daily : weekly; // tie → daily (the stronger habit)
    if (chosen.length === 0) continue;
    const cadence = chosen[0]!.cadence;
    const strongest = [...chosen].sort((a, b) => b.timesBought - a.timesBought)[0]!;
    const candidate: RecurringSuggestion = {
      storeKey,
      cadence,
      daysOfWeek: cadence === "WEEKLY" ? strongest.daysOfWeek : [],
      items: [...chosen].sort((a, b) => b.timesBought - a.timesBought),
    };
    if (!best || candidate.items.length > best.items.length) best = candidate;
  }
  return best;
}

// ─── Substitution ─────────────────────────────────────────────────────────────

/** How far a stand-in's price may stray from the original's (± this fraction). */
export const SUBSTITUTE_PRICE_BAND = 0.3;

/**
 * The best in-stock stand-in for `original` among `candidates` (already limited, by the caller's query, to
 * the same category and store). Same product type, enough stock for this quantity, price within ±30% of the
 * original; the closest price wins (cheaper on a tie). null = nothing suitable, so the item is skipped.
 */
export function pickSubstitute<V extends LiveVariant>(original: LiveVariant, quantity: number, candidates: V[]): V | null {
  const originalType = original.product.productType;
  const base = priceSubscriptionDelivery(original, 1).unitPrice;
  if (!(base > 0)) return null;

  let best: { v: V; diff: number; price: number } | null = null;
  for (const v of candidates) {
    if (!v.isActive || v.product.productType !== originalType) continue;
    const needed = isLooseType(v.product.productType) ? quantity * Number(v.packageSize) : quantity;
    if (Number(v.stock) + 1e-9 < needed) continue;
    const price = priceSubscriptionDelivery(v, 1).unitPrice;
    const diff = Math.abs(price - base);
    if (diff > base * SUBSTITUTE_PRICE_BAND + 1e-9) continue;
    if (!best || diff < best.diff - 1e-9 || (Math.abs(diff - best.diff) <= 1e-9 && price < best.price)) {
      best = { v, diff, price };
    }
  }
  return best?.v ?? null;
}

// ─── Price-change alert ───────────────────────────────────────────────────────

/** Smallest rise over the usual price worth interrupting someone for. */
export const ALERT_MIN_RISE = 10; // ₹
/** A lasting rise alerts again only if the total moved this much since the last alert. */
export const ALERT_MIN_MOVE = 5; // ₹

/**
 * Decide the price push for a run that was ORDERED within the ceiling.
 *  • "alert" — total is ≥ ₹10 above the usual and either never alerted, or has moved ≥ ₹5 since.
 *  • "reset" — total is back to/below usual: forget the last alert so the next rise alerts again.
 *  • "none"  — nothing to say (small rise, or the same elevated price we already told them about).
 */
export function shouldAlertPriceChange(drift: number, total: number, lastAlertedTotal: number | null): "alert" | "reset" | "none" {
  if (drift <= 0) return lastAlertedTotal == null ? "none" : "reset";
  if (drift < ALERT_MIN_RISE) return "none";
  if (lastAlertedTotal == null || Math.abs(total - lastAlertedTotal) >= ALERT_MIN_MOVE) return "alert";
  return "none";
}
