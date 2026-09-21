import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import type { Prisma } from "@prisma/client";

/**
 * Coupon validation and redemption — ONE implementation, shared by the grocery checkout
 * (services/cartPricing.ts) and the food checkout (routes/foodOrders.ts).
 *
 * These two functions used to live inline in cartPricing/orders. They were extracted when food
 * gained coupons, because the alternative was a second copy of a read-then-write that is only safe
 * because of a specific statement order (see redeemCouponInTx) — and a drifted copy of that is
 * silent money.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Validate a coupon and compute its discount against a subtotal.
 *
 * Returns a null `code` when the coupon does not exist, is inactive, expired, under its minimum, or
 * has hit a usage cap — callers treat that as "no coupon", never as an error. (Food is the exception
 * for FREE_DELIVERY: it refuses those explicitly rather than silently ignoring them.)
 */
export async function resolveCoupon(
  couponCode: string | null | undefined,
  subtotal: number,
  userId?: string | null,
): Promise<{ code: string | null; discount: number; isFreeDelivery: boolean }> {
  const none = { code: null, discount: 0, isFreeDelivery: false };
  if (!couponCode) return none;

  const coupon = await prisma.coupon.findUnique({ where: { code: couponCode.toUpperCase() } });
  if (!coupon || !coupon.isActive) return none;

  const now = new Date();
  const inRange = (!coupon.validFrom || coupon.validFrom <= now) &&
    (!coupon.validUntil || coupon.validUntil >= now);
  const meetsMin = subtotal >= Number(coupon.minOrder);
  const underLimit = !coupon.usageLimit || coupon.usageCount < coupon.usageLimit;
  // Per-user cap: how many times this customer has already redeemed it.
  let underPerUser = true;
  if (coupon.perUserLimit && userId) {
    const usedByUser = await prisma.couponRedemption.count({
      where: { couponId: coupon.id, userId },
    });
    underPerUser = usedByUser < coupon.perUserLimit;
  }
  if (!(inRange && meetsMin && underLimit && underPerUser)) return none;

  let discount = 0;
  if (coupon.couponType === "PERCENT") {
    discount = round2(subtotal * Number(coupon.value) / 100);
    if (coupon.maxDiscount) discount = Math.min(discount, Number(coupon.maxDiscount));
  } else if (coupon.couponType === "FLAT") {
    discount = Math.min(Number(coupon.value), subtotal);
  }
  // FREE_DELIVERY carries no line discount — it is applied to the delivery fee by the caller.
  return { code: coupon.code, discount, isFreeDelivery: coupon.couponType === "FREE_DELIVERY" };
}

/**
 * Burn one redemption of `couponCode` for `userId` against `orderId`. Call INSIDE the placement
 * transaction.
 *
 * ⚠️ LOAD-BEARING STATEMENT ORDER — the coupon UPDATE must stay above the per-user count, and must
 * stay unconditional. The per-user check is a read-then-write (count, then create), which in
 * isolation races: two concurrent checkouts would both read the pre-insert count and both redeem.
 * What makes it safe is that the UPDATE takes a row-level exclusive lock on the coupon, held to
 * commit — a second checkout on the SAME coupon blocks there, and under READ COMMITTED its later
 * COUNT(*) takes a fresh snapshot that sees the first transaction's committed redemption row. So
 * the lock, not a unique constraint, is the serialisation.
 *
 * Which means: reordering these statements, or skipping the increment on some path (e.g. "only bump
 * usageCount when usageLimit is set"), silently reopens the race with no test failing. If this ever
 * needs restructuring, add @@unique([couponId, userId]) on CouponRedemption and catch P2002 instead
 * — but check for existing duplicate rows first, since a perUserLimit > 1 coupon legitimately has
 * several per user.
 */
export async function redeemCouponInTx(
  tx: Prisma.TransactionClient,
  couponCode: string | null | undefined,
  userId: string,
  orderId: string,
): Promise<void> {
  if (!couponCode) return;
  const coupon = await tx.coupon.findUnique({ where: { code: couponCode } });
  if (!coupon) return;

  const bumped = await tx.coupon.updateMany({
    where: coupon.usageLimit == null
      ? { id: coupon.id }
      : { id: coupon.id, usageCount: { lt: coupon.usageLimit } },
    data: { usageCount: { increment: 1 } },
  });
  if (bumped.count === 0) {
    throw new AppError(400, "COUPON_LIMIT", "This coupon has reached its usage limit.");
  }

  if (coupon.perUserLimit != null) {
    const usedByUser = await tx.couponRedemption.count({
      where: { couponId: coupon.id, userId },
    });
    if (usedByUser >= coupon.perUserLimit) {
      throw new AppError(400, "COUPON_LIMIT", "You have already used this coupon the maximum number of times.");
    }
  }

  await tx.couponRedemption.create({
    data: { couponId: coupon.id, userId, orderId },
  });
}
