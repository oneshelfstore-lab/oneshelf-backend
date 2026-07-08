import { Router, type Response } from "express";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import {
  getSalesRegister,
  getGstr1Summary,
  getGstr1Json,
  getGstr3bSummary,
  getHsnSummary,
  getSellerTcs,
} from "../services/reports.js";

// Seller-facing reports, HARD-scoped to the caller's own sellerId (identity C files their OWN GSTR-1;
// the operator files GSTR-8). resolveSeller pins req.sellerId, so a seller can never see house or
// another seller's data. Mounted at /api/app/seller/reports (COMPLIANCE_PLAN.md P2-1/P2-2).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

function reqStr(q: SellerRequest["query"], key: string): string {
  const v = q[key];
  return typeof v === "string" ? v : "";
}

function parsePeriod(q: SellerRequest["query"]): string {
  const p = reqStr(q, "period");
  if (!/^\d{6}$/.test(p)) throw new ValidationError("period must be MMYYYY, e.g. 032026");
  return p;
}

function parseRange(q: SellerRequest["query"]): { from: Date; to: Date } {
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

router.get("/gstr1-summary", async (req: SellerRequest, res: Response) => {
  try {
    const data = await getGstr1Summary(parsePeriod(req.query), { kind: "seller", sellerId: req.sellerId! });
    res.json({ success: true, data });
  } catch (e) { sendError(res, e); }
});

router.get("/gstr1-json", async (req: SellerRequest, res: Response) => {
  try {
    const period = parsePeriod(req.query);
    const data = await getGstr1Json(period, { kind: "seller", sellerId: req.sellerId! });
    if (reqStr(req.query, "download") === "true") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="GSTR1-${period}.json"`);
      return res.json(data);
    }
    res.json({ success: true, data });
  } catch (e) { sendError(res, e); }
});

router.get("/gstr3b-summary", async (req: SellerRequest, res: Response) => {
  try {
    const data = await getGstr3bSummary(parsePeriod(req.query), { kind: "seller", sellerId: req.sellerId! });
    res.json({ success: true, data });
  } catch (e) { sendError(res, e); }
});

router.get("/sales-register", async (req: SellerRequest, res: Response) => {
  try {
    const { from, to } = parseRange(req.query);
    const data = await getSalesRegister(from, to, { kind: "seller", sellerId: req.sellerId! });
    res.json({ success: true, data });
  } catch (e) { sendError(res, e); }
});

router.get("/hsn-summary", async (req: SellerRequest, res: Response) => {
  try {
    const { from, to } = parseRange(req.query);
    const data = await getHsnSummary(from, to, { kind: "seller", sellerId: req.sellerId! });
    res.json({ success: true, data });
  } catch (e) { sendError(res, e); }
});

router.get("/tcs", async (req: SellerRequest, res: Response) => {
  try {
    const data = await getSellerTcs(req.sellerId!, parsePeriod(req.query));
    res.json({ success: true, data });
  } catch (e) { sendError(res, e); }
});

export default router;
