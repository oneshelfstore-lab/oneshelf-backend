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
import { bustUserSpend } from "../services/loyalty.js";
import { computeOrderEta } from "../services/orderEta.js";
import { computeUserSavings } from "../services/savings.js";
import { rollScratchReward, getScratchForCelebration, revealScratchReward } from "../services/scratchReward.js";
import { rollFreeSample, getFreeSampleReveal } from "../services/freeSample.js";
import { getNextOrderNumber } from "../services/orderNumbering.js";
import { createRazorpayOrder, verifyPaymentSignature, isRazorpayConfigured, refundPayment } from "../services/razorpay.js";
import { notifyNewOrder, notifyOrderStatusChange, notifySubOrderNew, notifyOrderMessage } from "../services/fcmNotifier.js";
import { shapeOrderMessage, sellerIdsForOrder, ownerUserIdsForSellers } from "../services/orderMessages.js";
import { signOrderMedia, signOrderMediaList } from "../lib/storageUrls.js";
import { quoteMessageSchema, quoteMessagePreview } from "./appUser.js";
import { generateOrderInvoice, syncInvoicePaymentStatus } from "../services/orderInvoice.js";
import { generateInvoicePdf } from "../services/pdfGenerator.js";
import { refundWalletOnCancel } from "../services/referralRewards.js";
import { reverseSellerLedgerOnCancel, cancelOrder, claimRefund } from "../services/subOrderFulfillment.js";
import { markOrderPaid } from "../services/orderPayment.js";
import { reconcileOrderPayment } from "../services/paymentReconciliation.js";
import { generateOtp, orderRequiresOtp, OTP_VISIBLE_STATUSES } from "../lib/otp.js";
import { consumeFifo, recordConsumption, restoreConsumption, type ConsumeResult } from "../services/stockBatches.js";
import { drawFreeGiftStock } from "../services/freeGifts.js";
import { computeSubOrderTds194o } from "../services/sellerTds194o.js";
import { haversineKm } from "../lib/distance.js";
import { getRiderRoute } from "../services/riderRoute.js";
import { recordOrderEventAsync } from "../services/orderEvents.js";
import { redeemCouponInTx } from "../services/coupons.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);

function isLooseType(t: string) { return t === "LOOSE" || t === "PRODUCE"; }

