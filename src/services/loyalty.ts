import prisma from "../lib/prisma.js";
import { memoCache } from "../lib/httpCache.js";
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
}

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
  };
}
