import prisma from "../lib/prisma.js";
import { createRazorpayOrder, isRazorpayConfigured } from "./razorpay.js";
import { AppError } from "../lib/errors.js";

export interface CreateTopupResult {
  topupId: string;
  razorpayOrderId: string;
  amountPaise: number;
}

/**
 * Starts a customer wallet top-up: validates the amount against StoreConfig bounds, creates a
 * PENDING WalletTopup row + a Razorpay order, and returns the ids for the app to open Razorpay.
 * The credit is applied LATER by creditTopup (via /pay, the webhook, or reconciliation) — never
 * here — so a closed app can't lose the money (the webhook still credits it).
 */
export async function createTopup(userId: string, amount: number): Promise<CreateTopupResult> {
  if (!isRazorpayConfigured()) {
    throw new AppError(400, "PAYMENT_UNAVAILABLE", "Online payments are not configured.");
  }
  const cfg = await prisma.storeConfig.findFirst();
  const min = cfg?.walletTopupMin ?? 50;
  const max = cfg?.walletTopupMax ?? 10000;
  const amt = Math.round(amount);
  if (!Number.isFinite(amt) || amt < min || amt > max) {
    throw new AppError(400, "INVALID_AMOUNT", `Top-up must be between ₹${min} and ₹${max}.`);
  }

  const topup = await prisma.walletTopup.create({
    data: { userId, amount: amt, status: "PENDING" },
  });

  const amountPaise = amt * 100;
  const rp = await createRazorpayOrder(amountPaise, `topup_${topup.id}`);
  await prisma.walletTopup.update({ where: { id: topup.id }, data: { razorpayOrderId: rp.id } });

  return { topupId: topup.id, razorpayOrderId: rp.id, amountPaise };
}

/**
 * Credits a confirmed top-up to the user's wallet. Idempotent via a guarded PENDING→PAID flip:
 * concurrent confirmations (the app's /pay AND the Razorpay webhook) race on updateMany WHERE
 * status=PENDING; only the winner (count===1) increments the balance + writes the TOPUP ledger row.
 * Returns true if THIS call applied the credit.
 */
export async function creditTopup(topupId: string, razorpayPaymentId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const flip = await tx.walletTopup.updateMany({
      where: { id: topupId, status: "PENDING" },
      data: { status: "PAID", razorpayPaymentId },
    });
    if (flip.count === 0) return false;

    const topup = await tx.walletTopup.findUnique({
      where: { id: topupId },
      select: { userId: true, amount: true },
    });
    if (!topup) return false;

    const u = await tx.user.update({
      where: { id: topup.userId },
      data: { walletBalance: { increment: topup.amount } },
      select: { walletBalance: true },
    });
    await tx.walletTransaction.create({
      data: {
        userId: topup.userId,
        amount: topup.amount,
        type: "TOPUP",
        balanceAfter: u.walletBalance,
        note: "Wallet top-up",
      },
    });
    return true;
  });
}

/** Webhook/reconcile entry: credit a top-up identified by its Razorpay order id. No-op if unknown. */
export async function creditTopupByRazorpayOrder(
  razorpayOrderId: string,
  razorpayPaymentId: string,
): Promise<boolean> {
  const topup = await prisma.walletTopup.findUnique({
    where: { razorpayOrderId },
    select: { id: true },
  });
  if (!topup) return false;
  return creditTopup(topup.id, razorpayPaymentId);
}
