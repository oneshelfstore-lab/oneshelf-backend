import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { notifyOrderStatusChange, notifyDeliveryArrived } from "../services/fcmNotifier.js";

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

// ─── GET /api/app/delivery/cash-summary — today's COD cash collected ─
// Declared BEFORE "/:id" so Express doesn't match "cash-summary" as an order id.
router.get("/cash-summary", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;

    // Start of "today" in IST (UTC+5:30), expressed in UTC for the deliveredAt filter.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
    const startUtc = new Date(istMidnight - IST_OFFSET_MS);

    const orders = await prisma.order.findMany({
      where: {
        deliveryBoyId: userId,
        paymentMethod: "COD",
        status: "DELIVERED",
        deliveredAt: { gte: startUtc },
      },
      select: { totalAmount: true },
    });

    const totalCollected = orders.reduce((sum, o) => sum + Number(o.totalAmount), 0);
    res.json({
      success: true,
      data: { date: startUtc.toISOString(), orderCount: orders.length, totalCollected },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Shared: start of "today" in IST, expressed in UTC (for deliveredAt filters) ──
function istTodayStartUtc(): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  return new Date(istMidnight - IST_OFFSET_MS);
}

// Builds the delivery boy's profile + today's stats (delivered count + COD cash to settle).
async function buildDeliveryProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, phone: true, isAvailableForDelivery: true },
  });
  if (!user) throw new NotFoundError("User", userId);

  const startUtc = istTodayStartUtc();
  const delivered = await prisma.order.findMany({
    where: { deliveryBoyId: userId, status: "DELIVERED", deliveredAt: { gte: startUtc } },
    select: { totalAmount: true, paymentMethod: true },
  });
  const todayCash = delivered
    .filter((o) => o.paymentMethod === "COD")
    .reduce((sum, o) => sum + Number(o.totalAmount), 0);

  return {
    name: user.name,
    phone: user.phone,
    isAvailableForDelivery: user.isAvailableForDelivery,
    todayDeliveredCount: delivered.length,
    todayCash,
  };
}

// NOTE: this router is mounted at /api/app/delivery/orders, so all paths below are under
// .../orders/... (e.g. "/me" → /api/app/delivery/orders/me).

// ─── GET /api/app/delivery/orders/me — profile + availability + today's stats ──
// Declared BEFORE "/:id" so Express doesn't treat "me" as an order id.
router.get("/me", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const data = await buildDeliveryProfile(req.appUser!.id);
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PATCH /api/app/delivery/orders/me — flip the availability toggle ──────
const availabilitySchema = z.object({ available: z.boolean() });

router.patch("/me", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = availabilitySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);

    await prisma.user.update({
      where: { id: req.appUser!.id },
      data: { isAvailableForDelivery: parsed.data.available },
    });
    const data = await buildDeliveryProfile(req.appUser!.id);
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/app/delivery/orders/history — this boy's delivered orders ────
// Declared BEFORE "/:id". Newest-delivered first, capped at 50 (a delivery boy never needs more
// than the recent tail on-device). Same slim shape as GET / so OrderDto.toDomain reuses cleanly.
router.get("/history", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      where: { deliveryBoyId: req.appUser!.id, status: "DELIVERED" },
      orderBy: { deliveredAt: "desc" },
      take: 50,
      select: {
        id: true, orderNumber: true, status: true, fulfillmentType: true,
        paymentMethod: true, paymentStatus: true, totalAmount: true,
        deliveryOtpRequired: true, shippingName: true, shippingPhone: true,
        shippingAddress: true, shippingPincode: true,
        createdAt: true, updatedAt: true, deliveredAt: true,
        _count: { select: { items: true } },
      },
    });
    res.json({ success: true, data: orders, serverTimestamp: new Date().toISOString() });
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

// ─── POST /api/app/delivery/orders/:id/arrived — ping the customer ──
// Lets the delivery boy tell the customer "I'm here" (FCM push). No status change.
router.post("/:id/arrived", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const isOwner = req.appUser!.role === "OWNER";

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    if (!isOwner && order.deliveryBoyId !== userId) {
      throw new AppError(403, "FORBIDDEN", "Not assigned to you");
    }

    notifyDeliveryArrived(order).catch(() => {});
    res.json({ success: true, data: { orderId: order.id } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
