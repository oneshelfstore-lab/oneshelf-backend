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
import { computeOrderEta } from "../services/orderEta.js";
import { computeUserSavings } from "../services/savings.js";
import { rollScratchReward, getScratchForCelebration, revealScratchReward } from "../services/scratchReward.js";
import { rollFreeSample, getFreeSampleReveal } from "../services/freeSample.js";
import { getNextOrderNumber } from "../services/orderNumbering.js";
import { createRazorpayOrder, verifyPaymentSignature, isRazorpayConfigured, refundPayment } from "../services/razorpay.js";
import { notifyNewOrder, notifyOrderStatusChange } from "../services/fcmNotifier.js";
import { generateOrderInvoice, syncInvoicePaymentStatus } from "../services/orderInvoice.js";
import { generateInvoicePdf } from "../services/pdfGenerator.js";
import { refundWalletOnCancel } from "../services/referralRewards.js";
import { markOrderPaid } from "../services/orderPayment.js";
import { reconcileOrderPayment } from "../services/paymentReconciliation.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);

function isLooseType(t: string) { return t === "LOOSE" || t === "PRODUCE"; }

// GST Sec-52 TCS rate the platform (e-commerce operator) collects on external sellers' net taxable
// supplies. ⚠️ CA-gated — confirm before launch. 1% total = 0.5% CGST + 0.5% SGST (intra-state).
const TCS_RATE_PCT = 1;

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
  // Optional URL of a customer-uploaded gate/door photo, surfaced to the delivery agent.
  gatePhotoUrl: z.string().max(500).optional().nullable(),
  // Optional URL of a customer-recorded voice note, played by the delivery agent.
  voiceNoteUrl: z.string().max(500).optional().nullable(),
  // Store credit the customer chose to apply (clamped server-side to balance + grand total).
  walletCredit: z.number().min(0).optional().nullable(),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = placeOrderSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid order data", parsed.error.errors);
    const { addressId, fulfillmentType, paymentMethod, couponCode, notes, deliverySlot, gatePhotoUrl, voiceNoteUrl, walletCredit } = parsed.data;
    const userId = req.appUser!.id;

    // Idempotency: if the client sends an Idempotency-Key and we already created an
    // order for it, return that order instead of creating a duplicate (double-tap/retry).
    const idempotencyKey = (req.headers["idempotency-key"] as string || "").slice(0, 100) || null;
    if (idempotencyKey) {
      const existing = await prisma.order.findUnique({ where: { idempotencyKey } });
      if (existing && existing.customerId === userId) {
        const replayEta = await computeOrderEta(existing.fulfillmentType, existing.deliverySlot);
        return res.status(200).json({
          success: true,
          data: {
            orderId: existing.id,
            orderNumber: existing.orderNumber,
            status: existing.status,
            paymentMethod: existing.paymentMethod,
            totalAmount: Number(existing.totalAmount),
            savedAmount: Number(existing.savedAmount),
            etaLabel: replayEta.etaLabel,
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
              select: { id: true, name: true, productType: true, hsnCode: true, gstRate: true, isPackaged: true, categoryId: true, imageUrls: true, sellerId: true, isBuyOneGetOne: true },
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
    const totals = await calculateCartTotals(cartItems as any, couponCode, userId, fulfillmentType, walletCredit);

    // Determine payment status. Every order starts PENDING; online orders flip to
    // PAID only after Razorpay verification in /:id/pay (which also arms the OTP).
    // Exception: if store credit covers the WHOLE bill (₹0 due) on an online order, there's nothing
    // to charge via Razorpay → settle it as PAID right at placement.
    const fullyWalletPaid = paymentMethod !== "COD" && totals.totalAmount === 0 && totals.walletApplied > 0;
    const initialPaymentStatus = fullyWalletPaid ? "PAID" : "PENDING";
    const needsOtp = orderRequiresOtp(paymentMethod, initialPaymentStatus, totals.totalAmount);

    // Honest ETA (range or chosen slot) — computed once, stored on the order, and echoed
    // back so the celebration screen renders it without a second round-trip.
    const eta = await computeOrderEta(fulfillmentType, deliverySlot);

    // Generate order number
    const orderNumber = await getNextOrderNumber();

    // Resolve the house seller once — the fallback owner for any item whose product has no
    // explicit seller (pre-backfill products). Used to group items into per-seller sub-orders.
    const houseSeller = await prisma.seller.findFirst({ where: { isHouse: true }, select: { id: true } });

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
        const needed = isLoose ? Number(item.quantity) * packageSize : Number(item.quantity);

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
        const lineTotal = pricingLine?.lineTotal ?? (effectivePrice * Number(item.quantity));

        return {
          variantId: item.variantId,
          productName: item.variant.product.name,
          variantSku: item.variant.sku,
          imageUrl: item.variant.product.imageUrls?.[0] ?? null,
          hsnCode: item.variant.product.hsnCode,
          unitPrice: effectivePrice,
          mrp: pricingLine?.mrp ?? null,
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
          sellerId: item.variant.product.sellerId ?? houseSeller?.id ?? null,
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
          // Coupon + loyalty member discount combined, so the stored order reconciles
          // (subtotal − discount + delivery = total). savedAmount tracks the full breakdown.
          discount: totals.discount + totals.loyaltyDiscount + totals.bogoDiscount,
          deliveryCharge: totals.deliveryCharge,
          taxableValue: totals.taxableValue,
          totalTax: totals.totalTax,
          totalAmount: totals.totalAmount,
          savedAmount: totals.savedAmount,
          couponCode: totals.couponCode,
          walletApplied: totals.walletApplied,
          estimatedReadyAt: eta.estimatedReadyAt,
          deliveryOtpRequired: needsOtp,
          notes,
          idempotencyKey,
          deliverySlot: fulfillmentType === "DELIVERY" ? (deliverySlot ?? null) : null,
          gatePhotoUrl: fulfillmentType === "DELIVERY" ? (gatePhotoUrl ?? null) : null,
          voiceNoteUrl: fulfillmentType === "DELIVERY" ? (voiceNoteUrl ?? null) : null,
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

      // Debit store credit (payment tender). The guarded decrement is the double-spend defense — a
      // concurrent checkout can't spend the same balance twice (count === 0 ⇒ the balance changed
      // since the quote ⇒ reject). The WalletTransaction @@unique([orderId, type]) is the retry guard.
      if (totals.walletApplied > 0) {
        const dec = await tx.user.updateMany({
          where: { id: userId, walletBalance: { gte: totals.walletApplied } },
          data: { walletBalance: { decrement: totals.walletApplied } },
        });
        if (dec.count === 0) {
          throw new AppError(400, "WALLET_INSUFFICIENT", "Your store credit changed. Please review your order and try again.");
        }
        const fresh = await tx.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
        await tx.walletTransaction.create({
          data: {
            userId,
            amount: -totals.walletApplied,
            type: "ORDER_DEBIT",
            balanceAfter: fresh!.walletBalance,
            orderId: created.id,
            note: "Paid with store credit",
          },
        });
      }

      // Clear the active cart. COD / fully-wallet-paid orders are settled now → clear immediately.
      // Online/UPI orders awaiting Razorpay DEFER the clear to markOrderPaid (on payment confirmation)
      // so an abandoned payment leaves the cart intact for a clean retry, and both the server cart and
      // the local Room cart end up clearing together at the moment payment succeeds.
      if (paymentMethod === "COD" || fullyWalletPaid) {
        await tx.cartItem.deleteMany({ where: { userId, savedForLater: false } });
      }

      // ── Split into per-seller sub-orders + accrue the commission ledger ──
      // Group the just-created items by seller, create one SubOrder per seller, link the items,
      // and bump each (non-house) seller's outstanding balance by their net (gross − commission
      // − TCS). A single-seller (house-only) order produces exactly one SubOrder, so the existing
      // flow is unchanged. Order-level discounts/delivery are NOT split in v1 (the platform funds
      // promos); commission is the seller's pct of their item subtotal. TCS stays 0 until Phase 6
      // (CA-gated). Skipped only if no seller resolves (pre-backfill) — order placement never breaks.
      type CreatedItem = (typeof created.items)[number];
      const itemsBySeller = new Map<string, CreatedItem[]>();
      for (const it of created.items) {
        if (!it.sellerId) continue;
        const arr = itemsBySeller.get(it.sellerId) ?? [];
        arr.push(it);
        itemsBySeller.set(it.sellerId, arr);
      }
      if (itemsBySeller.size > 0) {
        const sellers = await tx.seller.findMany({
          where: { id: { in: [...itemsBySeller.keys()] } },
          select: { id: true, commissionPct: true, isHouse: true },
        });
        const sellerById = new Map(sellers.map((s) => [s.id, s]));
        for (const [sid, sellerItems] of itemsBySeller) {
          const seller = sellerById.get(sid);
          if (!seller) continue;
          const subtotal = +sellerItems.reduce((sum, it) => sum + Number(it.lineTotal), 0).toFixed(2);
          const commissionPct = Number(seller.commissionPct);
          const commissionAmount = +((subtotal * commissionPct) / 100).toFixed(2);
          // ⚠️ GST/CA (Phase 6): as a GST e-commerce operator the platform collects Sec-52 TCS @ 1%
          // (0.5% CGST + 0.5% SGST) on the NET TAXABLE value of each EXTERNAL seller's supplies. The
          // house store is the platform's own catalog → no TCS on its own supplies. TCS is NOT charged
          // to the customer; it's withheld from the seller's payout and reported in GSTR-8. The TCS base
          // is the GST-exclusive taxable value (prices are GST-inclusive). Confirm the rate/base w/ CA.
          const taxableValue = +sellerItems.reduce((sum, it) => sum + Number(it.taxableValue), 0).toFixed(2);
          const tcsAmount = seller.isHouse ? 0 : +((taxableValue * TCS_RATE_PCT) / 100).toFixed(2);
          const netPayable = +(subtotal - commissionAmount - tcsAmount).toFixed(2);

          const subOrder = await tx.subOrder.create({
            data: {
              orderId: created.id,
              sellerId: sid,
              status: "PLACED",
              subtotal,
              commissionPct,
              commissionAmount,
              tcsAmount,
              netPayable,
            },
          });
          await tx.orderItem.updateMany({
            where: { id: { in: sellerItems.map((it) => it.id) } },
            data: { subOrderId: subOrder.id },
          });
          // The platform doesn't owe its own house store — only accrue for real sellers.
          if (!seller.isHouse) {
            await tx.seller.update({
              where: { id: sid },
              data: { outstandingBalance: { increment: netPayable } },
            });
          }
        }
      }

      return created;
    });

    // Roll the scratch-card outcome once, now (idempotent, keyed by orderId), so the celebration
    // screen has it ready. Best-effort — a failure here must never block order placement.
    try { await rollScratchReward(order.id, userId); } catch (e) { console.error("scratch roll failed:", e); }
    // Roll a possible free sample (gated by eligibility/chance/budget). Best-effort.
    try { await rollFreeSample(order.id); } catch (e) { console.error("free sample roll failed:", e); }

    // Create Razorpay order for online payment. A fully-wallet-paid online order (₹0 due) skips
    // Razorpay entirely — it's already settled as PAID above.
    let razorpayOrderId: string | null = null;
    if ((paymentMethod === "ONLINE" || paymentMethod === "UPI") && totals.totalAmount > 0) {
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

    // Generate invoice for COD orders immediately (online orders get invoiced after payment).
    // A fully-wallet-paid online order is already settled at placement → invoice it now too.
    if (paymentMethod === "COD" || fullyWalletPaid) {
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
        savedAmount: totals.savedAmount,
        etaLabel: eta.etaLabel,
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

    // Single idempotent confirmation path (shared with the webhook + reconciliation): flips
    // PENDING→PAID, arms the OTP, clears this order's cart lines, and generates the invoice.
    await markOrderPaid(order.id, razorpayPaymentId);

    res.json({ success: true, message: "Payment verified", data: { orderId: order.id, paymentStatus: "PAID" } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/orders/:id/reconcile — recover a stranded payment ──
// Belt-and-suspenders for "paid but app closed": the app calls this on reopen for any locally-pending
// online order. The server asks Razorpay whether the payment was actually captured and, if so, flips
// the order to PAID (idempotent — safe to call repeatedly, and harmless for COD/already-paid orders).

router.post("/:id/reconcile", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: req.appUser!.id },
      select: { id: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    const result = await reconcileOrderPayment(order.id);
    res.json({ success: true, data: result });
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
    // Return any store credit that was applied to this order (idempotent; no-op if none).
    refundWalletOnCancel(order.id).catch((e) => console.error("wallet refund failed:", e));

    res.json({ success: true, message: "Order cancelled", data: { orderId: order.id, status: "CANCELLED" } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Order rating (post-delivery feedback) ──────────────────────────────

const ratingSchema = z.object({
  stars: z.coerce.number().int().min(1).max(5),
  tags: z.array(z.string().max(40)).max(10).optional().default([]),
  comment: z.string().max(1000).optional().nullable(),
});

// POST /api/app/orders/:id/rating — rate a delivered order (idempotent upsert)
router.post("/:id/rating", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = ratingSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid rating", parsed.error.errors);

    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    if (order.status !== "DELIVERED") {
      throw new ValidationError("Only delivered orders can be rated.");
    }

    const rating = await prisma.orderRating.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        userId,
        stars: parsed.data.stars,
        tags: parsed.data.tags ?? [],
        comment: parsed.data.comment ?? null,
      },
      update: {
        stars: parsed.data.stars,
        tags: parsed.data.tags ?? [],
        comment: parsed.data.comment ?? null,
      },
    });

    res.status(201).json({ success: true, data: rating });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/orders/:id/rating — fetch the user's rating for an order (or null)
router.get("/:id/rating", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
      select: { id: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    const rating = await prisma.orderRating.findUnique({ where: { orderId: order.id } });
    res.json({ success: true, data: rating });
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

// ─── GET /api/app/orders/:id/invoices/:invoiceId/pdf — per-seller invoice ──
// A multi-seller order has one invoice per seller (Phase 6). The customer downloads each by id.
// The invoice MUST belong to this customer's order (ownership re-checked here).
router.get("/:id/invoices/:invoiceId/pdf", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
      select: { id: true, orderNumber: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.invoiceId, orderId: order.id },
      select: { id: true, invoiceNumber: true },
    });
    if (!invoice) throw new NotFoundError("Invoice", req.params.invoiceId!);

    const pdfBuffer = await generateInvoicePdf(invoice.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Invoice-${invoice.invoiceNumber.replace(/\//g, "-")}.pdf"`);
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
          items: { select: { productName: true, quantity: true, unitPrice: true, mrp: true, lineTotal: true, imageUrl: true, isLoose: true, stepSize: true, stepUnit: true, packageUnit: true, hsnCode: true, gstRate: true, variantId: true } },
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

// ─── GET /api/app/orders/:id/celebration — order-placed screen payload ──
// Consolidated read for the celebration screen (re-entry + async hydration). Everything
// here is real, computed data. scratch/freeSample stay null until later phases.

router.get("/:id/celebration", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
      select: {
        id: true, status: true, fulfillmentType: true, deliverySlot: true,
        savedAmount: true, totalAmount: true, estimatedReadyAt: true,
        freeSampleName: true, freeSampleImageUrl: true, freeSamplePacked: true,
      },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    const [savings, eta, scratch] = await Promise.all([
      computeUserSavings(userId),
      computeOrderEta(order.fulfillmentType, order.deliverySlot),
      getScratchForCelebration(order.id),
    ]);

    res.json({
      success: true,
      data: {
        orderId: order.id,
        status: order.status,
        savedAmount: Number(order.savedAmount),
        yearSavings: savings.yearToDate,
        etaLabel: eta.etaLabel,
        // Display-only trust card — confidence shown, not claimed. The real claim flow is Phase 4.
        refundPromiseShown: true,
        // Scratch card (Phase 3A): UNSCRATCHED hides the outcome until revealed via POST /scratch.
        scratch,
        // Free sample (Phase 3B): null until the owner confirms it's physically packed.
        freeSample: getFreeSampleReveal(order),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/orders/:id/scratch — reveal the scratch card ──────
// Idempotent: flips UNSCRATCHED→SCRATCHED, mints a single-use coupon on a win.

router.post("/:id/scratch", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    // Authorize: the order must belong to this user.
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
      select: { id: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    const result = await revealScratchReward(order.id, userId);
    if (!result) throw new NotFoundError("ScratchReward", req.params.id!);
    res.json({ success: true, data: result });
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
        // Each item carries its seller (via the sub-order) so the app can show "Sold by <shop>"
        // and group the order by seller.
        items: { include: { subOrder: { include: { seller: { select: { id: true, name: true, isHouse: true } } } } } },
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

    // Never expose the sample NAME before the owner confirms it's in the bag.
    const sampleName = order.freeSamplePacked ? order.freeSampleName : null;
    const sampleImage = order.freeSamplePacked ? order.freeSampleImageUrl : null;

    // Flatten the seller onto each item (the app's OrderItem is flat). sellerIsHouse=null when the
    // line has no seller link (legacy orders) so the app simply omits the "Sold by" label.
    const items = order.items.map((it) => ({
      ...it,
      sellerName: it.subOrder?.seller?.name ?? null,
      sellerIsHouse: it.subOrder?.seller?.isHouse ?? null,
    }));

    // Per-seller tax invoices for this order (Phase 6 — one per seller). The customer can view/
    // download each. supplierName is null for the house store → the app labels it "Store".
    const invoiceRows = await prisma.invoice.findMany({
      where: { orderId: order.id },
      orderBy: { invoiceNumber: "asc" },
      select: { id: true, invoiceNumber: true, sellerId: true, supplierName: true, totalAmount: true, invoiceType: true },
    });
    const invoices = invoiceRows.map((iv) => ({
      id: iv.id,
      invoiceNumber: iv.invoiceNumber,
      sellerName: iv.supplierName,
      isHouse: iv.sellerId == null,
      totalAmount: Number(iv.totalAmount),
      invoiceType: iv.invoiceType,
    }));

    res.json({
      success: true,
      data: { ...order, items, freeSampleName: sampleName, freeSampleImageUrl: sampleImage, deliveryOtp, invoices },
    });
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
          ? Number(item.quantity) * Number(item.stepSize)
          : Number(item.quantity);
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
          ? Number(item.quantity) * Number(item.stepSize)
          : Number(item.quantity);
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
          lineTotal: Number(item.substituteUnitPrice ?? item.unitPrice) * Number(item.quantity),
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
