import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { ValidationError } from "../lib/errors.js";

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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** "2026-07" for the IST calendar date of `d` — the ReferralCommission/ReferralPayout grouping key. */
export function istMonthKey(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Masks a full name for public display: keeps the first name, reduces the rest to initials.
 *  "Rahul Sharma" → "Rahul S.", "Rahul Kumar Sharma" → "Rahul K. S.", "Rahul" → "Rahul". */
export function maskName(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Someone";
  if (parts.length === 1) return parts[0]!;
  const initials = parts.slice(1).map((p) => `${p[0]!.toUpperCase()}.`).join(" ");
  return `${parts[0]} ${initials}`;
}

/** True once `now` is at least `months` calendar-months past `anchor` (IST). months<=0 = no cap. */
export function isPastCommissionWindow(anchor: Date, months: number, now: Date): boolean {
  if (months <= 0) return false;
  const cutoff = new Date(anchor.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() + months);
  return now.getTime() > cutoff.getTime();
}

/**
 * Accrue the REFERRER's ongoing commission (StoreConfig.referralCommissionPct % of the order
 * subtotal) on every DELIVERED order placed by their referee, for up to
 * StoreConfig.referralCommissionMonths from the day the referral was applied.
 *
 * Idempotent — ReferralCommission.orderId is @unique; a re-run's insert throws P2002 and is
 * swallowed as a no-op (same pattern as refundWalletOnCancel below). Best-effort caller; safe to
 * invoke from all three DELIVERED paths (delivery agent / owner / admin) and from concurrent retries.
 * No reversal path by design: a DELIVERED order can never be cancelled.
 */
export async function accrueReferralCommission(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, customerId: true, status: true, subtotal: true },
  });
  if (!order || order.status !== "DELIVERED") return;

  const customer = await prisma.user.findUnique({
    where: { id: order.customerId },
    select: { referredById: true },
  });
  if (!customer?.referredById) return;

  const referral = await prisma.referral.findUnique({
    where: { refereeId: order.customerId },
    select: { referrerId: true, createdAt: true },
  });
  if (!referral) return;

  const cfg = await prisma.storeConfig.findFirst();
  if (cfg && cfg.referralEnabled === false) return;
  const pct = Number(cfg?.referralCommissionPct ?? 1);
  if (pct <= 0) return;
  const windowMonths = cfg?.referralCommissionMonths ?? 12;
  if (isPastCommissionWindow(referral.createdAt, windowMonths, new Date())) return;

  const amount = round2((Number(order.subtotal) * pct) / 100);
  if (amount <= 0) return;

  try {
    await prisma.referralCommission.create({
      data: {
        referrerId: referral.referrerId,
        refereeId: order.customerId,
        orderId: order.id,
        amount,
        periodMonth: istMonthKey(new Date()),
      },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") {
      console.error(JSON.stringify({ level: "error", msg: "referral commission accrual failed", orderId, err: String(e) }));
    }
  }
}

/**
 * Group every unpaid ReferralCommission by (referrer, periodMonth) for months that have fully
 * elapsed (any month before the current IST month), and settle each group into one ReferralPayout.
 * A referrer with no bank details on file is skipped for now — their commissions just keep
 * accumulating unpaid until they add bank details; nothing is lost, nothing fails. No money moves
 * here; the owner works the resulting PENDING queue by hand (Referral Payouts screen → "Mark paid").
 */
