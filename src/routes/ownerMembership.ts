import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { memoCache } from "../lib/httpCache.js";
import {
  loyaltyConfigSchema,
  normalizeLoyaltyConfig,
  tierForSpend,
  type LoyaltyTier,
} from "../data/loyaltyTiers.js";
import { resolveLoyaltyConfig, bustLoyaltyConfig } from "../services/loyalty.js";

/**
 * Owner "Membership" management centre (Firebase-auth + OWNER). Mirrors the auth pattern of the other
 * owner routers (ownerBanner/ownerCoupons). Three things:
 *   GET  /               → the active tier config + a live cost/members dashboard
 *   PUT  /               → save a new tier config (zod-validated, perks derived, audit-logged)
 *   POST /simulate       → estimate what a candidate config would have cost over the last 90 days
 *
 * The config is the single lever for the store's standing member perks (free delivery + % discount),
 * which are enforced in `calculateCartTotals`. Everything is bounded by the zod safety rails
 * (≤6 tiers, discountPct ≤ 15, ascending minSpend) so the owner can never set a ruinous discount —
 * even through the raw API.
 */
export const ownerMembershipRouter = Router();
ownerMembershipRouter.use(firebaseAuthMiddleware as any);
ownerMembershipRouter.use(requireAppRole("OWNER") as any);

const DASHBOARD_KEY = "loyalty:dashboard";
const DASHBOARD_TTL_MS = 5 * 60 * 1000;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function monthStart(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Members-by-tier + this-month program cost. Cached 5 min (busted on save). All numbers are real
 * aggregates over live orders — no invented figures.
 */
async function computeDashboard() {
  const cfg = await resolveLoyaltyConfig();
  const baseKey = cfg.tiers[0]!.key; // everyone below the first real threshold sits here — not a "member"

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - cfg.windowDays);

  // Rolling-window spend per customer → bucket into tiers. One groupBy (bounded by #customers).
  const byCustomer = await prisma.order.groupBy({
    by: ["customerId"],
    _sum: { totalAmount: true },
    where: {
      status: { not: "CANCELLED" },
      paymentMethod: { not: "MONTHLY" },
      createdAt: { gte: windowStart },
    },
  });

  const tierCounts = new Map<string, number>(cfg.tiers.map((t) => [t.key, 0]));
  const memberIds: string[] = [];
  for (const row of byCustomer) {
    const spend = Number(row._sum.totalAmount ?? 0);
    const tier = tierForSpend(spend, cfg.tiers);
    tierCounts.set(tier.key, (tierCounts.get(tier.key) ?? 0) + 1);
    if (tier.key !== baseKey) memberIds.push(row.customerId);
  }

  // This month's program cost — direct from the snapshotted attribution columns (honest & immutable).
  const ms = monthStart();
  const costAgg = await prisma.order.aggregate({
    _sum: { loyaltyDiscount: true, tierDeliveryWaived: true },
    _count: true,
    where: {
      status: { not: "CANCELLED" },
      createdAt: { gte: ms },
      OR: [{ loyaltyDiscount: { gt: 0 } }, { tierDeliveryWaived: { gt: 0 } }],
    },
  });
  const loyaltyDiscountCost = round2(Number(costAgg._sum.loyaltyDiscount ?? 0));
  const deliveryWaivedCost = round2(Number(costAgg._sum.tierDeliveryWaived ?? 0));

  // This month's revenue from current members (tier applied as-of-now to the month's orders).
  const memberRevAgg = memberIds.length
    ? await prisma.order.aggregate({
        _sum: { totalAmount: true },
        _count: true,
        where: { status: { not: "CANCELLED" }, createdAt: { gte: ms }, customerId: { in: memberIds } },
      })
    : null;

  return {
    memberCount: memberIds.length,
    membersByTier: cfg.tiers.map((t) => ({
      key: t.key,
      name: t.name,
      minSpend: t.minSpend,
      count: tierCounts.get(t.key) ?? 0,
    })),
    costThisMonth: {
      loyaltyDiscount: loyaltyDiscountCost,
      deliveryWaived: deliveryWaivedCost,
      total: round2(loyaltyDiscountCost + deliveryWaivedCost),
      orderCount: costAgg._count,
    },
    memberRevenueThisMonth: round2(Number(memberRevAgg?._sum.totalAmount ?? 0)),
    memberOrdersThisMonth: memberRevAgg?._count ?? 0,
  };
}

