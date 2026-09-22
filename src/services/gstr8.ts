import prisma from "../lib/prisma.js";
import { ValidationError } from "../lib/errors.js";
import { TCS_RATE_PCT } from "../data/taxRates.js";
import {
  RETURN_TYPES,
  cancellationCutoff,
  reversibleFiledPeriods,
  periodWindow,
} from "./filedPeriods.js";

/**
 * GSTR-8 — the monthly TCS return a GST e-commerce operator files under Sec 52.
 *
 * ⚠️ THIS LIVES IN A SERVICE BECAUSE IT HAS TWO CALLERS AND THEY MUST NOT DRIFT. It was built inline
 * in routes/ownerGstr8.ts, which meant scripts/proveFiledPeriodFreeze.ts — the script whose entire
 * job is proving the filed-period freeze works — could only RESTATE the predicate rather than run
 * it. A test that reimplements what it tests passes even after the real thing breaks. Step 18 shipped
 * with that weakness named in its own output; step 19 is where it gets closed.
 *
 * The return is built from three rules, all of which are load-bearing:
 *
 *  1. THE BASE IS STORED, NEVER RECONSTRUCTED. The liable value used to be recovered as tcsAmount ÷
 *     the current rate constant, which assumes every row was written at today's rate. Halving TCS
 *     from 1% to 0.5% (step 06) would then have doubled every historical row's liable value. It sums
 *     SubOrder.taxableValue — the base the tax was actually charged on.
 *
 *  2. A FILED PERIOD IS FROZEN (step 18). A row that was live when the period was filed stays in it,
 *     because that is what went to the government. Cancelling an October order must not silently
 *     rewrite a September return that has already been submitted.
 *
 *  3. AND THE REVERSAL LANDS WHERE IT HAPPENED. Freezing alone would make a cancellation vanish —
 *     the tax collected, reported, and then quietly never given back. It appears as a NEGATIVE row
 *     in the period the cancellation occurred, naming the filed period it unwinds.
 *
 * ⚠️ The row filter is `tcsAmount > 0` — on the MONEY, not on `seller.isHouse`. That is what lets the
 * house store walk into this return on its own the day it becomes a separate legal entity (step 23),
 * with no code change. A filter written as `seller: { isHouse: false }` would have silently omitted
 * it from a filed return instead.
 */

export interface Gstr8Row {
  sellerId: string;
  sellerName: string;
  gstin: string | null;
  pan: string | null;
  orderCount: number;
  /** GST-inclusive value supplied through the operator. */
  grossSupplies: number;
  /** The taxable value the TCS was computed on, read from the stored column. */
  netLiableValue: number;
  tcsCgst: number;
  tcsSgst: number;
  tcsTotal: number;
  /**
   * The filed period this row unwinds, or null for an ordinary supply row.
   *
   * ⚠️ A MACHINE-READABLE FLAG, not a string match on sellerName. The reversal label is written into
   * the name so a human reading the return knows why a month contains a minus; anything in CODE that
   * needs to tell the two apart must use this, or it breaks the day the label is reworded.
   */
  reversalOf: string | null;
}

export interface Gstr8Return {
  period: string;
  /** True once the period has been marked filed — its figures are frozen. */
  filed: boolean;
  filedAt: Date | null;
  /** The statutory rate for rows written from now on. NOT a claim about this period — see below. */
  tcsRatePct: number;
  /** The rates this period's rows were actually written at. Two values only across a rate change. */
  ratesApplied: number[];
  sellerCount: number;
  rows: Gstr8Row[];
  totals: {
    grossSupplies: number;
    netLiableValue: number;
    tcsCgst: number;
    tcsSgst: number;
    tcsTotal: number;
  };
}

const r2 = (v: number) => +v.toFixed(2);

export function assertGstr8Period(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new ValidationError("period must be YYYY-MM");
  return period;
}

