import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  getSalesRegister,
  getPurchaseRegister,
  getGstr1Summary,
  getGstr3bSummary,
  getGstr1Json,
  getHsnSummary,
  getOutstandingReceivables,
  getOutstandingPayables,
  getTdsRegister,
  getDailySummary,
  salesRegisterToExcel,
  type InvoiceScope,
} from "../services/reports.js";

const router = Router();

// ─── Validation ─────────────────────────────────────────────────────

const dateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD"),
});

const periodSchema = z.object({
  period: z.string().regex(/^\d{6}$/, "Format: MMYYYY e.g. 032026"),
});

const quarterSchema = z.object({
  quarter: z.enum(["Q1", "Q2", "Q3", "Q4"]),
  fy: z.string().regex(/^\d{4}$/, "Format: 4 digits e.g. 2627"),
});

const dateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD"),
});

function parseDateRange(from: string, to: string) {
  const f = new Date(from);
  f.setHours(0, 0, 0, 0);
  const t = new Date(to);
  t.setHours(23, 59, 59, 999);
  if (isNaN(f.getTime()) || isNaN(t.getTime())) throw new ValidationError("Invalid dates");
  if (f > t) throw new ValidationError("'from' must be before 'to'");
  return { from: f, to: t };
}

// Optional invoice scope from query params. Defaults to the store's own books (house), which is what
// the owner/dashboard files. `?sellerId=<id>` → that external seller's supplies; `?scope=all` →
// everything (reconciliation). See COMPLIANCE_PLAN.md P0-2.
function parseScope(q: Request["query"]): InvoiceScope {
  const sellerId = typeof q.sellerId === "string" ? q.sellerId.trim() : "";
  if (sellerId) return { kind: "seller", sellerId };
  if (q.scope === "all") return { kind: "all" };
  return { kind: "house" };
}

// ─── 1. Sales Register ──────────────────────────────────────────────

router.get("/sales-register", async (req: Request, res: Response) => {
  try {
    const { from, to } = dateRangeSchema.parse(req.query);
    const range = parseDateRange(from, to);
    const format = (req.query.format as string) || "json";

    const data = await getSalesRegister(range.from, range.to, parseScope(req.query));

    if (format === "excel") {
      const buf = await salesRegisterToExcel(data);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="sales-register-${from}-to-${to}.xlsx"`);
      return res.send(buf);
    }

    res.json({ success: true, data, count: data.length });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 2. Purchase Register ───────────────────────────────────────────

router.get("/purchase-register", async (req: Request, res: Response) => {
  try {
    const { from, to } = dateRangeSchema.parse(req.query);
    const range = parseDateRange(from, to);
    const data = await getPurchaseRegister(range.from, range.to);
    res.json({ success: true, data, count: data.length });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 3. GSTR-1 Summary ─────────────────────────────────────────────

router.get("/gstr1-summary", async (req: Request, res: Response) => {
  try {
    const { period } = periodSchema.parse(req.query);
    const data = await getGstr1Summary(period, parseScope(req.query));
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 4. GSTR-3B Summary ────────────────────────────────────────────

router.get("/gstr3b-summary", async (req: Request, res: Response) => {
  try {
    const { period } = periodSchema.parse(req.query);
    const data = await getGstr3bSummary(period, parseScope(req.query));
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 5. GSTR-1 JSON (GSTN schema) ──────────────────────────────────

router.get("/gstr1-json", async (req: Request, res: Response) => {
  try {
    const { period } = periodSchema.parse(req.query);
    const data = await getGstr1Json(period, parseScope(req.query));

    const download = req.query.download === "true";
    if (download) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="GSTR1-${period}.json"`);
      return res.json(data);
    }

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 6. HSN Summary ────────────────────────────────────────────────

router.get("/hsn-summary", async (req: Request, res: Response) => {
  try {
    const { from, to } = dateRangeSchema.parse(req.query);
    const range = parseDateRange(from, to);
    const data = await getHsnSummary(range.from, range.to, parseScope(req.query));
    res.json({ success: true, data, count: data.length });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 7. Outstanding Receivables ─────────────────────────────────────

router.get("/outstanding-receivables", async (_req: Request, res: Response) => {
  try {
    const data = await getOutstandingReceivables();
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 8. Outstanding Payables ────────────────────────────────────────

router.get("/outstanding-payables", async (_req: Request, res: Response) => {
  try {
    const data = await getOutstandingPayables();
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 9. TDS Register ───────────────────────────────────────────────

router.get("/tds-register", async (req: Request, res: Response) => {
  try {
    const { quarter, fy } = quarterSchema.parse(req.query);
    const data = await getTdsRegister(quarter, fy);
    res.json({ success: true, data, count: data.length });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── 10. Daily Summary ─────────────────────────────────────────────

router.get("/daily-summary", async (req: Request, res: Response) => {
  try {
    const { date } = dateSchema.parse(req.query);
    const data = await getDailySummary(date, parseScope(req.query));
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
