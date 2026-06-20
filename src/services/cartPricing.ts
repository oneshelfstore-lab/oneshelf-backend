import prisma from "../lib/prisma.js";
import { toAppFormat } from "../utils/looseUnitConverter.js";
import { getUserSpend365 } from "./loyalty.js";
import { tierForSpend } from "../data/loyaltyTiers.js";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface CartLineItem {
  variantId: string;
  quantity: number;
  unitPrice: number;
  effectiveUnitPrice: number;
  mrp: number;
  lineTotal: number;
  gstRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  isBulk: boolean;
}

export interface CartTotals {
  items: CartLineItem[];
  subtotal: number;
  discount: number;
  couponCode: string | null;
  deliveryCharge: number;
  taxableValue: number;
  totalCgst: number;
  totalSgst: number;
  totalTax: number;
  totalAmount: number;
  // Total saved vs MRP: Σ max(0, mrp − price)×qty + coupon discount + loyalty discount + delivery waived.
  savedAmount: number;
  // Standing loyalty (tier) member discount applied to this cart, and the tier key that earned it.
  loyaltyDiscount: number;
  loyaltyTier: string | null;
  // Store credit (Phase 2) — a payment tender applied AFTER GST. walletApplied reduces totalAmount
  // (the amount due, never the taxable base); walletAvailable is the user's current balance (for
  // the checkout toggle). Both 0 for anonymous quotes (no userId).
  walletApplied: number;
  walletAvailable: number;
}

interface CartItemWithVariant {
  id: string;
  variantId: string;
  quantity: number;
  variant: {
    id: string;
    productId: string;
    sellingPrice: any;
    mrp: any;
    bulkMinQty: number;
    bulkPrice: any;
    gstRateOverride: any;
    packageSize: any;
    packageUnit: string;
    product: {
      productType: string;
      gstRate: any;
      hsnCode: string | null;
      isPackaged: boolean;
      categoryId: string;
    };
  };
}

function resolveGstRate(item: CartItemWithVariant): number {
  if (item.variant.gstRateOverride != null) return Number(item.variant.gstRateOverride);
  if (item.variant.product.gstRate != null) return Number(item.variant.product.gstRate);
  return 0;
}

function isLooseType(productType: string): boolean {
  return productType === "LOOSE" || productType === "PRODUCE";
}

