import { Router, type Response } from "express";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { buildPlatformPl, buildPlatformBalanceSheet } from "../services/platformPl.js";

// The platform's own P&L and what it is holding for other people (runbook step 21).
// Mounted at /api/app/owner/platform (Firebase auth + OWNER).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

function parseRange(q: FirebaseAuthRequest["query"]): { from: Date; to: Date } {
  const fromS = typeof q.from === "string" ? q.from : "";
  const toS = typeof q.to === "string" ? q.to : "";
  if (fromS || toS) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromS) || !/^\d{4}-\d{2}-\d{2}$/.test(toS)) {
      throw new ValidationError("from/to must be YYYY-MM-DD");
    }
    const from = new Date(fromS); from.setHours(0, 0, 0, 0);
    const to = new Date(toS); to.setHours(23, 59, 59, 999);
    if (from > to) throw new ValidationError("'from' must be before 'to'");
    return { from, to };
  }
  // Default: the current calendar month, in LOCAL time — the same window services/reports.ts builds,
  // so the two never disagree about which orders belong to "this month". See the commission-invoice
  // dating note for what happens when one of them uses UTC instead.
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { from, to };
}

// GET /pl?from=&to= — income, cost, margin, and what is held for the government.
router.get("/pl", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const { from, to } = parseRange(req.query);
    res.json({ success: true, data: await buildPlatformPl(from, to) });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /balance-sheet — what the platform owes, as of now.
router.get("/balance-sheet", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: await buildPlatformBalanceSheet() });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /summary — both, for the owner dashboard's single figure.
router.get("/summary", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const { from, to } = parseRange(req.query);
    const [pl, bs] = await Promise.all([buildPlatformPl(from, to), buildPlatformBalanceSheet()]);
    res.json({
      success: true,
      data: {
        pl,
        balanceSheet: bs,
        // ⚠️ "Obligations", not "net cash". There is no bank balance anywhere in this system, so a
        // net position cannot be computed — only what is owed. See services/platformPl.ts.
        dashboard: {
          marginThisPeriod: pl.margin,
          totalObligations: bs.totalObligations,
          ledgerReconciles: bs.owedToSellers.reconciles,
        },
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
