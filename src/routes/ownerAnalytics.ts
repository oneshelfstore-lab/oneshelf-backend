import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError } from "../lib/errors.js";
import { memoCache } from "../lib/httpCache.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Platform analytics for the admin console. Mounted at /api/app/owner/analytics (Firebase auth + OWNER).
// A single consolidated snapshot — revenue, order counts, commission earned, top sellers. (The full
// GST/sales reports live in routes/reports.ts behind dashboard JWT auth; the app can't reach those.)
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

const ACTIVE_STATUSES = ["PLACED", "CONFIRMED", "PACKED", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP"] as const;

router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalSellers,
      todayOrders,
      pendingOrders,
      todayRevenueAgg,
      revenue30Agg,
      commissionAgg,
      topSellersRaw,
      last30Orders,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.seller.count({ where: { isHouse: false, status: "APPROVED" } }),
      prisma.order.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.order.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: { status: "DELIVERED", createdAt: { gte: startOfToday } },
      }),
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: { status: "DELIVERED", createdAt: { gte: start30 } },
      }),
      // Commission the platform has accrued across all sub-orders (house = 0, so this is real-seller cut).
      prisma.subOrder.aggregate({ _sum: { commissionAmount: true } }),
      // Top sellers by gross merchandise value.
      prisma.subOrder.groupBy({
        by: ["sellerId"],
        _sum: { subtotal: true },
        orderBy: { _sum: { subtotal: "desc" } },
        take: 5,
      }),
      prisma.order.count({ where: { createdAt: { gte: start30 } } }),
    ]);

    const sellerIds = topSellersRaw.map((t) => t.sellerId);
    const sellers = await prisma.seller.findMany({
      where: { id: { in: sellerIds } },
      select: { id: true, name: true, isHouse: true },
    });
    const byId = new Map(sellers.map((s) => [s.id, s]));
    const topSellers = topSellersRaw.map((t) => ({
      sellerId: t.sellerId,
      name: byId.get(t.sellerId)?.name ?? "—",
      isHouse: byId.get(t.sellerId)?.isHouse ?? false,
      gross: Number(t._sum.subtotal ?? 0),
    }));

    res.json({
      success: true,
      data: {
        totalUsers,
        totalSellers,
        todayOrders,
        todayRevenue: Number(todayRevenueAgg._sum.totalAmount ?? 0),
        revenue30: Number(revenue30Agg._sum.totalAmount ?? 0),
        pendingOrders,
        last30Orders,
        commissionEarned: Number(commissionAgg._sum.commissionAmount ?? 0),
        topSellers,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Catalog health (Analytics revamp, Phase 1) ─────────────────────────────
// Ranked best/worst-mover lists + category revenue/margin + basket affinity, all derived from
// existing order data — no new tracking, no schema change. Every sub-metric shares one `since`
// window driven by `?range=`. Memoized 5 min per range: this fires ~6 groupBy/findMany queries
// together, and the Analytics tab is the only caller, but a tab reopen or a range-selector tap
// shouldn't re-hit Postgres every time on the single Render instance.

const RANGE_DAYS: Record<string, number> = { week: 7, month: 30, quarter: 90 };
const CATALOG_HEALTH_TTL_MS = 5 * 60 * 1000;
const VALID_RANGES = ["today", "week", "month", "quarter"];

// IST = UTC+5:30. Every timestamp in this schema is stored as naive UTC wall-clock (see the
// peak-hours query below), and this process runs in UTC on Render — so a plain
// `new Date(now.getFullYear(), now.getMonth(), now.getDate())` builds UTC midnight, not IST
// midnight, and "Today" would start up to 5.5h late/early. Fix: shift `now` forward by the IST
// offset to read off today's IST calendar date via the UTC getters (process-timezone-independent),
// then subtract the offset back off to get the real UTC instant of IST midnight.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istMidnightUtc(now: Date): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStartShifted - IST_OFFSET_MS);
}

function rangeSince(range: string): Date {
  const now = new Date();
  if (range === "today") return istMidnightUtc(now);
  const days = RANGE_DAYS[range] ?? RANGE_DAYS.month;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Generic ranked-row shape — matches the Android RankedBarChart's RankedItem 1:1. */
interface RankedRow {
  id: string;
  label: string;
  value: number;
  displayValue: string;
  sublabel?: string;
  /** Optional 7-day daily-units-sold history, oldest→newest. Only populated where attached below. */
  sparkline?: number[];
}

function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

const SPARKLINE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 7-day daily units-sold history per product, IST-day-bucketed, for exactly the product ids asked
 * for (Best Sellers + Dead Stock rows only — computing this for every product would be wasteful;
 * scoping to what's actually about to be rendered keeps it cheap). Returns oldest→newest arrays,
 * missing days filled with 0 (a real 0-sale day, not absence of data).
 */
async function buildProductSparklines(
  relevantProductIds: Set<string>,
  variantToProductId: Map<string, string>,
): Promise<Map<string, number[]>> {
  const byProduct = new Map<string, number[]>();
  if (relevantProductIds.size === 0) return byProduct;
  for (const id of relevantProductIds) byProduct.set(id, new Array(SPARKLINE_DAYS).fill(0));

  const since = new Date(Date.now() - SPARKLINE_DAYS * DAY_MS);
  // Not filtered to specific variants in SQL (would need a dynamic IN-list) — 7 days of a single
  // store's order items is a small scan, and the JS-side filter below only keeps rows for the
  // products we actually asked about.
  const rows = await prisma.$queryRaw<Array<{ variantId: string | null; day: Date; units: number | null }>>`
    SELECT oi."variantId" as "variantId",
           date_trunc('day', o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as day,
           SUM(oi.quantity)::float as units
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE oi."variantId" IS NOT NULL AND o.status != 'CANCELLED' AND o."createdAt" >= ${since}
    GROUP BY oi."variantId", day`;

  const todayShiftedDayStart = Math.floor((Date.now() + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
  for (const r of rows) {
    if (!r.variantId) continue;
    const productId = variantToProductId.get(r.variantId);
    if (!productId || !byProduct.has(productId)) continue;
    const dayShiftedMs = new Date(r.day).getTime();
    const daysAgo = Math.round((todayShiftedDayStart - dayShiftedMs) / DAY_MS);
    const indexFromOldest = SPARKLINE_DAYS - 1 - daysAgo;
    if (indexFromOldest < 0 || indexFromOldest >= SPARKLINE_DAYS) continue;
    byProduct.get(productId)![indexFromOldest] += Number(r.units ?? 0);
  }
  return byProduct;
}

async function buildCatalogHealth(range: string) {
  const since = rangeSince(range);

  const [revenueByVariant, unitsByVariant, activeProducts] = await Promise.all([
    // Realized revenue — DELIVERED only, same convention as todayRevenue/revenue30 above.
    prisma.orderItem.groupBy({
      by: ["variantId"],
      _sum: { lineTotal: true },
      where: { variantId: { not: null }, order: { status: "DELIVERED", createdAt: { gte: since } } },
    }),
    // Demand/units — placed-or-later, excludes cancelled (mirrors /products/trending-products).
    prisma.orderItem.groupBy({
      by: ["variantId"],
      _sum: { quantity: true },
      where: { variantId: { not: null }, order: { status: { not: "CANCELLED" }, createdAt: { gte: since } } },
    }),
    prisma.catalogProduct.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        createdAt: true,
        categoryId: true,
        category: { select: { name: true } },
        variants: {
          where: { isActive: true },
          select: { id: true, stock: true, costPrice: true, sellingPrice: true },
        },
      },
    }),
  ]);

  const revenueByVariantMap = new Map<string, number>(
    revenueByVariant.map((r) => [r.variantId as string, Number(r._sum.lineTotal ?? 0)])
  );
  const unitsByVariantMap = new Map<string, number>(
    unitsByVariant.map((r) => [r.variantId as string, Number(r._sum.quantity ?? 0)])
  );

  // Roll variant-level revenue/units/stock up to their parent product.
  interface ProductAgg {
    id: string;
    name: string;
    categoryId: string;
    categoryName: string;
    revenue: number;
    units: number;
    stock: number;
    stockValue: number;
    costKnownRevenue: number;
    costKnownCost: number;
    createdAt: Date;
  }
  const products: ProductAgg[] = [];
  const variantToProductId = new Map<string, string>();
  const productById = new Map<string, ProductAgg>();

  for (const p of activeProducts) {
    let revenue = 0, units = 0, stock = 0, stockValue = 0, costKnownRevenue = 0, costKnownCost = 0;
    for (const v of p.variants) {
      variantToProductId.set(v.id, p.id);
      const vRevenue = revenueByVariantMap.get(v.id) ?? 0;
      const vUnits = unitsByVariantMap.get(v.id) ?? 0;
      const vStock = Number(v.stock);
      revenue += vRevenue;
      units += vUnits;
      stock += vStock;
      stockValue += vStock * Number(v.sellingPrice);
      if (v.costPrice != null) {
        costKnownRevenue += vRevenue;
        costKnownCost += vUnits * Number(v.costPrice);
      }
    }
    const agg: ProductAgg = {
      id: p.id,
      name: p.name,
      categoryId: p.categoryId,
      categoryName: p.category.name,
      revenue, units, stock, stockValue, costKnownRevenue, costKnownCost,
      createdAt: p.createdAt,
    };
    products.push(agg);
    productById.set(p.id, agg);
  }

  // 1. Best sellers — top 8 by realized revenue.
  const bestSellers: RankedRow[] = products
    .filter((p) => p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: p.revenue,
      displayValue: rupees(p.revenue),
      sublabel: `${p.units} sold`,
    }));

  // 2. Dead stock — zero orders in the window, ranked by ₹ tied up (biggest opportunity first).
  const deadStock: RankedRow[] = products
    .filter((p) => p.units === 0 && p.stock > 0)
    .sort((a, b) => b.stockValue - a.stockValue)
    .slice(0, 10)
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: p.stockValue,
      displayValue: `${rupees(p.stockValue)} tied up`,
      sublabel: `${p.stock} in stock, 0 sold`,
    }));

  // 3. Restock priority — high units sold relative to what's left; about to run out.
  const restockPriority: RankedRow[] = products
    .filter((p) => p.units > 0 && p.stock > 0)
    .map((p) => ({ ...p, ratio: p.units / p.stock }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: p.ratio,
      displayValue: `${p.stock} left`,
      sublabel: `${p.units} sold this window`,
    }));

  // 4. Category revenue + margin. Margin only counts lines whose variant has costPrice set
  // (`hasFullCostData` tells the client whether that's ~all of the category's revenue or a
  // partial sample, so a category with no cost data entered doesn't silently show 0% margin).
  interface CategoryAgg { name: string; revenue: number; units: number; costKnownRevenue: number; costKnownCost: number }
  const byCategory = new Map<string, CategoryAgg>();
  for (const p of products) {
    const c = byCategory.get(p.categoryId) ?? {
      name: p.categoryName, revenue: 0, units: 0, costKnownRevenue: 0, costKnownCost: 0,
    };
    c.revenue += p.revenue;
    c.units += p.units;
    c.costKnownRevenue += p.costKnownRevenue;
    c.costKnownCost += p.costKnownCost;
    byCategory.set(p.categoryId, c);
  }
  const categoryBreakdown = [...byCategory.entries()]
    .filter(([, c]) => c.revenue > 0)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 8)
    .map(([categoryId, c]) => {
      const marginAmount = c.costKnownRevenue > 0 ? c.costKnownRevenue - c.costKnownCost : 0;
      const marginPct = c.costKnownRevenue > 0 ? (marginAmount / c.costKnownRevenue) * 100 : 0;
      return {
        categoryId,
        categoryName: c.name,
        revenue: c.revenue,
        unitsSold: c.units,
        marginAmount,
        marginPct,
        hasFullCostData: c.costKnownRevenue >= c.revenue * 0.99,
      };
    });

  // 5. New arrivals — active products launched within the window, and how they're doing so far.
  const newArrivals: RankedRow[] = products
    .filter((p) => p.createdAt >= since)
    .sort((a, b) => b.units - a.units)
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: p.units,
      displayValue: `${p.units} sold`,
      sublabel: `Added ${Math.max(0, Math.round((Date.now() - p.createdAt.getTime()) / 86_400_000))}d ago`,
    }));

  // 6. Basket affinity — products frequently bought in the same order. Orders with >15 distinct
  // products are skipped (a rare huge bulk order would otherwise flood the pair counts with noise).
  const orderItems = await prisma.orderItem.findMany({
    where: { variantId: { not: null }, order: { status: { not: "CANCELLED" }, createdAt: { gte: since } } },
    select: { orderId: true, variantId: true },
  });
  const productsByOrder = new Map<string, Set<string>>();
  for (const item of orderItems) {
    const pid = variantToProductId.get(item.variantId as string);
    if (!pid) continue;
    const set = productsByOrder.get(item.orderId) ?? new Set<string>();
    set.add(pid);
    productsByOrder.set(item.orderId, set);
  }
  const pairCounts = new Map<string, number>();
  for (const set of productsByOrder.values()) {
    if (set.size < 2 || set.size > 15) continue;
    const ids = [...set];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const basketPairs: RankedRow[] = [...pairCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => {
      const [aId, bId] = key.split("|");
      const aName = productById.get(aId)?.name ?? "—";
      const bName = productById.get(bId)?.name ?? "—";
      return {
        id: aId,
        label: `${aName} + ${bName}`,
        value: count,
        displayValue: `${count} orders`,
      };
    });

  // 7-day sparkline — only for the rows that will actually render one (Best Sellers + Dead Stock),
  // not the whole catalog. For Dead Stock this is the more useful read than the ranking value
  // alone: a declining-to-zero trend ("this recently died") reads very differently from a flat
  // zero the whole time ("this never sold"), and the sparkline is what shows the difference.
  const sparklineTargets = new Set([...bestSellers.map((r) => r.id), ...deadStock.map((r) => r.id)]);
  const sparklines = await buildProductSparklines(sparklineTargets, variantToProductId);
  for (const row of bestSellers) row.sparkline = sparklines.get(row.id);
  for (const row of deadStock) row.sparkline = sparklines.get(row.id);

  return { range, since: since.toISOString(), bestSellers, deadStock, restockPriority, categoryBreakdown, basketPairs, newArrivals };
}

