import { Router, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { notifyOrderStatusChange, notifyDeliveryAssignment, notifyNewDeliveryAvailable, notifyOrderMessage } from "../services/fcmNotifier.js";
import { syncInvoicePaymentStatus, generateOrderInvoice } from "../services/orderInvoice.js";
import { markSamplePacked } from "../services/freeSample.js";
import { accrueReferralCommission, refundWalletOnCancel } from "../services/referralRewards.js";
import { checkTierUpOnDelivery } from "../services/loyalty.js";
import { restoreConsumption } from "../services/stockBatches.js";
import { shapeOrderMessage } from "../services/orderMessages.js";
import { assertSellersPacked, markSubOrderPackedByOwner, reverseSellerLedgerOnCancel } from "../services/subOrderFulfillment.js";
import { quoteMessageSchema, quoteMessagePreview } from "./appUser.js";
import { getRiderOnboardingStatus, riderBlockedReason } from "./deliveryOnboarding.js";
import { signOrderMedia } from "../lib/storageUrls.js";
import { recordOrderEventAsync } from "../services/orderEvents.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// An ONLINE/UPI order is created PLACED/PENDING *before* Razorpay confirms it, and the expiry sweeper
// cancels it if the customer never pays. Keep it off the dispatch board and un-actionable until the
// payment lands, so nobody packs goods for an order that vanishes 20 min later. Mirrors
// PAYMENT_SETTLED in sellerOrders.ts. markOrderPaid() bumps updatedAt, so the board's `since` poll
// picks the order up the moment it's confirmed.
// Deliberately NOT gated: GET /:id detail and the message thread — reading an order and asking the
// customer "did your payment go through?" are exactly what you want while it's pending.
const PAYMENT_SETTLED: Prisma.OrderWhereInput = {
  NOT: { paymentMethod: { in: ["ONLINE", "UPI"] }, paymentStatus: "PENDING" },
};

function assertPaymentSettled(order: { paymentMethod: string; paymentStatus: string }) {
  if ((order.paymentMethod === "ONLINE" || order.paymentMethod === "UPI") && order.paymentStatus === "PENDING") {
    throw new ValidationError("This order's online payment hasn't been confirmed yet — it'll appear on the board once the customer's payment goes through.");
  }
}

// Valid status transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  PLACED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PACKED", "CANCELLED"],
  PACKED: ["OUT_FOR_DELIVERY", "READY_FOR_PICKUP"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  READY_FOR_PICKUP: ["DELIVERED"],
};

// ─── GET /api/app/owner/orders — dispatch board (polled) ────────────

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const since = req.query.since as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const status = req.query.status as string | undefined;

    const where: any = {};

    // Exclude subscription-generated orders from the owner's main board — they auto-pack + auto-assign
    // to the single subscription runner, and the owner plans them via the subscription "tomorrow totals"
    // view. Keeps the board to real one-off customer orders. (subscriptionId is null for normal orders.)
    where.subscriptionId = null;

    // Hide online orders still awaiting payment confirmation (see PAYMENT_SETTLED above).
    Object.assign(where, PAYMENT_SETTLED);

    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        where.updatedAt = { gt: sinceDate };
      }
    }

    if (status) {
      where.status = status;
    }

    const [orders, total, statusCounts] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, orderNumber: true, status: true, fulfillmentType: true,
          paymentMethod: true, paymentStatus: true, totalAmount: true,
          deliveryOtpRequired: true, deliveryBoyId: true, couponCode: true,
          shippingName: true, shippingPhone: true, shippingAddress: true,
          source: true, // "BULK_QUOTE" → owner board shows a BULK badge
          // A failed drop returns the order to PACKED, which is otherwise indistinguishable from a
          // freshly-packed order. These are what tell the owner it came back and why.
          deliveryAttempts: true, lastDeliveryFailure: true, lastDeliveryFailedAt: true,
          createdAt: true, updatedAt: true,
          customer: { select: { id: true, name: true, phone: true } },
          _count: { select: { items: true } },
          // Per-seller collection progress for the admin "Collected X/Y shops" chip (Phase 5).
          // Non-house sub-orders are the pickup stops; counts only — no owner action here.
          subOrders: {
            select: { id: true, status: true, seller: { select: { name: true, isHouse: true } } },
          },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.groupBy({
        by: ["status"],
        // Same board scope as the list (minus the status/since filters, which would collapse the
        // per-status counts) — otherwise the tab badges count orders the board deliberately hides.
        where: { subscriptionId: null, ...PAYMENT_SETTLED },
        _count: true,
      }),
    ]);

    const counts = Object.fromEntries(statusCounts.map(s => [s.status, s._count]));

    res.json({
      success: true,
      data: orders,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      statusCounts: counts,
      serverTimestamp: new Date().toISOString(),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/app/owner/orders/:id — full order detail ──────────────

router.get("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        address: true,
        customer: { select: { id: true, name: true, phone: true, email: true } },
        deliveryBoy: { select: { id: true, name: true, phone: true } },
      },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    res.json({ success: true, data: await signOrderMedia(order) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/orders/:id/sample-packed — confirm the free sample is in the bag ──
// Unlocks the customer's named reveal. The gate that keeps the sample feature honest.

router.post("/:id/sample-packed", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const ok = await markSamplePacked(req.params.id!);
    if (!ok) throw new NotFoundError("FreeSample", req.params.id!);
    res.json({ success: true, data: { orderId: req.params.id, freeSamplePacked: true } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT /api/app/owner/orders/:id/status — advance status ─────────

const statusSchema = z.object({
  status: z.enum(["CONFIRMED", "PACKED", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP", "DELIVERED", "CANCELLED"]),
});

router.put("/:id/status", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid status", parsed.error.errors);
    const { status: newStatus } = parsed.data;

    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    assertPaymentSettled(order);

    const allowed = VALID_TRANSITIONS[order.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new ValidationError(`Cannot transition from '${order.status}' to '${newStatus}'. Allowed: ${allowed?.join(", ") ?? "none"}`);
    }

    // Marking the parent PACKED is what releases it to the delivery pool, and the agent's collection run
    // can only pick up slices the seller has already packed — so every external seller must be ready
    // first, or the order deadlocks mid-run. See services/subOrderFulfillment.ts.
    if (newStatus === "PACKED") await assertSellersPacked(order.id);

    const updateData: any = { status: newStatus };

    // Handle cancellation — restore stock
    if (newStatus === "CANCELLED") {
      await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          if (!item.variantId) continue;
          await restoreConsumption(tx, { orderItemId: item.id });
        }
        await tx.order.update({ where: { id: order.id }, data: updateData });
      });
    } else {
      // Handle delivery completion
      if (newStatus === "DELIVERED") {
        updateData.deliveredAt = new Date();
        if (order.paymentMethod === "COD") {
          updateData.paymentStatus = "PAID";
        }
      }
      await prisma.order.update({ where: { id: order.id }, data: updateData });
    }

    // Sync payment status to linked invoice (DELIVERED→PAID, CANCELLED→CANCELLED)
    if (newStatus === "DELIVERED" || newStatus === "CANCELLED") {
      syncInvoicePaymentStatus(order.id).catch((e) => console.error("Invoice sync failed:", e));
    }
    // Generate invoice if it doesn't exist yet (e.g. for orders that were placed before auto-generation was added)
    if (newStatus === "DELIVERED" && !order.invoiceId) {
      generateOrderInvoice(order.id).catch((e) => console.error("Invoice generation failed:", e));
    }

    recordOrderEventAsync({
      orderId: order.id,
      fromState: order.status,
      toState: newStatus,
      actorType: "OWNER",
      actorId: req.appUser!.id,
    });

    notifyOrderStatusChange({ ...order, status: newStatus }).catch((e: unknown) => console.error("[background task failed]", e));
    // PACKED is what releases the order into the riders' shared pool — so this is the moment to wake
    // them. It was missing here AND in adminOrders.ts, only sellerOrders.ts had it: on a single-store
    // order (the common case) the owner packs it and NO rider was ever told. Riders had to guess and
    // hit refresh. notifyNewDeliveryAvailable no-ops for assigned/pickup orders.
    if (newStatus === "PACKED") {
      notifyNewDeliveryAvailable(order).catch((e: unknown) => console.error("[background task failed]", e));
    }
    // Referral hooks (idempotent + best-effort). Accrue the referrer's ongoing commission on every
    // delivery; refund any store credit if the order is cancelled.
    if (newStatus === "DELIVERED") {
      accrueReferralCommission(order.id).catch((e) => console.error("referral commission accrual failed:", e));
      checkTierUpOnDelivery(order.id).catch((e) => console.error("tier-up check failed:", e));
    }
    if (newStatus === "CANCELLED") {
      refundWalletOnCancel(order.id).catch((e) => console.error("wallet refund failed:", e));
      reverseSellerLedgerOnCancel(order.id).catch((e) => console.error("seller ledger reversal failed:", e));
    }

    res.json({ success: true, data: { orderId: order.id, status: newStatus } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/orders/:id/sub-orders/:subOrderId/packed ──
// Mark one seller's slice packed on their behalf. Needed because assertSellersPacked (above) now blocks
// the parent PACKED transition until every external seller is ready: a seller who has physically bagged
// the goods but never tapped "packed" would otherwise strand the order. Also the recovery path for an
// order already stuck at PACKED with an unpacked slice. Idempotent.
router.post("/:id/sub-orders/:subOrderId/packed", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const orderId = String(req.params.id ?? "");
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundError("Order", orderId);
    assertPaymentSettled(order);

    const result = await markSubOrderPackedByOwner(orderId, String(req.params.subOrderId ?? ""));
    res.json({ success: true, data: result });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/orders/:id/assign — assign delivery agent ──

const assignSchema = z.object({
  deliveryBoyId: z.string().min(1),
});

router.post("/:id/assign", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { deliveryBoyId } = parsed.data;

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    assertPaymentSettled(order);

    if (order.fulfillmentType !== "DELIVERY") {
      throw new ValidationError("Can only assign delivery agents to delivery orders");
    }

    // The route had no status check at all — a DELIVERED or CANCELLED order could be "assigned".
    if (order.status === "DELIVERED" || order.status === "CANCELLED") {
      throw new ValidationError(`This order is already ${order.status.toLowerCase()} — there's nothing to assign.`);
    }
    // Once it's OUT_FOR_DELIVERY the first rider is physically carrying the goods. Reassigning to
    // someone else silently handed the order to a second rider with no unassign and no warning —
    // both then saw it. Free to reassign before that (PACKED and earlier), which is the real use case.
    if (
      order.status === "OUT_FOR_DELIVERY" &&
      order.deliveryBoyId &&
      order.deliveryBoyId !== deliveryBoyId
    ) {
      throw new ValidationError(
        "This order is already out for delivery with another partner — they have the goods. Have them return it or complete it first.",
      );
    }

    const agent = await prisma.user.findUnique({ where: { id: deliveryBoyId } });
    if (!agent || agent.role !== "DELIVERY" || !agent.isActive) {
      throw new ValidationError("Invalid delivery agent");
    }
    // Same KYC gate the rider's own endpoints now enforce — otherwise the owner could hand an order
    // to someone whose verification is pending or rejected, and the rider would then be blocked from
    // acting on it (a dead-end order). See routes/deliveryOnboarding.ts.
    const blocked = riderBlockedReason(await getRiderOnboardingStatus(agent.id));
    if (blocked) {
      throw new ValidationError(`${agent.name} isn't verified yet — approve them in the onboarding queue first.`);
    }

    await prisma.order.update({
      where: { id: order.id },
      // Clear the unclaimed-escalation latch: the owner assigning it by hand IS the resolution.
      data: { deliveryBoyId, deliveryEscalatedAt: null },
    });

    notifyDeliveryAssignment(order, deliveryBoyId).catch((e: unknown) => console.error("[background task failed]", e));

    res.json({ success: true, data: { orderId: order.id, deliveryBoyId } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/orders/:id/unassign — take an order off a rider ──
//
// The counterpart to a failed delivery: the rider brought the goods back to the shop, so the order
// can go to somebody else. Deliberately the OWNER's call, not the rider's — only the store knows
// whether the stock is physically back on the shelf. Releasing it while it's still in a rider's bag
// would let a second rider accept an order they can't possibly fulfil.
router.post("/:id/unassign", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const orderId = String(req.params.id ?? "");
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundError("Order", orderId);
    if (!order.deliveryBoyId) throw new ValidationError("This order isn't assigned to anyone.");
    if (order.status === "DELIVERED" || order.status === "CANCELLED") {
      throw new ValidationError(`This order is already ${order.status.toLowerCase()}.`);
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      // Back to PACKED so it re-enters the shared pool in a state a new rider can act on.
      data: { deliveryBoyId: null, status: "PACKED" },
    });
    notifyNewDeliveryAvailable(updated).catch((e: unknown) => console.error("[background task failed]", e));

    res.json({ success: true, data: { orderId: order.id, status: "PACKED", deliveryBoyId: null } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/orders/:orderId/items/:itemId/substitute ──
// Owner proposes an in-stock product as a substitute for an OOS item.

const substituteSchema = z.object({
  substituteVariantId: z.string().min(1),
});

router.post("/:orderId/items/:itemId/substitute", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = substituteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { substituteVariantId } = parsed.data;

    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId as string },
      include: { items: true },
    });
    if (!order) throw new NotFoundError("Order", req.params.orderId as string);
    assertPaymentSettled(order);

    // Only allow substitutions on orders being packed (CONFIRMED or PACKED).
    if (!["CONFIRMED", "PACKED"].includes(order.status)) {
      throw new ValidationError(`Cannot propose substitutions on '${order.status}' orders. Must be CONFIRMED or PACKED.`);
    }

    const item = order.items.find((i) => i.id === (req.params.itemId as string));
    if (!item) throw new NotFoundError("OrderItem", req.params.itemId as string);

    // A free-gift line is a promised bonus, not a purchase — it can't be swapped for something else.
    if (item.isFreeGift) {
      throw new ValidationError("Free-gift lines can't be substituted.");
    }

    if (item.substitutionStatus !== "NONE" && item.substitutionStatus !== "REJECTED") {
      throw new ValidationError(`Item already has substitution status '${item.substitutionStatus}'`);
    }

    // Validate the substitute variant.
    const subVariant = await prisma.productVariant.findUnique({
      where: { id: substituteVariantId },
      include: {
        product: { select: { name: true, imageUrls: true, isActive: true } },
      },
    });
    if (!subVariant || !subVariant.isActive || !subVariant.product.isActive) {
      throw new ValidationError("Substitute variant not found or inactive");
    }
    if (Number(subVariant.stock) <= 0) {
      throw new ValidationError("Substitute variant is out of stock");
    }

    const subUnitPrice = Number(subVariant.sellingPrice);
    const originalUnitPrice = Number(item.unitPrice);
    const priceDelta = (subUnitPrice - originalUnitPrice) * Number(item.quantity);

    await prisma.orderItem.update({
      where: { id: item.id },
      data: {
        substitutionStatus: "PROPOSED",
        substituteVariantId,
        substituteProductName: subVariant.product.name,
        substituteImageUrl: subVariant.product.imageUrls?.[0] ?? null,
        substituteUnitPrice: subUnitPrice,
        substitutePriceDelta: priceDelta,
      },
    });

    // Notify customer via FCM.
    const { notifySubstitutionProposal } = await import("../services/fcmNotifier.js");
    notifySubstitutionProposal(order.customerId, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      originalItem: item.productName,
      substituteItem: subVariant.product.name,
      priceDelta,
    }).catch((e: unknown) => console.error("[background task failed]", e));

    res.json({
      success: true,
      data: {
        itemId: item.id,
        substitutionStatus: "PROPOSED",
        substituteProductName: subVariant.product.name,
        substituteUnitPrice: subUnitPrice,
        priceDelta,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Order message thread — owner replies as the store on any order ────────────────────────────
router.get("/:id/messages", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, select: { id: true } });
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
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, select: { id: true, orderNumber: true, customerId: true } });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    await prisma.orderMessage.create({
      data: {
        orderId: order.id, sender: "OWNER",
        text: parsed.data.text?.trim() || null, voiceUrl: parsed.data.voiceUrl || null, imageUrls: parsed.data.imageUrls ?? [],
      },
    });
    try {
      await notifyOrderMessage({
        orderId: order.id, orderNumber: order.orderNumber, fromSender: "OWNER",
        customerUserId: order.customerId, sellerOwnerUserIds: [], preview: quoteMessagePreview(parsed.data),
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

export default router;
