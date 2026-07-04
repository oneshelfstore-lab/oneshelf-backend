import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { notifyOrderStatusChange, notifyNewDeliveryAvailable, notifyNewComplaint, notifySubOrderPacked } from "../services/fcmNotifier.js";

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