router.get("/catalog", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const requested = String(req.query.range ?? "month");
    const range = VALID_RANGES.includes(requested) ? requested : "month";
    const data = await memoCache.get(`ownerCatalogHealth:${range}`, CATALOG_HEALTH_TTL_MS, () =>
      buildCatalogHealth(range)
    );
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Customer growth (Analytics revamp, Phase 2) ────────────────────────────
// AOV trend (real date_trunc bucketing — the one thing Phase 1 didn't need) + lifetime customer
// lifecycle segments + coupon/loyalty AOV impact. No schema change.

const CUSTOMER_GROWTH_TTL_MS = 5 * 60 * 1000;
// Segments are a lifetime snapshot ("as of today, how recently/how often has this customer
// ordered") — they don't bucket by the range selector the way revenue does, so they're cached
// under one fixed key instead of being recomputed per range.
const CUSTOMER_SEGMENTS_KEY = "ownerCustomerSegments";

interface AovBucketRow {
  bucket: Date;
  aov: number | null;
  orders: number | null;
}

function formatBucketLabel(d: Date): string {
  // Explicit timeZone: "UTC" — the values passed in already have the IST shift baked into their
  // wall-clock representation (see the callers), so formatting must read UTC calendar getters
  // regardless of what timezone the Node process itself happens to run in. Don't rely on Render
  // defaulting to UTC implicitly; say it outright.
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

// formatBucketLabel expects a value with the IST shift already "baked in" — that's what the raw-SQL
// AT TIME ZONE queries hand back after Node re-parses them as naive-UTC. A genuine raw `createdAt`
// instant (e.g. straight off the User table) needs that same shift applied first, or the label can
// read a calendar day off from the real IST date near a midnight boundary.
function formatIstDateLabel(d: Date): string {
  return formatBucketLabel(new Date(d.getTime() + IST_OFFSET_MS));
}

async function buildAovAndDiscountImpact(range: string) {
  const since = rangeSince(range);
  const bucketUnit: "day" | "week" = range === "today" || range === "week" ? "day" : "week";

  const [aovRows, discountAgg, noDiscountAgg, totalDiscountAgg] = await Promise.all([
    // Prisma's groupBy can't bucket by calendar day/week — this is the one query in the whole
    // Analytics revamp that needs raw SQL. bucketUnit is chosen from a 2-value whitelist above,
    // never taken directly from req.query, and is still passed as a bound param (not string-built).
    // IST-shifted before bucketing (see the peak-hours query + rangeSince for why every naive-UTC
    // "createdAt" needs this) — otherwise a "day" bucket groups by UTC calendar day, not IST.
    prisma.$queryRaw<AovBucketRow[]>`
      SELECT date_trunc(${bucketUnit}, "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as bucket,
             AVG("totalAmount")::float as aov,
             COUNT(*)::int as orders
      FROM "Order"
      WHERE status = 'DELIVERED' AND "createdAt" >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC`,
    prisma.order.aggregate({
      _avg: { totalAmount: true },
      _count: { _all: true },
      where: {
        status: "DELIVERED",
        createdAt: { gte: since },
        OR: [{ couponCode: { not: null } }, { loyaltyDiscount: { gt: 0 } }],
      },
    }),
    prisma.order.aggregate({
      _avg: { totalAmount: true },
      _count: { _all: true },
      where: { status: "DELIVERED", createdAt: { gte: since }, couponCode: null, loyaltyDiscount: 0 },
    }),
    prisma.order.aggregate({
      _sum: { discount: true },
      where: { status: "DELIVERED", createdAt: { gte: since } },
    }),
  ]);

  const aovTrend = aovRows.map((r) => ({
    label: formatBucketLabel(new Date(r.bucket)),
    value: Number(r.aov ?? 0),
    orders: Number(r.orders ?? 0),
  }));

  return {
    aovTrend,
    discountImpact: {
      aovWithDiscount: Number(discountAgg._avg.totalAmount ?? 0),
      aovWithoutDiscount: Number(noDiscountAgg._avg.totalAmount ?? 0),
      ordersWithDiscount: discountAgg._count._all,
      ordersWithoutDiscount: noDiscountAgg._count._all,
      totalDiscountGiven: Number(totalDiscountAgg._sum.discount ?? 0),
    },
  };
}

async function buildCustomerSegments() {
  // Every non-cancelled order, per customer: how many, how much, how recently.
  const perCustomer = await prisma.order.groupBy({
    by: ["customerId"],
    _count: { _all: true },
    _max: { createdAt: true },
    _sum: { totalAmount: true },
    where: { status: { not: "CANCELLED" } },
  });

  const now = Date.now();
  const buckets = {
    New: { count: 0, spend: 0 },
    Repeat: { count: 0, spend: 0 },
    "At risk": { count: 0, spend: 0 },
    Lapsed: { count: 0, spend: 0 },
  } as Record<string, { count: number; spend: number }>;

  let repeatCustomers = 0;
  for (const c of perCustomer) {
    const orderCount = c._count._all;
    const lastOrderAt = c._max.createdAt;
    if (!lastOrderAt) continue;
    const daysSinceLast = (now - lastOrderAt.getTime()) / 86_400_000;
    const spend = Number(c._sum.totalAmount ?? 0);
    if (orderCount >= 2) repeatCustomers++;

    const segment =
      daysSinceLast > 120 ? "Lapsed" :
      orderCount === 1 ? "New" :
      daysSinceLast <= 60 ? "Repeat" :
      "At risk";
    buckets[segment].count++;
    buckets[segment].spend += spend;
  }

  const totalCustomers = perCustomer.length;
  return {
    segments: Object.entries(buckets).map(([name, v]) => ({ name, count: v.count, spend: v.spend })),
    repeatPurchaseRatePct: totalCustomers > 0 ? (repeatCustomers / totalCustomers) * 100 : 0,
  };
}

// Cohort retention — signup-week cohorts × weeks-since-signup, % who placed ≥1 order that week.
// Range-independent (lifetime), cached under one fixed key like segments. Computed in JS (not raw
// SQL) — bounded dataset at kirana scale, same reasoning as the Phase 1 basket-affinity pairing.
// Only cohorts whose full tracked window has ALREADY elapsed are included — a cohort from 2 weeks
// ago simply doesn't appear yet rather than showing fabricated 0%s for weeks that haven't happened.
// That's why this can come back sparse or empty on a young store: honest, not a bug.
//
// ⚠️ Correctness note for future agents: the first draft of this function tried to reconstruct a
// calendar label from an epoch-anchored week INDEX (`new Date(cw * WEEK_MS)`), and used that same
// index arithmetic to compute week-offsets. Both were wrong and caught only by hand-tracing test
// cases in a standalone Node script before shipping — epoch-anchored 7-day buckets (Jan 1 1970 was
// a Thursday) don't align with any calendar week, so "cw*WEEK_MS" is NOT the date a human would
// associate with that bucket. Fixed by using `istWeekIndex` ONLY to group signups into a cohort
// (any consistent bucketing works for that), and switching week-offset + the label to plain
// elapsed-time-from-each-user's-own-signup arithmetic, which needs no timezone handling at all — a
// duration in milliseconds is the same duration regardless of timezone.
const COHORT_RETENTION_KEY = "ownerCohortRetention";
const COHORT_WEEKS = 8;
const OFFSET_WEEKS = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function istWeekIndex(d: Date): number {
  return Math.floor((d.getTime() + IST_OFFSET_MS) / WEEK_MS);
}

async function buildCohortRetention() {
  const lookbackWeeks = COHORT_WEEKS + OFFSET_WEEKS;
  const since = new Date(Date.now() - lookbackWeeks * WEEK_MS);

  const users = await prisma.user.findMany({
    where: { role: "CUSTOMER", createdAt: { gte: since } },
    select: { id: true, createdAt: true },
  });
  if (users.length === 0) return { cohortLabels: [], offsetLabels: [], grid: [], cohortSizes: [] };

  // Group signups into ~weekly cohorts (grouping only — any consistent bucket works, it doesn't
  // need to align to a calendar week boundary the way a *label* would).
  const signupById = new Map(users.map((u) => [u.id, u.createdAt]));
  const usersByCohort = new Map<number, string[]>();
  const earliestSignupInCohort = new Map<number, Date>();
  for (const u of users) {
    const cw = istWeekIndex(u.createdAt);
    const arr = usersByCohort.get(cw) ?? [];
    arr.push(u.id);
    usersByCohort.set(cw, arr);
    const earliest = earliestSignupInCohort.get(cw);
    if (!earliest || u.createdAt < earliest) earliestSignupInCohort.set(cw, u.createdAt);
  }

  const orders = await prisma.order.findMany({
    where: { customerId: { in: users.map((u) => u.id) }, status: { not: "CANCELLED" } },
    select: { customerId: true, createdAt: true },
  });
  const orderedOffsetsByUser = new Map<string, Set<number>>();
  for (const o of orders) {
    const signedUpAt = signupById.get(o.customerId);
    if (!signedUpAt) continue;
    // Elapsed time from THIS user's own signup — timezone-independent by construction.
    const offset = Math.floor((o.createdAt.getTime() - signedUpAt.getTime()) / WEEK_MS);
    if (offset < 0 || offset >= OFFSET_WEEKS) continue;
    const set = orderedOffsetsByUser.get(o.customerId) ?? new Set<number>();
    set.add(offset);
    orderedOffsetsByUser.set(o.customerId, set);
  }

  const nowMs = Date.now();
  const completeCohortWeeks = [...usersByCohort.keys()]
    .filter((cw) => {
      // Use the cohort's LATEST signup (not the bucket boundary) so every member's own
      // OFFSET_WEEKS window is genuinely complete, not just the earliest signer's.
      const cohortUserIds = usersByCohort.get(cw)!;
      const latestSignupMs = Math.max(...cohortUserIds.map((id) => signupById.get(id)!.getTime()));
      return latestSignupMs + OFFSET_WEEKS * WEEK_MS <= nowMs;
    })
    .sort((a, b) => a - b)
    .slice(-COHORT_WEEKS);

  const cohortLabels: string[] = [];
  const cohortSizes: number[] = [];
  const grid: number[][] = [];
  for (const cw of completeCohortWeeks) {
    const cohortUserIds = usersByCohort.get(cw)!;
    const size = cohortUserIds.length;
    cohortSizes.push(size);
    cohortLabels.push(formatIstDateLabel(earliestSignupInCohort.get(cw)!));
    const row: number[] = [];
    for (let offset = 0; offset < OFFSET_WEEKS; offset++) {
      const retained = cohortUserIds.filter((id) => orderedOffsetsByUser.get(id)?.has(offset)).length;
      row.push(size > 0 ? Math.round((retained / size) * 100) : 0);
    }
    grid.push(row);
  }

  return {
    cohortLabels,
    offsetLabels: Array.from({ length: OFFSET_WEEKS }, (_, i) => `Wk ${i}`),
    grid,
    cohortSizes,
  };
}

// Cart abandonment — a LIVE snapshot, not a windowed rate. CartItem only holds CURRENT cart state
// (no event log of past abandon/recover/checkout), so a true "abandonment rate over the last N
// days" isn't honestly computable here — this mirrors services/abandonedCart.ts's own idle +
// no-recent-order logic (same IDLE_HOURS, same OOS-line exclusion) and reports "right now."
const CART_ABANDONMENT_KEY = "ownerCartAbandonment";
const CART_IDLE_HOURS = 4;

async function buildCartAbandonment() {
  const idleCutoff = new Date(Date.now() - CART_IDLE_HOURS * 60 * 60 * 1000);

  const items = await prisma.cartItem.findMany({
    where: { savedForLater: false },
    select: {
      userId: true,
      quantity: true,
      updatedAt: true,
      variant: { select: { sellingPrice: true, stock: true } },
    },
  });

  interface CartAgg { value: number; lastTouch: Date }
  const byUser = new Map<string, CartAgg>();
  for (const ci of items) {
    if (Number(ci.variant.stock) <= 0) continue;
    const value = Number(ci.quantity) * Number(ci.variant.sellingPrice);
    const cur = byUser.get(ci.userId) ?? { value: 0, lastTouch: ci.updatedAt };
    cur.value += value;
    if (ci.updatedAt > cur.lastTouch) cur.lastTouch = ci.updatedAt;
    byUser.set(ci.userId, cur);
  }

  const totalActiveCarts = byUser.size;
  const idleUserIds = [...byUser.entries()]
    .filter(([, v]) => v.lastTouch < idleCutoff)
    .map(([id]) => id);

  const recentOrders = idleUserIds.length > 0
    ? await prisma.order.groupBy({
        by: ["customerId"],
        _max: { createdAt: true },
        where: { customerId: { in: idleUserIds } },
      })
    : [];
  const lastOrderByUser = new Map(recentOrders.map((o) => [o.customerId, o._max.createdAt]));

  let abandonedCount = 0;
  let abandonedValue = 0;
  for (const userId of idleUserIds) {
    const cart = byUser.get(userId)!;
    const lastOrder = lastOrderByUser.get(userId);
    if (lastOrder && lastOrder > cart.lastTouch) continue; // ordered since going idle — not abandoned
    abandonedCount++;
    abandonedValue += cart.value;
  }

  return {
    totalActiveCarts,
    abandonedCount,
    abandonedValue,
    abandonedRatePct: totalActiveCarts > 0 ? (abandonedCount / totalActiveCarts) * 100 : 0,
  };
}

router.get("/customers", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const requested = String(req.query.range ?? "month");
    const range = VALID_RANGES.includes(requested) ? requested : "month";
    const [
      { aovTrend, discountImpact },
      { segments, repeatPurchaseRatePct },
      cohortRetention,
      cartAbandonment,
    ] = await Promise.all([
      memoCache.get(`ownerAovDiscount:${range}`, CUSTOMER_GROWTH_TTL_MS, () => buildAovAndDiscountImpact(range)),
      memoCache.get(CUSTOMER_SEGMENTS_KEY, CUSTOMER_GROWTH_TTL_MS, buildCustomerSegments),
      memoCache.get(COHORT_RETENTION_KEY, CUSTOMER_GROWTH_TTL_MS, buildCohortRetention),
      memoCache.get(CART_ABANDONMENT_KEY, CUSTOMER_GROWTH_TTL_MS, buildCartAbandonment),
    ]);
    res.json({
      success: true,
      data: {
        range, since: rangeSince(range).toISOString(), aovTrend, discountImpact, segments,
        repeatPurchaseRatePct, cohortRetention, cartAbandonment,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Operations (Analytics revamp, Phase 3) ─────────────────────────────────
// Delivery SLA per agent, peak-hour demand (weekday × 3-hour block — the first real use of the
// Android HeatmapGrid), and a seller scorecard (GMV/cancellation rate/pack time). No schema change
// — `SubOrder.packedAt`/`collectedAt` and `Order.deliveredAt` already existed, just unused for this.

const OPERATIONS_TTL_MS = 5 * 60 * 1000;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Block label = the block's start hour. 8 blocks × 3h covers the day without a 24-column heatmap.
const HOUR_BLOCK_LABELS = ["12am", "3am", "6am", "9am", "12pm", "3pm", "6pm", "9pm"];

interface PeakHourRow {
  dow: number;
  hour: number;
  orders: number;
}

async function buildOperations(range: string) {
  const since = rangeSince(range);

  const [deliveredOrders, peakRows, subOrders] = await Promise.all([
    prisma.order.findMany({
      where: {
        status: "DELIVERED",
        deliveredAt: { not: null },
        deliveryBoyId: { not: null },
        createdAt: { gte: since },
      },
      select: { deliveryBoyId: true, createdAt: true, deliveredAt: true },
    }),
    // DateTime columns are stored as naive `timestamp` (no tz) holding UTC wall-clock — the double
    // AT TIME ZONE converts UTC → IST before extracting day-of-week/hour, so "peak hours" reflects
    // when the store's actual customers are awake, not UTC midnight.
    prisma.$queryRaw<PeakHourRow[]>`
      SELECT EXTRACT(DOW FROM "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::int as dow,
             EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::int as hour,
             COUNT(*)::int as orders
      FROM "Order"
      WHERE "createdAt" >= ${since} AND status != 'CANCELLED'
      GROUP BY dow, hour`,
    prisma.subOrder.findMany({
      where: { createdAt: { gte: since } },
      select: { sellerId: true, status: true, subtotal: true, packedAt: true, createdAt: true },
    }),
  ]);

  // Delivery SLA — placed→delivered, per agent. Ranked slowest-first (like Dead Stock/Restock
  // Priority elsewhere in this file: the biggest bar is the one that needs attention).
  const byAgent = new Map<string, { totalMinutes: number; count: number }>();
  let overallTotalMinutes = 0;
  for (const o of deliveredOrders) {
    const minutes = (o.deliveredAt!.getTime() - o.createdAt.getTime()) / 60_000;
    overallTotalMinutes += minutes;
    const cur = byAgent.get(o.deliveryBoyId as string) ?? { totalMinutes: 0, count: 0 };
    cur.totalMinutes += minutes;
    cur.count += 1;
    byAgent.set(o.deliveryBoyId as string, cur);
  }
  const agentIds = [...byAgent.keys()];
  const agents = agentIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
    : [];
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const deliveryAgents: RankedRow[] = [...byAgent.entries()]
    .map(([id, v]) => ({ id, avgMinutes: v.totalMinutes / v.count, count: v.count }))
    .sort((a, b) => b.avgMinutes - a.avgMinutes)
    .slice(0, 10)
    .map((a) => ({
      id: a.id,
      label: agentNameById.get(a.id) ?? "—",
      value: Math.round(a.avgMinutes),
      displayValue: `${Math.round(a.avgMinutes)} min avg`,
      sublabel: `${a.count} delivered`,
    }));
  const overallAvgDeliveryMinutes = deliveredOrders.length > 0 ? overallTotalMinutes / deliveredOrders.length : 0;

  // Peak-hour demand grid — 7 weekdays × 8 three-hour blocks.
  const grid: number[][] = WEEKDAY_LABELS.map(() => new Array(HOUR_BLOCK_LABELS.length).fill(0));
  for (const row of peakRows) {
    const dow = Number(row.dow);
    const blockIndex = Math.min(HOUR_BLOCK_LABELS.length - 1, Math.floor(Number(row.hour) / 3));
    if (dow >= 0 && dow <= 6) grid[dow][blockIndex] += Number(row.orders);
  }

  // Seller scorecard — GMV, cancellation rate, avg pack time (house sub-orders included, so a
  // single-store owner still gets their own fulfillment-speed signal, not just external sellers).
  interface SellerAgg { gmv: number; total: number; cancelled: number; packMinutesSum: number; packedCount: number }
  const bySeller = new Map<string, SellerAgg>();
  for (const so of subOrders) {
    const cur: SellerAgg = bySeller.get(so.sellerId) ?? { gmv: 0, total: 0, cancelled: 0, packMinutesSum: 0, packedCount: 0 };
    cur.total += 1;
    if (so.status === "CANCELLED") {
      cur.cancelled += 1;
    } else {
      cur.gmv += Number(so.subtotal);
    }
    if (so.packedAt) {
      cur.packMinutesSum += (so.packedAt.getTime() - so.createdAt.getTime()) / 60_000;
      cur.packedCount += 1;
    }
    bySeller.set(so.sellerId, cur);
  }
  const sellerIds = [...bySeller.keys()];
  const sellerRows = sellerIds.length > 0
    ? await prisma.seller.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true, isHouse: true } })
    : [];
  const sellerById = new Map(sellerRows.map((s) => [s.id, s]));
  const sellers: RankedRow[] = [...bySeller.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.gmv - a.gmv)
    .slice(0, 10)
    .map((s) => {
      const meta = sellerById.get(s.id);
      const cancelPct = s.total > 0 ? (s.cancelled / s.total) * 100 : 0;
      const avgPackMinutes = s.packedCount > 0 ? s.packMinutesSum / s.packedCount : null;
      return {
        id: s.id,
        label: (meta?.name ?? "—") + (meta?.isHouse ? " (house)" : ""),
        value: s.gmv,
        displayValue: rupees(s.gmv),
        sublabel: avgPackMinutes != null
          ? `${cancelPct.toFixed(0)}% cancelled · ${Math.round(avgPackMinutes)} min pack`
          : `${cancelPct.toFixed(0)}% cancelled`,
      };
    });

  return {
    range,
    since: since.toISOString(),
    overallAvgDeliveryMinutes: Math.round(overallAvgDeliveryMinutes),
    deliveryAgents,
    peakHours: { weekdayLabels: WEEKDAY_LABELS, blockLabels: HOUR_BLOCK_LABELS, grid },
    sellers,
  };
}

router.get("/operations", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const requested = String(req.query.range ?? "month");
    const range = VALID_RANGES.includes(requested) ? requested : "month";
    const data = await memoCache.get(`ownerOperations:${range}`, OPERATIONS_TTL_MS, () => buildOperations(range));
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Search insights (Analytics revamp, Phase 4) ────────────────────────────
// The one phase in this initiative with a schema change: NEW additive `SearchQuery` model, logged
// best-effort from `GET /api/app/products` in catalog.ts. Turns "we don't know what customers
// wanted but couldn't find" into a direct, actionable list — the #1 gap flagged back when this
// initiative was first scoped, since every other phase can only see what customers DID buy.

const SEARCH_INSIGHTS_TTL_MS = 5 * 60 * 1000;

// Generous cap on distinct exact-phrase terms folded into the word-frequency roll-up below —
// bounds query cost without truncating the roll-up at realistic single-store search volumes
// (a few hundred/thousand distinct terms per quarter, not tens of thousands).
const SEARCH_TERM_FOLD_LIMIT = 1000;

// Filler words that would otherwise pollute the top-10-by-word ranking without carrying any
// "what should I stock" signal.
const SEARCH_STOPWORDS = new Set(["of", "the", "and", "a", "an", "for", "in", "on", "with", "to"]);

/** Alphanumeric words (2+ chars, stopwords dropped) found in a normalized search term. */
function tokenizeSearchTerm(term: string): Set<string> {
  const words = term.match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => w.length >= 2 && !SEARCH_STOPWORDS.has(w)));
}

async function buildSearchInsights(range: string) {
  const since = rangeSince(range);
  const where = { createdAt: { gte: since } };

  const [totalSearches, zeroResultCount, topRaw, zeroRaw] = await Promise.all([
    prisma.searchQuery.count({ where }),
    prisma.searchQuery.count({ where: { ...where, resultCount: 0 } }),
    prisma.searchQuery.groupBy({
      by: ["term"],
      _count: { term: true },
      where,
      orderBy: { _count: { term: "desc" } },
      take: SEARCH_TERM_FOLD_LIMIT,
    }),
    prisma.searchQuery.groupBy({
      by: ["term"],
      _count: { term: true },
      where: { ...where, resultCount: 0 },
      orderBy: { _count: { term: "desc" } },
      take: SEARCH_TERM_FOLD_LIMIT,
    }),
  ]);

  // Word-frequency roll-up instead of exact-phrase: "milk", "amul milk", and "milk packet" used
  // to rank as 3 separate, individually-small rows even though they're the same underlying
  // demand signal. Each logged term's count is folded into EVERY word it contains (not split
  // fractionally across them — a search for "amul milk" is real evidence for both "amul" and
  // "milk"), then ranked by summed word count. Every distinct term up to SEARCH_TERM_FOLD_LIMIT
  // is folded in, not just the top 10 exact phrases, so a word spread across many low-count
  // phrasings still ranks correctly.
  const toWordRows = (rows: typeof topRaw, suffix: string): RankedRow[] => {
    const byWord = new Map<string, number>();
    for (const r of rows) {
      for (const word of tokenizeSearchTerm(r.term)) {
        byWord.set(word, (byWord.get(word) ?? 0) + r._count.term);
      }
    }
    return [...byWord.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word, count]) => ({
        id: word,
        label: word,
        value: count,
        displayValue: `${count}${suffix}`,
      }));
  };

  return {
    range,
    since: since.toISOString(),
    totalSearches,
    zeroResultRatePct: totalSearches > 0 ? (zeroResultCount / totalSearches) * 100 : 0,
    topSearches: toWordRows(topRaw, " searches"),
    zeroResultSearches: toWordRows(zeroRaw, "× · 0 results"),
  };
}

