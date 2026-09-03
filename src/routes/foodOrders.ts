import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { resolveFoodConfig, isRestaurantOpen, RESTAURANT_TRADING } from "../services/foodMenu.js";
import { computeFoodOrderTotals, type FoodLineInput } from "../services/foodPricing.js";
import { computeDeliveryForOrigin } from "../services/deliveryPricing.js";
import { computeSubOrderTds194o } from "../services/sellerTds194o.js";
import { getNextOrderNumber } from "../services/orderNumbering.js";
import { generateOrderInvoice } from "../services/orderInvoice.js";
import { notifyNewOrder, notifySubOrderNew } from "../services/fcmNotifier.js";
import { generateOtp, orderRequiresOtp } from "../lib/otp.js";
import { isRazorpayConfigured, createRazorpayOrder } from "../services/razorpay.js";

/**
 * Food quote + order placement (MULTIVERTICAL_PLAN.md §4).
 *
 * ⚠️ Mounted at the SAME path as the public browse router (routes/food.ts). Express runs mounted
 * routers in order and calls next() when none of a router's routes match, so the public router
 * handles /restaurants* and falls through to this one for /quote and /orders. This works because
 * the public router has no catch-all — do not add one to it.
 *
 * ⚠️ This does NOT reuse routes/orders.ts's placement handler. That function is ~450 lines of FIFO
 * stock consumption, free gifts, free samples, bulk/loose pricing, MRP savings and substitutions —
 * none of which apply to a dish, and branching food through the middle of it would make the riskiest
 * money path in the app riskier. Instead it follows the materializeQuoteOrder precedent: build the
 * Order + one SubOrder, then hand off to the SAME shared services (numbering, OTP, invoice,
 * notifications, TDS), so everything downstream is genuinely shared rather than duplicated.
 */
const router = Router();
router.use(firebaseAuthMiddleware as any);

const itemsSchema = z
  .array(
    z.object({
      menuItemId: z.string().min(1),
      quantity: z.number().int().min(1).max(50),
    }),
  )
  .min(1)
  .max(50);

const quoteSchema = z.object({
  restaurantId: z.string().min(1),
  items: itemsSchema,
  addressId: z.string().min(1).optional(),
});

const placeSchema = quoteSchema.extend({
  addressId: z.string().min(1),
  paymentMethod: z.enum(["COD", "ONLINE", "UPI"]),
  notes: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().max(100).optional(),
});

interface PricedOrder {
  restaurant: {
    id: string; name: string; commissionPct: number; minOrderValue: number;
    lat: number | null; lng: number | null; isOpen: boolean;
    ownerUserId: string | null; isHouse: boolean; pan: string | null; entityType: "INDIVIDUAL_HUF" | "OTHER";
  };
  totals: ReturnType<typeof computeFoodOrderTotals>;
  prepMinutes: number;
  distanceKm: number | null;
  outOfRange: boolean;
  // Only the fields the caller actually snapshots onto the order — lat/lng are consumed inside
  // priceOrder for the distance calc and deliberately not re-exported as Prisma Decimals.
  address: { id: string; addressLine: string; pincode: string } | null;
}

/**
 * Resolves and prices an order from the DATABASE. Shared by /quote and /orders so the price the
 * customer is shown is produced by the exact same code that charges them.
 *
 * ⚠️ Nothing here trusts the client beyond ids and quantities — every price, GST rate and prep time
 * is read from the menu row. A client-supplied price is how a marketplace gets robbed.
 */
