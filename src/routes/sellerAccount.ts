import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { memoCache } from "../lib/httpCache.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";

// Seller-scoped profile + earnings. Mounted at /api/app/seller/me.
//   GET  /            → shop profile
//   PUT  /            → update editable profile fields (NOT commission/status — admin-controlled)
//   GET  /earnings    → gross / commission / net, outstanding balance, payout history
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

function shapeProfile(s: any) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    logoUrl: s.logoUrl,
    shopAddress: s.shopAddress,
    city: s.city,
    pincode: s.pincode,
    lat: s.lat != null ? Number(s.lat) : null,
    lng: s.lng != null ? Number(s.lng) : null,
    phone: s.phone,
    gstin: s.gstin,
    pan: s.pan,
    bankDetails: s.bankDetails ?? null,
    commissionPct: Number(s.commissionPct),
    outstandingBalance: Number(s.outstandingBalance),
    status: s.status,
    isActive: s.isActive,
    // House manager (the store's own catalog) → the app shows the owner-level merchandising toggles
    // + a "goes live now" note in the product editor.
    isHouse: s.isHouse,
  };
}

// ─── GET / — shop profile ─────────────────────────────────────────
router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const seller = await prisma.seller.findUnique({ where: { id: req.sellerId } });
    if (!seller) throw new NotFoundError("Seller", req.sellerId ?? "");
    res.json({ success: true, data: shapeProfile(seller) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT / — update editable profile fields ───────────────────────
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logoUrl: z.string().max(500).optional().nullable(),
  shopAddress: z.string().max(300).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  pincode: z.string().max(10).optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  phone: z.string().max(15).optional().nullable(),
  gstin: z.string().max(15).optional().nullable(),
  pan: z.string().max(10).optional().nullable(),
  bankDetails: z.any().optional().nullable(),
});

