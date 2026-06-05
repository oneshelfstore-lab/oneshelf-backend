import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { notifyOrderStatusChange } from "../services/fcmNotifier.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("DELIVERY", "OWNER") as any);

// ─── GET /api/app/delivery/orders — assigned orders ─────────────────

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const since = req.query.since as string | undefined;

    const where: any = {
      deliveryBoyId: userId,
      status: { in: ["PACKED", "OUT_FOR_DELIVERY"] },
    };

    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        where.updatedAt = { gt: sinceDate };
      }
    }

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true, orderNumber: true, status: true, fulfillmentType: true,
        paymentMethod: true, paymentStatus: true, totalAmount: true,
        deliveryOtpRequired: true, shippingName: true, shippingPhone: true,
        shippingAddress: true, shippingPincode: true,
        createdAt: true, updatedAt: true,
        _count: { select: { items: true } },
      },
    });

    res.json({
      success: true,
      data: orders,
      serverTimestamp: new Date().toISOString(),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/app/delivery/orders/:id — order detail ────────────────

router.get("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const isOwner = req.appUser!.role === "OWNER";

    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: { select: { productName: true, quantity: true, lineTotal: true, isLoose: true, stepSize: true, stepUnit: true } },
        address: true,
      },
    });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    // Delivery agent can only see their assigned orders; owner sees all
    if (!isOwner && order.deliveryBoyId !== userId) {
      throw new AppError(403, "FORBIDDEN", "This order is not assigned to you");
    }

    // Never expose OTP to delivery agent — only customer sees it
    res.json({ success: true, data: order });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/delivery/orders/:id/accept — accept assignment ───

router.post("/:id/accept", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    if (order.deliveryBoyId !== userId) throw new AppError(403, "FORBIDDEN", "Not assigned to you");
    if (order.status !== "PACKED") throw new ValidationError("Can only accept orders in PACKED status");

    await prisma.order.update({
      where: { id: order.id },
      data: { status: "OUT_FOR_DELIVERY" },
    });

    notifyOrderStatusChange({ ...order, status: "OUT_FOR_DELIVERY" }).catch(() => {});

    res.json({ success: true, data: { orderId: order.id, status: "OUT_FOR_DELIVERY" } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/delivery/orders/:id/deliver — OTP-verified delivery

const deliverSchema = z.object({
  code: z.string().length(4).optional(),
});

router.post("/:id/deliver", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = deliverSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { code } = parsed.data;

    const userId = req.appUser!.id;
    const isOwner = req.appUser!.role === "OWNER";

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw new NotFoundError("Order", req.params.id!);

    // Auth: must be assigned agent OR owner
    if (!isOwner && order.deliveryBoyId !== userId) {
      throw new AppError(403, "FORBIDDEN", "Not assigned to you");
    }

    if (order.status === "DELIVERED") throw new ValidationError("Order is already delivered");
    if (!["OUT_FOR_DELIVERY", "READY_FOR_PICKUP", "PACKED"].includes(order.status)) {
      throw new ValidationError(`Cannot deliver order in '${order.status}' status`);
    }

    // OTP verification
    if (order.deliveryOtpRequired) {
      if (!code) throw new ValidationError("Delivery code is required for this order");

      const secret = await prisma.orderSecret.findUnique({ where: { orderId: order.id } });
      if (!secret) throw new AppError(500, "INTERNAL_ERROR", "OTP secret not found");

      if (secret.verified) throw new ValidationError("Code already verified");
      if (secret.attempts >= secret.maxAttempts) {
        throw new ValidationError("Maximum verification attempts exceeded. Contact support.");
      }

      if (secret.otp !== code) {
        // Increment attempts (standalone write so it persists even if we throw)
        await prisma.orderSecret.update({
          where: { orderId: order.id },
          data: { attempts: { increment: 1 } },
        });
        throw new ValidationError(`Incorrect code. ${secret.maxAttempts - secret.attempts - 1} attempts remaining.`);
      }

      // Code matches — mark verified + deliver in one batch
      await prisma.$transaction([
        prisma.orderSecret.update({
          where: { orderId: order.id },
          data: { verified: true },
        }),
        prisma.order.update({
          where: { id: order.id },
          data: {
            status: "DELIVERED",
            deliveredAt: new Date(),
            paymentStatus: order.paymentMethod === "COD" ? "PAID" : order.paymentStatus,
          },
        }),
      ]);
    } else {
      // No OTP required — just mark delivered
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: "DELIVERED",
          deliveredAt: new Date(),
          paymentStatus: order.paymentMethod === "COD" ? "PAID" : order.paymentStatus,
        },
      });
    }

    notifyOrderStatusChange({ ...order, status: "DELIVERED" }).catch(() => {});

    res.json({ success: true, data: { orderId: order.id, status: "DELIVERED" } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
