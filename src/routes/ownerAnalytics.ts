import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError } from "../lib/errors.js";
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

export default router;