router.put("/", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid profile data", parsed.error.errors);
    const updated = await prisma.seller.update({ where: { id: req.sellerId }, data: parsed.data });
    res.json({ success: true, data: shapeProfile(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /earnings — gross / commission / net + payout history ────
router.get("/earnings", async (req: SellerRequest, res: Response) => {
  try {
    const seller = await prisma.seller.findUnique({
      where: { id: req.sellerId },
      select: { outstandingBalance: true, commissionPct: true },
    });
    if (!seller) throw new NotFoundError("Seller", req.sellerId ?? "");

    const [allTime, unsettled, payouts] = await Promise.all([
      prisma.subOrder.aggregate({ where: { sellerId: req.sellerId }, _sum: { subtotal: true, commissionAmount: true, tcsAmount: true, netPayable: true }, _count: true }),
      prisma.subOrder.aggregate({ where: { sellerId: req.sellerId, settled: false }, _sum: { netPayable: true }, _count: true }),
      prisma.sellerPayout.findMany({ where: { sellerId: req.sellerId }, orderBy: { paidAt: "desc" }, take: 20 }),
    ]);

    res.json({
      success: true,
      data: {
        commissionPct: Number(seller.commissionPct),
        outstandingBalance: Number(seller.outstandingBalance),
        orderCount: allTime._count,
        totalGross: Number(allTime._sum.subtotal ?? 0),
        totalCommission: Number(allTime._sum.commissionAmount ?? 0),
        // GST Sec-52 TCS the platform withholds (gross − commission − tcs = net). 0 until Phase 6.
        totalTcs: Number(allTime._sum.tcsAmount ?? 0),
        totalNet: Number(allTime._sum.netPayable ?? 0),
        unsettledCount: unsettled._count,
        unsettledNet: Number(unsettled._sum.netPayable ?? 0),
        payouts: payouts.map((p) => ({
          id: p.id,
          grossAmount: Number(p.grossAmount),
          commission: Number(p.commission),
          tcs: Number(p.tcs),
          netPaid: Number(p.netPaid),
          paidAt: p.paidAt,
          mode: p.mode,
          reference: p.reference,
          note: p.note,
        })),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /analytics — seller's own sales/inventory analytics (interactive charts) ──
// Scoped strictly to THIS seller (SubOrder.sellerId / OrderItem.sellerId), so it never leaks another
// seller's numbers. Mirrors the owner Analytics revamp's shapes 1:1 (RankedRow, IST-day bucketing)
// so the app reuses the same Vico chart components — but deliberately narrower: a shopkeeper needs
// "how's MY shop doing", not the platform-wide/cross-seller view the owner tab carries. No schema
// change (git-push only). Memoized 3 min per (seller, range) so a range-tap / tab-reopen doesn't
// re-hit Postgres on the single Render instance.
//
// "Revenue" here = GROSS sales (SubOrder.subtotal / OrderItem.lineTotal), NOT net-after-commission —
// it's the sales-performance signal; the take-home net stays in the money cards on the Earnings tab.
// All of it excludes CANCELLED (a cancelled slice isn't a sale).

const SELLER_ANALYTICS_TTL_MS = 3 * 60 * 1000;
const SELLER_VALID_RANGES = ["today", "week", "month", "quarter"];
const SELLER_RANGE_DAYS: Record<string, number> = { week: 7, month: 30, quarter: 90 };

// IST = UTC+5:30. Every timestamp is stored naive-UTC and Render runs in UTC, so "today" must be
// computed off IST midnight, not the process's UTC midnight (same reasoning + helper as
// ownerAnalytics.ts — see the long comment there).
const SELLER_IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function sellerIstMidnightUtc(now: Date): Date {
  const shifted = new Date(now.getTime() + SELLER_IST_OFFSET_MS);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStartShifted - SELLER_IST_OFFSET_MS);
}

function sellerRangeSince(range: string): Date {
  const now = new Date();
  if (range === "today") return sellerIstMidnightUtc(now);
  const days = SELLER_RANGE_DAYS[range] ?? SELLER_RANGE_DAYS.month;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function sellerRupees(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

// The bucket values come back with the IST shift already baked in (the AT TIME ZONE query below),
// so format them by their UTC calendar getters explicitly (don't rely on the process TZ).
function sellerBucketLabel(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

interface SellerRankedRow {
  id: string;
  label: string;
  value: number;
  displayValue: string;
  sublabel?: string;
}

interface SellerTrendRow {
  bucket: Date;
  revenue: number | null;
  orders: number | null;
}

async function buildSellerAnalytics(sellerId: string, range: string) {
  const since = sellerRangeSince(range);
  const durationMs = Date.now() - since.getTime();
  const prevSince = new Date(since.getTime() - durationMs); // equal-length window ending where current begins
  const bucketUnit: "day" | "week" = range === "today" || range === "week" ? "day" : "week";

  const [trendRows, currentAgg, prevAgg, topProductsRaw, unitsByVariant, activeProducts] =
    await Promise.all([
      // Sales trend — gross subtotal + sub-order count per IST calendar day/week. bucketUnit is
      // chosen from a 2-value whitelist (never taken from req.query) and still passed as a bound
      // param; sellerId is a bound param too.
      prisma.$queryRaw<SellerTrendRow[]>`
        SELECT date_trunc(${bucketUnit}, "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as bucket,
               SUM("subtotal")::float as revenue,
               COUNT(*)::int as orders
        FROM "SubOrder"
        WHERE "sellerId" = ${sellerId} AND status != 'CANCELLED' AND "createdAt" >= ${since}
        GROUP BY bucket
        ORDER BY bucket ASC`,
      prisma.subOrder.aggregate({
        _sum: { subtotal: true },
        _count: true,
        where: { sellerId, status: { not: "CANCELLED" }, createdAt: { gte: since } },
      }),
      prisma.subOrder.aggregate({
        _sum: { subtotal: true },
        _count: true,
        where: { sellerId, status: { not: "CANCELLED" }, createdAt: { gte: prevSince, lt: since } },
      }),
      // Top products by gross revenue. Grouped by the item's snapshot productName (a clean label with
      // no variant→product join needed); these rows aren't tap-to-drill in the seller tab, same as the
      // owner's agent/seller rows, so the name doubling as the id is harmless.
      prisma.orderItem.groupBy({
        by: ["productName"],
        _sum: { lineTotal: true, quantity: true },
        where: { sellerId, order: { status: { not: "CANCELLED" }, createdAt: { gte: since } } },
        orderBy: { _sum: { lineTotal: "desc" } },
        take: 8,
      }),
      // Units sold per variant in the window (for the inventory-health rollup below).
      prisma.orderItem.groupBy({
        by: ["variantId"],
        _sum: { quantity: true },
        where: {
          sellerId,
          variantId: { not: null },
          order: { status: { not: "CANCELLED" }, createdAt: { gte: since } },
        },
      }),
      // This seller's own active catalog (dead-stock / restock is scoped to their products only).
      prisma.catalogProduct.findMany({
        where: { isActive: true, sellerId },
        select: {
          id: true,
          name: true,
          variants: { where: { isActive: true }, select: { id: true, stock: true, sellingPrice: true } },
        },
      }),
    ]);

  // ── Summary (current period + previous period → the ▲/▼% delta) ──
  const revenue = Number(currentAgg._sum.subtotal ?? 0);
  const orders = currentAgg._count;
  const prevRevenue = Number(prevAgg._sum.subtotal ?? 0);
  const prevOrders = prevAgg._count;
  const avgOrderValue = orders > 0 ? revenue / orders : 0;
  // null when there's no prior baseline — the app shows "new" instead of a misleading +100%/∞.
  const revenueDeltaPct = prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue) * 100 : null;

  // ── Trend series (both metrics; the app toggles Revenue⇄Orders on the same chart) ──
  const trend = trendRows.map((r) => ({
    label: sellerBucketLabel(new Date(r.bucket)),
    revenue: Number(r.revenue ?? 0),
    orders: Number(r.orders ?? 0),
  }));

  // ── Top products ──
  const topProducts: SellerRankedRow[] = topProductsRaw
    .filter((r) => Number(r._sum.lineTotal ?? 0) > 0)
    .map((r) => ({
      id: r.productName,
      label: r.productName,
      value: Number(r._sum.lineTotal ?? 0),
      displayValue: sellerRupees(Number(r._sum.lineTotal ?? 0)),
      sublabel: `${Number(r._sum.quantity ?? 0)} sold`,
    }));

  // ── Inventory health: roll variant units/stock up to the parent product ──
  const unitsByVariantMap = new Map<string, number>(
    unitsByVariant.map((r) => [r.variantId as string, Number(r._sum.quantity ?? 0)])
  );
  interface PAgg { id: string; name: string; units: number; stock: number; stockValue: number }
  const products: PAgg[] = activeProducts.map((p) => {
    let units = 0, stock = 0, stockValue = 0;
    for (const v of p.variants) {
      const u = unitsByVariantMap.get(v.id) ?? 0;
      const s = Number(v.stock);
      units += u;
      stock += s;
      stockValue += s * Number(v.sellingPrice);
    }
    return { id: p.id, name: p.name, units, stock, stockValue };
  });

  // Dead stock — in stock but zero orders this window, ranked by ₹ tied up (biggest opportunity first).
  const deadStock: SellerRankedRow[] = products
    .filter((p) => p.units === 0 && p.stock > 0)
    .sort((a, b) => b.stockValue - a.stockValue)
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: p.stockValue,
      displayValue: `${sellerRupees(p.stockValue)} tied up`,
      sublabel: `${p.stock} in stock, 0 sold`,
    }));

  // Restock priority — high units sold relative to what's left; about to run out.
  const restockPriority: SellerRankedRow[] = products
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

  return {
    range,
    since: since.toISOString(),
    summary: { revenue, orders, avgOrderValue, prevRevenue, prevOrders, revenueDeltaPct },
    trend,
    topProducts,
    deadStock,
    restockPriority,
  };
}

router.get("/analytics", async (req: SellerRequest, res: Response) => {
  try {
    const sellerId = req.sellerId as string;
    const requested = String(req.query.range ?? "month");
    const range = SELLER_VALID_RANGES.includes(requested) ? requested : "month";
    const data = await memoCache.get(
      `sellerAnalytics:${sellerId}:${range}`,
      SELLER_ANALYTICS_TTL_MS,
      () => buildSellerAnalytics(sellerId, range)
    );
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
