import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { notifyOrderStatusChange, notifyNewDeliveryAvailable, notifyNewComplaint, notifySubOrderPacked } from "../services/fcmNotifier.js";
import { bustUserSpend } from "../services/loyalty.js";
import { refundPayment } from "../services/razorpay.js";
import { syncInvoicePaymentStatus } from "../services/orderInvoice.js";
import { refundWalletOnCancel } from "../services/referralRewards.js";
import { restoreConsumption } from "../services/stockBatches.js";

// Fixed, translatable reason set the co-manager/seller picks from when rejecting an order — mirrors
// the shape of the customer-facing "Need help" reason chips (see OrderHelpSheet) so both surfaces feel
// consistent. Kept as a small closed enum (not free text) so the owner's Complaints inbox gets a
// scannable reason, not a wall of ad-hoc prose; `note` still allows an optional short elaboration.
const REJECT_REASON_LABELS: Record<string, string> = {
  OUT_OF_STOCK: "Item(s) out of stock",
  TOO_BUSY: "Store too busy to fulfill in time",
  ITEM_UNAVAILABLE: "Item(s) no longer available",
  PRICING_ERROR: "Pricing / listing error",
  OTHER: "Other reason",
};

// When a seller marks their slice PACKED, the PARENT order may now be fully ready. If every sub-order
// is PACKED/COLLECTED/CANCELLED and the parent is still pre-packed (PLACED/CONFIRMED), advance it:
//   DELIVERY → PACKED  (enters the delivery "Available" pool — any agent can accept it)
//   PICKUP   → READY_FOR_PICKUP  (customer collects; no delivery agent)
// Without this, packing at the seller/co-manager level never pushes the order into the delivery
// pipeline — it just sat "awaiting pickup" and no delivery boy ever saw it.
async function maybeAdvanceParentOrder(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, status: true, fulfillmentType: true, orderNumber: true,
      deliveryBoyId: true, paymentMethod: true, paymentStatus: true, customerId: true,
    },
  });
  if (!order) return;
  if (order.status !== "PLACED" && order.status !== "CONFIRMED") return;

  // Never ship an online order that hasn't been paid yet (COD is collected at the door, so it's fine).
  if (order.paymentMethod !== "COD" && order.paymentStatus === "PENDING") return;

  const subs = await prisma.subOrder.findMany({
    where: { orderId }, select: { status: true },
  });
  const allReady = subs.length > 0 &&
    subs.every((s) => s.status === "PACKED" || s.status === "COLLECTED" || s.status === "CANCELLED");
  if (!allReady) return;

  const newStatus = order.fulfillmentType === "PICKUP" ? "READY_FOR_PICKUP" : "PACKED";
  await prisma.order.update({ where: { id: orderId }, data: { status: newStatus } });

  notifyOrderStatusChange({ ...order, status: newStatus }).catch(() => {});
  // Unassigned delivery order → it's now in the shared pool; ping available agents.
  if (newStatus === "PACKED" && !order.deliveryBoyId) {
    notifyNewDeliveryAvailable({ id: order.id, orderNumber: order.orderNumber }).catch(() => {});
  }
}

// Seller-scoped orders. Mounted at /api/app/seller/orders. A seller sees only their own SubOrders
// (their slice of each parent order) and can mark their slice ACCEPTED / PACKED. The delivery
// collection-run (COLLECTED) and the parent-order lifecycle are handled elsewhere (Phase 5).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

function shape(so: any) {
  return {
    id: so.id,
    orderId: so.orderId,
    orderNumber: so.order?.orderNumber ?? "",
    status: so.status,
    parentStatus: so.order?.status ?? "",
    fulfillmentType: so.order?.fulfillmentType ?? "DELIVERY",
    // Subscription-generated orders are auto-packed at creation (no accept/pack step) — the app uses
    // this to badge + group them separately so they don't read as unexplained "orders with no action".
    isSubscription: so.order?.subscriptionId != null,
    createdAt: so.createdAt,
    customerName: so.order?.shippingName ?? null,
    customerPhone: so.order?.shippingPhone ?? null,
    subtotal: Number(so.subtotal),
    commissionAmount: Number(so.commissionAmount),
    netPayable: Number(so.netPayable),
    settled: so.settled,
    // Customer's special request (text) + recorded voice note — the co-manager packing these
    // items needs them too (clarifies item names STT mangles), not just the delivery agent.
    notes: so.order?.notes ?? null,
    voiceNoteUrl: so.order?.voiceNoteUrl ?? null,
    items: (so.items ?? []).map((it: any) => ({
      id: it.id,
      productName: it.productName,
      variantSku: it.variantSku,
      imageUrl: it.imageUrl,
      quantity: it.quantity,
      unitPrice: Number(it.unitPrice),
      lineTotal: Number(it.lineTotal),
      isLoose: it.isLoose,
      stepSize: it.stepSize != null ? Number(it.stepSize) : null,
      stepUnit: it.stepUnit,
    })),
  };
}

