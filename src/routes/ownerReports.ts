import { Router, type Request, type Response } from "express";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import {
  getSalesRegister,
  getGstr1Summary,
  getGstr3bSummary,
  getGstr1Json,
  getHsnSummary,
  getDailySummary,
  getOutstandingReceivables,
  getProfitAndLoss,
  getPresumptiveTurnover,
  getClosingStockValuation,
  getGstHealth,
  getGstr2bReconciliation,
  type InvoiceScope,
  type Gstr2bRow,
} from "../services/reports.js";

// Owner-facing (Firebase auth) mirror of the JWT dashboard reports, so the owner can pull GST + income-tax
// reports from the app (COMPLIANCE_PLAN.md P1a). Reuses the same pure service functions — no logic here.
// Mounted at /api/app/owner/reports. All reports default to the store's own (house) books.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// ─── Query parsing ───────────────────────────────────────────────────

function reqStr(q: Request["query"], key: string): string {
  const v = q[key];
  return typeof v === "string" ? v : "";
}

function scopeFrom(q: Request["query"]): InvoiceScope {
  const sellerId = reqStr(q, "sellerId").trim();
  if (sellerId) return { kind: "seller", sellerId };
  if (q.scope === "all") return { kind: "all" };
  return { kind: "house" };
}

function parseRange(q: Request["query"]): { from: Date; to: Date } {
  const fromS = reqStr(q, "from"), toS = reqStr(q, "to");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromS) || !/^\d{4}-\d{2}-\d{2}$/.test(toS)) {
    throw new ValidationError("from/to must be YYYY-MM-DD");
  }
  const from = new Date(fromS); from.setHours(0, 0, 0, 0);
  const to = new Date(toS); to.setHours(23, 59, 59, 999);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new ValidationError("Invalid dates");
  if (from > to) throw new ValidationError("'from' must be before 'to'");
  return { from, to };
}

function parsePeriod(q: Request["query"]): string {
  const p = reqStr(q, "period");
  if (!/^\d{6}$/.test(p)) throw new ValidationError("period must be MMYYYY, e.g. 032026");
  return p;
}

// ─── GST returns ─────────────────────────────────────────────────────

router.get("/sales-register", async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req.query);
    res.json({ success: true, data: await getSalesRegister(from, to, scopeFrom(req.query)) });
  } catch (e) { sendError(res, e); }
});

router.get("/gstr1-summary", async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getGstr1Summary(parsePeriod(req.query), scopeFrom(req.query)) });
  } catch (e) { sendError(res, e); }
});

router.get("/gstr3b-summary", async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getGstr3bSummary(parsePeriod(req.query), scopeFrom(req.query)) });
  } catch (e) { sendError(res, e); }
});

router.get("/gstr1-json", async (req: Request, res: Response) => {
  try {
    const period = parsePeriod(req.query);
    const data = await getGstr1Json(period, scopeFrom(req.query));
    if (reqStr(req.query, "download") === "true") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="GSTR1-${period}.json"`);
      return res.json(data);
    }
    res.json({ success: true, data });
  } catch (e) { sendError(res, e); }
});

router.get("/hsn-summary", async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req.query);
    res.json({ success: true, data: await getHsnSummary(from, to, scopeFrom(req.query)) });
  } catch (e) { sendError(res, e); }
});

// ─── Operational ─────────────────────────────────────────────────────

router.get("/daily-summary", async (req: Request, res: Response) => {
  try {
    const date = reqStr(req.query, "date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("date must be YYYY-MM-DD");
    res.json({ success: true, data: await getDailySummary(date, scopeFrom(req.query)) });
  } catch (e) { sendError(res, e); }
});

router.get("/outstanding-receivables", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getOutstandingReceivables() });
  } catch (e) { sendError(res, e); }
});

// ─── Income tax (P1b) ────────────────────────────────────────────────

router.get("/pnl", async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req.query);
    res.json({ success: true, data: await getProfitAndLoss(from, to) });
  } catch (e) { sendError(res, e); }
});

router.get("/presumptive", async (req: Request, res: Response) => {
  try {
    const fy = parseInt(reqStr(req.query, "fy"), 10);
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
      throw new ValidationError("fy must be the FY start year, e.g. 2025 for FY 2025-26");
    }
    res.json({ success: true, data: await getPresumptiveTurnover(fy) });
  } catch (e) { sendError(res, e); }
});

router.get("/closing-stock", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getClosingStockValuation() });
  } catch (e) { sendError(res, e); }
});

// ─── GST Health readiness (P1a-2) ────────────────────────────────────

router.get("/gst-health", async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getGstHealth(parsePeriod(req.query)) });
  } catch (e) { sendError(res, e); }
});

// ─── GSTR-2B reconciliation (P2-4) ───────────────────────────────────
// POST body: { from, to (YYYY-MM-DD), rows?: [{supplierGstin, invoiceNumber, taxableValue?, taxAmount?}],
// portal?: <raw GSTR-2B JSON from the portal> }. Either `rows` (pre-normalized) or `portal` (parsed here).

function flatten2b(portal: any): Gstr2bRow[] {
  const b2b = portal?.data?.docdata?.b2b ?? portal?.docdata?.b2b ?? portal?.b2b ?? [];
  const rows: Gstr2bRow[] = [];
  for (const sup of b2b) {
    const gstin = sup?.ctin ?? sup?.supplierGstin ?? "";
    for (const inv of (sup?.inv ?? [])) {
      const items = inv?.itms ?? inv?.items ?? [];
      let taxable = 0, tax = 0;
      for (const it of items) {
        const d = it?.itm_det ?? it ?? {};
        taxable += Number(d.txval ?? 0);
        tax += Number(d.camt ?? 0) + Number(d.samt ?? 0) + Number(d.iamt ?? 0);
      }
      rows.push({
        supplierGstin: String(gstin),
        invoiceNumber: String(inv?.inum ?? inv?.invoiceNumber ?? ""),
        taxableValue: taxable || Number(inv?.txval ?? 0),
        taxAmount: tax,
      });
    }
  }
  return rows;
}

router.post("/gstr2b-reconcile", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as any;
    const fromS = typeof body.from === "string" ? body.from : "";
    const toS = typeof body.to === "string" ? body.to : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromS) || !/^\d{4}-\d{2}-\d{2}$/.test(toS)) {
      throw new ValidationError("from/to must be YYYY-MM-DD");
    }
    const from = new Date(fromS); from.setHours(0, 0, 0, 0);
    const to = new Date(toS); to.setHours(23, 59, 59, 999);
    const rows: Gstr2bRow[] = Array.isArray(body.rows)
      ? body.rows
      : (body.portal ? flatten2b(body.portal) : []);
    res.json({ success: true, data: await getGstr2bReconciliation(from, to, rows) });
  } catch (e) { sendError(res, e); }
});

export default router;
