import prisma from "../lib/prisma.js";
import { generateOrderInvoice } from "./orderInvoice.js";
import { generateOtp } from "../lib/otp.js";

/**
 * The single, idempotent "this order's online payment is confirmed" routine. ALL THREE confirmation
 * paths converge here so confirmation never depends on the mobile app surviving:
 *   1. the app's POST /orders/:id/pay  (fast path)
 *   2. the Razorpay webhook            (server-to-server; survives an app crash/kill)
 *   3. reconciliation                  (queries Razorpay's API on app reopen + inside the sweeper)
 *
 * Signature/authenticity is established by each caller (the /pay route verifies the payment
 * signature; the webhook verifies its HMAC; reconciliation trusts a captured payment from Razorpay's
 * own API). This routine only flips state, so calling it twice is a safe no-op.
 *
 * Returns true if THIS call flipped PENDING→PAID, false if it was already paid / not pending.
 */
export async function markOrderPaid(orderId: string, razorpayPaymentId: string): Promise<boolean> {
  const flipped = await prisma.$transaction(async (tx) => {
    // Guarded flip — the idempotency gate. A racing /pay + webhook can both call this; only the
    // first wins (count === 1), the rest no-op (count === 0). Prepaid orders always need a handover
    // OTP, so we arm that flag here too.
    const upd = await tx.order.updateMany({
      where: { id: orderId, paymentStatus: "PENDING" },
      data: { paymentStatus: "PAID", razorpayPaymentId, deliveryOtpRequired: true },
    });
    if (upd.count === 0) return false;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { customerId: true, fulfillmentType: true, items: { select: { variantId: true } } },
    });
    if (!order) return true;

    // Arm the handover OTP if placement didn't already create one.
    const existingSecret = await tx.orderSecret.findFirst({ where: { orderId } });
    if (!existingSecret) {
      await tx.orderSecret.create({
        data: {
          orderId,
          otp: generateOtp(),
          customerId: order.customerId,
          fulfillmentType: order.fulfillmentType,
        },
      });
    }

    // Clear the customer's active cart — but ONLY the lines that belong to THIS order, so anything
    // they added after placing (a fresh shopping session before a late confirmation lands) survives.
    const variantIds = order.items
      .map((i) => i.variantId)
      .filter((v): v is string => !!v);
    if (variantIds.length > 0) {
      await tx.cartItem.deleteMany({
        where: { userId: order.customerId, savedForLater: false, variantId: { in: variantIds } },
      });
    }

    return true;
  });

  if (flipped) {
    // Invoice now that payment is confirmed (best-effort; must never block confirmation).
    generateOrderInvoice(orderId).catch((e) => console.error("Invoice generation failed:", e));
  }
  return flipped;
}
