/**
 * Read-only. Re-prices real historical baskets through calculateCartTotals and prints ONLY the
 * fields that existed before runbook step 15, canonically ordered.
 *
 * This is the step-15 prove — "an order's totalAmount is unchanged to the paise versus the same
 * basket before the deploy" — run as a diff rather than as an argument. Step 15 adds columns and
 * touches no arithmetic, so the claim is true by inspection of the patch; this makes it true by
 * measurement instead, over the baskets customers actually placed.
 *
 * ⚠️ It deliberately does NOT print deliveryTaxable/deliveryGst/deliverySupply. Those do not exist
 * at HEAD, so including them would guarantee a diff and prove nothing. The question is whether the
 * OLD numbers moved.
 *
 * Run at HEAD and on the change, then diff:
 *   railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/replayCartTotals.ts' > before.json
 */
import { PrismaClient } from "@prisma/client";
import { calculateCartTotals } from "../src/services/cartPricing.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

async function main() {
  // Every order that has real item lines, newest first, capped so this stays a minute's work.
  const orders = await prisma.order.findMany({
    where: { items: { some: { variantId: { not: null } } } },
    select: {
      id: true, orderNumber: true, fulfillmentType: true, couponCode: true,
      deliveryCharge: true, totalAmount: true, customerId: true,
      address: { select: { lat: true, lng: true } },
      items: { select: { variantId: true, quantity: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 120,
  });

  const out: any[] = [];
  for (const o of orders) {
    const ids = o.items.map((i) => i.variantId).filter((v): v is string => !!v);
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: ids } },
      include: {
        product: {
          select: {
            productType: true, gstRate: true, hsnCode: true, isPackaged: true,
            categoryId: true, isBuyOneGetOne: true,
          },
        },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    // ⚠️ The shape matters: calculateCartTotals reads item.variantId as well as item.variant, and
    // takes POSITIONAL arguments, not an options object. Passing an object as the second argument
    // silently binds it to couponCode.
    const cart = o.items
      .filter((i) => i.variantId && byId.has(i.variantId))
      .map((i, n) => ({
        id: `replay-${o.id}-${n}`,
        variantId: i.variantId!,
        quantity: Number(i.quantity),
        variant: byId.get(i.variantId!),
      }));
    if (cart.length === 0) continue;

    try {
      const t = await calculateCartTotals(
        cart as any,
        o.couponCode ?? null,
        o.customerId,
        o.fulfillmentType as any,
        null,
        o.address?.lat != null ? Number(o.address.lat) : null,
        o.address?.lng != null ? Number(o.address.lng) : null,
      );
      // Pre-step-15 fields only. Ordered explicitly so two runs are byte-identical.
      out.push({
        order: o.orderNumber,
        subtotal: t.subtotal,
        discount: t.discount,
        couponCode: t.couponCode,
        deliveryCharge: t.deliveryCharge,
        taxableValue: t.taxableValue,
        totalCgst: t.totalCgst,
        totalSgst: t.totalSgst,
        totalTax: t.totalTax,
        totalAmount: t.totalAmount,
        savedAmount: t.savedAmount,
        loyaltyDiscount: t.loyaltyDiscount,
        tierDeliveryWaived: t.tierDeliveryWaived,
        bogoDiscount: t.bogoDiscount,
        walletApplied: t.walletApplied,
        belowMinOrder: t.belowMinOrder,
        outOfRange: t.outOfRange,
      });
    } catch (e) {
      out.push({ order: o.orderNumber, error: (e as Error).message });
    }
  }

  out.sort((a, b) => String(a.order).localeCompare(String(b.order)));
  console.log(JSON.stringify({ replayed: out.length, baskets: out }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
