import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma.js";
import { verifyWebhookSignature } from "../services/razorpay.js";
import { markOrderPaid } from "../services/orderPayment.js";
import { reconcileOrderPayment } from "../services/paymentReconciliation.js";
import { creditTopupByRazorpayOrder } from "../services/walletTopup.js";
import { creditQuoteByRazorpayOrder } from "../services/quotePayment.js";

const router = Router();

// ─── POST /api/app/webhooks/razorpay ─────────────────────────────────
// Server-to-server payment confirmation, independent of the mobile app. This is what makes "paid but
// app closed" safe: even if the app is killed before it can call /pay, Razorpay POSTs the captured
// payment here and we confirm the order (or credit the wallet top-up) anyway.
//
// Signature is verified against the RAW request body (captured by the express.json `verify` hook in
// index.ts) using RAZORPAY_WEBHOOK_SECRET. Everything downstream is idempotent, so Razorpay's
// at-least-once retries are harmless. Mounted PUBLIC (before the auth guards) — the HMAC is the auth.

router.post("/razorpay", async (req: Request, res: Response) => {
  const signature = (req.headers["x-razorpay-signature"] as string) || "";
  const rawBody: Buffer | undefined = (req as any).rawBody;

  if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
    // Reject forged/misconfigured payloads. 400 tells Razorpay the delivery failed.
    return res.status(400).json({ success: false });
  }

  try {
    const event = req.body?.event as string | undefined;
    const paymentEntity = req.body?.payload?.payment?.entity;
    const orderEntity = req.body?.payload?.order?.entity;
    const razorpayOrderId: string | undefined = paymentEntity?.order_id || orderEntity?.id;
    const razorpayPaymentId: string | undefined = paymentEntity?.id;

    if ((event === "payment.captured" || event === "order.paid") && razorpayOrderId) {
      const order = await prisma.order.findFirst({
        where: { razorpayOrderId },
        select: { id: true },
      });
      if (order) {
        // Use the payment id if the event carried one; otherwise fall back to reconcile, which
        // fetches the captured payment from Razorpay's API. Both paths are idempotent.
        if (razorpayPaymentId) await markOrderPaid(order.id, razorpayPaymentId);
        else await reconcileOrderPayment(order.id);
      } else if (razorpayPaymentId) {
        // Not an order → maybe a wallet top-up, else a bulk-quote payment, keyed by the same
        // Razorpay order id. Both are idempotent and short-circuit when the id isn't theirs.
        const creditedTopup = await creditTopupByRazorpayOrder(razorpayOrderId, razorpayPaymentId);
        if (!creditedTopup) await creditQuoteByRazorpayOrder(razorpayOrderId, razorpayPaymentId);
      }
    }

    // Always 200 fast on a verified event (Razorpay retries non-2xx). Unknown events are ignored.
    res.json({ success: true });
  } catch (e) {
    // Post-verification failures: log and still 200 so Razorpay doesn't hammer retries on a
    // transient bug — the reconciliation sweep is the backstop. (Bad signatures already 400'd above.)
    console.error(JSON.stringify({ level: "error", msg: "razorpay webhook failed", err: String(e) }));
    res.json({ success: true });
  }
});

export default router;
