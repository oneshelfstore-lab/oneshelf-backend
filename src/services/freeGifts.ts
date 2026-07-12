import type { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { AppError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import { consumeFifo } from "./stockBatches.js";
import { memoCache } from "../lib/httpCache.js";

function isLooseType(productType: string): boolean {
  return productType === "LOOSE" || productType === "PRODUCE";
}

/** One qualifying "buy N, get M free" line — computed against the current cart. */
export interface FreeGiftLine {
  offerId: string;
  triggerVariantId: string;
  rewardVariantId: string;
  // How many of the reward variant's own sellable increments this cart earns (already multiplied
  // by however many times triggerQty was crossed — e.g. 2× a 10kg bag with triggerQty=1 → 2 free
  // 1kg bags if rewardQty=1).
  rewardQty: number;
  rewardName: string;
  rewardNameHi: string | null;
  rewardImageUrl: string | null;
  rewardSku: string;
  rewardHsnCode: string | null;
  rewardGstRate: number;
  rewardIsLoose: boolean;
  rewardStepSize: number | null; // base-unit size of ONE increment, loose only
  rewardStepUnit: string | null;
  rewardPackageUnit: string;
}

interface CartLineLike {
  variantId: string;
  quantity: number;
}

/**
 * Preview computation — which free-gift offers does this cart currently qualify for, and how much
 * of each reward. Called from calculateCartTotals (powers both /cart/quote and order placement, so
 * the cart preview and the real order never drift — same principle as bogoDiscount/bulk pricing).
 * Does NOT touch stock — that's enforced only at real placement (drawFreeGiftStock below),
 * same "preview optimistic, placement authoritative" split as distance-delivery's outOfRange.
 */
export async function computeFreeGiftLines(cartItems: CartLineLike[]): Promise<FreeGiftLine[]> {
  if (cartItems.length === 0) return [];
  const qtyByVariant = new Map<string, number>();
  for (const item of cartItems) {
    qtyByVariant.set(item.variantId, (qtyByVariant.get(item.variantId) ?? 0) + item.quantity);
  }

  const offers = await memoCache.get("freeGiftOffers:active", 60_000, () =>
    prisma.freeGiftOffer.findMany({
      where: { isActive: true, triggerVariantId: { in: [...qtyByVariant.keys()] } },
      select: {
        id: true,
        triggerVariantId: true,
        triggerQty: true,
        rewardQty: true,
        rewardVariant: {
          select: {
            id: true,
            sku: true,
            packageSize: true,
            packageUnit: true,
            gstRateOverride: true,
            product: { select: { name: true, nameHi: true, imageUrls: true, hsnCode: true, gstRate: true, productType: true } },
          },
        },
      },
    }),
  );

  const lines: FreeGiftLine[] = [];
  for (const offer of offers) {
    const qty = qtyByVariant.get(offer.triggerVariantId) ?? 0;
    const multiples = Math.floor(qty / offer.triggerQty);
    if (multiples <= 0) continue;
    const rv = offer.rewardVariant;
    const isLoose = isLooseType(rv.product.productType);
    // Same precedence cartPricing.ts's resolveGstRate uses: variant override wins, else the
    // product's own rate, else 0.
    const gstRate = rv.gstRateOverride != null ? Number(rv.gstRateOverride) : Number(rv.product.gstRate ?? 0);
    lines.push({
      offerId: offer.id,
      triggerVariantId: offer.triggerVariantId,
      rewardVariantId: rv.id,
      rewardQty: multiples * offer.rewardQty,
      rewardName: rv.product.name,
      rewardNameHi: rv.product.nameHi,
      rewardImageUrl: rv.product.imageUrls?.[0] ?? null,
      rewardSku: rv.sku,
      rewardHsnCode: rv.product.hsnCode,
      rewardGstRate: gstRate,
      rewardIsLoose: isLoose,
      rewardStepSize: isLoose ? Number(rv.packageSize) : null,
      rewardStepUnit: isLoose ? rv.packageUnit : null,
      rewardPackageUnit: rv.packageUnit,
    });
  }
  return lines;
}

/** Same shape orders.ts already builds for cart-derived OrderItem rows — reused so the free-gift
 *  rows slot into the exact same `items: { create: [...] }` / sub-order-splitting code path. */
export interface FreeGiftOrderItemInput {
  variantId: string;
  productName: string;
  variantSku: string;
  imageUrl: string | null;
  hsnCode: string | null;
  unitPrice: number;
  mrp: number;
  costPriceSnapshot: number | null;
  quantity: number;
  gstRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  lineTotal: number;
  isLoose: boolean;
  stepSize: number | null;
  stepUnit: string | null;
  packageUnit: string;
  sellerId: string;
  isFreeGift: true;
  freeGiftOfferId: string;
}

/**
 * Transaction-time step: atomically draw FIFO stock for each qualifying free-gift line's reward
 * variant and build the OrderItem input rows for it — capped by whatever's actually on the shelf.
 * A reward that's out of stock (or only partially available) is silently skipped/capped rather than
 * failing the whole order — a free bonus item must never be the reason a real purchase can't go
 * through (same philosophy as rollFreeSample's "OOS → skip, never throw").
 *
 * Returns the OrderItem inputs (NOT yet created) plus a matching consumption result per input, keyed
 * by ARRAY INDEX (not variantId — two lines could target the same reward variant, or a reward could
 * coincide with something already in the cart, so variantId is not a safe key here).
 */
export async function drawFreeGiftStock(
  tx: Prisma.TransactionClient,
  lines: FreeGiftLine[],
): Promise<{ input: FreeGiftOrderItemInput; consumed: { batchId: string; qty: number; unitCost: number }[] }[]> {
  const out: { input: FreeGiftOrderItemInput; consumed: { batchId: string; qty: number; unitCost: number }[] }[] = [];

  for (const line of lines) {
    if (line.rewardQty <= 0) continue;
    const baseQtyNeeded = line.rewardIsLoose && line.rewardStepSize != null
      ? line.rewardQty * line.rewardStepSize
      : line.rewardQty;

    let result;
    try {
      result = await consumeFifo(tx, line.rewardVariantId, baseQtyNeeded);
    } catch (e) {
      if (e instanceof AppError && e.code === "INSUFFICIENT_STOCK") continue; // skip this gift, never block the order
      throw e;
    }

    out.push({
      input: {
        variantId: line.rewardVariantId,
        productName: line.rewardName,
        variantSku: line.rewardSku,
        imageUrl: line.rewardImageUrl,
        hsnCode: line.rewardHsnCode,
        unitPrice: 0,
        mrp: 0,
        costPriceSnapshot: result.totalQty > 0 ? result.weightedUnitCost : null,
        quantity: line.rewardQty,
        gstRate: line.rewardGstRate,
        taxableValue: 0,
        cgst: 0,
        sgst: 0,
        lineTotal: 0,
        isLoose: line.rewardIsLoose,
        stepSize: line.rewardStepSize,
        stepUnit: line.rewardStepUnit,
        packageUnit: line.rewardPackageUnit,
        sellerId: "", // filled in by the caller once the house seller id is resolved
        isFreeGift: true,
        freeGiftOfferId: line.offerId,
      },
      consumed: result.consumed,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// Offer CRUD — shared by BOTH admin routers that manage offers:
// routes/ownerFreeGifts.ts (owner) and routes/sellerFreeGifts.ts (the
// house co-manager). Both only ever touch house products (validated
// below), so one implementation serves both — the routers differ only in
// their auth stack (owner role vs. seller role + sellerIsHouse gate).
// ═══════════════════════════════════════════════════════════════════════

export const freeGiftOfferSchema = z.object({
  triggerVariantId: z.string().min(1),
  triggerQty: z.number().int().min(1).max(999),
  rewardVariantId: z.string().min(1),
  rewardQty: z.number().int().min(1).max(999),
  isActive: z.boolean().default(true),
});

export const freeGiftOfferInclude = {
  triggerVariant: { select: { id: true, sku: true, packageSize: true, packageUnit: true, product: { select: { name: true, imageUrls: true } } } },
  rewardVariant: { select: { id: true, sku: true, packageSize: true, packageUnit: true, product: { select: { name: true, imageUrls: true } } } },
} as const;

/** Both variants must exist, be distinct, and belong to the HOUSE catalog (null sellerId ⇒ a
 *  pre-backfill/legacy product, treated as house everywhere else in this codebase too). */
export async function validateFreeGiftVariantPair(triggerVariantId: string, rewardVariantId: string): Promise<void> {
  if (triggerVariantId === rewardVariantId) {
    throw new ValidationError("The reward can't be the same product as the trigger.");
  }
  const [trigger, reward] = await Promise.all([
    prisma.productVariant.findUnique({
      where: { id: triggerVariantId },
      select: { id: true, product: { select: { sellerId: true, seller: { select: { isHouse: true } } } } },
    }),
    prisma.productVariant.findUnique({
      where: { id: rewardVariantId },
      select: { id: true, product: { select: { sellerId: true, seller: { select: { isHouse: true } } } } },
    }),
  ]);
  if (!trigger) throw new NotFoundError("Product variant", triggerVariantId);
  if (!reward) throw new NotFoundError("Product variant", rewardVariantId);

  const isHouse = (v: typeof trigger) => v.product.sellerId == null || v.product.seller?.isHouse === true;
  if (!isHouse(trigger) || !isHouse(reward)) {
    throw new ValidationError("Free-gift offers only work between the store's own (house) products for now.");
  }
}

export function listFreeGiftOffers() {
  return prisma.freeGiftOffer.findMany({ include: freeGiftOfferInclude, orderBy: { createdAt: "desc" } });
}

export async function createFreeGiftOfferRecord(data: z.infer<typeof freeGiftOfferSchema>) {
  await validateFreeGiftVariantPair(data.triggerVariantId, data.rewardVariantId);
  const existing = await prisma.freeGiftOffer.findUnique({ where: { triggerVariantId: data.triggerVariantId } });
  if (existing) throw new ConflictError("This product already has a free-gift offer — edit or delete it instead.");
  const offer = await prisma.freeGiftOffer.create({ data, include: freeGiftOfferInclude });
  memoCache.bust("freeGiftOffers");
  return offer;
}

export async function updateFreeGiftOfferRecord(id: string, data: Partial<z.infer<typeof freeGiftOfferSchema>>) {
  const existingOffer = await prisma.freeGiftOffer.findUnique({ where: { id } });
  if (!existingOffer) throw new NotFoundError("Free-gift offer", id);

  const triggerVariantId = data.triggerVariantId ?? existingOffer.triggerVariantId;
  const rewardVariantId = data.rewardVariantId ?? existingOffer.rewardVariantId;
  await validateFreeGiftVariantPair(triggerVariantId, rewardVariantId);

  if (triggerVariantId !== existingOffer.triggerVariantId) {
    const dup = await prisma.freeGiftOffer.findUnique({ where: { triggerVariantId } });
    if (dup) throw new ConflictError("This product already has a free-gift offer — edit or delete it instead.");
  }

  const offer = await prisma.freeGiftOffer.update({ where: { id }, data, include: freeGiftOfferInclude });
  memoCache.bust("freeGiftOffers");
  return offer;
}

export async function deleteFreeGiftOfferRecord(id: string): Promise<void> {
  const existing = await prisma.freeGiftOffer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Free-gift offer", id);
  await prisma.freeGiftOffer.delete({ where: { id } });
  memoCache.bust("freeGiftOffers");
}