// ─── GET /  — active config + dashboard ──────────────────────────────
ownerMembershipRouter.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const cfg = await resolveLoyaltyConfig();
    const dashboard = await memoCache.get(DASHBOARD_KEY, DASHBOARD_TTL_MS, computeDashboard);
    res.json({ success: true, data: { config: cfg, dashboard } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT /  — save the tier config ───────────────────────────────────
ownerMembershipRouter.put("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = loyaltyConfigSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid membership config", parsed.error.errors);
    const next = normalizeLoyaltyConfig(parsed.data);

    const config = await prisma.storeConfig.findFirst();
    if (!config) throw new NotFoundError("StoreConfig", "store");

    const before = config.loyaltyConfig ?? null;
    await prisma.storeConfig.update({
      where: { id: config.id },
      data: { loyaltyConfig: next as any },
    });

    // Config changes to live money → paper trail (before/after). Best-effort.
    await prisma.auditLog
      .create({
        data: {
          userId: req.appUser!.id,
          action: "UPDATE",
          entityType: "StoreConfig",
          entityId: config.id,
          oldValues: { loyaltyConfig: before } as any,
          newValues: { loyaltyConfig: next } as any,
        },
      })
      .catch((e) => console.warn("membership audit write failed (non-fatal):", e?.message));

    // Reflect the change server-instantly: drop the cached config + the tier-bucketed dashboard.
    bustLoyaltyConfig();
    memoCache.bust(DASHBOARD_KEY);

    res.json({ success: true, data: { config: next } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /simulate  — estimate a candidate config's cost over the last 90 days ──
ownerMembershipRouter.post("/simulate", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = loyaltyConfigSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid membership config", parsed.error.errors);
    const cfg = normalizeLoyaltyConfig(parsed.data);

    const PERIOD_DAYS = 90;
    if (!cfg.enabled) {
      // Program off ⇒ no cost. Still report the order/member counts so the owner has context.
      res.json({
        success: true,
        data: { periodDays: PERIOD_DAYS, estDiscountCost: 0, estDeliveryCost: 0, estTotalCost: 0, orderCount: 0, memberCount: 0 },
      });
      return;
    }

    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - cfg.windowDays);
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - PERIOD_DAYS);

    // Candidate tier per customer, from spend over the candidate window.
    const spendRows = await prisma.order.groupBy({
      by: ["customerId"],
      _sum: { totalAmount: true },
      where: { status: { not: "CANCELLED" }, paymentMethod: { not: "MONTHLY" }, createdAt: { gte: windowStart } },
    });
    const tierByCustomer = new Map<string, LoyaltyTier>();
    const memberIds = new Set<string>();
    const baseKey = cfg.tiers[0]!.key;
    for (const r of spendRows) {
      const t = tierForSpend(Number(r._sum.totalAmount ?? 0), cfg.tiers);
      tierByCustomer.set(r.customerId, t);
      if (t.key !== baseKey) memberIds.add(r.customerId);
    }

    // Replay the last 90 days' orders against those candidate tiers.
    const storeCfg = await prisma.storeConfig.findFirst({ select: { freeDeliveryAbove: true, deliveryCharge: true } });
    const freeDeliveryAbove = Number(storeCfg?.freeDeliveryAbove ?? 500);
    const standardDelivery = Number(storeCfg?.deliveryCharge ?? 30);

    const orders = await prisma.order.findMany({
      where: { status: { not: "CANCELLED" }, paymentMethod: { not: "MONTHLY" }, createdAt: { gte: periodStart } },
      select: { customerId: true, subtotal: true, fulfillmentType: true },
    });

    let discountCost = 0;
    let deliveryCost = 0;
    for (const o of orders) {
      const tier = tierByCustomer.get(o.customerId);
      if (!tier) continue;
      const sub = Number(o.subtotal);
      if (tier.discountPct > 0) discountCost += (sub * tier.discountPct) / 100;
      // The member free-delivery perk only "costs" when the order would otherwise have been charged
      // (a delivery order below the free-delivery threshold).
      if (tier.freeDelivery && o.fulfillmentType === "DELIVERY" && sub < freeDeliveryAbove) {
        deliveryCost += standardDelivery;
      }
    }

    res.json({
      success: true,
      data: {
        periodDays: PERIOD_DAYS,
        estDiscountCost: round2(discountCost),
        estDeliveryCost: round2(deliveryCost),
        estTotalCost: round2(discountCost + deliveryCost),
        orderCount: orders.length,
        memberCount: memberIds.size,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default ownerMembershipRouter;
