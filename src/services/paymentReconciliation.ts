import prisma from "../lib/prisma.js";
import { fetchCapturedPaymentForOrder, isRazorpayConfigured, refundPayment } from "./razorpay.js";
import { markOrderPaid } from "./orderPayment.js";

export interface ReconcileResult {
  orderId: string;
  paymentStatus: string; // resulting payment status (PENDING | PAID | REFUND_INITIATED | REFUNDED | UNKNOWN)
  changed: boolean; // did this call change anything?
}

/**
 * Reconciles a single order's payment against Razorpay's API — the belt-and-suspenders recovery for
 * a payment that was captured but whose confirmation never reached us (app killed, network dropped
 * before /pay, webhook missed). For a PENDING online order with a razorpayOrderId, ask Razorpay
 * whether a payment was actually captured; if so, mark the order PAID via the shared idempotent path.
 *
 * Also self-heals the rare "wrongly auto-cancelled but actually paid" case: if a captured payment
 * exists for a CANCELLED order, it initiates a refund so money is never silently kept.
 *
 * Safe + idempotent: no-op for COD / unconfigured-Razorpay / already-PAID / no-captured-payment.
 * Called from POST /orders/:id/reconcile (app reopen) and from the expiry sweeper before cancelling.
 */
export async function reconcileOrderPayment(orderId: string): Promise<ReconcileResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      razorpayOrderId: true,
    },
  });
  if (!order) return { orderId, paymentStatus: "UNKNOWN", changed: false };

  const isOnline = order.paymentMethod === "ONLINE" || order.paymentMethod === "UPI";
  if (!order.razorpayOrderId || !isOnline || !isRazorpayConfigured()) {
    return { orderId, paymentStatus: order.paymentStatus, changed: false };
  }
  if (order.paymentStatus === "PAID") {
    return { orderId, paymentStatus: "PAID", changed: false };
  }

  let captured;
  try {
    captured = await fetchCapturedPaymentForOrder(order.razorpayOrderId);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "reconcile fetch failed", orderId, err: String(e) }));
    return { orderId, paymentStatus: order.paymentStatus, changed: false };
  }
  if (!captured) {
    // Genuinely unpaid — let the normal flow (retry / auto-cancel) proceed.
    return { orderId, paymentStatus: order.paymentStatus, changed: false };
  }

  // Money WAS captured at Razorpay.
  if (order.status === "CANCELLED") {
    // Wrongly cancelled yet actually paid (a capture that landed after auto-cancel). Refund — never
    // keep money for an order we won't fulfil. Skip if already in/through a refund state.
    if (order.paymentStatus === "REFUND_INITIATED" || order.paymentStatus === "REFUNDED") {
      return { orderId, paymentStatus: order.paymentStatus, changed: false };
    }
    try {
      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: "REFUND_INITIATED", razorpayPaymentId: captured.id },
      });
      await refundPayment(captured.id, captured.amount);
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: "REFUNDED" } });
      return { orderId, paymentStatus: "REFUNDED", changed: true };
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "orphan refund failed", orderId, err: String(e) }));
      return { orderId, paymentStatus: "REFUND_INITIATED", changed: true };
    }
  }

  // PENDING + captured → confirm it through the shared idempotent path.
  const changed = await markOrderPaid(order.id, captured.id);
  return { orderId, paymentStatus: "PAID", changed };
}
