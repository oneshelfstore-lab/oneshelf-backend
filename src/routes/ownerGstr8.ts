import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { TCS_RATE_PCT } from "../data/taxRates.js";
import {
  RETURN_TYPES,
  cancellationCutoff,
  reversibleFiledPeriods,
  periodWindow,
} from "../services/filedPeriods.js";

// ⚠️ GST/CA (Phase 6): GSTR-8 is the monthly TCS return a GST e-commerce operator files (Sec-52).
// This endpoint produces the per-seller TCS summary the owner / CA needs to file it. It does NOT
// itself file anything — it's a reporting export. Mounted at /api/app/owner/gstr8 (OWNER auth).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET /?period=YYYY-MM — per-seller TCS for the calendar month. Defaults to the current month.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const period = String(req.query.period ?? "").trim() || defaultPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) throw new ValidationError("period must be YYYY-MM");

    const [yy, mm] = period.split("-").map(Number);
    const start = new Date(Date.UTC(yy!, mm! - 1, 1));
    const end = new Date(Date.UTC(yy!, mm!, 1));

    // ── The filed-period rule (runbook step 18) ────────────────────────────────────────────────
    //
    // An OPEN period reads current status: a cancelled order is simply not in the return.
    //
    // A FILED period is frozen. A row that was live when the period was filed STAYS in it, because
    // that is what was reported to the government — otherwise cancelling an October order silently
    // rewrites the September return that has already gone out. The cancellation instead shows up as
    // a negative in the period it actually happened in, below.
    const cutoff = await cancellationCutoff(RETURN_TYPES.GSTR8, period);
    const liveInPeriod = cutoff
      // ⚠️ cancelledAt NULL means the order was cancelled before that column existed, so it is
      // treated as cancelled-before-filing and stays excluded — the pre-step-18 behaviour, and safe
      // because no such row can be inside a filed period.
      ? { OR: [{ status: { not: "CANCELLED" as const } }, { cancelledAt: { gt: cutoff } }] }
      : { status: { not: "CANCELLED" as const } };

    // Sub-orders with TCS in the window. tcsAmount > 0 already excludes the house store (it never
    // accrues TCS on its own supplies).
    // ⚠️ Step 09 deliberately changes NOTHING here, and that is worth stating rather than leaving
    // to be rediscovered: the filter is on the money, not on isHouse. The day the shop becomes a
    // separate legal entity its slices start carrying real TCS and appear in this return on their
    // own, with no code change. A filter written as `seller: { isHouse: false }` would instead have
    // silently omitted them from a filed GSTR-8.
    const inPeriod = {
      createdAt: { gte: start, lt: end },
      tcsAmount: { gt: 0 },
      order: { is: liveInPeriod },
    };

    const grouped = await prisma.subOrder.groupBy({
      by: ["sellerId"],
      where: inPeriod,
      // ⚠️ taxableValue is SUMMED, not reconstructed. The liable value used to be recovered as
      // tcsAmount ÷ the current rate constant, which silently assumed every row had been written at
      // today's rate — so halving TCS from 1% to 0.5% (runbook step 06) would have doubled the
      // liable value of every row written before it, in a return that goes to the government.
      // SubOrder.taxableValue IS the base the TCS was charged on, stored at placement. Read it.
      _sum: { subtotal: true, tcsAmount: true, taxableValue: true },
      _count: true,
    });

    // Which rates the period's rows were actually written at, so the header can state a fact rather
    // than assert today's constant over history. Normally one value; two only across a rate change.
    const rateGroups = await prisma.subOrder.groupBy({ by: ["tcsRatePct"], where: inPeriod });
    const ratesApplied = rateGroups
      .map((r) => Number(r.tcsRatePct ?? TCS_RATE_PCT))
      .sort((x, y) => x - y);

    // ── Reversals of ALREADY-FILED periods that happened during this one ───────────────────────
    //
    // ⚠️ The other half of the rule, and not optional. Freezing alone would make a reversal vanish
    // entirely: the TCS would be collected, reported, and then quietly never given back. These are
    // NEGATIVE rows, reported in the period the cancellation happened.
    const priorFiled = await reversibleFiledPeriods(RETURN_TYPES.GSTR8, period);
    const reversals: { sellerId: string; subtotal: number; taxable: number; tcs: number; count: number; fromPeriod: string }[] = [];
    for (const f of priorFiled) {
      const w = periodWindow(f.period);
      const rows = await prisma.subOrder.groupBy({
        by: ["sellerId"],
        where: {
          createdAt: { gte: w.start, lt: w.end },
          tcsAmount: { gt: 0 },
          // Cancelled after that period was filed (so it was IN the filed return) and during this
          // period (so this is where the reversal belongs).
          order: { is: { status: "CANCELLED", cancelledAt: { gt: f.filedAt, gte: start, lt: end } } },
        },
        _sum: { subtotal: true, tcsAmount: true, taxableValue: true },
        _count: true,
      });
      for (const r of rows) {
        reversals.push({
          sellerId: r.sellerId,
          subtotal: -Number(r._sum.subtotal ?? 0),
          taxable: -Number(r._sum.taxableValue ?? 0),
          tcs: -Number(r._sum.tcsAmount ?? 0),
          count: r._count,
          fromPeriod: f.period,
        });
      }
    }

    const sellerIds = [...new Set([...grouped.map((g) => g.sellerId), ...reversals.map((r) => r.sellerId)])];
    const sellers = await prisma.seller.findMany({
      where: { id: { in: sellerIds } },
      select: { id: true, name: true, gstin: true, pan: true },
    });
    const sellerById = new Map(sellers.map((s) => [s.id, s]));

    const rows = grouped.map((g) => {
      const seller = sellerById.get(g.sellerId);
      const tcs = Number(g._sum.tcsAmount ?? 0);
      // CGST/SGST split the TCS in half (intra-state supply).
      const netLiable = +Number(g._sum.taxableValue ?? 0).toFixed(2);
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

    // Reversal rows carry negative values and name the filed period they unwind, so the owner and
    // their CA can see WHY a month contains a minus rather than having to reconcile it blind.
    for (const rv of reversals) {
      const seller = sellerById.get(rv.sellerId);
      const netLiable = +rv.taxable.toFixed(2);
      const half = +(rv.tcs / 2).toFixed(2);
      rows.push({
        sellerId: rv.sellerId,
        sellerName: `${seller?.name ?? "Unknown"} — reversal of ${rv.fromPeriod}`,
        gstin: seller?.gstin ?? null,
        pan: seller?.pan ?? null,
        orderCount: rv.count,
        grossSupplies: rv.subtotal,
        netLiableValue: netLiable,
        tcsCgst: half,
        tcsSgst: +(rv.tcs - half).toFixed(2),
        tcsTotal: rv.tcs,
      });
    }

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
        // So a caller can tell a frozen month from a live one without asking separately.
        filed: cutoff != null,
        filedAt: cutoff,
        period,
        // The statutory rate applied to rows written from now on. It is NOT a claim about this
        // period's rows — ratesApplied is.
        tcsRatePct: TCS_RATE_PCT,
        ratesApplied,
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