// GST Sec-52 TCS rate the platform (e-commerce operator) collects on external sellers' net taxable
// supplies. ⚠️ CA-gated — confirm before launch. 1% total = 0.5% CGST + 0.5% SGST (intra-state).
const TCS_RATE_PCT = 1;

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
    // pickup orders are not charged delivery (matches the /cart/quote preview exactly), and the
    // address coordinates so delivery pricing is distance-based (falls back to the flat rate when
    // either the store or this address has no saved lat/lng).
    const addressLat = address?.lat != null ? Number(address.lat) : null;
    const addressLng = address?.lng != null ? Number(address.lng) : null;
    const totals = await calculateCartTotals(cartItems as any, couponCode, userId, fulfillmentType, walletCredit, addressLat, addressLng);

    // A real placement (unlike a /cart/quote preview) must reject an address beyond the store's
    // configured delivery radius — never silently charge more and ship it anyway.
    if (fulfillmentType === "DELIVERY" && totals.outOfRange) {
      throw new ValidationError("This address is outside our delivery area.");
    }

    // Minimum order value (StoreConfig.minOrderValue, 0 = unenforced) — a real placement must reject,
    // same as outOfRange; /cart/quote just surfaces `belowMinOrder` for the app to warn early. No
    // fulfillmentType check here on purpose: calculateCartTotals already scopes the flag to delivery,
    // so the quote and this check can't drift.
    if (totals.belowMinOrder) {
      throw new ValidationError(`Minimum order value is ₹${totals.minOrderValue}. Please add more items.`);
    }

    // Owner-curated pincode allowlist (StoreConfig.allowedPincodes). Empty = unenforced.
    if (fulfillmentType === "DELIVERY" && address) {
      const pincodeCfg = await prisma.storeConfig.findFirst({ select: { allowedPincodes: true } });
      if (pincodeCfg?.allowedPincodes.length && !pincodeCfg.allowedPincodes.includes(address.pincode)) {
        throw new ValidationError(`We don't deliver to pincode ${address.pincode} yet.`);
      }
    }

    // Determine payment status. Every order starts PENDING; online orders flip to
    // PAID only after Razorpay verification in /:id/pay (which also arms the OTP).
    // Exception: if store credit covers the WHOLE bill (₹0 due) there is nothing left to collect —
    // not via Razorpay, and not at the door either — so settle it as PAID right at placement.
    // Deliberately NOT gated on paymentMethod any more: a COD order with ₹0 due used to stay
    // PENDING and hand the delivery agent a "collect ₹0" job that could never be closed out.
    const fullyWalletPaid = totals.totalAmount === 0 && totals.walletApplied > 0;
    const initialPaymentStatus = fullyWalletPaid ? "PAID" : "PENDING";
    const needsOtp = orderRequiresOtp(initialPaymentStatus, totals.totalAmount);

    // Honest ETA (range or chosen slot) — computed once, stored on the order, and echoed
    // back so the celebration screen renders it without a second round-trip.
    const eta = await computeOrderEta(fulfillmentType, deliverySlot);

    // Generate order number
    const orderNumber = await getNextOrderNumber();

    // Resolve the house seller once — the fallback owner for any item whose product has no
    // explicit seller (pre-backfill products). Used to group items into per-seller sub-orders.
    const houseSeller = await prisma.seller.findFirst({ where: { isHouse: true }, select: { id: true } });

    // Populated inside the transaction (one entry per non-house seller with items on this order),
    // fired AFTER commit so a notify hiccup can never roll back the order.
    const sellerNotifications: { ownerUserId: string; itemCount: number; subtotal: number }[] = [];

    // Transactional: decrement stock + create order + clear cart
    const order = await prisma.$transaction(async (tx) => {
      // Validate + atomically consume FIFO stock batches for each item. consumeFifo replicates the
      // exact same guarded-decrement atomicity the old single-row updateMany gave (see its own
      // doc comment) — it just walks oldest-batch-first instead of one flat counter — and additionally
      // returns what was actually drawn so we can snapshot the real cost onto each OrderItem below.
      // Keyed by variantId (never duplicated within one order — CartItem has
      // @@unique([userId, variantId, savedForLater])) so it can be looked up again once the
      // OrderItems exist, without depending on Prisma's nested-create return array order.
      const consumeResultByVariant = new Map<string, ConsumeResult>();
      for (const item of cartItems) {
        const isLoose = isLooseType(item.variant.product.productType);
        const packageSize = Number(item.variant.packageSize);
        const needed = isLoose ? Number(item.quantity) * packageSize : Number(item.quantity);

        try {
          consumeResultByVariant.set(item.variantId, await consumeFifo(tx, item.variantId, needed));
        } catch (e) {
          if (e instanceof AppError && e.code === "INSUFFICIENT_STOCK") {
            // Distinguish "gone/inactive" from "not enough stock" for a clear message.
            const variant = await tx.productVariant.findUnique({ where: { id: item.variantId } });
            if (!variant || !variant.isActive) {
              throw new AppError(400, "PRODUCT_UNAVAILABLE", `Product variant ${item.variantId} is no longer available`);
            }
            throw new AppError(400, "INSUFFICIENT_STOCK", `Insufficient stock for ${item.variant.product.name}`);
          }
          throw e;
        }
      }

      // Build order items (snapshot at sale time)
      const orderItems = cartItems.map((item, idx) => {
        const isLoose = isLooseType(item.variant.product.productType);
        const converted = toAppFormat(item.variant, isLoose);
        const pricingLine = totals.items.find(l => l.variantId === item.variantId);
        const effectivePrice = pricingLine?.effectiveUnitPrice ?? converted.sellingPrice;
        const lineTotal = pricingLine?.lineTotal ?? (effectivePrice * Number(item.quantity));
        const consumeResult = consumeResultByVariant.get(item.variantId);

        return {
          variantId: item.variantId,
          productName: item.variant.product.name,
          variantSku: item.variant.sku,
          imageUrl: item.variant.product.imageUrls?.[0] ?? null,
          hsnCode: item.variant.product.hsnCode,
          unitPrice: effectivePrice,
          mrp: pricingLine?.mrp ?? null,
          // Weighted cost of the exact FIFO batches this sale drew from — see OrderItem.costPriceSnapshot.
          costPriceSnapshot: consumeResult && consumeResult.totalQty > 0 ? consumeResult.weightedUnitCost : null,
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
          // Membership attribution, snapshotted for the owner cost dashboard (both already reflected
          // in `discount`/`deliveryCharge` above — these just record how much the program funded).
          loyaltyDiscount: totals.loyaltyDiscount,
          tierDeliveryWaived: totals.tierDeliveryWaived,
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

      // Now that each OrderItem has a real id, persist the batch draws recorded above against it
      // (looked up by variantId — safe per the uniqueness note above).
      for (const it of created.items) {
        if (!it.variantId) continue;
        const consumeResult = consumeResultByVariant.get(it.variantId);
        if (consumeResult) await recordConsumption(tx, { orderItemId: it.id }, consumeResult.consumed);
      }

      // ── Free-gift promo lines ("buy N, get M free") ──────────────────
      // Created as SEPARATE rows (not nested in the batch above) specifically so each one's real id
      // is known immediately — Prisma's nested-create return array order isn't guaranteed to match
      // input order (see the comment above `consumeResultByVariant`), and a reward variant could
      // collide with something already in the cart or with another gift line, so matching consumption
      // results back by variantId alone would be unsafe here. Never blocks the real order: a reward
      // that's out of stock is silently skipped by drawFreeGiftStock, not thrown.
      const freeGiftItems: (typeof created.items)[number][] = [];
      if (houseSeller && totals.freeGifts.length > 0) {
        const drawn = await drawFreeGiftStock(tx, totals.freeGifts);
        for (const { input, consumed } of drawn) {
          const giftItem = await tx.orderItem.create({
            data: { orderId: created.id, ...input, sellerId: houseSeller.id },
          });
          await recordConsumption(tx, { orderItemId: giftItem.id }, consumed);
          freeGiftItems.push(giftItem);
        }
      }

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
      //
      // One shared implementation with the food checkout — the statement order inside is
      // load-bearing against a redemption race. See services/coupons.ts.
      await redeemCouponInTx(tx, totals.couponCode, userId, created.id);

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
      // Free-gift rows are always house-only (v1 restriction, enforced at offer-creation) — fold
      // them into the house seller's bucket so they get the same subOrderId as everything else. They
      // contribute 0 to subtotal/taxableValue, so commission/TCS math is unaffected either way.
      if (freeGiftItems.length > 0) {
        const arr = itemsBySeller.get(houseSeller!.id) ?? [];
        arr.push(...freeGiftItems);
        itemsBySeller.set(houseSeller!.id, arr);
      }
      if (itemsBySeller.size > 0) {
        const sellers = await tx.seller.findMany({
          where: { id: { in: [...itemsBySeller.keys()] } },
          select: { id: true, commissionPct: true, isHouse: true, ownerUserId: true, pan: true, entityType: true },
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
          // Income Tax Sec 194-O TDS — off (0) unless StoreConfig.tds194oEnabled. See
          // services/sellerTds194o.ts for the rate/threshold/deduction-point discipline.
          const { tdsAmount } = await computeSubOrderTds194o(tx, seller, subtotal);
          const netPayable = +(subtotal - commissionAmount - tcsAmount - tdsAmount).toFixed(2);

          const subOrder = await tx.subOrder.create({
            data: {
              orderId: created.id,
              sellerId: sid,
              status: "PLACED",
              subtotal,
              commissionPct,
              commissionAmount,
              tcsAmount,
              tdsAmount,
              netPayable,
            },
          });
          await tx.orderItem.updateMany({
            where: { id: { in: sellerItems.map((it) => it.id) } },
            data: { subOrderId: subOrder.id },
          });
          // The platform doesn't owe its own house store — only accrue payout for real sellers.
          if (!seller.isHouse) {
            await tx.seller.update({
              where: { id: sid },
              data: { outstandingBalance: { increment: netPayable } },
              select: { id: true },
            });
          }
          // Notify whoever logs in to pack this slice — house co-manager included. The house
          // seller's ownerUserId points to the co-manager's own login (same mechanism as a
          // third-party seller), and this is a direct per-device-token push, not the owner_orders
          // topic — so the co-manager's device (which never subscribes to owner_orders, only the
          // literal StoreConfig.ownerUid device does) actually needs this to hear about new orders.
          if (seller.ownerUserId) {
            sellerNotifications.push({ ownerUserId: seller.ownerUserId, itemCount: sellerItems.length, subtotal });
          }
        }
      }

      return created;
    });

    // The opening entry in this order's history. fromState is null — nothing preceded creation.
    recordOrderEventAsync({
      orderId: order.id,
      toState: "PLACED",
      actorType: "CUSTOMER",
      actorId: userId,
      metadata: { paymentMethod, fulfillmentType, totalAmount: totals.totalAmount, source: "APP" },
    });

    // A new order changes the customer's rolling spend → drop their cached loyalty spend so they
    // re-tier promptly (otherwise the memo could serve stale spend for up to its TTL).
    bustUserSpend(userId);

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
        try {
          const amountInPaise = Math.round(totals.totalAmount * 100);
          const rpOrder = await createRazorpayOrder(amountInPaise, order.orderNumber);
          razorpayOrderId = rpOrder.id;
          await prisma.order.update({
            where: { id: order.id },
            data: { razorpayOrderId: rpOrder.id },
          });
        } catch (rpErr) {
          // Gateway rejected the request (bad/rotated keys, Razorpay outage). Degrade to the same
          // shape as "not configured": return no razorpayOrderId — the app then shows its
          // "online payment unavailable, choose COD" message and the PENDING order is
          // auto-cancelled by the expiry sweeper. A naked throw here would surface as a
          // useless generic 500 to the customer.
          console.error("Razorpay order creation failed (check RAZORPAY_KEY_ID/SECRET):", rpErr);
        }
      }
    }

    // Generate invoice for COD orders immediately (online orders get invoiced after payment).
    // A fully-wallet-paid online order is already settled at placement → invoice it now too.
    if (paymentMethod === "COD" || fullyWalletPaid) {
      generateOrderInvoice(order.id).catch((e) => console.error("Invoice generation failed:", e));
    }

    // FCM to the owner + to each seller with a slice in this order (fire and forget) — but ONLY for
    // orders that are actually settled. An ONLINE/UPI order sitting at PENDING isn't a real order yet
    // (the sweeper cancels it if the customer never pays), and it's hidden from both the owner board
    // and the seller list until confirmed (PAYMENT_SETTLED in ownerOrders.ts / sellerOrders.ts) — so
    // pushing here would announce an order nobody can open. markOrderPaid() sends both instead, at the
    // moment payment lands.
    if (paymentMethod === "COD" || fullyWalletPaid) {
      notifyNewOrder(order).catch((e: unknown) => console.error("[background task failed]", e));
      for (const sn of sellerNotifications) {
        notifySubOrderNew(sn.ownerUserId, { orderNumber: order.orderNumber, itemCount: sn.itemCount, subtotal: sn.subtotal }).catch((e: unknown) => console.error("[background task failed]", e));
      }
    }

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
    // Already confirmed — most likely the webhook won the race and flipped it first. The customer's
    // payment genuinely succeeded, so this must read as success, not an error (was previously a hard
    // throw here, which surfaced "Order is already paid" as a payment FAILURE on a real successful charge).
    if (order.paymentStatus === "PAID") {
      res.json({ success: true, message: "Payment verified", data: { orderId: order.id, paymentStatus: "PAID" } });
      return;
    }

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
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    // Compare-and-swap: flips the status and restores stock in one transaction, and only for the
    // caller that actually wins the row. The status check used to live out here, which let a double
    // tap (or a race with the expiry sweeper / a seller reject) restore the same stock twice.
    // See services/subOrderFulfillment.ts.
    const outcome = await cancelOrder(order.id);
    if (outcome === "NOT_CANCELLABLE") {
      throw new ValidationError(`Cannot cancel order in '${order.status}' status. Only PLACED or CONFIRMED orders can be cancelled.`);
    }
    if (outcome === "ALREADY_CANCELLED") {
      // Their first tap got through and the reply was lost. The intent is satisfied, so this reads as
      // success — reporting a failure here would send them looking for an order that IS cancelled.
      // Everything below already ran for the winning call.
      res.json({ success: true, message: "Order cancelled", data: { orderId: order.id, status: "CANCELLED" } });
      return;
    }

    // Refund any captured online payment. claimRefund is the CAS that decides who calls the gateway —
    // without it, this path and reconcileOrderPayment's orphan-capture refund could both read
    // paymentStatus PAID and both refund. The gateway call stays outside any transaction.
    if (order.paymentStatus === "PAID" && order.razorpayPaymentId) {
      if (await claimRefund(order.id, order.razorpayPaymentId)) {
        try {
          await refundPayment(order.razorpayPaymentId, Math.round(Number(order.totalAmount) * 100));
          await prisma.order.update({
            where: { id: order.id },
            data: { paymentStatus: "REFUNDED" },
          });
        } catch (refundErr) {
          // Logged; the order stays REFUND_INITIATED for manual follow-up (the cancellation stands).
          console.error("Refund failed for order", order.id, refundErr);
        }
      }
    }

    // Cancelling removes this order from the rolling spend → re-tier the customer promptly.
    bustUserSpend(order.customerId);

    recordOrderEventAsync({
      orderId: order.id,
      fromState: order.status,
      toState: "CANCELLED",
      actorType: "CUSTOMER",
      actorId: order.customerId,
      reason: "cancelled by customer",
    });

    notifyOrderStatusChange({ ...order, status: "CANCELLED" }).catch((e: unknown) => console.error("[background task failed]", e));
    syncInvoicePaymentStatus(order.id).catch((e) => console.error("Invoice sync failed:", e));
    // Return any store credit that was applied to this order (idempotent; no-op if none).
    refundWalletOnCancel(order.id).catch((e) => console.error("wallet refund failed:", e));
    reverseSellerLedgerOnCancel(order.id).catch((e) => console.error("seller ledger reversal failed:", e));

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

    // Subscription-generated orders are EXCLUDED from the main "My Orders" list — a daily milk
    // subscription would otherwise flood it with ~30 rows/month. subscriptionId is null for normal
    // checkout orders. ?subscription=only inverts it, for the app's Past → Subscription sub-tab
    // (which had no way to ever receive a row before this).
    const listWhere = {
      customerId: userId,
      subscriptionId: req.query.subscription === "only" ? { not: null } : null,
    };
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: listWhere,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          // variant.productId lets the app link a thumbnail straight to its product page —
          // OrderItem itself has no productId column, only variantId (same fix as GET /:id).
          items: { select: { productName: true, quantity: true, unitPrice: true, mrp: true, lineTotal: true, imageUrl: true, isLoose: true, stepSize: true, stepUnit: true, packageUnit: true, hsnCode: true, gstRate: true, variantId: true, isFreeGift: true, variant: { select: { productId: true } }, subOrder: { select: { seller: { select: { name: true, isHouse: true } } } } } },
        },
      }),
      prisma.order.count({ where: listWhere }),
    ]);

    // Attach the handover code to shipped, unverified OTP orders so the customer can see it on
    // Home / the Orders list without opening detail. Same exposure rule as GET /:id (owner-only
    // data, out-for-delivery/ready-for-pickup only, unverified). One batched query over the page.
    const otpOrderIds = orders
      .filter((o) => o.deliveryOtpRequired && OTP_VISIBLE_STATUSES.includes(o.status))
      .map((o) => o.id);
    const secrets = otpOrderIds.length
      ? await prisma.orderSecret.findMany({
          where: { orderId: { in: otpOrderIds }, verified: false },
          select: { orderId: true, otp: true },
        })
      : [];
    const otpByOrder = new Map(secrets.map((s) => [s.orderId, s.otp]));
    // Media fields hold Storage object PATHS — swap each for a 6h signed URL before it leaves.
    const data = await signOrderMediaList(
      orders.map((o) => ({
        ...o,
        deliveryOtp: otpByOrder.get(o.id) ?? null,
        // Flatten the seller onto each item, matching GET /:id. A food order needs it so the list
        // card can name the restaurant; grocery gets its "Sold by" attribution here for free.
        items: o.items.map((it) => ({
          ...it,
          productId: it.variant?.productId ?? null,
          sellerName: it.subOrder?.seller?.name ?? null,
          sellerIsHouse: it.subOrder?.seller?.isHouse ?? null,
        })),
      })),
    );

    res.json({
      success: true,
      data,
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
        savedAmount: true, totalAmount: true, walletApplied: true, estimatedReadyAt: true,
        freeSampleName: true, freeSampleImageUrl: true, freeSamplePacked: true,
        // What was ordered and where it is going. This screen used to show an order id and a
        // payment id and nothing else — it is the one moment a wrong address is free to catch,
        // and it gave the customer nothing to catch it with.
        shippingAddress: true, addressId: true,
      },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    const [savings, eta, scratch, items, addr] = await Promise.all([
      computeUserSavings(userId),
      computeOrderEta(order.fulfillmentType, order.deliverySlot),
      getScratchForCelebration(order.id),
      // ⚠️ Read as their own queries rather than `items:`/`address:` branches of the select above.
      // Prisma's inference for `order` in this handler collapses to the bare Order row — the same
      // pre-existing wart that makes `order.items.map(...)` implicitly-any elsewhere in this file —
      // so a nested relation does not type-check. The rider-status block further down already works
      // around it exactly this way. Two extra indexed reads beat an `as any` over the whole row.
      prisma.orderItem.findMany({
        where: { orderId: order.id },
        select: { productName: true, imageUrl: true, quantity: true, lineTotal: true },
        // Biggest lines first: only the first few are shown, and the expensive items are the
        // recognisable ones. Alphabetical would lead with whatever happens to start with "A".
        orderBy: { lineTotal: "desc" },
      }),
      order.addressId
        ? prisma.address.findUnique({ where: { id: order.addressId }, select: { label: true } })
        : null,
    ]);

    res.json({
      success: true,
      data: {
        orderId: order.id,
        status: order.status,
        savedAmount: Number(order.savedAmount),
        yearSavings: savings.yearToDate,
        etaLabel: eta.etaLabel,
        // ⚠️ `totalAmount` is what was left to CHARGE, already net of store credit — a fully
        // wallet-paid order carries 0 in it. The order is still worth what it is worth, so the
        // headline figure adds the credit back, exactly as the order-detail bill does.
        total: Number(order.totalAmount) + Number(order.walletApplied),
        amountCharged: Number(order.totalAmount),
        fulfillmentType: order.fulfillmentType,
        // Two parts, not one pre-joined line: the app renders this in two languages, and the label
        // is the half worth emphasising.
        addressLabel: addr?.label ?? null,
        addressLine: order.shippingAddress ?? null,
        // The whole basket's count, but only the first few rows. This is a reassurance glance
        // ("yes, that is my order"), not the itemised bill — order detail already carries that.
        itemCount: items.length,
        items: items.slice(0, 4).map((it) => ({
          name: it.productName,
          imageUrl: it.imageUrl,
          quantity: Number(it.quantity),
          lineTotal: Number(it.lineTotal),
        })),
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

// ─── Order message thread (customer ↔ owner/whichever seller has a slice of this order) ───────
// Reuses QuoteMessage's exact schema/preview helpers (appUser.ts) — same shape, different table
// (see services/orderMessages.ts for why OrderMessage is its own model, not a widened QuoteMessage).

router.get("/:id/messages", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findFirst({ where: { id: req.params.id, customerId: req.appUser!.id }, select: { id: true } });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    const messages = await prisma.orderMessage.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    res.json({ success: true, data: messages.map(shapeOrderMessage) });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/:id/messages", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = quoteMessageSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid message", parsed.error.errors);
    const order = await prisma.order.findFirst({ where: { id: req.params.id, customerId: req.appUser!.id }, select: { id: true, orderNumber: true, customerId: true } });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    const msg = await prisma.orderMessage.create({
      data: {
        orderId: order.id, sender: "CUSTOMER",
        text: parsed.data.text?.trim() || null, voiceUrl: parsed.data.voiceUrl || null, imageUrls: parsed.data.imageUrls ?? [],
      },
    });
    try {
      const sellerOwnerUserIds = await ownerUserIdsForSellers(await sellerIdsForOrder(order.id));
      await notifyOrderMessage({
        orderId: order.id, orderNumber: order.orderNumber, fromSender: "CUSTOMER",
        customerUserId: order.customerId, sellerOwnerUserIds, preview: quoteMessagePreview(parsed.data),
      });
    } catch (e) {
      console.warn("notifyOrderMessage failed:", e);
    }
    const messages = await prisma.orderMessage.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    res.status(201).json({ success: true, data: messages.map(shapeOrderMessage) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/app/orders/:id — order detail ─────────────────────────

router.get("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;

    const order = await prisma.order.findFirst({
      where: { id: String(req.params.id ?? ""), customerId: userId },
      include: {
        // Each item carries its seller (via the sub-order) so the app can show "Sold by <shop>"
        // and group the order by seller. Also its variant, so we can flatten the real productId
        // onto the item below — OrderItem has no productId column of its own, only variantId.
        items: {
          include: {
            subOrder: { include: { seller: { select: { id: true, name: true, isHouse: true } } } },
            variant: { select: { productId: true } },
          },
        },
        address: true,
      },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    // Include OTP for the customer only once handover is imminent (out for delivery / ready for
    // pickup) and it's not yet verified — never while PLACED/CONFIRMED/PACKED.
    let deliveryOtp: string | null = null;
    if (order.deliveryOtpRequired) {
      const secret = await prisma.orderSecret.findUnique({ where: { orderId: order.id } });
      if (secret && !secret.verified && OTP_VISIBLE_STATUSES.includes(order.status)) {
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
      productId: it.variant?.productId ?? null,
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
      isHouse: iv.supplierName == null,
      totalAmount: Number(iv.totalAmount),
      invoiceType: iv.invoiceType,
    }));

    // Live rider position, surfaced as a DISTANCE rather than raw coordinates.
    //
    // ⚠️ REVERSED Sep 17 2026 on an explicit owner decision: this now returns lat/lng so the
    // customer app can draw a live map. The previous rule was "a distance, never coordinates" — the
    // reasoning was that handing every customer a rider's exact position is a far larger disclosure
    // than "how far away is my order" needs. That concern is real and has NOT gone away; it was
    // accepted deliberately, not overlooked. What still contains it:
    //   • only while the order is OUT_FOR_DELIVERY (no position before the trip or after it),
    //   • only a fix under 15 min old,
    //   • only to the ONE customer whose order this is (the handler is already customerId-scoped),
    //   • still NO history — one overwritten row, so there is no trail to reconstruct.
    // distanceKm is kept alongside: it is what the UI falls back to when the delivery address has no
    // pin, which today is EVERY address (see the Sep 17 address fix).
    //
    // Gated on OUT_FOR_DELIVERY (before that there's no trip; after it the rider is on someone
    // else's order) and on a position fresher than 15 min, so the app never renders a stale
    // position as though it were live.
    let riderStatus: {
      name: string;
      phone: string | null;
      distanceKm: number | null;
      lastSeenAt: Date;
      lat: number;
      lng: number;
      destLat: number | null;
      destLng: number | null;
      // Which half of the journey the rider is on: fetching the goods, or bringing them.
      leg: "TO_PICKUP" | "TO_CUSTOMER";
      // The shop they collect from. Sent on BOTH legs so the customer can always see where their
      // order is coming from; null for a seller who has never marked their pickup point.
      pickupLat: number | null;
      pickupLng: number | null;
      pickupName: string | null;
      routePolyline: string | null;
      etaMinutes: number | null;
    } | null = null;

    // ⚠️ WIDENED Sep 20 2026 to cover the PICKUP leg as well as the delivery one, so the customer
    // can watch the rider fetch their order rather than having it appear on the road already.
    //
    // PACKED with a rider assigned means exactly that: since the two-step accept/pickup change, a
    // claimed order SITS at PACKED until the rider taps "picked up", so this window is the rider
    // travelling to the shop.
    //
    // ⚠️ This releases the rider's coordinates roughly 10-20 minutes earlier than before. That is
    // a real extension of the disclosure this file already documents, made deliberately on the
    // owner's request, not an oversight. Every other containment is untouched: coordinates still go
    // only to the one customer who owns the order (this handler is customerId-scoped), still only
    // with a fix under 15 minutes old, and still with NO position history written anywhere.
    // Held as its own const so the null check below narrows it. Testing a boolean alias instead
    // leaves order.deliveryBoyId as string|null at the findUnique, which is what the old inline
    // "status === X && order.deliveryBoyId" condition had been quietly doing for us.
    const riderId = order.deliveryBoyId;
    const onPickupLeg = riderId != null && order.status === "PACKED";
    const onDeliveryLeg = riderId != null && order.status === "OUT_FOR_DELIVERY";
    if (riderId && (onPickupLeg || onDeliveryLeg)) {
      const rider = await prisma.user.findUnique({
        where: { id: riderId },
        select: { name: true, phone: true, lastLat: true, lastLng: true, lastSeenAt: true },
      });
      const fresh = rider?.lastSeenAt != null && Date.now() - rider.lastSeenAt.getTime() < 15 * 60 * 1000;
      if (rider && fresh && rider.lastLat != null && rider.lastLng != null) {
        // Read the destination pin directly rather than through order.address: `order`'s inferred
        // type in this handler has lost its include shape (the same pre-existing wart that makes
        // `order.items.map((it) =>` implicitly-any a few lines up), so reaching through the relation
        // doesn't type-check. One extra lookup on a rare path beats an `as any` over the whole row.
        const dest = order.addressId
          ? await prisma.address.findUnique({
              where: { id: order.addressId },
              select: { lat: true, lng: true },
            })
          : null;
        const destLat = dest?.lat != null ? Number(dest.lat) : null;
        const destLng = dest?.lng != null ? Number(dest.lng) : null;

        // Where the goods are collected from. Read as its own query for the same reason the
        // address is: this handler's inferred type for `order` has lost its include shape.
        //
        // ⚠️ The stop that matters is the first one NOT yet collected. A multi-seller order has
        // several, and pointing at the first in the list would keep showing a shop the rider has
        // already been to. Cancelled slices are skipped for the same reason.
        //
        // ⚠️ House stops count here, unlike in the rider's own pickupStops. A house-only order
        // still has a physical counter the rider walks to, and the customer is owed a pin for it.
        const stops = await prisma.subOrder.findMany({
          where: { orderId: order.id },
          select: {
            status: true,
            seller: { select: { name: true, lat: true, lng: true } },
          },
          orderBy: { createdAt: "asc" },
        });
        const nextStop =
          stops.find(
            (st) => st.status !== "COLLECTED" && st.status !== "CANCELLED" && st.seller?.lat != null,
          ) ?? stops.find((st) => st.seller?.lat != null);
        const pickupLat = nextStop?.seller?.lat != null ? Number(nextStop.seller.lat) : null;
        const pickupLng = nextStop?.seller?.lng != null ? Number(nextStop.seller.lng) : null;
        const pickupName = nextStop?.seller?.name ?? null;

        // On the pickup leg the rider is driving to the SHOP, so that is what the route and the ETA
        // have to be measured to. Routing to the customer's door while the rider is heading the
        // other way would show a line going backwards and an arrival time that is simply wrong.
        const targetLat = onPickupLeg ? pickupLat : destLat;
        const targetLng = onPickupLeg ? pickupLng : destLng;

        // The real road route + ETA, cached per order so the app's 30s poll doesn't bill a Routes
        // call every time. Null whenever ROUTES_API_KEY is unset or Google is unhappy — the app
        // then draws the dashed straight line it drew before this existed.
        // ⚠️ The cache keys on the destination too, so the handover from shop to doorstep
        // re-fetches on its own rather than serving the leftover leg-one line.
        const route =
          targetLat != null && targetLng != null
            ? await getRiderRoute(order.id, Number(rider.lastLat), Number(rider.lastLng), targetLat, targetLng)
            : null;
        riderStatus = {
          name: rider.name,
          // The rider's own number, so a customer can ring them when the gate is locked or the
          // lane is unmarked. It is the single most-asked-for action on a live tracking screen
          // and the app had no way to do it at all.
          // ⚠️ This is a REAL personal number, not a masked proxy line. It rides the exact same
          // gate as the coordinates above — OUT_FOR_DELIVERY, a fix under 15 min, and only the one
          // customer who owns this order — which is what stops it becoming a directory of your
          // riders. Masking needs a Twilio-style proxy; at 2-5 in-house riders that is more
          // machinery than the problem. Revisit if riders are ever third-party.
          phone: rider.phone,
          // Distance to whatever the rider is actually driving at right now — the shop on the
          // pickup leg, the doorstep after. Null when that end has no pin, and the app then shows
          // "on the way" with a timestamp rather than inventing a number.
          distanceKm:
            targetLat != null && targetLng != null
              ? Math.round(haversineKm(Number(rider.lastLat), Number(rider.lastLng), targetLat, targetLng) * 10) / 10
              : null,
          lastSeenAt: rider.lastSeenAt!,
          // The map needs both ends of the line. destLat/destLng are null for an address saved
          // before the Sep 17 fix, and the app then shows the rider alone without a destination pin
          // rather than dropping a marker on 0,0 in the Gulf of Guinea.
          lat: Number(rider.lastLat),
          lng: Number(rider.lastLng),
          destLat,
          destLng,
          leg: onPickupLeg ? ("TO_PICKUP" as const) : ("TO_CUSTOMER" as const),
          pickupLat,
          pickupLng,
          pickupName,
          routePolyline: route?.polyline ?? null,
          // A real driving ETA beats the straight-line distance for answering "how long until my
          // order is here" — but it is still only as fresh as the rider's last position fix.
          etaMinutes: route?.etaMinutes ?? null,
        };
      }
    }

    res.json({
      success: true,
      data: await signOrderMedia({
        ...order, items, freeSampleName: sampleName, freeSampleImageUrl: sampleImage, deliveryOtp, invoices,
        riderStatus,
      }),
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
      // Restore the original variant's batches first (frees them up — and matters if the
      // substitute happens to BE the original's own product in some other pack size drawing from
      // the same underlying stock pool, though that's not a case this app currently creates).
      if (item.variantId) {
        await restoreConsumption(tx, { orderItemId: item.id });
      }

      // Consume FIFO batches for the substitute variant, then re-link this SAME orderItemId's
      // consumption ledger to the substitute's draw (restoreConsumption above already cleared the
      // old rows for this id) — costPriceSnapshot below reflects the substitute's real cost, not
      // the original's.
      let substituteCostSnapshot: number | null = item.costPriceSnapshot != null ? Number(item.costPriceSnapshot) : null;
      if (item.substituteVariantId) {
        const decrementBy = item.isLoose && item.stepSize
          ? Number(item.quantity) * Number(item.stepSize)
          : Number(item.quantity);
        let consumeResult;
        try {
          consumeResult = await consumeFifo(tx, item.substituteVariantId, decrementBy);
        } catch (e) {
          if (e instanceof AppError && e.code === "INSUFFICIENT_STOCK") {
            throw new ValidationError("Substitute is now out of stock");
          }
          throw e;
        }
        await recordConsumption(tx, { orderItemId: item.id }, consumeResult.consumed);
        substituteCostSnapshot = consumeResult.totalQty > 0 ? consumeResult.weightedUnitCost : null;
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
          costPriceSnapshot: substituteCostSnapshot,
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
    notifySubstitutionResponse(order, item.substituteProductName ?? "", "approved").catch((e: unknown) => console.error("[background task failed]", e));

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
