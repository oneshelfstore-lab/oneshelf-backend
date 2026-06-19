import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";

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
    createdAt: so.createdAt,
    customerName: so.order?.shippingName ?? null,
    customerPhone: so.order?.shippingPhone ?? null,
    subtotal: Number(so.subtotal),
    commissionAmount: Number(so.commissionAmount),
    netPayable: Number(so.netPayable),
    settled: so.settled,
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
  order: { select: { orderNumber: true, status: true, fulfillmentType: true, shippingName: true, shippingPhone: true } },
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
    res.json({ success: true, data: shape(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
