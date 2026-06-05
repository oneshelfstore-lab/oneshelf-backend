import prisma from "../lib/prisma.js";

// Online/UPI orders decrement stock at placement (to hold it during payment). If the
// customer never completes payment (abandons the Razorpay sheet, app crash), that stock
// would be held forever. This sweeper auto-cancels stale unpaid online orders and
// restores their stock.
//
// NOTE: This does NOT issue refunds — by definition these orders were never paid
// (paymentStatus PENDING, no razorpayPaymentId). The separate orphan-payment case
// (money captured by Razorpay but /pay never reached the server) still needs a Razorpay
// webhook + reconciliation job; that is intentionally out of scope here.

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
            ? item.quantity * Number(item.stepSize)
            : item.quantity;
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