async function priceOrder(
  userId: string,
  input: z.infer<typeof quoteSchema>,
): Promise<PricedOrder> {
  const restaurant = await prisma.seller.findFirst({
    where: { id: input.restaurantId, ...RESTAURANT_TRADING },
    select: {
      id: true, name: true, commissionPct: true, minOrderValue: true, lat: true, lng: true,
      openTime: true, closeTime: true, avgPrepMinutes: true,
      ownerUserId: true, isHouse: true, pan: true, entityType: true,
    },
  });
  if (!restaurant) throw new NotFoundError("Restaurant", input.restaurantId);

  const wanted = new Map(input.items.map((i) => [i.menuItemId, i.quantity]));
  const rows = await prisma.menuItem.findMany({
    // Scoped to THIS restaurant: an item id from another restaurant's menu simply doesn't resolve,
    // so a hand-crafted request can't mix two kitchens into one order.
    where: { id: { in: [...wanted.keys()] }, sellerId: restaurant.id, isActive: true },
    select: {
      id: true, name: true, imageUrl: true, price: true, gstRate: true,
      sacCode: true, prepMinutes: true, isAvailable: true,
    },
  });

  const missing = [...wanted.keys()].filter((id) => !rows.some((r) => r.id === id));
  if (missing.length > 0) throw new ValidationError("Some items are no longer on the menu");
  // 86'd items are named, because "something is unavailable" leaves the customer guessing which.
  const unavailable = rows.filter((r) => !r.isAvailable).map((r) => r.name);
  if (unavailable.length > 0) {
    throw new ValidationError(`Sold out right now: ${unavailable.join(", ")}`);
  }

  const lines: FoodLineInput[] = rows.map((r) => ({
    menuItemId: r.id,
    name: r.name,
    imageUrl: r.imageUrl,
    unitPrice: Number(r.price),
    quantity: wanted.get(r.id)!,
    gstRate: Number(r.gstRate),
    sacCode: r.sacCode,
  }));

  const address = input.addressId
    ? await prisma.address.findFirst({
        // userId in the filter, so another customer's address id resolves to null rather than
        // leaking where they live.
        where: { id: input.addressId, userId },
        select: { id: true, addressLine: true, pincode: true, lat: true, lng: true },
      })
    : null;

  // ⚠️ Measured RESTAURANT → customer, not store → customer. The rider's trip starts at the kitchen.
  const delivery = await computeDeliveryForOrigin(
    restaurant.lat != null ? Number(restaurant.lat) : null,
    restaurant.lng != null ? Number(restaurant.lng) : null,
    address?.lat != null ? Number(address.lat) : null,
    address?.lng != null ? Number(address.lng) : null,
  );

  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      commissionPct: Number(restaurant.commissionPct),
      minOrderValue: Number(restaurant.minOrderValue),
      lat: restaurant.lat != null ? Number(restaurant.lat) : null,
      lng: restaurant.lng != null ? Number(restaurant.lng) : null,
      isOpen: isRestaurantOpen(restaurant.openTime, restaurant.closeTime),
      ownerUserId: restaurant.ownerUserId,
      isHouse: restaurant.isHouse,
      pan: restaurant.pan,
      entityType: restaurant.entityType,
    },
    totals: computeFoodOrderTotals(lines, delivery.charge),
    // The kitchen is only ready when its SLOWEST dish is — a biryani doesn't finish when the raita does.
    prepMinutes: Math.max(restaurant.avgPrepMinutes, ...rows.map((r) => r.prepMinutes)),
    distanceKm: delivery.distanceKm,
    outOfRange: delivery.outOfRange,
    address: address
      ? { id: address.id, addressLine: address.addressLine, pincode: address.pincode }
      : null,
  };
}

