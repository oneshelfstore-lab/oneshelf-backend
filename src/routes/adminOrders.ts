import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";
import { syncInvoicePaymentStatus, generateOrderInvoice } from "../services/orderInvoice.js";
import { creditReferrerOnFirstDelivered, refundWalletOnCancel } from "../services/referralRewards.js";

/**
 * Admin order management for the React dashboard (JWT auth).
 * Mirrors the Firebase-auth owner routes but for staff users.
 * Mounted at /api/orders behind the global authMiddleware.
 */
const router = Router();

// GET /api/orders — list all app orders (dashboard dispatch board)
router.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const status = (req.query.status as string) || undefined;
    const search = ((req.query.search as string) || "").slice(0, 100) || undefined;

    const where: any = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: "insensitive" } },
        { shippingName: { contains: search, mode: "insensitive" } },
        { shippingPhone: { contains: search, mode: "insensitive" } },
      ];
    }

    const [orders, total, statusCounts] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          _count: { select: { items: true } },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.groupBy({ by: ["status"], _count: true }),
    ]);

    const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s._count]));

    res.json({
      success: true,
      data: orders,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      statusCounts: counts,
    });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/orders/:id — full order detail
router.get("/:id", async (req: Request, res: Response) => {
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

// PUT /api/orders/:id/status — advance status (owner/accountant)
const VALID_TRANSITIONS: Record<string, string[]> = {
  PLACED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PACKED", "CANCELLED"],
  PACKED: ["OUT_FOR_DELIVERY", "READY_FOR_PICKUP"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  READY_FOR_PICKUP: ["DELIVERED"],
};

const statusSchema = z.object({
  status: z.enum(["CONFIRMED", "PACKED", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP", "DELIVERED", "CANCELLED"]),
});

router.put("/:id/status", requireRole("OWNER", "ACCOUNTANT", "BILLING_CLERK") as any, async (req: Request, res: Response) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid status", parsed.error.errors);
    const { status: newStatus } = parsed.data;

    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    const allowed = VALID_TRANSITIONS[order.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new ValidationError(`Cannot transition from '${order.status}' to '${newStatus}'.`);
    }

    if (newStatus === "CANCELLED") {
      await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          if (!item.variantId) continue;
          const restore = item.isLoose && item.stepSize ? item.quantity * Number(item.stepSize) : item.quantity;
          await tx.productVariant.update({ where: { id: item.variantId }, data: { stock: { increment: restore } } });
        }
        await tx.order.update({ where: { id: order.id }, data: { status: newStatus } });
      });
    } else {
      const data: any = { status: newStatus };
      if (newStatus === "DELIVERED") {
        data.deliveredAt = new Date();
        if (order.paymentMethod === "COD") data.paymentStatus = "PAID";
      }
      await prisma.order.update({ where: { id: order.id }, data });
    }

    // Sync payment/cancellation to linked invoice
    if (newStatus === "DELIVERED" || newStatus === "CANCELLED") {
      syncInvoicePaymentStatus(order.id).catch((e) => console.error("Invoice sync failed:", e));
    }
    if (newStatus === "DELIVERED" && !order.invoiceId) {
      generateOrderInvoice(order.id).catch((e) => console.error("Invoice generation failed:", e));
    }
    // Referral wallet hooks (idempotent + best-effort).
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

export default router;