export async function closeMonthlyReferralPayouts(now: Date = new Date()): Promise<{ created: number }> {
  const currentMonth = istMonthKey(now);

  const unpaid = await prisma.referralCommission.findMany({
    where: { payoutId: null, periodMonth: { lt: currentMonth } },
    select: {
      id: true,
      referrerId: true,
      periodMonth: true,
      amount: true,
      referrer: {
        select: { referralBankAccountName: true, referralBankAccountNumber: true, referralBankIfsc: true },
      },
    },
  });
  if (unpaid.length === 0) return { created: 0 };

  const groups = new Map<string, typeof unpaid>();
  for (const row of unpaid) {
    const key = `${row.referrerId}::${row.periodMonth}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  let created = 0;
  for (const rows of groups.values()) {
    const first = rows[0]!;
    if (!first.referrer.referralBankAccountNumber) continue; // no bank details yet — leave accruing

    await prisma.$transaction(async (tx) => {
      const payout = await tx.referralPayout.create({
        data: {
          referrerId: first.referrerId,
          periodMonth: first.periodMonth,
          amount: rows.reduce((sum, r) => sum + Number(r.amount), 0),
          bankAccountName: first.referrer.referralBankAccountName,
          bankAccountNumber: first.referrer.referralBankAccountNumber,
          bankIfsc: first.referrer.referralBankIfsc,
        },
      });
      await tx.referralCommission.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { payoutId: payout.id },
      });
    });
    created += 1;
  }
  return { created };
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

/** Sum of a referrer's commission not yet grouped into any payout — their withdrawable balance. */
export async function getAvailableReferralBalance(userId: string): Promise<number> {
  const agg = await prisma.referralCommission.aggregate({
    _sum: { amount: true },
    where: { referrerId: userId, payoutId: null },
  });
  return round2(Number(agg._sum.amount ?? 0));
}

/**
 * Self-serve withdrawal of a referrer's un-grouped commission balance, on demand.
 *  - WALLET: instant — the amount becomes store credit (usable at checkout) and the payout is
 *    recorded PAID/method=WALLET (auto-settled, no owner action). Needs no bank details.
 *  - BANK:   creates a PENDING/method=BANK payout the owner settles by transfer (mark-paid queue).
 *            Requires bank details on file (snapshotted onto the payout).
 * Consuming the commissions (setting payoutId) is what prevents double-withdrawal.
 * ponytail: no per-user lock — a single user double-tapping is guarded by the client loading state
 *           + the txn; add SELECT FOR UPDATE only if real concurrent-withdrawal abuse shows up.
 */
export async function withdrawReferralBalance(
  userId: string,
  method: "BANK" | "WALLET",
): Promise<{ method: "BANK" | "WALLET"; amount: number; walletBalance: number | null }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.referralCommission.findMany({
      where: { referrerId: userId, payoutId: null },
      select: { id: true, amount: true },
    });
    const amount = round2(rows.reduce((s, r) => s + Number(r.amount), 0));
    if (rows.length === 0 || amount <= 0) {
      throw new ValidationError("No referral balance to withdraw yet.");
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { referralBankAccountName: true, referralBankAccountNumber: true, referralBankIfsc: true },
    });

    if (method === "BANK" && !user?.referralBankAccountNumber) {
      throw new ValidationError("Add your bank account details before requesting a bank payout.");
    }

    const periodMonth = istMonthKey(new Date());
    const payout = await tx.referralPayout.create({
      data: {
        referrerId: userId,
        periodMonth,
        amount,
        method,
        status: method === "WALLET" ? "PAID" : "PENDING",
        paidAt: method === "WALLET" ? new Date() : null,
        bankAccountName: method === "BANK" ? user?.referralBankAccountName : null,
        bankAccountNumber: method === "BANK" ? user?.referralBankAccountNumber : null,
        bankIfsc: method === "BANK" ? user?.referralBankIfsc : null,
      },
    });
    await tx.referralCommission.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { payoutId: payout.id },
    });

    if (method === "WALLET") {
      const u = await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { increment: amount } },
        select: { walletBalance: true },
      });
      await tx.walletTransaction.create({
        data: {
          userId,
          amount,
          type: "REFERRAL_CREDIT",
          balanceAfter: u.walletBalance,
          note: "Referral earnings → store credit",
        },
      });
      return { method, amount, walletBalance: Number(u.walletBalance) };
    }
    return { method, amount, walletBalance: null };
  });
}
