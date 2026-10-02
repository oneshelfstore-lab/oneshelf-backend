import prisma from "../lib/prisma.js";
import { notifyRefund } from "./fcmNotifier.js";

/**
 * Tell the customer a Razorpay refund has started / finished.
 *
 * `refundPayment` only knows a payment id, so this finds whose payment it was: a shop order, else a
 * courier booking. A payment that matches neither (a wallet top-up, a bulk quote) is left alone —
 * nobody asked for those refunds from inside this flow. Best-effort by design: a refund that DID
 * happen must never fail because the courtesy message could not be sent.
 */
export async function noticeRefund(paymentId: string, amountPaise: number | undefined, stage: "initiated" | "completed") {
  try {
    const order = await prisma.order.findFirst({
      where: { razorpayPaymentId: paymentId },
      select: { id: true, orderNumber: true, customerId: true, totalAmount: true },
    });
    if (order) {
      const amount = amountPaise != null ? amountPaise / 100 : Number(order.totalAmount);
      await notifyRefund(order.customerId, { orderId: order.id, label: `order #${order.orderNumber}`, amount, stage });
      return;
    }
    const booking = await prisma.courierBooking.findFirst({
      where: { razorpayPaymentId: paymentId },
      select: { number: true, customerId: true, total: true },
    });
    if (booking) {
      const amount = amountPaise != null ? amountPaise / 100 : Number(booking.total);
      await notifyRefund(booking.customerId, { label: `courier booking ${booking.number}`, amount, stage });
    }
  } catch (e) {
    console.error("refund notice failed:", e);
  }
}
