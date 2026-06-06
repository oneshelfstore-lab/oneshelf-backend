import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { toAppFormat } from "../utils/looseUnitConverter.js";
import { calculateCartTotals } from "../services/cartPricing.js";
import { getNextOrderNumber } from "../services/orderNumbering.js";
import { createRazorpayOrder, verifyPaymentSignature, isRazorpayConfigured, refundPayment } from "../services/razorpay.js";
import { notifyNewOrder, notifyOrderStatusChange } from "../services/fcmNotifier.js";
import { generateOrderInvoice, syncInvoicePaymentStatus } from "../services/orderInvoice.js";
import { generateInvoicePdf } from "../services/pdfGenerator.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);

function isLooseType(t: string) { return t === "LOOSE" || t === "PRODUCE"; }

function generateOtp(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function orderRequiresOtp(paymentMethod: string, paymentStatus: string, total: number): boolean {
  if (paymentStatus === "PAID" || paymentStatus === "ADVANCE_PAID") return true;
  if (total > 2000) return true;
  return false;
}

// ─── POST /api/app/orders — place order ─────────────────────────────

const placeOrderSchema = z.object({
  addressId: z.string().min(1).optional(),
  fulfillmentType: z.enum(["DELIVERY", "PICKUP"]).default("DELIVERY"),
  paymentMethod: z.enum(["COD", "ONLINE", "UPI"]).default("COD"),
  couponCode: z.string().max(20).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  deliverySlot: z.string().max(60).optional().nullable(),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = placeOrderSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid order data", parsed.error.errors);
    const { addressId, fulfillmentType, paymentMethod, couponCode, notes, deliverySlot } = parsed.data;
    const userId = req.appUser!.id;

    // Idempotency: if the client sends an Idempotency-Key and we already created an
    // order for it, return that order instead of creating a duplicate (double-tap/retry).
    const idempotencyKey = (req.headers["idempotency-key"] as string || "").slice(0, 100) || null;
    if (idempotencyKey) {
      const existing = await prisma.order.findUnique({ where: { idempotencyKey } });
      if (existing && existing.customerId === userId) {
        return res.status(200).json({
          success: true,
          data: {
            orderId: existing.id,
            orderNumber: existing.orderNumber,
            status: existing.status,
            paymentMethod: existing.paymentMethod,
            totalAmount: Number(existing.totalAmount),
            razorpayOrderId: existing.razorpayOrderId,
            deliveryOtpRequired: existing.deliveryOtpRequired,
          },
        });
      }
    }

    // Load cart from DB (not from request body — prevent tampering)
    const cartItems = await prisma.cartItem.findMany({
      where: { userId, savedForLater: false },
      include: {
        variant: {
          include: {
            product: {
              select: { id: true, name: true, productType: true, hsnCode: true, gstRate: true, isPackaged: true, categoryId: true, imageUrls: true },
            },
          },
        },
      },
    });

    if (cartItems.length === 0) throw new ValidationError("Cart is empty");

    // Validate address for delivery
    let address = null;
    if (fulfillmentType === "DELIVERY") {
      if (!addressId) throw new ValidationError("Address is required for delivery");
      address = await prisma.address.findFirst({ where: { id: addressId, userId } });
      if (!address) throw new NotFoundError("Address", addressId);
    }

    // Calculate totals (reuses the cart pricing service). Pass fulfillmentType so
    // pickup orders are not charged delivery (matches the /cart/quote preview exactly).
    const totals = await calculateCartTotals(cartItems as any, couponCode, userId, fulfillmentType);

    // Determine payment status. Every order starts PENDING; online orders flip to
    // PAID only after Razorpay verification in /:id/pay (which also arms the OTP).
    const initialPaymentStatus = "PENDING";
    const needsOtp = orderRequiresOtp(paymentMethod, initialPaymentStatus, totals.totalAmount);

    // Generate order number
    const orderNumber = await getNextOrderNumber();

    // Transactional: decrement stock + create order + clear cart
    const order = await prisma.$transaction(async (tx) => {
      // Validate + atomically decrement stock for each item.
      // A guarded conditional update (updateMany WHERE stock >= needed) makes the
      // check-and-decrement a single atomic operation, eliminating the read-check-write
      // race that previously allowed two concurrent orders to both buy the last unit
      // (overselling). updateMany returns count=0 when the guard fails.
      for (const item of cartItems) {
        const isLoose = isLooseType(item.variant.product.productType);
        const packageSize = Number(item.variant.packageSize);
        const needed = isLoose ? item.quantity * packageSize : item.quantity;

        const result = await tx.productVariant.updateMany({
          where: { id: item.variantId, isActive: true, stock: { gte: needed } },
          data: { stock: { decrement: needed } },
        });

        if (result.count === 0) {
          // Distinguish "gone/inactive" from "not enough stock" for a clear message.
          const variant = await tx.productVariant.findUnique({ where: { id: item.variantId } });
          if (!variant || !variant.isActive) {
            throw new AppError(400, "PRODUCT_UNAVAILABLE", `Product variant ${item.variantId} is no longer available`);
          }
          throw new AppError(400, "INSUFFICIENT_STOCK", `Insufficient stock for ${item.variant.product.name}`);
        }
      }

      // Build order items (snapshot at sale time)
      const orderItems = cartItems.map((item, idx) => {
        const isLoose = isLooseType(item.variant.product.productType);
        const converted = toAppFormat(item.variant, isLoose);
        const pricingLine = totals.items.find(l => l.variantId === item.variantId);
        const effectivePrice = pricingLine?.effectiveUnitPrice ?? converted.sellingPrice;
        const lineTotal = pricingLine?.lineTotal ?? (effectivePrice * item.quantity);

        return {
          variantId: item.variantId,
          productName: item.variant.product.name,
          variantSku: item.variant.sku,
          imageUrl: item.variant.product.imageUrls?.[0] ?? null,
          hsnCode: item.variant.product.hsnCode,
          unitPrice: effectivePrice,
          quantity: item.quantity,
          gstRate: pricingLine?.gstRate ?? 0,
          taxableValue: pricingLine?.taxableValue ?? lineTotal,
          cgst: pricingLine?.cgst ?? 0,
          sgst: pricingLine?.sgst ?? 0,
          lineTotal,
          isLoose,
          stepSize: isLoose ? Number(item.variant.packageSize) : null,
          stepUnit: isLoose ? item.variant.packageUnit : null,
          packageUnit: item.variant.packageUnit,
        };
      });

      // Create order
      const created = await tx.order.create({
        data: {
          orderNumber,
          customerId: userId,
          status: "PLACED",
          fulfillmentType,
          paymentMethod,
          paymentStatus: initialPaymentStatus,
          addressId: address?.id,
          shippingName: req.appUser!.name,
          shippingPhone: req.appUser!.phone,
          shippingAddress: address?.addressLine,
          shippingPincode: address?.pincode,
          subtotal: totals.subtotal,
          discount: totals.discount,
          deliveryCharge: totals.deliveryCharge,
          taxableValue: totals.taxableValue,
          totalTax: totals.totalTax,
          totalAmount: totals.totalAmount,
          couponCode: totals.couponCode,
          deliveryOtpRequired: needsOtp,
          notes,
          idempotencyKey,
          deliverySlot: fulfillmentType === "DELIVERY" ? (deliverySlot ?? null) : null,
          items: { create: orderItems },
        },
        include: { items: true },
      });

      // Create OTP secret if required
      if (needsOtp) {
        await tx.orderSecret.create({
          data: {
            orderId: created.id,
            otp: generateOtp(),
            customerId: userId,
            fulfillmentType,
          },
        });
      }

      // Record coupon usage. The global cap is enforced atomically (guarded
      // updateMany) to prevent over-redemption under concurrency; per-user cap is
      // checked against the redemption ledger, and a redemption row is written.
      if (totals.couponCode) {
        const coupon = await tx.coupon.findUnique({ where: { code: totals.couponCode } });
        if (coupon) {
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
            data: { couponId: coupon.id, userId, orderId: created.id },
          });
        }
      }

      // Clear active cart
      await tx.cartItem.deleteMany({ where: { userId, savedForLater: false } });

      return created;
    });

    // Create Razorpay order for online payment
    let razorpayOrderId: string | null = null;
    if (paymentMethod === "ONLINE" || paymentMethod === "UPI") {
      if (isRazorpayConfigured()) {
        const amountInPaise = Math.round(totals.totalAmount * 100);
        const rpOrder = await createRazorpayOrder(amountInPaise, order.orderNumber);
        razorpayOrderId = rpOrder.id;
        await prisma.order.update({
          where: { id: order.id },
          data: { razorpayOrderId: rpOrder.id },
        });
      }
    }

    // Generate invoice for COD orders immediately (online orders get invoiced after payment)
    if (paymentMethod === "COD") {
      generateOrderInvoice(order.id).catch((e) => console.error("Invoice generation failed:", e));
    }

    // FCM notification to owner (fire and forget)
    notifyNewOrder(order).catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentMethod,
        totalAmount: totals.totalAmount,
        razorpayOrderId,
        deliveryOtpRequired: order.deliveryOtpRequired,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/orders/:id/pay — Razorpay payment verification ───

const paySchema = z.object({
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

router.post("/:id/pay", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = paySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid payment data", parsed.error.errors);
    const { razorpayPaymentId, razorpaySignature } = parsed.data;

    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: req.appUser!.id },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    if (!order.razorpayOrderId) throw new ValidationError("This order does not have a pending online payment");
    if (order.paymentStatus === "PAID") throw new ValidationError("Order is already paid");

    const isValid = verifyPaymentSignature(order.razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) throw new AppError(400, "PAYMENT_INVALID", "Payment signature verification failed");

    await prisma.$transaction(async (tx) => {
      // Prepaid orders always require a handover OTP at delivery/pickup.
      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: "PAID",
          razorpayPaymentId,
          deliveryOtpRequired: true,
        },
      });
      // Arm the OTP secret if one wasn't already created at placement.
      const existing = await tx.orderSecret.findFirst({ where: { orderId: order.id } });
      if (!existing) {
        await tx.orderSecret.create({
          data: {
            orderId: order.id,
            otp: generateOtp(),
            customerId: order.customerId,
            fulfillmentType: order.fulfillmentType,
          },
        });
      }
    });

    // Generate invoice now that payment is confirmed
    generateOrderInvoice(order.id).catch((e) => console.error("Invoice generation failed:", e));

    res.json({ success: true, message: "Payment verified", data: { orderId: order.id, paymentStatus: "PAID" } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/orders/:id/cancel — cancel order ────────────────

router.post("/:id/cancel", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: req.appUser!.id },
      include: { items: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    if (!["PLACED", "CONFIRMED"].includes(order.status)) {
      throw new ValidationError(`Cannot cancel order in '${order.status}' status. Only PLACED or CONFIRMED orders can be cancelled.`);
    }

    await prisma.$transaction(async (tx) => {
      // Restore stock
      for (const item of order.items) {
        if (!item.variantId) continue;
        const isLoose = item.isLoose;
        const restoreAmount = isLoose && item.stepSize
          ? item.quantity * Number(item.stepSize)
          : item.quantity;

        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { increment: restoreAmount } },
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLED" },
      });
    });

    // Refund any captured online payment. Best-effort: mark REFUND_INITIATED first,
    // then call Razorpay; on success mark REFUNDED. A failure is logged and the order
    // stays REFUND_INITIATED for manual follow-up (the cancellation itself stands).
    if (order.paymentStatus === "PAID" && order.razorpayPaymentId) {
      try {
        await prisma.order.update({
          where: { id: order.id },
          data: { paymentStatus: "REFUND_INITIATED" },
        });
        await refundPayment(order.razorpayPaymentId, Math.round(Number(order.totalAmount) * 100));
        await prisma.order.update({
          where: { id: order.id },
          data: { paymentStatus: "REFUNDED" },
        });
      } catch (refundErr) {
        console.error("Refund failed for order", order.id, refundErr);
      }
    }

    notifyOrderStatusChange({ ...order, status: "CANCELLED" }).catch(() => {});
    syncInvoicePaymentStatus(order.id).catch((e) => console.error("Invoice sync failed:", e));

    res.json({ success: true, message: "Order cancelled", data: { orderId: order.id, status: "CANCELLED" } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/app/orders/:id/invoice/pdf — generate & download invoice PDF ──

router.get("/:id/invoice/pdf", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    // Auto-generate invoice if it doesn't exist yet
    let invoiceId = order.invoiceId;
    if (!invoiceId) {
      invoiceId = await generateOrderInvoice(order.id);
      if (!invoiceId) throw new AppError(500, "INVOICE_FAILED", "Could not generate invoice for this order");
    }

    const pdfBuffer = await generateInvoicePdf(invoiceId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Invoice-${order.orderNumber.replace(/\//g, "-")}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/app/orders — customer's orders ────────────────────────

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: { customerId: userId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          items: { select: { productName: true, quantity: true, unitPrice: true, lineTotal: true, imageUrl: true, isLoose: true, stepSize: true, stepUnit: true, packageUnit: true, hsnCode: true, gstRate: true, variantId: true } },
        },
      }),
      prisma.order.count({ where: { customerId: userId } }),
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/app/orders/:id — order detail ─────────────────────────

router.get("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;

    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
      include: {
        items: true,
        address: true,
      },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    // Include OTP for customer (only if active + not verified)
    let deliveryOtp: string | null = null;
    if (order.deliveryOtpRequired) {
      const secret = await prisma.orderSecret.findUnique({ where: { orderId: order.id } });
      if (secret && !secret.verified && ["PLACED", "CONFIRMED", "PACKED", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP"].includes(order.status)) {
        deliveryOtp = secret.otp;
      }
    }

    res.json({ success: true, data: { ...order, deliveryOtp } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/orders/:orderId/items/:itemId/substitute/respond ─
// Customer approves or rejects an owner-proposed substitution.

const substituteResponseSchema = z.object({
  action: z.enum(["approve", "reject"]),
});

router.post("/:orderId/items/:itemId/substitute/respond", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = substituteResponseSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { action } = parsed.data;
    const userId = req.appUser!.id;

    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId as string, customerId: userId },
      include: { items: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.orderId as string);

    const item = order.items.find((i) => i.id === (req.params.itemId as string));
    if (!item) throw new NotFoundError("OrderItem", req.params.itemId as string);

    if (item.substitutionStatus !== "PROPOSED") {
      throw new ValidationError(`Item substitution is '${item.substitutionStatus}', not PROPOSED`);
    }

    if (action === "reject") {
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { substitutionStatus: "REJECTED" },
      });
      return res.json({ success: true, data: { itemId: item.id, substitutionStatus: "REJECTED" } });
    }

    // ── Approve: swap the item and adjust order total. ──────────
    const priceDelta = Number(item.substitutePriceDelta ?? 0);

    await prisma.$transaction(async (tx) => {
      // Decrement stock for the substitute variant.
      if (item.substituteVariantId) {
        const decrementBy = item.isLoose && item.stepSize
          ? item.quantity * Number(item.stepSize)
          : item.quantity;
        const updated = await tx.productVariant.updateMany({
          where: { id: item.substituteVariantId, stock: { gte: decrementBy } },
          data: { stock: { decrement: decrementBy } },
        });
        if (updated.count === 0) {
          throw new ValidationError("Substitute is now out of stock");
        }
      }

      // Restore stock for the original variant.
      if (item.variantId) {
        const restoreBy = item.isLoose && item.stepSize
          ? item.quantity * Number(item.stepSize)
          : item.quantity;
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { increment: restoreBy } },
        });
      }

      // Update the order item — swap to the substitute.
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          substitutionStatus: "APPROVED",
          // Overwrite the snapshotted product info with the substitute.
          variantId: item.substituteVariantId,
          productName: item.substituteProductName ?? item.productName,
          imageUrl: item.substituteImageUrl,
          unitPrice: item.substituteUnitPrice ?? item.unitPrice,
          lineTotal: Number(item.substituteUnitPrice ?? item.unitPrice) * item.quantity,
        },
      });

      // Adjust order totals.
      if (priceDelta !== 0) {
        const newTotal = Number(order.totalAmount) + priceDelta;
        const newSubtotal = Number(order.subtotal) + priceDelta;
        await tx.order.update({
          where: { id: order.id },
          data: {
            totalAmount: Math.max(0, newTotal),
            subtotal: Math.max(0, newSubtotal),
          },
        });
      }
    });

    // For prepaid online orders with a negative delta → partial refund.
    if (priceDelta < 0 && order.paymentStatus === "PAID" && order.razorpayPaymentId) {
      const refundPaise = Math.round(Math.abs(priceDelta) * 100);
      try {
        await refundPayment(order.razorpayPaymentId, refundPaise);
      } catch (e) {
        console.error(JSON.stringify({ level: "error", msg: "substitution partial refund failed", orderId: order.id, err: String(e) }));
        // Don't fail the approval — the refund can be retried manually.
      }
    }

    // Notify owner that customer approved.
    const { notifySubstitutionResponse } = await import("../services/fcmNotifier.js");
    notifySubstitutionResponse(order, item.substituteProductName ?? "", "approved").catch(() => {});

    res.json({
      success: true,
      data: {
        itemId: item.id,
        substitutionStatus: "APPROVED",
        newTotal: Number(order.totalAmount) + priceDelta,
        priceDelta,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
