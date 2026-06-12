import prisma from "../lib/prisma.js";

/** Weighted pick. A real NONE weight keeps wins variable (not an entitlement). */
function pickOutcome(none: number, fd: number, flat: number): "NONE" | "FREE_DELIVERY_NEXT" | "FLAT_OFF" {
  const total = Math.max(1, none + fd + flat);
  let r = Math.random() * total;
  if ((r -= none) < 0) return "NONE";
  if ((r -= fd) < 0) return "FREE_DELIVERY_NEXT";
  return "FLAT_OFF";
}

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `SCRATCH-${s}`;
}

function rewardLabel(type: string, value: number | null): string {
  switch (type) {
    case "FREE_DELIVERY_NEXT":
      return "Free delivery on your next order";
    case "FLAT_OFF":
      return `₹${value ?? 0} off your next order`;
    default:
      return "No win this time — try again next order";
  }
}

/**
 * Roll the scratch outcome ONCE at order placement (idempotent, keyed by orderId). No-op if the
 * delight engine is off or a card already exists — so re-opening the celebration screen never re-rolls.
 */
export async function rollScratchReward(orderId: string, userId: string): Promise<void> {
  const config = await prisma.storeConfig.findFirst();
  if (config && !config.delightEnabled) return;
  const existing = await prisma.scratchReward.findUnique({ where: { orderId } });
  if (existing) return;

  const none = config?.scratchNoneWeight ?? 55;
  const fd = config?.scratchFreeDeliveryWeight ?? 30;
  const flat = config?.scratchFlatOffWeight ?? 15;
  const flatValue = config?.scratchFlatOffValue ?? 20;
  const type = pickOutcome(none, fd, flat);

  await prisma.scratchReward.create({
    data: {
      orderId,
      userId,
      type,
      value: type === "FLAT_OFF" ? flatValue : null,
      status: "UNSCRATCHED",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
}

/** Celebration payload. Reveal the outcome only once scratched — preserve the surprise. */
export async function getScratchForCelebration(orderId: string) {
  const r = await prisma.scratchReward.findUnique({ where: { orderId } });
  if (!r) return null;
  if (r.status === "UNSCRATCHED") {
    return { status: "UNSCRATCHED", hasReward: true, type: null, label: null, couponCode: null };
  }
  return {
    status: r.status,
    hasReward: true,
    type: r.type,
    label: rewardLabel(r.type, r.value ? Number(r.value) : null),
    couponCode: r.couponCode,
  };
}

/** Reveal: flip to SCRATCHED and mint a single-use coupon on a win. Idempotent. */
export async function revealScratchReward(orderId: string, userId: string) {
  const r = await prisma.scratchReward.findUnique({ where: { orderId } });
  if (!r || r.userId !== userId) return null;

  // Already revealed → return as-is (idempotent re-scratch).
  if (r.status !== "UNSCRATCHED") {
    return {
      status: r.status,
      type: r.type,
      label: rewardLabel(r.type, r.value ? Number(r.value) : null),
      couponCode: r.couponCode,
    };
  }

  let couponCode: string | null = null;
  if (r.type === "FREE_DELIVERY_NEXT" || r.type === "FLAT_OFF") {
    couponCode = randomCode();
    const expiresAt = r.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.coupon.create({
      data: {
        code: couponCode,
        couponType: r.type === "FREE_DELIVERY_NEXT" ? "FREE_DELIVERY" : "FLAT",
        value: r.type === "FLAT_OFF" ? (r.value ?? 0) : 0,
        minOrder: 0,
        isActive: true,
        validUntil: expiresAt,
        usageLimit: 1,
        perUserLimit: 1,
        description: "Scratch card reward",
      },
    });
  }

  await prisma.scratchReward.update({
    where: { orderId },
    data: { status: "SCRATCHED", couponCode },
  });

  return {
    status: "SCRATCHED",
    type: r.type,
    label: rewardLabel(r.type, r.value ? Number(r.value) : null),
    couponCode,
  };
}
