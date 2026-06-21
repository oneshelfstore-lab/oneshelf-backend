import { Router, type Request, type Response } from "express";
import { sendError } from "../lib/errors.js";
import { generateDueSubscriptionOrders, closeMonthlyStatements } from "../services/subscriptionEngine.js";

// Internal automation endpoints — NOT behind Firebase/JWT auth (an external scheduler with no user
// identity calls them). Protected by a shared secret header instead. Mounted in index.ts BEFORE the
// global JWT guard, alongside the other public app routes.
const router = Router();

function authorize(req: Request, res: Response): boolean {
  const secret = process.env.INTERNAL_CRON_SECRET;
  if (!secret) {
    // Fail closed: never run an unauthenticated cycle if the secret isn't configured.
    res.status(503).json({ success: false, error: { code: "NOT_CONFIGURED", message: "Internal cron is not configured" } });
    return false;
  }
  if (req.headers["x-internal-secret"] !== secret) {
    res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Invalid internal secret" } });
    return false;
  }
  return true;
}

// POST /api/app/internal/subscriptions/run
// The reliable daily driver (the in-process setInterval is only a backup on the free tier).
// Generates today's due subscription orders, then closes the prior month's statements on the billing day.
router.post("/subscriptions/run", async (req: Request, res: Response) => {
  try {
    if (!authorize(req, res)) return;
    const gen = await generateDueSubscriptionOrders();
    const bill = await closeMonthlyStatements();
    res.json({ success: true, data: { generated: gen.generated, skipped: gen.skipped, billed: bill.billed } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
