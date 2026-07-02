/**
 * Loyalty tiers — the code-defined DEFAULT ladder + the validation schema for the owner-tunable
 * override stored in `StoreConfig.loyaltyConfig` (see loyalty.ts `resolveLoyaltyConfig`).
 *
 * Tier is the rolling-window SUM of a customer's non-cancelled order totals. Spend-based (not order
 * COUNT) so it can't be gamed by splitting one cart into many tiny orders. Perks here are the ones
 * actually ENFORCED server-side in `calculateCartTotals`:
 *   - freeDelivery: waived in calculateCartTotals
 *   - discountPct:  standing member discount on the cart, applied in calculateCartTotals
 * Perk STRINGS are DERIVED from those two toggles (`derivePerks`), never free-typed — so the
 * customer-facing card can only ever promise what the server actually gives (honesty by construction).
 * (Tier-up hampers are a later phase — deliberately NOT a perk until they're a real fulfillment loop.)
 */
import { z } from "zod";

export interface LoyaltyTier {
  key: string;
  name: string;
  minSpend: number;
  freeDelivery: boolean;
  discountPct: number;
  perks: string[];
}

export interface LoyaltyConfig {
  enabled: boolean;
  windowDays: number;
  tiers: LoyaltyTier[];
}

export const LOYALTY_TIERS: LoyaltyTier[] = [
  { key: "bronze", name: "Bronze", minSpend: 0, freeDelivery: false, discountPct: 0, perks: ["You're earning rewards on every order"] },
  { key: "silver", name: "Silver", minSpend: 2000, freeDelivery: true, discountPct: 0, perks: ["Free delivery on every order"] },
  { key: "gold", name: "Gold", minSpend: 6000, freeDelivery: true, discountPct: 3, perks: ["Free delivery on every order", "3% member discount, always"] },
  { key: "platinum", name: "Platinum", minSpend: 15000, freeDelivery: true, discountPct: 5, perks: ["Free delivery on every order", "5% member discount, always"] },
];

/** The default program used whenever no valid `StoreConfig.loyaltyConfig` is set. */
export const DEFAULT_LOYALTY_CONFIG: LoyaltyConfig = {
  enabled: true,
  windowDays: 365,
  tiers: LOYALTY_TIERS,
};

// ─── Safety rails the owner cannot cross, even through the API ───────────
export const MAX_DISCOUNT_PCT = 15; // hard cap on any tier's standing member discount
export const MAX_TIERS = 6;

/** Perks are derived from the enforced toggles — the owner never types marketing copy the server
 *  doesn't back. Keeps the customer-facing tier card honest no matter what the owner sets. */
export function derivePerks(t: { freeDelivery: boolean; discountPct: number }): string[] {
  const perks: string[] = [];
  if (t.freeDelivery) perks.push("Free delivery on every order");
  if (t.discountPct > 0) perks.push(`${t.discountPct % 1 === 0 ? t.discountPct : t.discountPct.toFixed(1)}% member discount, always`);
  if (perks.length === 0) perks.push("You're earning rewards on every order");
  return perks;
}

// ─── Zod schema for the owner override (validated on write AND read) ─────
export const loyaltyTierInputSchema = z.object({
  key: z.string().trim().min(1).max(24).regex(/^[a-z0-9_]+$/, "key must be a lowercase slug (a-z, 0-9, _)"),
  name: z.string().trim().min(1).max(24),
  minSpend: z.number().int().min(0).max(10_000_000),
  freeDelivery: z.boolean(),
  discountPct: z.number().min(0).max(MAX_DISCOUNT_PCT),
  // Ignored on input — perks are always derived. Accepted so a full config round-trips cleanly.
  perks: z.array(z.string()).optional(),
});

export const loyaltyConfigSchema = z
  .object({
    enabled: z.boolean(),
    windowDays: z.number().int().min(30).max(1095).default(365),
    tiers: z.array(loyaltyTierInputSchema).min(1).max(MAX_TIERS),
  })
  .superRefine((cfg, ctx) => {
    const keys = new Set<string>();
    let prev = -1;
    cfg.tiers.forEach((t, i) => {
      if (keys.has(t.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate tier key "${t.key}"`, path: ["tiers", i, "key"] });
      }
      keys.add(t.key);
      if (t.minSpend <= prev) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each tier's spend must be higher than the one before it", path: ["tiers", i, "minSpend"] });
      }
      prev = t.minSpend;
    });
    if (cfg.tiers[0] && cfg.tiers[0].minSpend !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The first (base) tier must start at ₹0", path: ["tiers", 0, "minSpend"] });
    }
  });

export type LoyaltyConfigInput = z.infer<typeof loyaltyConfigSchema>;

/** Turn a validated input into the canonical config (perks always freshly derived). */
export function normalizeLoyaltyConfig(input: LoyaltyConfigInput): LoyaltyConfig {
  return {
    enabled: input.enabled,
    windowDays: input.windowDays,
    tiers: input.tiers.map((t) => ({
      key: t.key,
      name: t.name,
      minSpend: t.minSpend,
      freeDelivery: t.freeDelivery,
      discountPct: t.discountPct,
      perks: derivePerks(t),
    })),
  };
}

/** Highest tier whose threshold the spend meets, within the given ladder. */
export function tierForSpend(spend: number, tiers: LoyaltyTier[] = LOYALTY_TIERS): LoyaltyTier {
  let current = tiers[0]!;
  for (const t of tiers) if (spend >= t.minSpend) current = t;
  return current;
}

/** The next tier above the current spend, or null if already at the top. */
export function nextTier(spend: number, tiers: LoyaltyTier[] = LOYALTY_TIERS): LoyaltyTier | null {
  return tiers.find((t) => t.minSpend > spend) ?? null;
}
