import { Router, type Response } from "express";
import { sendError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { buildGstr8, currentGstr8Period } from "../services/gstr8.js";

// ⚠️ GST/CA (Phase 6): GSTR-8 is the monthly TCS return a GST e-commerce operator files (Sec-52).
// This endpoint produces the per-seller TCS summary the owner / CA needs to file it. It does NOT
// itself file anything — it's a reporting export. Mounted at /api/app/owner/gstr8 (OWNER auth).
//
// ⚠️ The aggregate itself lives in services/gstr8.ts, not here, and that move is runbook step 19's
// doing. While it was inline, scripts/proveFiledPeriodFreeze.ts could only restate the filed-period
// predicate rather than run it — a test that reimplements what it tests keeps passing after the real
// thing breaks. This route is a thin wrapper on purpose; keep it that way.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET /?period=YYYY-MM — per-seller TCS for the calendar month. Defaults to the current month.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const period = String(req.query.period ?? "").trim() || currentGstr8Period();
    res.json({ success: true, data: await buildGstr8(period) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
