import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { shapeQuote } from "./appUser.js";
import { notifyQuoteReady } from "../services/fcmNotifier.js";

// Bulk-order (quote-request) inbox for the HOUSE co-manager. Mounted at /api/app/seller/quote-requests.
// Quote requests are store-wide (not per-seller), so this MIRRORS the owner inbox (routes/ownerQuotes.ts)
// but is gated to the store's house manager only — third-party marketplace sellers (sellerIsHouse=false)
// get 403. The owner keeps their own /api/app/owner/quote-requests routes unchanged.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

// Every route here is house-manager-only — third-party sellers can't manage store bulk orders.
function requireHouse(req: SellerRequest, res: Response): boolean {
  if (req.sellerIsHouse !== true) {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Only the store's house manager can manage bulk orders", details: [] },
    });
    return false;
  }
  return true;
}

// GET /api/app/seller/quote-requests → all requests + customer name/phone (newest first)
router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    if (!requireHouse(req, res)) return;
    const quotes = await prisma.quoteRequest.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { select: { name: true, phone: true } }, items: true },
    });
    res.json({ success: true, data: quotes.map((q) => shapeQuote(q)) });
  } catch (e) {
    sendError(res, e);
  }
});

const quoteSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        qty: z.string().max(40).default(""),
        amount: z.number().nonnegative(),
      }),
    )
    .min(1, "Add at least one item")
    .max(60),
  deliveryFee: z.number().nonnegative().default(0),
  message: z.string().max(2000).default(""),
});

// POST /api/app/seller/quote-requests/:id/quote → send an itemized price (status → QUOTED).
// Replaces any previously-sent line items. `quotedAmount` is the grand total (Σ items + fee).
router.post("/:id/quote", async (req: SellerRequest, res: Response) => {
  try {
    if (!requireHouse(req, res)) return;
    const id = String(req.params.id ?? "");
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid quotation", parsed.error.errors);

    const existing = await prisma.quoteRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Quote request", id);

    const subtotal = parsed.data.items.reduce((sum, it) => sum + it.amount, 0);
    const total = subtotal + parsed.data.deliveryFee;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.quoteItem.deleteMany({ where: { quoteRequestId: id } });
      await tx.quoteItem.createMany({
        data: parsed.data.items.map((it, i) => ({
          quoteRequestId: id,
          name: it.name.trim(),
          qty: it.qty.trim(),
          amount: it.amount,
          sortOrder: i,
        })),
      });
      return tx.quoteRequest.update({
        where: { id },
        data: {
          quotedAmount: total,
          deliveryFee: parsed.data.deliveryFee,
          quoteMessage: parsed.data.message.trim(),
          status: "QUOTED",
        },
        include: { user: { select: { name: true, phone: true } }, items: true },
      });
    });

    // Tell the customer their estimate is ready — never let a push failure fail the quote.
    try {
      await notifyQuoteReady(updated.userId, {
        id: updated.id,
        requestNumber: "QR-" + updated.id.slice(-6).toUpperCase(),
        total,
      });
    } catch (notifyErr) {
      console.warn("notifyQuoteReady failed:", notifyErr);
    }

    res.json({ success: true, data: shapeQuote(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/seller/quote-requests/:id/fulfill → mark fulfilled
router.post("/:id/fulfill", async (req: SellerRequest, res: Response) => {
  try {
    if (!requireHouse(req, res)) return;
    const id = String(req.params.id ?? "");
    const existing = await prisma.quoteRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Quote request", id);

    const updated = await prisma.quoteRequest.update({
      where: { id },
      data: { status: "FULFILLED" },
      include: { user: { select: { name: true, phone: true } }, items: true },
    });
    res.json({ success: true, data: shapeQuote(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
