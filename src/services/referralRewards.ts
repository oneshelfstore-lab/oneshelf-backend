import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { notifyReferralReward } from "./fcmNotifier.js";

// Unambiguous code chars (no 0/O/1/I) — same convention as the scratch-card mint.
function randomSuffix(len = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Mint the referee's single-use WELCOME coupon (FLAT ₹ off, min-order gated, ~30-day expiry).
 * Called inside the /referral/apply transaction. Reuses the existing Coupon system, so the coupon
 * surfaces in the Coupons screen and validates at checkout with zero extra logic. The code is
 * random + returned only to the referee (same exposure model as the scratch-card coupons).
 */
export async function mintReferralWelcomeCoupon(
  tx: Prisma.TransactionClient,
  opts: { amount: number; minOrder: number; expiryDays: number },
): Promise<{ code: string; amount: number; minOrder: number; expiresAt: Date }> {
  const code = `REFER-WELCOME-${randomSuffix()}`;
  const expiresAt = new Date(Date.now() + opts.expiryDays * 24 * 60 * 60 * 1000);
  await tx.coupon.create({
    data: {
      code,
      couponType: "FLAT",
      value: opts.amount,
      minOrder: opts.minOrder,
      isActive: true,
      validUntil: expiresAt,
      usageLimit: 1,
      perUserLimit: 1,
      description: "Welcome — referral reward",
    },
  });
  return { code, amount: opts.amount, minOrder: opts.minOrder, expiresAt };
}

/**
 * Credit the REFERRER ₹X store credit when their referee's FIRST order is delivered.
 *
 * Idempotent — keyed by Referral.status PENDING→REWARDED (guarded updateMany) + qualifyingOrderId
 * @unique + WalletTransaction is written in the same tx. Best-effort caller; safe to invoke from all
 * three DELIVERED paths (delivery agent / owner / admin) and from concurrent retries.
 *
 * No reversal path exists by design: a DELIVERED order can never be cancelled (cancel only allows
 * PLACED/CONFIRMED), so this trigger is monotonic.
 */
export async function creditReferrerOnFirstDelivered(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, customerId: true, status: true, createdAt: true },
  });
  if (!order || order.status !== "DELIVERED") return;

  // Only proceed if this customer is a referee with a still-PENDING referral.
  const referral = await prisma.referral.findUnique({
    where: { refereeId: order.customerId },
    select: { id: true, status: true, referrerId: true },
  });
  if (!referral || referral.status !== "PENDING") return;

  // "First delivered order" = no earlier DELIVERED order for this referee.
  const priorDelivered = await prisma.order.count({
    where: {
      customerId: order.customerId,
      status: "DELIVERED",
      id: { not: order.id },
      createdAt: { lt: order.createdAt },
    },
  });
  if (priorDelivered > 0) return;

  const cfg = await prisma.storeConfig.findFirst();
  if (cfg && cfg.referralEnabled === false) return;
  const amount = Number(cfg?.referralRewardAmount ?? 50);
  if (amount <= 0) return;

  await prisma.$transaction(async (tx) => {
    // Guarded flip — the single idempotency gate. A concurrent path that already flipped it loses
    // here (count === 0) and bails, so the credit is applied exactly once.
    const bumped = await tx.referral.updateMany({
      where: { id: referral.id, status: "PENDING" },
      data: {
        status: "REWARDED",
        qualifyingOrderId: order.id,
        rewardAmount: amount,
        rewardedAt: new Date(),
      },
    });
    if (bumped.count === 0) return;

    const updated = await tx.user.update({
      where: { id: referral.referrerId },
      data: { walletBalance: { increment: amount } },
      select: { walletBalance: true },
    });
    await tx.walletTransaction.create({
      data: {
        userId: referral.referrerId,
        amount,
        type: "REFERRAL_CREDIT",
        balanceAfter: updated.walletBalance,
        referralId: referral.id,
        note: "Referral reward",
      },
    });
  });

  notifyReferralReward(referral.referrerId, amount).catch(() => {});
}

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