router.get("/search", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const requested = String(req.query.range ?? "month");
    const range = VALID_RANGES.includes(requested) ? requested : "month";
    const data = await memoCache.get(`ownerSearchInsights:${range}`, SEARCH_INSIGHTS_TTL_MS, () =>
      buildSearchInsights(range)
    );
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Overview trend (Analytics revamp, Phase 5) ─────────────────────────────
// Gives the top-of-page Overview section (still the pre-revamp flat snapshot cards) a real
// interactive chart: revenue over time (reuses the same date_trunc bucketing pattern Phase 2
// built for AOV) + revenue-by-payment-mode share — the first real use of DonutShareChart, which
// had no phase that needed a share-of-total breakdown until now.

const OVERVIEW_TREND_TTL_MS = 5 * 60 * 1000;

function prettifyEnumLabel(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function buildOverviewTrend(range: string) {
  const since = rangeSince(range);
  const bucketUnit: "day" | "week" = range === "today" || range === "week" ? "day" : "week";

  const [revenueRows, paymentModeAgg] = await Promise.all([
    // Same bucketing approach as the AOV trend in /customers — see that query's comment for why
    // this is the one raw-SQL shape the whole revamp needs (Prisma's groupBy can't bucket dates).
    // IST-shifted before bucketing, same as AOV trend and peak-hours (naive-UTC "createdAt").
    prisma.$queryRaw<Array<{ bucket: Date; revenue: number | null }>>`
      SELECT date_trunc(${bucketUnit}, "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as bucket,
             SUM("totalAmount")::float as revenue
      FROM "Order"
      WHERE status = 'DELIVERED' AND "createdAt" >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC`,
    prisma.order.groupBy({
      by: ["paymentMethod"],
      _sum: { totalAmount: true },
      where: { status: "DELIVERED", createdAt: { gte: since } },
    }),
  ]);

  const revenueTrend = revenueRows.map((r) => ({
    label: formatBucketLabel(new Date(r.bucket)),
    value: Number(r.revenue ?? 0),
  }));

  const paymentModeShare = paymentModeAgg
    .map((p) => ({ label: prettifyEnumLabel(p.paymentMethod), value: Number(p._sum.totalAmount ?? 0) }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value);

  return { range, since: since.toISOString(), revenueTrend, paymentModeShare };
}

router.get("/overview", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const requested = String(req.query.range ?? "month");
    const range = VALID_RANGES.includes(requested) ? requested : "month";
    const data = await memoCache.get(`ownerOverviewTrend:${range}`, OVERVIEW_TREND_TTL_MS, () =>
      buildOverviewTrend(range)
    );
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
