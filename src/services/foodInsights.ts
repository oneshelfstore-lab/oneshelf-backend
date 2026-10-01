// ─── Restaurant insights (FOOD_SELLER_PLAN.md F4) ────────────────────────────────────────────────
// Pure — no Prisma — so every rule is unit-testable. The route feeds it rows and renders the result.

const IST_OFFSET_MS = 330 * 60_000;

export interface InsightSub {
  id: string;
  status: string;
  createdAt: Date;
}
export interface InsightEvent {
  subOrderId: string | null;
  toState: string;
  createdAt: Date;
}

export interface KitchenStats {
  orders: number;
  /** Orders the restaurant took on: accepted at some point, whatever happened afterwards. */
  accepted: number;
  cancelled: number;
  /** cancelled ÷ orders, as a percentage; null with no orders. */
  cancellationRatePct: number | null;
  /** Mean ACCEPTED → PACKED ("food ready") minutes over orders that have both events; null with none. */
  avgPrepMinutes: number | null;
  /** How many orders each IST 3-hour block received: [0-3, 3-6, … 21-24). Always 8 long. */
  peakBlocks: number[];
}

/** An accept→ready gap outside this is a forgotten tap (left cooking overnight), not a prep time. */
const MAX_PLAUSIBLE_PREP_MIN = 240;

/**
 * ⚠️ "Cancelled" is deliberately NOT called "rejected": the order log can't tell a seller's reject from
 * a customer's own cancel, and a restaurant must not be shown a rejection rate that includes
 * customers changing their minds. Likewise there is no "acceptance rate" — same reason.
 */
export function kitchenStats(subs: InsightSub[], events: InsightEvent[]): KitchenStats {
  const peakBlocks = new Array<number>(8).fill(0);
  let accepted = 0;
  let cancelled = 0;

  for (const s of subs) {
    if (s.status === "ACCEPTED" || s.status === "PACKED" || s.status === "COLLECTED") accepted++;
    if (s.status === "CANCELLED") cancelled++;
    // Shift to IST, then read it off UTC getters — the process timezone must not matter.
    const istHour = new Date(s.createdAt.getTime() + IST_OFFSET_MS).getUTCHours();
    peakBlocks[Math.floor(istHour / 3)]++;
  }

  // First ACCEPTED and first PACKED per sub-order (an order can be re-accepted after a flap).
  const first = new Map<string, { accepted?: number; ready?: number }>();
  for (const e of events) {
    if (!e.subOrderId) continue;
    const slot = first.get(e.subOrderId) ?? {};
    const t = e.createdAt.getTime();
    if (e.toState === "ACCEPTED" && (slot.accepted === undefined || t < slot.accepted)) slot.accepted = t;
    if (e.toState === "PACKED" && (slot.ready === undefined || t < slot.ready)) slot.ready = t;
    first.set(e.subOrderId, slot);
  }
  const gaps: number[] = [];
  for (const { accepted: a, ready: r } of first.values()) {
    if (a === undefined || r === undefined || r <= a) continue;
    const mins = (r - a) / 60_000;
    if (mins <= MAX_PLAUSIBLE_PREP_MIN) gaps.push(mins);
  }

  return {
    orders: subs.length,
    accepted,
    cancelled,
    cancellationRatePct: subs.length > 0 ? Math.round((cancelled / subs.length) * 1000) / 10 : null,
    avgPrepMinutes: gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
    peakBlocks,
  };
}
