import ExcelJS from "exceljs";
import prisma from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";
import { NotFoundError } from "../lib/errors.js";
import { payableSubOrderWhere, resolvePayoutSettings } from "./sellerPayout.js";

/**
 * The settlement statement (runbook step 19) — what a seller was paid, and why, line by line.
 *
 * ⚠️ EVERY FIGURE COMES FROM A STORED COLUMN. Nothing here recomputes commission, tax or a net from
 * a rate, and that is the whole discipline of this file: a statement that re-derives its numbers
 * stops reconciling the day a rate changes, and it stops reconciling QUIETLY — the seller sees a
 * total that no longer matches the money that reached their bank and has no way to tell which of the
 * two is wrong. The rate columns are shown so a negotiated rate can be VERIFIED against the amount
 * beside it, never so the amount can be produced from the rate.
 *
 * ⚠️ IT DECLARES WHETHER IT RECONCILES rather than assuming it does. `summary.reconciles` is the
 * payout's own arithmetic checked against its own total: gross − commission − commissionGst − tcs −
 * tds + adjustments must equal netPaid. That check is not decoration — writing this file is what
 * found that step 07 began withholding commission GST while SellerPayout had nowhere to record it,
 * so the first real payout would have carried a total its own columns could not reproduce.
 *
 * Two modes, one code path:
 *   a PAYOUT      — a settlement that happened. The summary is the SellerPayout row's own columns.
 *   PENDING (null) — what would be paid if the owner settled now. There is no payout row yet, so the
 *                    summary is summed from the slices. `summary.fromStoredPayout` says which.
 */

const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

export interface StatementLine {
  orderNumber: string;
  orderedAt: Date;
  productName: string;
  quantity: number;
  lineTotal: number;
  taxableValue: number;
  /** ⚠️ Null on a line placed before runbook step 08, which had no per-line rate at all. */
  commissionPct: number | null;
  commissionAmount: number | null;
  /** True when this line carried a rate negotiated for the product rather than the seller default. */
  negotiated: boolean;
}

export interface StatementOrder {
  orderNumber: string;
  orderedAt: Date;
  status: string;
  gross: number;
  taxableValue: number | null;
  /** ⚠️ The BLENDED effective rate across the slice since step 08, not "the seller's agreed rate". */
  commissionPct: number;
  commissionAmount: number;
  commissionGstPct: number | null;
  commissionGstAmount: number | null;
  tcsRatePct: number | null;
  tcsAmount: number;
  tdsRatePct: number | null;
  tdsAmount: number;
  netPayable: number;
}

export interface StatementAdjustment {
  createdAt: Date;
  kind: string;
  amount: number;
  reason: string;
}

export interface SettlementStatement {
  seller: { id: string; name: string; gstin: string | null; pan: string | null };
  payout: {
    id: string;
    paidAt: Date;
    mode: string | null;
    reference: string | null;
    note: string | null;
  } | null;
  summary: {
    /** false ⇒ this is a PENDING statement summed from slices, not a settlement that happened. */
    fromStoredPayout: boolean;
    orderCount: number;
    gross: number;
    commission: number;
    commissionGst: number;
    tcs: number;
    tds: number;
    adjustments: number;
    netPaid: number;
    /** gross − commission − commissionGst − tcs − tds + adjustments === netPaid, to the paise. */
    reconciles: boolean;
    /** Signed. Non-zero means the stored components and the stored total disagree. */
    reconciliationGap: number;
  };
  orders: StatementOrder[];
  lines: StatementLine[];
  adjustments: StatementAdjustment[];
}

const SLICE_SELECT = {
  id: true,
  subtotal: true,
  taxableValue: true,
  commissionPct: true,
  commissionAmount: true,
  commissionGstPct: true,
  commissionGstAmount: true,
  tcsRatePct: true,
  tcsAmount: true,
  tdsRatePct: true,
  tdsAmount: true,
  netPayable: true,
  status: true,
  createdAt: true,
  order: { select: { orderNumber: true } },
  items: {
    select: {
      productName: true,
      quantity: true,
      lineTotal: true,
      taxableValue: true,
      commissionPct: true,
      commissionAmount: true,
      variant: { select: { product: { select: { commissionPctOverride: true } } } },
    },
  },
} as const;

