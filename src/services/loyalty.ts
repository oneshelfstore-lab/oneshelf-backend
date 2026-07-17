import prisma from "../lib/prisma.js";
import { memoCache } from "../lib/httpCache.js";
import { notifyTierUp } from "./fcmNotifier.js";
import {
  DEFAULT_LOYALTY_CONFIG,
  loyaltyConfigSchema,
  normalizeLoyaltyConfig,
  tierForSpend,
  nextTier,
  type LoyaltyConfig,
  type LoyaltyTier,
} from "../data/loyaltyTiers.js";

// The 365-day spend aggregate runs on every /cart/quote (debounce-fired per cart edit) — the most
// per-keystroke-expensive query in the app on the single Render instance. Memoize it per user (busted
// on order place/cancel, so a tier change lags a cancellation by at most this TTL — irrelevant).
const SPEND_TTL_MS = 5 * 60 * 1000;
// The owner's tier config changes rarely; keep it hot but bust it the instant the owner saves.
const CONFIG_TTL_MS = 30 * 1000;

const SPEND_KEY = (userId: string) => `loyalty:spend:${userId}`;
const CONFIG_KEY = "loyalty:config";

/**
 * The active loyalty program: the owner's `StoreConfig.loyaltyConfig` when it's present and valid,
 * else the code-defined default ladder. An invalid stored value logs and falls back rather than ever
 * crashing the pricing path.
 */
export async function resolveLoyaltyConfig(): Promise<LoyaltyConfig> {
  return memoCache.get(CONFIG_KEY, CONFIG_TTL_MS, async () => {
    const cfg = await prisma.storeConfig.findFirst({ select: { loyaltyConfig: true } });
    const raw = cfg?.loyaltyConfig;
    if (raw != null) {
      const parsed = loyaltyConfigSchema.safeParse(raw);
      if (parsed.success) return normalizeLoyaltyConfig(parsed.data);
      console.error("Invalid StoreConfig.loyaltyConfig — falling back to defaults:", parsed.error.errors);
    }
    return DEFAULT_LOYALTY_CONFIG;
  });
}

/** Drop the cached config so an owner edit is reflected server-instantly. */
export function bustLoyaltyConfig(): void {
  memoCache.bust(CONFIG_KEY);
}

/** Drop a user's cached spend so a just-placed/cancelled order re-tiers them promptly. */
export function bustUserSpend(userId: string): void {
  memoCache.bust(SPEND_KEY(userId));
}

/**
 * Rolling-window spend = SUM of the customer's non-cancelled order totals over `windowDays`.
 * Aggregate (not a stored counter) so it's always correct and needs no reset/decrement bookkeeping.
 */
export async function getUserSpend365(userId: string): Promise<number> {
  return memoCache.get(SPEND_KEY(userId), SPEND_TTL_MS, async () => {
    const cfg = await resolveLoyaltyConfig();
    const start = new Date();
    start.setDate(start.getDate() - cfg.windowDays);
    const agg = await prisma.order.aggregate({
      _sum: { totalAmount: true },
      where: {
        customerId: userId,
        status: { not: "CANCELLED" },
        createdAt: { gte: start },
        // Subscription (MONTHLY) orders are deferred/unpaid khata — they do NOT count toward loyalty
        // tier spend (would otherwise push customers to the top tier on uncollected money). Decision D5.
        paymentMethod: { not: "MONTHLY" },
      },
    });
    return Number(agg._sum.totalAmount ?? 0);
  });
}

/** Lightweight tier lookup for the pricing hot path (config + one cached aggregate). */
export async function getUserTier(userId: string): Promise<LoyaltyTier> {
  const cfg = await resolveLoyaltyConfig();
  return tierForSpend(await getUserSpend365(userId), cfg.tiers);
}

export interface LoyaltyInfo {
  enabled: boolean;
  tierKey: string;
  tierName: string;
  spend365: number;
  freeDelivery: boolean;
  discountPct: number;
  perks: string[];
  nextTierName: string | null;
  amountToNext: number;
  progress: number; // 0..1 within the current tier band
  allTiers: { key: string; name: string; minSpend: number }[];
  // Honest, computed "you're about to slip a tier" line (or null). The rolling window means old
  // orders age out — this looks 30 days ahead and warns ONLY when enough of the current spend is
  // about to roll off that the customer would drop below their current tier's floor. No push
  // notification for this (loss-aversion pushes read as spammy) — surfaced on-screen only.
  slipWarning: string | null;
  // Fulfillment status of the customer's most recent tier-up hamper (Phase 4), or null if they've
  // never crossed into a hamper-eligible tier. PENDING = owner hasn't packed it yet.
  hamperStatus: "PENDING" | "PACKED" | "SENT" | null;
}

const SLIP_WARNING_HORIZON_DAYS = 30;

