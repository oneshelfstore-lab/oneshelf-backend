import prisma from "../lib/prisma.js";

/**
 * Roll a free sample at order placement. Gated by ALL of:
 *  - delight engine on
 *  - monthly budget not exhausted (conservative count × maxValue cap)
 *  - the dice (sampleChancePct)
 *  - at least one eligible, in-stock, value-capped product exists
 * Marking products sample-eligible is the owner's on-switch; sampleChancePct/maxValue/budget bound cost.
 * Idempotent (skips if the order already has a sample). Stock is decremented atomically.
 */
export async function rollFreeSample(orderId: string): Promise<void> {
  const config = await prisma.storeConfig.findFirst();
  if (config && !config.delightEnabled) return;
  const chance = config?.sampleChancePct ?? 12;
  const maxValue = config?.sampleMaxValue ?? 50;
  const budget = config?.monthlySampleBudget ?? 500;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { freeSampleVariantId: true },
  });
  if (!order || order.freeSampleVariantId) return; // idempotent

  // Monthly budget: cap the COUNT of samples so worst-case spend (count × maxValue) ≤ budget.
  if (maxValue > 0) {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const monthCount = await prisma.order.count({
      where: { freeSampleVariantId: { not: null }, createdAt: { gte: startOfMonth } },
    });
    if (monthCount >= Math.floor(budget / maxValue)) return;
  }

  if (Math.random() * 100 >= chance) return; // no sample this order

  // Eligible candidates: owner-flagged, active, in stock, value-capped, and unit-stocked
  // (exclude loose/produce — decrementing 1 base unit isn't a "sample").
  const candidates = await prisma.productVariant.findMany({
    where: {
      isActive: true,
      stock: { gt: 0 },
      sellingPrice: { lte: maxValue },
      product: { isActive: true, isSampleEligible: true, productType: { notIn: ["LOOSE", "PRODUCE"] } },
    },
    select: { id: true, product: { select: { name: true, imageUrls: true } } },
    take: 40,
  });
  if (candidates.length === 0) return;

  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;

  // Atomic decrement (guard against a race with a real purchase of the last unit).
  const dec = await prisma.productVariant.updateMany({
    where: { id: pick.id, stock: { gte: 1 } },
    data: { stock: { decrement: 1 } },
  });
  if (dec.count === 0) return;

  await prisma.order.update({
    where: { id: orderId },
    data: {
      freeSampleVariantId: pick.id,
      freeSampleName: pick.product.name,
      freeSampleImageUrl: pick.product.imageUrls?.[0] ?? null,
    },
  });
}

interface SampleOrderFields {
  freeSampleName: string | null;
  freeSampleImageUrl: string | null;
  freeSamplePacked: boolean;
}

/**
 * Customer-facing reveal — NAMED only after the owner confirms it's physically in the bag.
 * Before that we return null (no promise): the gate that keeps the feature honest.
 */
export function getFreeSampleReveal(order: SampleOrderFields) {
  if (order.freeSampleName && order.freeSamplePacked) {
    return { packed: true, name: order.freeSampleName, imageUrl: order.freeSampleImageUrl };
  }
  return null;
}

/** Owner confirms the sample is in the bag → unlocks the customer reveal. Idempotent. */
export async function markSamplePacked(orderId: string): Promise<boolean> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { freeSampleVariantId: true },
  });
  if (!order || !order.freeSampleVariantId) return false; // nothing to pack
  await prisma.order.update({ where: { id: orderId }, data: { freeSamplePacked: true } });
  return true;
}