/**
 * @param payoutId a settled batch, or null for everything currently payable.
 * @param db       a transaction client, so a statement can be built for a payout that has not been
 *                 committed yet. scripts/provePayoutStatement.ts uses it to create a real payout,
 *                 reconcile the statement against it and roll the whole thing back — the only way to
 *                 prove this against live data without leaving a settlement behind.
 */
export async function buildSettlementStatement(
  sellerId: string,
  payoutId: string | null,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SettlementStatement> {
  const seller = await db.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, name: true, gstin: true, pan: true },
  });
  if (!seller) throw new NotFoundError("Seller", sellerId);

  let payout: SettlementStatement["payout"] = null;
  let stored: { gross: number; commission: number; commissionGst: number; tcs: number; tds: number; adjustments: number; netPaid: number } | null = null;

  if (payoutId) {
    const row = await db.sellerPayout.findFirst({
      where: { id: payoutId, sellerId },
      select: {
        id: true, paidAt: true, mode: true, reference: true, note: true,
        grossAmount: true, commission: true, commissionGst: true, tcs: true, tds: true,
        adjustmentTotal: true, netPaid: true,
      },
    });
    if (!row) throw new NotFoundError("Payout", payoutId);
    payout = { id: row.id, paidAt: row.paidAt, mode: row.mode, reference: row.reference, note: row.note };
    stored = {
      gross: n(row.grossAmount), commission: n(row.commission), commissionGst: n(row.commissionGst),
      tcs: n(row.tcs), tds: n(row.tds), adjustments: n(row.adjustmentTotal), netPaid: n(row.netPaid),
    };
  }

  const slices = payoutId
    ? await db.subOrder.findMany({ where: { payoutId, sellerId }, select: SLICE_SELECT, orderBy: { createdAt: "asc" } })
    : await db.subOrder.findMany({
        where: payableSubOrderWhere({ sellerId, payoutHoldDays: (await resolvePayoutSettings()).payoutHoldDays }),
        select: SLICE_SELECT,
        orderBy: { createdAt: "asc" },
      });

  const adjustmentRows = payoutId
    ? await db.subOrderAdjustment.findMany({
        where: { payoutId, sellerId },
        select: { createdAt: true, kind: true, amount: true, reason: true },
        orderBy: { createdAt: "asc" },
      })
    : await db.subOrderAdjustment.findMany({
        where: { sellerId, settled: false },
        select: { createdAt: true, kind: true, amount: true, reason: true },
        orderBy: { createdAt: "asc" },
      });

  const orders: StatementOrder[] = slices.map((s) => ({
    orderNumber: s.order.orderNumber,
    orderedAt: s.createdAt,
    status: s.status,
    gross: n(s.subtotal),
    taxableValue: s.taxableValue == null ? null : n(s.taxableValue),
    commissionPct: n(s.commissionPct),
    commissionAmount: n(s.commissionAmount),
    commissionGstPct: s.commissionGstPct == null ? null : n(s.commissionGstPct),
    commissionGstAmount: s.commissionGstAmount == null ? null : n(s.commissionGstAmount),
    tcsRatePct: s.tcsRatePct == null ? null : n(s.tcsRatePct),
    tcsAmount: n(s.tcsAmount),
    tdsRatePct: s.tdsRatePct == null ? null : n(s.tdsRatePct),
    tdsAmount: n(s.tdsAmount),
    netPayable: n(s.netPayable),
  }));

  const lines: StatementLine[] = slices.flatMap((s) =>
    s.items.map((i) => ({
      orderNumber: s.order.orderNumber,
      orderedAt: s.createdAt,
      productName: i.productName,
      quantity: n(i.quantity),
      lineTotal: n(i.lineTotal),
      taxableValue: n(i.taxableValue),
      commissionPct: i.commissionPct == null ? null : n(i.commissionPct),
      commissionAmount: i.commissionAmount == null ? null : n(i.commissionAmount),
      // ⚠️ Reads the product's override as it is NOW, so this flag answers "is there a negotiated
      // rate on this product" rather than "was this line charged one". The rate that was ACTUALLY
      // applied is commissionPct beside it, snapshotted — that is the number to trust.
      negotiated: i.variant?.product.commissionPctOverride != null,
    })),
  );

  const adjustments: StatementAdjustment[] = adjustmentRows.map((a) => ({
    createdAt: a.createdAt, kind: a.kind, amount: n(a.amount), reason: a.reason,
  }));

  // For a stored payout these are the row's own columns. For a pending statement there is no row, so
  // they are summed from the slices — the only honest thing to do, and flagged as such.
  const summed = {
    gross: r2(orders.reduce((t, o) => t + o.gross, 0)),
    commission: r2(orders.reduce((t, o) => t + o.commissionAmount, 0)),
    commissionGst: r2(orders.reduce((t, o) => t + (o.commissionGstAmount ?? 0), 0)),
    tcs: r2(orders.reduce((t, o) => t + o.tcsAmount, 0)),
    tds: r2(orders.reduce((t, o) => t + o.tdsAmount, 0)),
    adjustments: r2(adjustments.reduce((t, a) => t + a.amount, 0)),
    netPaid: r2(orders.reduce((t, o) => t + o.netPayable, 0) + adjustments.reduce((t, a) => t + a.amount, 0)),
  };
  const s = stored ?? summed;
  const expected = r2(s.gross - s.commission - s.commissionGst - s.tcs - s.tds + s.adjustments);
  const gap = r2(s.netPaid - expected);

  return {
    seller,
    payout,
    summary: {
      fromStoredPayout: stored != null,
      orderCount: orders.length,
      ...s,
      reconciles: Math.abs(gap) < 0.005,
      reconciliationGap: gap,
    },
    orders,
    lines,
    adjustments,
  };
}