/** Full loyalty payload for the profile tier card. `enabled=false` ⇒ the app hides the card. */
export async function computeUserLoyalty(userId: string): Promise<LoyaltyInfo> {
  const cfg = await resolveLoyaltyConfig();
  const spend = await getUserSpend365(userId);
  const tier = tierForSpend(spend, cfg.tiers);
  const next = nextTier(spend, cfg.tiers);

  const bandLow = tier.minSpend;
  const bandHigh = next ? next.minSpend : tier.minSpend;
  const progress = next && bandHigh > bandLow
    ? Math.min(1, Math.max(0, (spend - bandLow) / (bandHigh - bandLow)))
    : 1;

  // Slip warning: only meaningful above the base (free) tier, and only a real risk — a bounded extra
  // aggregate over the slice of the window that will age out in the next 30 days, run only here (the
  // profile read), never on the /cart/quote hot path.
  let slipWarning: string | null = null;
  const isBaseTier = cfg.tiers[0]?.key === tier.key;
  if (cfg.enabled && !isBaseTier) {
    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setDate(windowStart.getDate() - cfg.windowDays);
    const windowStartIn30Days = new Date(now);
    windowStartIn30Days.setDate(windowStartIn30Days.getDate() - cfg.windowDays + SLIP_WARNING_HORIZON_DAYS);

    const atRiskAgg = await prisma.order.aggregate({
      _sum: { totalAmount: true },
      where: {
        customerId: userId,
        status: { not: "CANCELLED" },
        paymentMethod: { not: "MONTHLY" },
        createdAt: { gte: windowStart, lt: windowStartIn30Days },
      },
    });
    const atRiskSpend = Number(atRiskAgg._sum.totalAmount ?? 0);
    const projectedSpend = Math.max(0, spend - atRiskSpend);

    if (projectedSpend < tier.minSpend) {
      const amountNeeded = Math.round(tier.minSpend - projectedSpend);
      if (amountNeeded > 0) {
        slipWarning = `₹${amountNeeded} in orders in the next ${SLIP_WARNING_HORIZON_DAYS} days keeps your ${tier.name} benefits.`;
      }
    }
  }

  const latestHamper = await prisma.tierUpHamper.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });

  return {
    enabled: cfg.enabled,
    tierKey: tier.key,
    tierName: tier.name,
    spend365: spend,
    freeDelivery: tier.freeDelivery,
    discountPct: tier.discountPct,
    perks: tier.perks,
    nextTierName: next?.name ?? null,
    amountToNext: next ? Math.max(0, next.minSpend - spend) : 0,
    progress,
    allTiers: cfg.tiers.map((t) => ({ key: t.key, name: t.name, minSpend: t.minSpend })),
    slipWarning,
    hamperStatus: latestHamper?.status ?? null,
  };
}

/**
 * Tier-up push, checked at every DELIVERED transition (the only guaranteed-permanent moment — a
 * DELIVERED order can't later be cancelled in this codebase, unlike PLACED/CONFIRMED/etc.). Idempotent
 * via a guarded `lastNotifiedTier` flip on User, so two orders delivering concurrently can't double-fire
 * and re-observing the same tier is a no-op. Best-effort: never throws into the caller.
 */
export async function checkTierUpOnDelivery(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerId: true, paymentMethod: true },
  });
  // Khata (subscription) orders don't count toward tier spend — nothing to re-check.
  if (!order || order.paymentMethod === "MONTHLY") return;

  const cfg = await resolveLoyaltyConfig();
  if (!cfg.enabled || cfg.tiers.length === 0) return;

  const spend = await getUserSpend365(order.customerId);
  const tier = tierForSpend(spend, cfg.tiers);

  const user = await prisma.user.findUnique({
    where: { id: order.customerId },
    select: { lastNotifiedTier: true },
  });
  if (!user) return;
  if (user.lastNotifiedTier === tier.key) return; // no change since we last looked

  // First-ever observation for this user: record the baseline silently. Otherwise an already-Gold
  // customer would get a false "you leveled up!" push the first time any of their orders is delivered
  // after this feature ships.
  const previousTier = user.lastNotifiedTier;
  const flipped = await prisma.user.updateMany({
    where: { id: order.customerId, lastNotifiedTier: previousTier },
    data: { lastNotifiedTier: tier.key },
  });
  if (flipped.count === 0) return; // lost the race to a concurrent delivery — the other call handles it
  if (previousTier === null) return; // baseline recorded, no push

  const previousRank = cfg.tiers.findIndex((t) => t.key === previousTier);
  const newRank = cfg.tiers.findIndex((t) => t.key === tier.key);
  if (newRank <= previousRank) return; // a drop (or unknown tier) — never push for going down

  // A hamper-eligible tier gets a real fulfillment row alongside the push (best-effort — a hiccup
  // here must never fail the delivery transaction this is called from).
  if (tier.hamper) {
    await prisma.tierUpHamper
      .create({ data: { userId: order.customerId, tierKey: tier.key, tierName: tier.name } })
      .catch(() => {});
  }

  await notifyTierUp(order.customerId, tier.name, tier.hamper).catch(() => {});
}