export async function calculateCartTotals(
  cartItems: CartItemWithVariant[],
  couponCode?: string | null,
  userId?: string | null,
  fulfillmentType?: string | null,
  walletCredit?: number | null,
): Promise<CartTotals> {
  const lines: CartLineItem[] = [];

  for (const item of cartItems) {
    const isLoose = isLooseType(item.variant.product.productType);
    const converted = toAppFormat(item.variant, isLoose);
    const unitPrice = converted.sellingPrice;

    const isBulk = item.variant.bulkMinQty > 0 &&
      item.quantity >= item.variant.bulkMinQty &&
      converted.bulkPrice != null;

    const effectiveUnitPrice = isBulk ? converted.bulkPrice! : unitPrice;
    const lineTotal = round2(effectiveUnitPrice * item.quantity);
    const gstRate = resolveGstRate(item);

    // GST-inclusive back-calculation: taxable = gross / (1 + rate)
    const taxableValue = gstRate > 0 ? round2(lineTotal / (1 + gstRate / 100)) : lineTotal;
    const totalItemTax = round2(lineTotal - taxableValue);
    const cgst = round2(totalItemTax / 2);
    const sgst = round2(totalItemTax - cgst);

    lines.push({
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice,
      effectiveUnitPrice,
      mrp: converted.mrp,
      lineTotal,
      gstRate,
      taxableValue,
      cgst,
      sgst,
      isBulk,
    });
  }

  const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));

  // Coupon
  let discount = 0;
  let appliedCoupon: string | null = null;

  if (couponCode) {
    const coupon = await prisma.coupon.findUnique({ where: { code: couponCode.toUpperCase() } });
    if (coupon && coupon.isActive) {
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

      if (inRange && meetsMin && underLimit && underPerUser) {
        appliedCoupon = coupon.code;
        if (coupon.couponType === "PERCENT") {
          discount = round2(subtotal * Number(coupon.value) / 100);
          if (coupon.maxDiscount) discount = Math.min(discount, Number(coupon.maxDiscount));
        } else if (coupon.couponType === "FLAT") {
          discount = Math.min(Number(coupon.value), subtotal);
        }
        // FREE_DELIVERY handled below
      }
    }
  }

  // Loyalty tier perks (member free delivery + standing % member discount). One lightweight
  // aggregate query when a user is known; absent for anonymous quotes. Spend-based tier.
  let loyaltyDiscount = 0;
  let loyaltyTier: string | null = null;
  let tierFreeDelivery = false;
  if (userId) {
    const tier = tierForSpend(await getUserSpend365(userId));
    loyaltyTier = tier.key;
    tierFreeDelivery = tier.freeDelivery;
    if (tier.discountPct > 0) {
      // Applied on the post-coupon subtotal so the two discounts don't compound oddly.
      loyaltyDiscount = round2((subtotal - discount) * tier.discountPct / 100);
    }
  }

  // Delivery charge
  const storeConfig = await prisma.storeConfig.findFirst();
  const freeDeliveryAbove = storeConfig ? Number(storeConfig.freeDeliveryAbove) : 500;
  const standardDelivery = storeConfig ? Number(storeConfig.deliveryCharge) : 30;
  const isFreeDelivery = appliedCoupon &&
    (await prisma.coupon.findUnique({ where: { code: appliedCoupon } }))?.couponType === "FREE_DELIVERY";

  let deliveryCharge = 0;
  const isPickup = fulfillmentType === "PICKUP";
  // Pickup never incurs a delivery charge. Otherwise charge the store's standard fee unless the
  // order qualifies for free delivery (threshold, FREE_DELIVERY coupon, or a member tier perk).
  if (!isPickup && subtotal < freeDeliveryAbove && !isFreeDelivery && !tierFreeDelivery) {
    deliveryCharge = standardDelivery; // single source of truth: store config
  }

  const afterDiscount = round2(subtotal - discount - loyaltyDiscount);

  // Recalculate totals
  const totalTaxable = round2(lines.reduce((sum, l) => sum + l.taxableValue, 0));
  const totalCgst = round2(lines.reduce((sum, l) => sum + l.cgst, 0));
  const totalSgst = round2(lines.reduce((sum, l) => sum + l.sgst, 0));
  const totalTax = round2(totalCgst + totalSgst);

  const grandTotal = round2(afterDiscount + deliveryCharge);

  // Store credit (Phase 2) — a payment TENDER, applied after GST. It reduces the amount DUE (never
  // the taxable base), so GST is unchanged. Clamp to the user's balance and the grand total (a tender
  // can cover the whole bill incl. delivery). savedAmount is NOT increased — store credit is the
  // customer's own money being returned, not a discount.
  let walletApplied = 0;
  let walletAvailable = 0;
  if (userId) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
    walletAvailable = Number(u?.walletBalance ?? 0);
    if (walletCredit && walletCredit > 0) {
      walletApplied = round2(Math.min(walletCredit, walletAvailable, grandTotal));
    }
  }
  const totalAmount = round2(grandTotal - walletApplied);

  // Savings vs MRP. Three honest components:
  //  1. Per-line MRP gap: Σ max(0, mrp − effectiveUnitPrice) × qty (covers bulk pricing too).
  //  2. Coupon discount (what the coupon knocked off).
  //  3. Delivery waived: only a real saving on a DELIVERY order that would have been charged
  //     but qualified for free delivery (threshold or coupon). Pickup never had a fee to save.
  const mrpSavings = round2(
    lines.reduce((sum, l) => sum + Math.max(0, l.mrp - l.effectiveUnitPrice) * l.quantity, 0),
  );
  const deliverySaved = !isPickup && deliveryCharge === 0 && standardDelivery > 0 ? standardDelivery : 0;
  const savedAmount = round2(mrpSavings + discount + loyaltyDiscount + deliverySaved);

  return {
    items: lines,
    subtotal,
    discount,
    couponCode: appliedCoupon,
    deliveryCharge,
    taxableValue: totalTaxable,
    totalCgst,
    totalSgst,
    totalTax,
    totalAmount,
    savedAmount,
    loyaltyDiscount,
    loyaltyTier,
    walletApplied,
    walletAvailable,
  };
}