/** Price preview. Surfaces blockers as flags rather than errors so the cart can explain them. */
router.post("/quote", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const cfg = await resolveFoodConfig();
    if (!cfg.enabled) throw new ValidationError("Food ordering is not available yet");

    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid quote request");

    const p = await priceOrder(req.appUser!.id, parsed.data);
    res.json({
      success: true,
      data: {
        ...p.totals,
        restaurantName: p.restaurant.name,
        isOpen: p.restaurant.isOpen,
        minOrderValue: p.restaurant.minOrderValue,
        belowMinOrder: p.totals.subtotal < p.restaurant.minOrderValue,
        prepMinutes: p.prepMinutes,
        distanceKm: p.distanceKm,
        outOfRange: p.outOfRange,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/orders", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const cfg = await resolveFoodConfig();
    if (!cfg.enabled) throw new ValidationError("Food ordering is not available yet");

    const parsed = placeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid order");
    const body = parsed.data;
    const userId = req.appUser!.id;

    // Replay guard — same mechanism as grocery placement (Order.idempotencyKey @unique), so a
    // double-tap or a retried request returns the original order instead of charging twice.
    if (body.idempotencyKey) {
      const existing = await prisma.order.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
        select: { id: true, orderNumber: true, totalAmount: true, razorpayOrderId: true },
      });
      if (existing) {
        return res.json({
          success: true,
          data: {
            orderId: existing.id,
            orderNumber: existing.orderNumber,
            totalAmount: Number(existing.totalAmount),
            razorpayOrderId: existing.razorpayOrderId,
            replayed: true,
          },
        });
      }
    }

    const p = await priceOrder(userId, body);
    if (!p.restaurant.isOpen) throw new ValidationError(`${p.restaurant.name} is closed right now`);
    if (!p.address) throw new NotFoundError("Address", body.addressId);
    if (p.outOfRange) throw new ValidationError("That address is outside our delivery range");
    if (p.totals.subtotal < p.restaurant.minOrderValue) {
      throw new ValidationError(
        `Minimum order for ${p.restaurant.name} is ₹${p.restaurant.minOrderValue}`,
      );
    }

    const paymentMethod = body.paymentMethod;
    const initialPaymentStatus = "PENDING" as const;
    const needsOtp = orderRequiresOtp(initialPaymentStatus, p.totals.totalAmount);
    const orderNumber = await getNextOrderNumber();
    const estimatedReadyAt = new Date(Date.now() + p.prepMinutes * 60_000);

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber,
          customerId: userId,
          // PLACED, not CONFIRMED: the restaurant has to ACCEPT before anything is cooking. The
          // sub-order then walks PLACED → ACCEPTED (cooking) → PACKED (ready), at which point the
          // EXISTING maybeAdvanceParentOrder flips this order to PACKED and it enters the rider
          // pool. That is why food needs no new OrderStatus value.
          status: "PLACED",
          fulfillmentType: "DELIVERY",
          paymentMethod,
          paymentStatus: initialPaymentStatus,
          source: "FOOD",
          addressId: p.address!.id,
          shippingName: req.appUser!.name,
          shippingPhone: req.appUser!.phone,
          shippingAddress: p.address!.addressLine,
          shippingPincode: p.address!.pincode,
          subtotal: p.totals.subtotal,
          discount: 0,
          deliveryCharge: p.totals.deliveryCharge,
          taxableValue: p.totals.taxableValue,
          totalTax: p.totals.totalTax,
          totalAmount: p.totals.totalAmount,
          savedAmount: 0,
          estimatedReadyAt,
          deliveryOtpRequired: needsOtp,
          notes: body.notes,
          idempotencyKey: body.idempotencyKey,
          items: {
            create: p.totals.lines.map((l) => ({
              // variantId stays null and menuItemId carries the link — the two are mutually
              // exclusive on a line (see OrderItem in schema.prisma).
              menuItemId: l.menuItemId,
              productName: l.name,
              variantSku: "FOOD",
              imageUrl: l.imageUrl,
              hsnCode: l.sacCode,
              unitPrice: l.unitPrice,
              quantity: l.quantity,
              gstRate: l.gstRate,
              taxableValue: l.taxableValue,
              cgst: l.cgst,
              sgst: l.sgst,
              lineTotal: l.lineTotal,
              sellerId: p.restaurant.id,
            })),
          },
        },
        include: { items: true },
      });

      if (needsOtp) {
        await tx.orderSecret.create({
          data: { orderId: created.id, otp: generateOtp(), customerId: userId, fulfillmentType: "DELIVERY" },
        });
      }

      const commissionPct = p.restaurant.commissionPct;
      const commissionAmount = +((p.totals.subtotal * commissionPct) / 100).toFixed(2);
      // ⚠️⚠️ GST/CA — TCS IS DELIBERATELY ZERO ON FOOD, and this is the single most important line
      // in this file. A goods sub-order accrues Sec-52 TCS @1% because the platform merely COLLECTS
      // tax on someone else's supply. Restaurant service supplied through an e-commerce operator is
      // Sec 9(5): the platform is the DEEMED SUPPLIER and pays the 5% itself — the two mechanisms
      // are alternatives, not additions, so charging TCS here would withhold from the restaurant for
      // a tax the platform is separately liable for. MULTIVERTICAL_PLAN.md §4.4. Confirm with the CA
      // BEFORE StoreConfig.foodEnabled is ever turned on.
      const tcsAmount = 0;
      // Income Tax Sec 194-O is a DIFFERENT statute (income tax on the seller's receipts) and is
      // unaffected by the GST mechanism above, so it still applies to restaurants.
      const { tdsAmount } = await computeSubOrderTds194o(tx, p.restaurant, p.totals.subtotal);
      const netPayable = +(p.totals.subtotal - commissionAmount - tcsAmount - tdsAmount).toFixed(2);

      const subOrder = await tx.subOrder.create({
        data: {
          orderId: created.id,
          sellerId: p.restaurant.id,
          status: "PLACED",
          subtotal: p.totals.subtotal,
          commissionPct,
          commissionAmount,
          tcsAmount,
          tdsAmount,
          netPayable,
        },
      });
      await tx.orderItem.updateMany({
        where: { id: { in: created.items.map((i) => i.id) } },
        data: { subOrderId: subOrder.id },
      });
      if (!p.restaurant.isHouse) {
        await tx.seller.update({
          where: { id: p.restaurant.id },
          data: { outstandingBalance: { increment: netPayable } },
        });
      }

      return created;
    });

    // Razorpay handle for an online order. Degrades exactly like grocery placement: a gateway
    // failure returns no razorpayOrderId (the app offers COD) rather than a useless 500.
    let razorpayOrderId: string | null = null;
    if (paymentMethod !== "COD" && p.totals.totalAmount > 0 && isRazorpayConfigured()) {
      try {
        const rp = await createRazorpayOrder(Math.round(p.totals.totalAmount * 100), order.orderNumber);
        razorpayOrderId = rp.id;
        await prisma.order.update({ where: { id: order.id }, data: { razorpayOrderId: rp.id } });
      } catch (rpErr) {
        console.error("Razorpay order creation failed (food):", rpErr);
      }
    }

    // ⚠️ COD only. An unpaid ONLINE order must stay silent: PAYMENT_SETTLED hides it from the owner
    // board and the seller list, and the expiry sweeper cancels it — so telling a kitchen to start
    // cooking would burn real food. markOrderPaid fires these for prepaid orders instead, and it
    // needs no food-specific change (its cart-clear filters on variantId, which food lines don't have).
    if (paymentMethod === "COD") {
      generateOrderInvoice(order.id).catch((e) => console.error("Food invoice generation failed:", e));
      notifyNewOrder(order).catch((e: unknown) => console.error("[background task failed]", e));
      if (p.restaurant.ownerUserId) {
        notifySubOrderNew(p.restaurant.ownerUserId, {
          orderNumber: order.orderNumber,
          itemCount: order.items.length,
          subtotal: p.totals.subtotal,
        }).catch((e: unknown) => console.error("[background task failed]", e));
      }
    }

    res.json({
      success: true,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalAmount: p.totals.totalAmount,
        deliveryCharge: p.totals.deliveryCharge,
        prepMinutes: p.prepMinutes,
        estimatedReadyAt,
        razorpayOrderId,
        deliveryOtpRequired: order.deliveryOtpRequired,
        replayed: false,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
