import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// ⚠️ GST/CA (Phase 6): GSTR-8 is the monthly TCS return a GST e-commerce operator files (Sec-52).
// This endpoint produces the per-seller TCS summary the owner / CA needs to file it. It does NOT
// itself file anything — it's a reporting export. Mounted at /api/app/owner/gstr8 (OWNER auth).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// TCS rate the operator collected (must match the placement-time rate in routes/orders.ts).
const TCS_RATE_PCT = 1;

// GET /?period=YYYY-MM — per-seller TCS for the calendar month. Defaults to the current month.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const period = String(req.query.period ?? "").trim() || defaultPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) throw new ValidationError("period must be YYYY-MM");

    const [yy, mm] = period.split("-").map(Number);
    const start = new Date(Date.UTC(yy!, mm! - 1, 1));
    const end = new Date(Date.UTC(yy!, mm!, 1));

    // Sub-orders with TCS in the window, excluding cancelled parent orders. tcsAmount > 0 already
    // excludes the house store (it never accrues TCS on its own supplies).
    const grouped = await prisma.subOrder.groupBy({
      by: ["sellerId"],
      where: {
        createdAt: { gte: start, lt: end },
        tcsAmount: { gt: 0 },
        order: { is: { status: { not: "CANCELLED" } } },
      },
      _sum: { subtotal: true, tcsAmount: true },
      _count: true,
    });

    const sellerIds = grouped.map((g) => g.sellerId);
    const sellers = await prisma.seller.findMany({
      where: { id: { in: sellerIds } },
      select: { id: true, name: true, gstin: true, pan: true },
    });
    const sellerById = new Map(sellers.map((s) => [s.id, s]));

    const rows = grouped.map((g) => {
      const seller = sellerById.get(g.sellerId);
      const tcs = Number(g._sum.tcsAmount ?? 0);
      // Net value of supplies liable to TCS = tcs / rate. CGST/SGST split the TCS in half (intra-state).
      const netLiable = +(tcs / (TCS_RATE_PCT / 100)).toFixed(2);
      const half = +(tcs / 2).toFixed(2);
      return {
        sellerId: g.sellerId,
        sellerName: seller?.name ?? "Unknown",
        gstin: seller?.gstin ?? null,
        pan: seller?.pan ?? null,
        orderCount: g._count,
        grossSupplies: Number(g._sum.subtotal ?? 0), // GST-inclusive value supplied through the operator
        netLiableValue: netLiable,                    // taxable value the TCS was computed on
        tcsCgst: half,
        tcsSgst: half,
        tcsTotal: tcs,
      };
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.grossSupplies += r.grossSupplies;
        acc.netLiableValue += r.netLiableValue;
        acc.tcsTotal += r.tcsTotal;
        return acc;
      },
      { grossSupplies: 0, netLiableValue: 0, tcsTotal: 0 },
    );

    res.json({
      success: true,
      data: {
        period,
        tcsRatePct: TCS_RATE_PCT,
        sellerCount: rows.length,
        rows,
        totals: {
          grossSupplies: +totals.grossSupplies.toFixed(2),
          netLiableValue: +totals.netLiableValue.toFixed(2),
          tcsCgst: +(totals.tcsTotal / 2).toFixed(2),
          tcsSgst: +(totals.tcsTotal / 2).toFixed(2),
          tcsTotal: +totals.tcsTotal.toFixed(2),
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
