import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import {
  generateCommissionInvoice,
  generateCommissionInvoicesForPeriod,
} from "../services/commissionInvoice.js";
import { INVOICE_KIND } from "../data/invoiceKinds.js";

// The platform's monthly commission billing (runbook step 17). Mounted at
// /api/app/owner/commission-invoices, OWNER auth.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

function parsePeriod(raw: unknown): string {
  const p = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(p)) throw new ValidationError("period must be YYYY-MM, e.g. 2026-09");
  return p;
}

// GET /?period=YYYY-MM — what has already been billed for the period.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const period = parsePeriod(req.query.period);
    const invoices = await prisma.invoice.findMany({
      where: { invoiceKind: INVOICE_KIND.COMMISSION, commissionPeriodKey: { endsWith: `:${period}` } },
      select: {
        id: true, invoiceNumber: true, invoiceDate: true, customerName: true, customerGstin: true,
        supplyType: true, subtotal: true, totalCgst: true, totalSgst: true, totalIgst: true,
        totalAmount: true, amountPaid: true, amountDue: true, commissionPeriodKey: true,
      },
      orderBy: { invoiceNumber: "asc" },
    });
    res.json({ success: true, data: { period, invoices } });
  } catch (e) { sendError(res, e); }
});

// POST /?period=YYYY-MM[&sellerId=...] — bill one seller, or every seller with commission.
//
// ⚠️ Safe to press twice. Invoice.commissionPeriodKey is unique, so a repeat returns the document
// that already exists rather than raising a second one — which would charge a seller twice for the
// same service and put two documents in one filed return.
router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const period = parsePeriod(req.query.period ?? (req.body as any)?.period);
    const sellerId = String(req.query.sellerId ?? (req.body as any)?.sellerId ?? "").trim();
    const results = sellerId
      ? [await generateCommissionInvoice(sellerId, period)]
      : await generateCommissionInvoicesForPeriod(period);
    res.json({
      success: true,
      data: {
        period,
        issued: results.filter((r) => r.invoiceId && !r.skipped).length,
        results,
      },
    });
  } catch (e) { sendError(res, e); }
});

export default router;