export function currentGstr8Period(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function buildGstr8(period: string): Promise<Gstr8Return> {
  assertGstr8Period(period);
  const { start, end } = periodWindow(period);

  const cutoff = await cancellationCutoff(RETURN_TYPES.GSTR8, period);
  const liveInPeriod = cutoff
    // ⚠️ cancelledAt NULL means the order was cancelled before that column existed, so it is treated
    // as cancelled-before-filing and stays excluded — the pre-step-18 behaviour, and safe because no
    // such row can be inside a filed period.
    ? { OR: [{ status: { not: "CANCELLED" as const } }, { cancelledAt: { gt: cutoff } }] }
    : { status: { not: "CANCELLED" as const } };

  const inPeriod = {
    createdAt: { gte: start, lt: end },
    tcsAmount: { gt: 0 },
    order: { is: liveInPeriod },
  };

  const grouped = await prisma.subOrder.groupBy({
    by: ["sellerId"],
    where: inPeriod,
    _sum: { subtotal: true, tcsAmount: true, taxableValue: true },
    _count: true,
  });

  const rateGroups = await prisma.subOrder.groupBy({ by: ["tcsRatePct"], where: inPeriod });
  const ratesApplied = rateGroups
    .map((r) => Number(r.tcsRatePct ?? TCS_RATE_PCT))
    .sort((x, y) => x - y);

  const priorFiled = await reversibleFiledPeriods(RETURN_TYPES.GSTR8, period);
  const reversals: { sellerId: string; subtotal: number; taxable: number; tcs: number; count: number; fromPeriod: string }[] = [];
  for (const f of priorFiled) {
    const w = periodWindow(f.period);
    const rows = await prisma.subOrder.groupBy({
      by: ["sellerId"],
      where: {
        createdAt: { gte: w.start, lt: w.end },
        tcsAmount: { gt: 0 },
        // Cancelled AFTER that period was filed (so it was in the filed return) and DURING this one
        // (so this is where the reversal belongs).
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

  const rows: Gstr8Row[] = grouped.map((g) => {
    const seller = sellerById.get(g.sellerId);
    const tcs = Number(g._sum.tcsAmount ?? 0);
    const half = r2(tcs / 2);
    return {
      sellerId: g.sellerId,
      sellerName: seller?.name ?? "Unknown",
      gstin: seller?.gstin ?? null,
      pan: seller?.pan ?? null,
      orderCount: g._count,
      grossSupplies: Number(g._sum.subtotal ?? 0),
      netLiableValue: r2(Number(g._sum.taxableValue ?? 0)),
      tcsCgst: half,
      tcsSgst: half,
      tcsTotal: tcs,
      reversalOf: null,
    };
  });

  // Reversal rows carry negative values and name the filed period they unwind, so the owner and
  // their CA can see WHY a month contains a minus rather than having to reconcile it blind.
  for (const rv of reversals) {
    const seller = sellerById.get(rv.sellerId);
    const half = r2(rv.tcs / 2);
    rows.push({
      sellerId: rv.sellerId,
      sellerName: `${seller?.name ?? "Unknown"} — reversal of ${rv.fromPeriod}`,
      gstin: seller?.gstin ?? null,
      pan: seller?.pan ?? null,
      orderCount: rv.count,
      grossSupplies: rv.subtotal,
      netLiableValue: r2(rv.taxable),
      tcsCgst: half,
      tcsSgst: r2(rv.tcs - half), // absorbs the odd paisa
      tcsTotal: rv.tcs,
      reversalOf: rv.fromPeriod,
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

  return {
    period,
    filed: cutoff != null,
    filedAt: cutoff,
    tcsRatePct: TCS_RATE_PCT,
    ratesApplied,
    sellerCount: rows.length,
    rows,
    totals: {
      grossSupplies: r2(totals.grossSupplies),
      netLiableValue: r2(totals.netLiableValue),
      tcsCgst: r2(totals.tcsTotal / 2),
      tcsSgst: r2(totals.tcsTotal / 2),
      tcsTotal: r2(totals.tcsTotal),
    },
  };
}