const ORDER_INCLUDE = {
  order: { select: { orderNumber: true, status: true, fulfillmentType: true, shippingName: true, shippingPhone: true, notes: true, voiceNoteUrl: true, subscriptionId: true } },
  items: { select: { id: true, productName: true, variantSku: true, imageUrl: true, quantity: true, unitPrice: true, lineTotal: true, isLoose: true, stepSize: true, stepUnit: true } },
} as const;

// ─── GET / — this seller's sub-orders (newest first) ──────────────
router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const subOrders = await prisma.subOrder.findMany({
      where: { sellerId: req.sellerId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: ORDER_INCLUDE,
    });
    res.json({ success: true, data: subOrders.map(shape) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PATCH /:id/status — mark ACCEPTED / PACKED (ownership-checked) ─
router.patch("/:id/status", async (req: SellerRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const parsed = z.object({ status: z.enum(["ACCEPTED", "PACKED"]) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("status must be ACCEPTED or PACKED");
    const { status } = parsed.data;

    const sub = await prisma.subOrder.findFirst({ where: { id, sellerId: req.sellerId } });
    if (!sub) throw new NotFoundError("SubOrder", id);

    const data: any = { status };
    if (status === "PACKED") data.packedAt = new Date();

    const updated = await prisma.subOrder.update({ where: { id }, data, include: ORDER_INCLUDE });

    // Packing a slice may complete the parent order → push it into the delivery pipeline.
    // Best-effort: a hiccup here must never fail the seller's pack action.
    if (status === "PACKED") {
      // Immediate per-seller progress ping — separate from maybeAdvanceParentOrder's notify, which
      // only fires once EVERY seller on a multi-seller order is done. This lets the owner + an
      // already-assigned delivery agent see "this seller is ready to collect" right away.
      // Best-effort, same as maybeAdvanceParentOrder below: a lookup/notify hiccup must never turn a
      // successful pack action into a 500 for the seller.
      try {
        const [seller, order] = await Promise.all([
          prisma.seller.findUnique({ where: { id: req.sellerId }, select: { name: true } }),
          prisma.order.findUnique({ where: { id: sub.orderId }, select: { id: true, orderNumber: true, deliveryBoyId: true } }),
        ]);
        if (seller && order) {
          notifySubOrderPacked({ id: order.id, orderNumber: order.orderNumber }, seller.name, order.deliveryBoyId).catch(() => {});
        }
      } catch (e) {
        console.error("notifySubOrderPacked lookup failed:", e);
      }

      await maybeAdvanceParentOrder(sub.orderId).catch((e) =>
        console.error("maybeAdvanceParentOrder failed:", e),
      );
    }

    res.json({ success: true, data: shape(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/reject — seller/co-manager declines their slice before packing ──
// Distinct from flag-unavailable (subscriptions only, owner resolves manually): this is a full reject
// of a regular order slice, allowed only before packing starts (PLACED/ACCEPTED). Restores stock for
// this slice immediately (nothing was ever handed over) and, when this was the ONLY active seller on
// the order (single-seller order, or the last still-active slice of a multi-seller one), cancels +
// refunds the whole parent order — mirroring the customer's own /orders/:id/cancel path exactly, since
// from the customer's perspective nothing is left to fulfill either way. If other sellers' slices are
// still active, the parent order is left alone (they still get their items) and a Complaint is raised
// so the owner can sort out a partial refund/replacement with the customer manually.
const rejectSchema = z.object({
  reason: z.enum(["OUT_OF_STOCK", "TOO_BUSY", "ITEM_UNAVAILABLE", "PRICING_ERROR", "OTHER"]),
  note: z.string().max(500).optional(),
});
router.post("/:id/reject", async (req: SellerRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const parsed = rejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError("Pick a reason for rejecting this order");
    const { reason, note } = parsed.data;

    const sub = await prisma.subOrder.findFirst({
      where: { id, sellerId: req.sellerId },
      include: {
        items: { select: { id: true, variantId: true, quantity: true, isLoose: true, stepSize: true } },
        order: { select: { id: true, orderNumber: true, status: true, paymentStatus: true, paymentMethod: true, razorpayPaymentId: true, totalAmount: true, customerId: true, shippingName: true } },
      },
    });
    if (!sub) throw new NotFoundError("SubOrder", id);
    if (sub.status !== "PLACED" && sub.status !== "ACCEPTED") {
      throw new ValidationError(`Cannot reject an order that's already ${sub.status.toLowerCase()}.`);
    }

    const otherActiveSubs = await prisma.subOrder.count({
      where: { orderId: sub.orderId, id: { not: sub.id }, status: { notIn: ["CANCELLED"] } },
    });
    const isLastActiveSeller = otherActiveSubs === 0;

    await prisma.$transaction(async (tx) => {
      for (const item of sub.items) {
        if (!item.variantId) continue;
        await restoreConsumption(tx, { orderItemId: item.id });
      }

      await tx.subOrder.update({ where: { id: sub.id }, data: { status: "CANCELLED" } });

      if (isLastActiveSeller && (sub.order.status === "PLACED" || sub.order.status === "CONFIRMED")) {
        await tx.order.update({ where: { id: sub.order.id }, data: { status: "CANCELLED" } });
      }
    });

    const reasonLabel = REJECT_REASON_LABELS[reason] ?? reason;
    const complaint = await prisma.complaint.create({
      data: {
        userId: sub.order.customerId,
        orderId: sub.orderId,
        subject: `Seller rejected order #${sub.order.orderNumber}`,
        message: `Reason: ${reasonLabel}.` + (note ? ` Note: ${note}` : ""),
      },
    });
    notifyNewComplaint({
      id: complaint.id,
      subject: complaint.subject,
      customerName: sub.order.shippingName || req.appUser!.name,
    }).catch(() => {});

    if (isLastActiveSeller && (sub.order.status === "PLACED" || sub.order.status === "CONFIRMED")) {
      // Whole order is now cancelled — same refund/notify path as a customer-initiated cancel.
      bustUserSpend(sub.order.customerId);
      if (sub.order.paymentStatus === "PAID" && sub.order.razorpayPaymentId) {
        try {
          await prisma.order.update({ where: { id: sub.order.id }, data: { paymentStatus: "REFUND_INITIATED" } });
          await refundPayment(sub.order.razorpayPaymentId, Math.round(Number(sub.order.totalAmount) * 100));
          await prisma.order.update({ where: { id: sub.order.id }, data: { paymentStatus: "REFUNDED" } });
        } catch (refundErr) {
          console.error("Refund failed for order", sub.order.id, refundErr);
        }
      }
      notifyOrderStatusChange({ id: sub.order.id, orderNumber: sub.order.orderNumber, status: "CANCELLED", customerId: sub.order.customerId }).catch(() => {});
      syncInvoicePaymentStatus(sub.order.id).catch((e) => console.error("Invoice sync failed:", e));
      refundWalletOnCancel(sub.order.id).catch((e) => console.error("wallet refund failed:", e));
    }

    res.json({
      success: true,
      data: { subOrderId: sub.id, orderCancelled: isLastActiveSeller, complaintId: complaint.id },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/flag-unavailable — "can't fulfill this subscription delivery today" ──
// Seller-initiated, owner-resolved (not an automatic cancel/refund): raises a Complaint linked to the
// parent order, visible in the owner's existing Complaints inbox. The owner reviews and, if warranted,
// cancels that ONE order via the existing order-management flow — which already auto-refunds any
// wallet-applied amount (services/referralRewards.ts refundWalletOnCancel, keyed off Order.walletApplied,
// which the subscription engine already stamps on prepaid deliveries). Deliberately NOT an automatic
// money-moving action here: a bad-faith or mistaken flag should not self-service a refund.
const flagSchema = z.object({ note: z.string().max(500).optional() });
router.post("/:id/flag-unavailable", async (req: SellerRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const parsed = flagSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError("Invalid data");

    const sub = await prisma.subOrder.findFirst({
      where: { id, sellerId: req.sellerId },
      include: { order: { select: { id: true, orderNumber: true, subscriptionId: true } } },
    });
    if (!sub) throw new NotFoundError("SubOrder", id);
    if (!sub.order.subscriptionId) {
      throw new ValidationError("This is only for subscription deliveries — contact the store for a regular order.");
    }

    const itemNames = (await prisma.orderItem.findMany({
      where: { subOrderId: sub.id },
      select: { productName: true },
    })).map((i) => i.productName).join(", ");

    const complaint = await prisma.complaint.create({
      data: {
        userId: req.appUser!.id,
        orderId: sub.orderId,
        subject: `Subscription delivery unavailable — order #${sub.order.orderNumber}`,
        message:
          `Seller flagged today's subscription delivery as unavailable (${itemNames || "item"}).` +
          (parsed.data.note ? ` Note: ${parsed.data.note}` : ""),
      },
    });

    notifyNewComplaint({
      id: complaint.id,
      subject: complaint.subject,
      customerName: req.appUser!.name,
    }).catch(() => {});

    res.status(201).json({ success: true, data: { complaintId: complaint.id } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
