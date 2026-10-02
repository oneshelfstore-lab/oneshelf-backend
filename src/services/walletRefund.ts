import prisma from "../lib/prisma.js";

/**
 * Refund store credit when a wallet-paying order is cancelled. Idempotent via the
 * WalletTransaction @@unique([orderId, "ORDER_REFUND"]) — a second call throws P2002, which rolls
 * back the balance increment too (so the refund is applied exactly once). Best-effort caller.
 */
export async function refundWalletOnCancel(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, customerId: true, walletApplied: true, status: true },
  });
  const amt = Number(order?.walletApplied ?? 0);
  // Require CANCELLED so this is safe to call unconditionally (e.g. from the expiry sweeper loop):
  // it no-ops on still-active orders even though they may carry walletApplied.
  if (!order || order.status !== "CANCELLED" || amt <= 0) return;

  try {
    await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: order.customerId },
        data: { walletBalance: { increment: amt } },
        select: { walletBalance: true },
      });
      await tx.walletTransaction.create({
        data: {
          userId: order.customerId,
          amount: amt,
          type: "ORDER_REFUND",
          balanceAfter: u.walletBalance,
          orderId: order.id,
          note: "Refund — order cancelled",
        },
      });
    });
  } catch (e: any) {
    // P2002 on @@unique([orderId, type]) → already refunded → idempotent no-op.
    if (e?.code !== "P2002") {
      console.error(JSON.stringify({ level: "error", msg: "wallet refund failed", orderId, err: String(e) }));
    }
  }
}
