import prisma from "../lib/prisma.js";
import { LOYALTY_TIERS, tierForSpend, nextTier, type LoyaltyTier } from "../data/loyaltyTiers.js";

/**
 * Rolling-365-day spend = SUM of the customer's non-cancelled order totals. Aggregate
 * (not a stored counter) so it's always correct and needs no reset/decrement bookkeeping.
 */
export async function getUserSpend365(userId: string): Promise<number> {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const agg = await prisma.order.aggregate({
    _sum: { totalAmount: true },
    where: {
      customerId: userId,
      status: { not: "CANCELLED" },
      createdAt: { gte: start },
      // Subscription (MONTHLY) orders are deferred/unpaid khata — they do NOT count toward loyalty
      // tier spend (would otherwise push customers to Platinum on uncollected money). Decision D5.
      paymentMethod: { not: "MONTHLY" },
    },
  });
  return Number(agg._sum.totalAmount ?? 0);
}

/** Lightweight tier lookup for the pricing hot path (one aggregate query). */
export async function getUserTier(userId: string): Promise<LoyaltyTier> {
  return tierForSpend(await getUserSpend365(userId));
}

export interface LoyaltyInfo {
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

/** Full loyalty payload for the profile tier card. */
export async function computeUserLoyalty(userId: string): Promise<LoyaltyInfo> {
  const spend = await getUserSpend365(userId);
  const tier = tierForSpend(spend);
  const next = nextTier(spend);

  const bandLow = tier.minSpend;
  const bandHigh = next ? next.minSpend : tier.minSpend;
  const progress = next && bandHigh > bandLow
    ? Math.min(1, Math.max(0, (spend - bandLow) / (bandHigh - bandLow)))
    : 1;

  return {
    tierKey: tier.key,
    tierName: tier.name,
    spend365: spend,
    freeDelivery: tier.freeDelivery,
    discountPct: tier.discountPct,
    perks: tier.perks,
    nextTierName: next?.name ?? null,
    amountToNext: next ? Math.max(0, next.minSpend - spend) : 0,
    progress,
    allTiers: LOYALTY_TIERS.map((t) => ({ key: t.key, name: t.name, minSpend: t.minSpend })),
  };
}
