import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Income Tax Sec 194-O — the per-seller TDS the platform withheld (services/sellerTds194o.ts),
// grouped by the calendar month the SubOrder was placed (accrual-based, mirrors routes/ownerGstr8.ts's
// TCS report exactly — same "accrued for later" philosophy applies to both withholdings). This does
// NOT itself file or deposit anything — it's the figure the owner/CA need for the quarterly TDS
// return + Form 16A. The actual deposit-tracking ledger (challan/deposit-date/return-filed) is the
// existing TdsRecord register, auto-fed one row per payout batch by services/sellerPayout.ts.
// Mounted at /api/app/owner/tds194o (OWNER auth).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET /?period=YYYY-MM — per-seller TDS accrued in the calendar month. Defaults to current month.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const period = String(req.query.period ?? "").trim() || defaultPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) throw new ValidationError("period must be YYYY-MM");

    const [yy, mm] = period.split("-").map(Number);
    const start = new Date(Date.UTC(yy!, mm! - 1, 1));
    const end = new Date(Date.UTC(yy!, mm!, 1));

    const config = await prisma.storeConfig.findFirst({
      select: { tds194oEnabled: true, tds194oRatePct: true, tds194oThreshold: true },
    });

    // Sub-orders with TDS accrued in the window, excluding cancelled parent orders. tdsAmount > 0
    // already excludes the house store (it never accrues TDS on its own supplies).
    const grouped = await prisma.subOrder.groupBy({
      by: ["sellerId"],
      where: {
        createdAt: { gte: start, lt: end },
        tdsAmount: { gt: 0 },
        order: { is: { status: { not: "CANCELLED" } } },
      },
      _sum: { subtotal: true, tdsAmount: true },
      _count: true,
    });

    const sellerIds = grouped.map((g) => g.sellerId);
    const sellers = await prisma.seller.findMany({
      where: { id: { in: sellerIds } },
      select: { id: true, name: true, pan: true, entityType: true },
    });
    const sellerById = new Map(sellers.map((s) => [s.id, s]));

    const rows = grouped.map((g) => {
      const seller = sellerById.get(g.sellerId);
      const grossSupplies = Number(g._sum.subtotal ?? 0);
      const tdsTotal = Number(g._sum.tdsAmount ?? 0);
      return {
        sellerId: g.sellerId,
        sellerName: seller?.name ?? "Unknown",
        pan: seller?.pan ?? null,
        entityType: seller?.entityType ?? "OTHER",
        orderCount: g._count,
        grossSupplies, // GST-inclusive value supplied through the operator this month
        tdsTotal, // Sec 194-O TDS withheld this month (effective rate varies if a seller crossed
        //          the ₹5L threshold mid-month — this is the actual withheld figure, not gross × rate)
      };
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.grossSupplies += r.grossSupplies;
        acc.tdsTotal += r.tdsTotal;
        return acc;
      },
      { grossSupplies: 0, tdsTotal: 0 },
    );

    res.json({
      success: true,
      data: {
        period,
        enabled: config?.tds194oEnabled ?? false,
        ratePct: Number(config?.tds194oRatePct ?? 0.1),
        thresholdAmount: Number(config?.tds194oThreshold ?? 500000),
        sellerCount: rows.length,
        rows,
        totals: {
          grossSupplies: +totals.grossSupplies.toFixed(2),
          tdsTotal: +totals.tdsTotal.toFixed(2),
        },
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

function defaultPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default router;