/** Three tabs: what was paid, which orders it covered, and which line carried which rate. */
export async function settlementToExcel(st: SettlementStatement): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const money = "#,##0.00";
  const pct = "0.00";
  const head = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F5E9" } };
  };

  // ── Summary ─────────────────────────────────────────────────────────────────────────────────
  const sum = wb.addWorksheet("Summary");
  sum.columns = [{ key: "k", width: 34 }, { key: "v", width: 20 }];
  const row = (k: string, v: string | number, bold = false) => {
    const r = sum.addRow({ k, v });
    if (typeof v === "number") r.getCell("v").numFmt = money;
    if (bold) r.font = { bold: true };
    return r;
  };
  row("Seller", st.seller.name, true);
  row("GSTIN", st.seller.gstin ?? "—");
  row("PAN", st.seller.pan ?? "—");
  if (st.payout) {
    row("Paid at", st.payout.paidAt.toISOString().slice(0, 10));
    row("Mode", st.payout.mode ?? "—");
    row("Reference", st.payout.reference ?? "—");
  } else {
    row("Status", "PENDING — not yet settled");
  }
  sum.addRow({});
  row("Orders covered", st.summary.orderCount);
  row("Gross sales", st.summary.gross, true);
  row("Less: commission", -st.summary.commission);
  row("Less: GST on commission", -st.summary.commissionGst);
  row("Less: TCS (GST Sec 52)", -st.summary.tcs);
  row("Less: TDS (Sec 194-O)", -st.summary.tds);
  row("Adjustments", st.summary.adjustments);
  row("NET PAID", st.summary.netPaid, true);
  sum.addRow({});
  // ⚠️ The check is ON the statement, not just in the code that built it. A statement that silently
  // fails to add up is worse than one that says so.
  row("Reconciles", st.summary.reconciles ? "YES" : `NO — off by ${st.summary.reconciliationGap.toFixed(2)}`, true);
  row("Figures from", st.summary.fromStoredPayout ? "the stored payout record" : "unsettled orders (pending)");
  sum.getColumn("k").font = { ...(sum.getColumn("k").font ?? {}) };

  if (st.adjustments.length > 0) {
    sum.addRow({});
    const h = sum.addRow({ k: "Adjustments", v: "" });
    h.font = { bold: true };
    for (const a of st.adjustments) {
      const r = sum.addRow({ k: `${a.createdAt.toISOString().slice(0, 10)} ${a.kind} — ${a.reason}`, v: a.amount });
      r.getCell("v").numFmt = money;
    }
  }

  // ── Orders ──────────────────────────────────────────────────────────────────────────────────
  const ord = wb.addWorksheet("Orders");
  ord.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Order #", key: "orderNumber", width: 20 },
    { header: "Status", key: "status", width: 12 },
    { header: "Gross (₹)", key: "gross", width: 13 },
    { header: "Taxable (₹)", key: "taxable", width: 13 },
    { header: "Comm %", key: "commissionPct", width: 9 },
    { header: "Commission (₹)", key: "commission", width: 15 },
    { header: "GST on comm (₹)", key: "commissionGst", width: 16 },
    { header: "TCS %", key: "tcsPct", width: 8 },
    { header: "TCS (₹)", key: "tcs", width: 11 },
    { header: "TDS %", key: "tdsPct", width: 8 },
    { header: "TDS (₹)", key: "tds", width: 11 },
    { header: "Net (₹)", key: "net", width: 13 },
  ];
  head(ord);
  for (const o of st.orders) {
    ord.addRow({
      date: o.orderedAt.toISOString().slice(0, 10),
      orderNumber: o.orderNumber,
      status: o.status,
      gross: o.gross,
      taxable: o.taxableValue ?? "—",
      commissionPct: o.commissionPct,
      commission: o.commissionAmount,
      commissionGst: o.commissionGstAmount ?? "—",
      tcsPct: o.tcsRatePct ?? "—",
      tcs: o.tcsAmount,
      tdsPct: o.tdsRatePct ?? "—",
      tds: o.tdsAmount,
      net: o.netPayable,
    });
  }
  for (const k of ["gross", "taxable", "commission", "commissionGst", "tcs", "tds", "net"]) {
    ord.getColumn(k).numFmt = money;
  }
  for (const k of ["commissionPct", "tcsPct", "tdsPct"]) ord.getColumn(k).numFmt = pct;
  const ordTotal = ord.addRow({
    date: "", orderNumber: "TOTAL", status: "",
    gross: st.summary.gross, taxable: "", commissionPct: "",
    commission: st.summary.commission, commissionGst: st.summary.commissionGst,
    tcsPct: "", tcs: st.summary.tcs, tdsPct: "", tds: st.summary.tds,
    net: r2(st.orders.reduce((t, o) => t + o.netPayable, 0)),
  });
  ordTotal.font = { bold: true };

  // ── Lines ───────────────────────────────────────────────────────────────────────────────────
  // ⚠️ The reason this tab exists. Since step 08 a rate can be negotiated per PRODUCT, so the
  // sub-order's rate is a blend and cannot be checked against any agreement. This is the level a
  // seller can actually verify a negotiated rate at.
  const ln = wb.addWorksheet("Lines");
  ln.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Order #", key: "orderNumber", width: 20 },
    { header: "Product", key: "product", width: 34 },
    { header: "Qty", key: "qty", width: 9 },
    { header: "Line total (₹)", key: "lineTotal", width: 14 },
    { header: "Taxable (₹)", key: "taxable", width: 13 },
    { header: "Comm %", key: "commissionPct", width: 9 },
    { header: "Commission (₹)", key: "commission", width: 15 },
    { header: "Negotiated rate", key: "negotiated", width: 16 },
  ];
  head(ln);
  for (const l of st.lines) {
    ln.addRow({
      date: l.orderedAt.toISOString().slice(0, 10),
      orderNumber: l.orderNumber,
      product: l.productName,
      qty: l.quantity,
      lineTotal: l.lineTotal,
      taxable: l.taxableValue,
      // A line placed before step 08 has no rate of its own. "—" is the honest cell; a 0 would read
      // as "this line was charged nothing".
      commissionPct: l.commissionPct ?? "—",
      commission: l.commissionAmount ?? "—",
      negotiated: l.negotiated ? "yes" : "",
    });
  }
  for (const k of ["lineTotal", "taxable", "commission"]) ln.getColumn(k).numFmt = money;
  ln.getColumn("commissionPct").numFmt = pct;

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
