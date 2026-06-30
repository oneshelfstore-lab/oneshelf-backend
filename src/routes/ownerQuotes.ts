import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { shapeQuote } from "./appUser.js";
import { notifyQuoteReady } from "../services/fcmNotifier.js";
import { materializeQuoteOrder } from "../services/quoteToOrder.js";

// Owner quote-request inbox. Mounted at /api/app/owner/quote-requests.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET /api/app/owner/quote-requests → all requests + customer name/phone (newest first)
router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
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
        // Optional SKU link — when set, converting the quote to an order decrements this variant's stock.
        variantId: z.string().max(40).optional().nullable(),
      }),
    )
    .min(1, "Add at least one item")
    .max(60),
  deliveryFee: z.number().nonnegative().default(0),
  message: z.string().max(2000).default(""),
});

// POST /api/app/owner/quote-requests/:id/quote → send an itemized price (status → QUOTED).
// Replaces any previously-sent line items. `quotedAmount` is the grand total (Σ items + fee).
router.post("/:id/quote", async (req: FirebaseAuthRequest, res: Response) => {
  try {
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
          variantId: it.variantId || null,
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

// POST /api/app/owner/quote-requests/:id/fulfill → push an ACCEPTED quote into the delivery pipeline.
// A1 (Bulk Express): an accepted quote is now FULFILLED by materializing a real Order that flows
// through the owner board + delivery dashboard (assign agent → deliver via OTP). This endpoint is
// the owner-side safety net: it idempotently CONVERTS the quote to an order (covering legacy quotes
// accepted before A1, or a conversion that failed on approve). It deliberately does NOT flip the
// quote to FULFILLED when an order exists — the linked order's real status now drives fulfillment.
// Only when conversion isn't possible (no items / no house seller / already terminal) does it fall
// back to the legacy FULFILLED flip so the button still resolves edge-case quotes.
router.post("/:id/fulfill", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const existing = await prisma.quoteRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Quote request", id);

    let converted: Awaited<ReturnType<typeof materializeQuoteOrder>> = null;
    try {
      converted = await materializeQuoteOrder(id);
    } catch (convErr) {
      console.warn("materializeQuoteOrder (owner fulfill) failed:", convErr);
    }

    if (converted) {
      // Order exists (just created or already linked) — return the quote with its orderId.
      const fresh = await prisma.quoteRequest.findUnique({
        where: { id },
        include: { user: { select: { name: true, phone: true } }, items: true },
      });
      res.json({ success: true, data: shapeQuote(fresh!) });
      return;
    }

    // Legacy fallback: nothing to convert → keep the old behaviour.
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
