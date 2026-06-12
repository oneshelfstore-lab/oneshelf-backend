/**
 * Loyalty tiers — code-defined defaults (owner-tunable config UI is a later phase).
 *
 * Tier is the rolling-365-day SUM of a customer's DELIVERED/non-cancelled order totals.
 * Spend-based (not order COUNT) so it can't be gamed by splitting one cart into many tiny
 * orders. Perks here are the ones actually ENFORCED server-side in Phase 2:
 *   - freeDelivery: waived in calculateCartTotals
 *   - discountPct:  standing member discount on the cart, applied in calculateCartTotals
 * (Tier-up hampers are Phase 4 — deliberately NOT listed as a perk until they're real.)
 */
export interface LoyaltyTier {
  key: string;
  name: string;
  minSpend: number;
  freeDelivery: boolean;
  discountPct: number;
  perks: string[];
}

export const LOYALTY_TIERS: LoyaltyTier[] = [
  { key: "bronze", name: "Bronze", minSpend: 0, freeDelivery: false, discountPct: 0, perks: ["You're earning rewards on every order"] },
  { key: "silver", name: "Silver", minSpend: 2000, freeDelivery: true, discountPct: 0, perks: ["Free delivery on every order"] },
  { key: "gold", name: "Gold", minSpend: 6000, freeDelivery: true, discountPct: 3, perks: ["Free delivery on every order", "3% member discount, always"] },
  { key: "platinum", name: "Platinum", minSpend: 15000, freeDelivery: true, discountPct: 5, perks: ["Free delivery on every order", "5% member discount, always"] },
];

/** Highest tier whose threshold the spend meets. */
export function tierForSpend(spend: number): LoyaltyTier {
  let current = LOYALTY_TIERS[0]!;
  for (const t of LOYALTY_TIERS) if (spend >= t.minSpend) current = t;
  return current;
}

/** The next tier above the current spend, or null if already at the top. */
export function nextTier(spend: number): LoyaltyTier | null {
  return LOYALTY_TIERS.find((t) => t.minSpend > spend) ?? null;
}
