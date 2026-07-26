import prisma from "../lib/prisma.js";
import { createRazorpayOrder, isRazorpayConfigured, fetchCapturedPaymentForOrder } from "./razorpay.js";
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

/**
 * Reconciles this user's unfinished top-ups against Razorpay's API — the third recovery layer, mirroring
 * reconcileOrderPayment for orders. Until this existed the Razorpay webhook was the ONLY thing that could
 * credit a top-up whose /pay confirmation never landed (app killed right after paying, network dropped),
 * so a single missed webhook meant money captured at Razorpay and a balance that never moved, with
 * nothing anywhere retrying.
 *
 * Scoped to the caller's own recent PENDING top-ups rather than taking an id, so the client needs to
 * track nothing — it just asks "did any of my payments actually go through?" on wallet open / app launch.
 * Credit itself goes through the idempotent creditTopup, so racing this with the webhook is safe.
 */
export async function reconcileUserTopups(userId: string): Promise<{ credited: number; balance: number }> {
  let credited = 0;

  if (isRazorpayConfigured()) {
    const pending = await prisma.walletTopup.findMany({
      // razorpayOrderId null ⇒ Razorpay never saw it (creation failed) ⇒ no money to recover.
      where: { userId, status: "PENDING", razorpayOrderId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 5, // ponytail: bounded scan; a user never has a meaningful backlog of unpaid top-ups.
      select: { id: true, razorpayOrderId: true },
    });

    for (const t of pending) {
      try {
        const captured = await fetchCapturedPaymentForOrder(t.razorpayOrderId!);
        if (captured && (await creditTopup(t.id, captured.id))) credited++;
      } catch (e) {
        // Transient Razorpay/network failure — leave it PENDING so the next call (or the webhook)
        // retries. Never throw: this runs on screen-open and must not break the wallet.
        console.error(JSON.stringify({ level: "error", msg: "topup reconcile failed", topupId: t.id, err: String(e) }));
      }
    }
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
  return { credited, balance: Number(user?.walletBalance ?? 0) };
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
