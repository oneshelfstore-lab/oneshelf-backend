import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { notifyOrderStatusChange, notifyDeliveryAssignment } from "../services/fcmNotifier.js";
import { syncInvoicePaymentStatus, generateOrderInvoice } from "../services/orderInvoice.js";
import { markSamplePacked } from "../services/freeSample.js";
import { creditReferrerOnFirstDelivered, refundWalletOnCancel } from "../services/referralRewards.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

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

    res.json({ success: true, data: order });
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

    const allowed = VALID_TRANSITIONS[order.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new ValidationError(`Cannot transition from '${order.status}' to '${newStatus}'. Allowed: ${allowed?.join(", ") ?? "none"}`);
    }

    const updateData: any = { status: newStatus };

    // Handle cancellation — restore stock
    if (newStatus === "CANCELLED") {
      await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          if (!item.variantId) continue;
          const restoreAmount = item.isLoose && item.stepSize
            ? item.quantity * Number(item.stepSize)
            : item.quantity;
          await tx.productVariant.update({
            where: { id: item.variantId },
            data: { stock: { increment: restoreAmount } },
          });
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

    notifyOrderStatusChange({ ...order, status: newStatus }).catch(() => {});
    // Referral wallet hooks (idempotent + best-effort). Credit the referrer on the referee's first
    // delivery; refund any store credit if the order is cancelled.
    if (newStatus === "DELIVERED") {
      creditReferrerOnFirstDelivered(order.id).catch((e) => console.error("referral credit failed:", e));
    }
    if (newStatus === "CANCELLED") {
      refundWalletOnCancel(order.id).catch((e) => console.error("wallet refund failed:", e));
    }

    res.json({ success: true, data: { orderId: order.id, status: newStatus } });
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

    if (order.fulfillmentType !== "DELIVERY") {
      throw new ValidationError("Can only assign delivery agents to delivery orders");
    }

    const agent = await prisma.user.findUnique({ where: { id: deliveryBoyId } });
    if (!agent || agent.role !== "DELIVERY") {
      throw new ValidationError("Invalid delivery agent");
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { deliveryBoyId },
    });

    notifyDeliveryAssignment(order, deliveryBoyId).catch(() => {});

    res.json({ success: true, data: { orderId: order.id, deliveryBoyId } });
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

    // Only allow substitutions on orders being packed (CONFIRMED or PACKED).
    if (!["CONFIRMED", "PACKED"].includes(order.status)) {
      throw new ValidationError(`Cannot propose substitutions on '${order.status}' orders. Must be CONFIRMED or PACKED.`);
    }

    const item = order.items.find((i) => i.id === (req.params.itemId as string));
    if (!item) throw new NotFoundError("OrderItem", req.params.itemId as string);

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
    }).catch(() => {});

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

export default router;
