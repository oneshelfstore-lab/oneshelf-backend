import prisma from "../lib/prisma.js";
import { refundWalletOnCancel } from "./referralRewards.js";
import { reconcileOrderPayment } from "./paymentReconciliation.js";

// Online/UPI orders decrement stock at placement (to hold it during payment). If the
// customer never completes payment (abandons the Razorpay sheet, app crash), that stock
// would be held forever. This sweeper auto-cancels stale unpaid online orders and
// restores their stock.
//
// SAFE-CANCEL: before cancelling, each candidate is reconciled against Razorpay's API
// (reconcileOrderPayment) — so an order that was actually PAID but whose /pay confirmation never
// reached us (app killed, webhook missed) is recovered to PAID and NOT cancelled. We only cancel
// orders Razorpay confirms were never captured. This, together with the Razorpay webhook, closes
// the orphan-payment gap (money captured but order stuck PENDING).

const EXPIRY_MINUTES = 20;

export async function expireStaleUnpaidOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: {
      status: "PLACED",
      paymentStatus: "PENDING",
      paymentMethod: { in: ["ONLINE", "UPI"] },
      razorpayPaymentId: null, // never verified a payment
      createdAt: { lt: cutoff },
    },
    include: { items: true },
  });

  let expired = 0;

  for (const order of stale) {
    try {
      // Ask Razorpay whether this "unpaid" order was in fact paid (a captured payment whose
      // confirmation never reached us). If so, reconcile marks it PAID (or refunds if it was already
      // wrongly cancelled) and we must NOT cancel it.
      if (order.razorpayOrderId) {
        const r = await reconcileOrderPayment(order.id);
        if (r.paymentStatus !== "PENDING") continue;
      }

      await prisma.$transaction(async (tx) => {
        // Re-read inside the tx so we never cancel an order that just got paid in a
        // racing /pay call.
        const fresh = await tx.order.findUnique({ where: { id: order.id } });
        if (!fresh || fresh.status !== "PLACED" || fresh.paymentStatus !== "PENDING" || fresh.razorpayPaymentId) {
          return;
        }

        for (const item of order.items) {
          if (!item.variantId) continue;
          const restore = item.isLoose && item.stepSize
            ? Number(item.quantity) * Number(item.stepSize)
            : Number(item.quantity);
          await tx.productVariant.update({
            where: { id: item.variantId },
            data: { stock: { increment: restore } },
          });
        }

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "CANCELLED",
            notes: `${fresh.notes ? fresh.notes + " " : ""}[auto-cancelled: payment not completed]`,
          },
        });
        expired++;
      });
      // If this order was auto-cancelled and had store credit applied (a partly-wallet-paid online
      // order the customer abandoned), return that credit. Safe to call unconditionally — it verifies
      // status === CANCELLED internally and is idempotent.
      await refundWalletOnCancel(order.id);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "order-expiry failed", orderId: order.id, err: String(err) }));
    }
  }

  if (expired > 0) {
    console.log(JSON.stringify({ level: "info", msg: "expired stale unpaid orders", count: expired }));
  }
  return expired;
}

/**
 * Starts a periodic in-process sweeper. Fine for a single instance; for multiple
 * instances use an external scheduler or a DB advisory lock to avoid double-runs.
 */
export function startOrderExpirySweeper(intervalMs = 5 * 60 * 1000): void {
  const timer = setInterval(() => {
    expireStaleUnpaidOrders().catch((e) =>
      console.error(JSON.stringify({ level: "error", msg: "order-expiry sweep crashed", err: String(e) })),
    );
  }, intervalMs);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();
}
