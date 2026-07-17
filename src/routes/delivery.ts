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
import { accrueReferralCommission, istMonthKey } from "../services/referralRewards.js";
import { checkTierUpOnDelivery } from "../services/loyalty.js";
import { OTP_LOCK_SECONDS } from "../lib/otp.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("DELIVERY", "OWNER") as any);

// ─── GET /api/app/delivery/orders — assigned orders ─────────────────

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const since = req.query.since as string | undefined;

    // Two buckets in one feed:
    //  • assigned to me (PACKED = accept, OUT_FOR_DELIVERY = active), and
    //  • the shared "Available" pool: any UNASSIGNED, PACKED delivery order. A house order the
    //    co-manager just packed lands here so every agent can see + accept it (first to claim wins).
    const where: any = {
      OR: [
        { deliveryBoyId: userId, status: { in: ["PACKED", "OUT_FOR_DELIVERY"] } },
        { deliveryBoyId: null, status: "PACKED", fulfillmentType: "DELIVERY" },
      ],
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
        // Bulk Express: "BULK_QUOTE" → delivery card shows a BULK badge. amountPaid (advance already
        // captured) lets the card show the correct cash-to-collect = totalAmount − amountPaid.
        source: true, amountPaid: true,
        // Customer-uploaded gate/door photo, shown on the delivery card to help find the address.
        gatePhotoUrl: true,
        // Customer-recorded voice note, played on the delivery card.
        voiceNoteUrl: true,
        // Set when this order was auto-generated from a subscription → the app shows a 🔁 chip.
        subscriptionId: true,
        _count: { select: { items: true } },
        // Per-seller collection manifest for the Phase-5 collection run. House sub-orders
        // (seller.isHouse) are at the store — shown as "From store", auto-collected; only
        // non-house stops need a physical pickup.
        subOrders: {
          select: {
            id: true, status: true, collectedAt: true,
            seller: {
              select: {
                id: true, name: true, shopAddress: true, city: true,
                pincode: true, lat: true, lng: true, phone: true, isHouse: true,
              },
            },
            items: { select: { productName: true, quantity: true } },
          },
        },
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

// Cash this agent has collected but not yet handed over/settled — since their LAST settlement (or
// all-time if they've never settled). This is the "still owed to the store" figure, independent of
// the calendar-day "today's stats" numbers below.
async function computeUnsettledCash(userId: string) {
  const lastSettlement = await prisma.cashSettlement.findFirst({
    where: { deliveryBoyId: userId },
    orderBy: { settledAt: "desc" },
    select: { settledAt: true },
  });
  const orders = await prisma.order.findMany({
    where: {
      deliveryBoyId: userId,
      paymentMethod: "COD",
      status: "DELIVERED",
      ...(lastSettlement ? { deliveredAt: { gt: lastSettlement.settledAt } } : {}),
    },
    select: { totalAmount: true, amountPaid: true },
  });
  const amount = orders.reduce(
    (sum, o) => sum + Math.max(0, Number(o.totalAmount) - Number(o.amountPaid)),
    0,
  );
  return { amount, orderCount: orders.length, lastSettledAt: lastSettlement?.settledAt ?? null };
}

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
      select: { totalAmount: true, amountPaid: true },
    });

    // Cash actually collected at the door = total − anything already captured online (bulk advance).
    // amountPaid is 0 for normal COD orders, so this is unchanged for them.
    const totalCollected = orders.reduce(
      (sum, o) => sum + Math.max(0, Number(o.totalAmount) - Number(o.amountPaid)),
      0,
    );
    // unsettled = the real "still owe the store" figure (may span multiple days if never settled),
    // distinct from totalCollected which is scoped to just today.
    const unsettled = await computeUnsettledCash(userId);
    res.json({
      success: true,
      data: {
        date: startUtc.toISOString(), orderCount: orders.length, totalCollected,
        unsettledCash: unsettled.amount, unsettledOrderCount: unsettled.orderCount, lastSettledAt: unsettled.lastSettledAt,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/delivery/cash-settle — agent hands over collected COD cash ─
// Records the handover (self-reported, same trust level as the rest of COD in this app — no money
// physically moves through the backend) so the running unsettledCash total resets. Recomputes the
// amount server-side (never trusts a client-sent figure) so it can't be under-reported.
router.post("/cash-settle", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null;

    const unsettled = await computeUnsettledCash(userId);
    if (unsettled.orderCount === 0) throw new ValidationError("Nothing to settle — no unsettled COD cash.");

    const settlement = await prisma.cashSettlement.create({
      data: { deliveryBoyId: userId, amount: unsettled.amount, orderCount: unsettled.orderCount, note },
    });
    res.json({
      success: true,
      data: { id: settlement.id, amount: Number(settlement.amount), orderCount: settlement.orderCount, settledAt: settlement.settledAt },
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
    select: { name: true, phone: true, isAvailableForDelivery: true, deliveryMonthlySalary: true },
  });
  if (!user) throw new NotFoundError("User", userId);

  const startUtc = istTodayStartUtc();
  const delivered = await prisma.order.findMany({
    where: { deliveryBoyId: userId, status: "DELIVERED", deliveredAt: { gte: startUtc } },
    select: { totalAmount: true, amountPaid: true, paymentMethod: true },
  });
  const todayCash = delivered
    .filter((o) => o.paymentMethod === "COD")
    .reduce((sum, o) => sum + Math.max(0, Number(o.totalAmount) - Number(o.amountPaid)), 0);

  // Rider's own payroll view (read-only). What they're paid monthly, whether this month is settled,
  // and a short history — so they can see it without asking the owner.
  const currentMonth = istMonthKey(new Date());
  const salaryPayments = await prisma.riderSalaryPayment.findMany({
    where: { riderId: userId },
    orderBy: { periodMonth: "desc" },
    take: 12,
    select: { periodMonth: true, amount: true, paidAt: true },
  });

  return {
    name: user.name,
    phone: user.phone,
    isAvailableForDelivery: user.isAvailableForDelivery,
    todayDeliveredCount: delivered.length,
    todayCash,
    monthlySalary: Number(user.deliveryMonthlySalary),
    salaryPaidThisMonth: salaryPayments.some((p) => p.periodMonth === currentMonth),
    salaryHistory: salaryPayments.map((p) => ({ periodMonth: p.periodMonth, amount: Number(p.amount) })),
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

// ─── GET /api/app/delivery/orders/subscription-run — today's batched subscription run ──
// Declared BEFORE "/:id". All of THIS agent's subscription-generated orders for today, in one route
// ordered by pincode/area, each with items + cash-to-collect. This is the "one delivery boy delivers
// all subscriptions together" view. Prepaid (WALLET/UPI) stops show "Prepaid"; COD stops show cash.
router.get("/subscription-run", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const startUtc = istTodayStartUtc();

    const orders = await prisma.order.findMany({
      where: {
        deliveryBoyId: userId,
        subscriptionId: { not: null },
        status: { in: ["PACKED", "OUT_FOR_DELIVERY"] },
        // today's run: generated today (subscriptionDate) — the engine stamps IST-midnight.
        subscriptionDate: { gte: startUtc },
      },
      orderBy: [{ shippingPincode: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, orderNumber: true, status: true,
        paymentMethod: true, paymentStatus: true, totalAmount: true, amountPaid: true,
        shippingName: true, shippingPhone: true, shippingAddress: true, shippingPincode: true,
        subscriptionId: true, createdAt: true,
        items: {
          select: { productName: true, quantity: true, lineTotal: true, isLoose: true, stepSize: true, stepUnit: true },
        },
      },
    });

    // Cash to collect = COD orders only (prepaid wallet/UPI already PAID at generation).
    const cashToCollect = orders
      .filter((o) => o.paymentMethod === "COD")
      .reduce((sum, o) => sum + Math.max(0, Number(o.totalAmount) - Number(o.amountPaid)), 0);
    const pending = orders.filter((o) => o.status !== "DELIVERED").length;

    res.json({
      success: true,
      data: {
        date: startUtc.toISOString(),
        stops: orders.length,
        pendingStops: pending,
        cashToCollect,
        orders,
      },
      serverTimestamp: new Date().toISOString(),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/delivery/orders/subscription-run/deliver-all ─────
// Marks every still-undelivered subscription order in today's run DELIVERED (subscription orders carry
// no handover OTP). COD orders flip to PAID. Idempotent + best-effort per order. Returns how many landed.
router.post("/subscription-run/deliver-all", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const startUtc = istTodayStartUtc();

    const orders = await prisma.order.findMany({
      where: {
        deliveryBoyId: userId,
        subscriptionId: { not: null },
        status: { in: ["PACKED", "OUT_FOR_DELIVERY"] },
        subscriptionDate: { gte: startUtc },
      },
      select: { id: true, orderNumber: true, status: true, paymentMethod: true, customerId: true },
    });

    let delivered = 0;
    for (const o of orders) {
      try {
        const r = await prisma.order.updateMany({
          where: { id: o.id, status: { in: ["PACKED", "OUT_FOR_DELIVERY"] } },
          data: {
            status: "DELIVERED",
            deliveredAt: new Date(),
            paymentStatus: o.paymentMethod === "COD" ? "PAID" : undefined,
          },
        });
        if (r.count > 0) {
          delivered++;
          notifyOrderStatusChange({ ...o, status: "DELIVERED" }).catch(() => {});
        }
      } catch (e) {
        console.error("subscription deliver-all: order failed", o.id, e);
      }
    }

    res.json({ success: true, data: { delivered, total: orders.length } });
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
        subOrders: {
          select: {
            id: true, status: true, collectedAt: true,
            seller: {
              select: {
                id: true, name: true, shopAddress: true, city: true,
                pincode: true, lat: true, lng: true, phone: true, isHouse: true,
              },
            },
            items: { select: { productName: true, quantity: true } },
          },
        },
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

// Atomically claim an unassigned order for this delivery boy. Returns false if someone else grabbed
// it first (the conditional updateMany only matches while deliveryBoyId is still null). Idempotent
// when the caller already owns it.
async function claimForAgent(orderId: string, userId: string): Promise<boolean> {
  const r = await prisma.order.updateMany({
    where: { id: orderId, deliveryBoyId: null },
    data: { deliveryBoyId: userId },
  });
  return r.count > 0;
}

// ─── POST /api/app/delivery/orders/:id/accept — accept (and claim if pooled) ───

router.post("/:id/accept", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    if (order.status !== "PACKED") throw new ValidationError("Can only accept orders in PACKED status");

    // Assigned to someone else → hands off. Unassigned (shared pool) → claim it atomically.
    if (order.deliveryBoyId && order.deliveryBoyId !== userId) {
      throw new AppError(403, "FORBIDDEN", "This order was already taken by another delivery partner");
    }
    if (!order.deliveryBoyId) {
      const claimed = await claimForAgent(order.id, userId);
      if (!claimed) throw new ValidationError("This order was just taken by another delivery partner");
    }

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

// ─── POST /api/app/delivery/orders/:id/collect/:subOrderId — collection-run pickup ──
// The delivery agent marks one seller's (PACKED) sub-order COLLECTED during the collection run.
// House sub-orders (the store's own items) sit at the dispatch point and are auto-collected here.
// When every sub-order is collected, the parent order auto-advances PACKED → OUT_FOR_DELIVERY.
// House-only orders never call this — they use /accept (no behavior change for the common case).
router.post("/:id/collect/:subOrderId", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const isOwner = req.appUser!.role === "OWNER";
    const orderId = req.params.id as string;
    const subOrderId = req.params.subOrderId as string;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundError("Order", orderId);
    if (order.status !== "PACKED") {
      throw new ValidationError(`Can only collect for orders in PACKED status (order is '${order.status}')`);
    }
    // Assigned to someone else → forbidden. Unassigned (shared pool) → the agent claims it by
    // starting the collection run. Owner is exempt.
    if (!isOwner) {
      if (order.deliveryBoyId && order.deliveryBoyId !== userId) {
        throw new AppError(403, "FORBIDDEN", "This order was already taken by another delivery partner");
      }
      if (!order.deliveryBoyId) {
        const claimed = await claimForAgent(order.id, userId);
        if (!claimed) throw new ValidationError("This order was just taken by another delivery partner");
      }
    }

    const sub = await prisma.subOrder.findFirst({
      where: { id: subOrderId, orderId },
      include: { seller: { select: { isHouse: true } } },
    });
    if (!sub) throw new NotFoundError("SubOrder", subOrderId);

    // Idempotent: re-collecting an already-collected stop is a no-op success.
    if (sub.status !== "COLLECTED") {
      if (sub.status !== "PACKED") {
        throw new ValidationError("Seller hasn't packed these items yet");
      }
      await prisma.subOrder.update({
        where: { id: sub.id },
        data: { status: "COLLECTED", collectedAt: new Date(), collectedById: userId },
      });
    }

    // Auto-collect house sub-orders (they're already at the store), then advance the parent order
    // to OUT_FOR_DELIVERY once every sub-order is COLLECTED/CANCELLED.
    const all = await prisma.subOrder.findMany({
      where: { orderId },
      select: { id: true, status: true, seller: { select: { isHouse: true } } },
    });
    const houseUncollected = all.filter(
      (s) => s.seller.isHouse && s.status !== "COLLECTED" && s.status !== "CANCELLED",
    );
    if (houseUncollected.length > 0) {
      await prisma.subOrder.updateMany({
        where: { id: { in: houseUncollected.map((s) => s.id) } },
        data: { status: "COLLECTED", collectedAt: new Date(), collectedById: userId },
      });
      houseUncollected.forEach((s) => { s.status = "COLLECTED"; });
    }

    let orderStatus: string = order.status;
    const allDone = all.every((s) => s.status === "COLLECTED" || s.status === "CANCELLED");
    if (allDone) {
      await prisma.order.update({ where: { id: orderId }, data: { status: "OUT_FOR_DELIVERY" } });
      orderStatus = "OUT_FOR_DELIVERY";
      notifyOrderStatusChange({ ...order, status: "OUT_FOR_DELIVERY" }).catch(() => {});
    }

    const pickupStops = all.filter((s) => !s.seller.isHouse);
    const collectedStops = pickupStops.filter((s) => s.status === "COLLECTED").length;

    res.json({
      success: true,
      data: {
        orderId,
        subOrderId,
        subOrderStatus: "COLLECTED",
        orderStatus,
        collectedStops,
        totalStops: pickupStops.length,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/delivery/orders/:id/deliver — OTP-verified delivery

const deliverSchema = z.object({
  code: z.string().length(6).optional(),
  // Rider-captured proof-of-delivery photo (client uploads to Storage first, sends the public URL).
  proofPhotoUrl: z.string().max(500).optional().nullable(),
});

router.post("/:id/deliver", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = deliverSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { code, proofPhotoUrl } = parsed.data;

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

      // Cooldown lock (DoS-safe — never a permanent brick). The OWNER is trusted and exempt, so a
      // jammed order can always be completed by the store.
      const now = new Date();
      if (!isOwner && secret.lockedUntil && secret.lockedUntil > now) {
        const wait = Math.ceil((secret.lockedUntil.getTime() - now.getTime()) / 1000);
        throw new ValidationError(`Too many incorrect attempts. Try again in ${wait}s.`);
      }

      if (secret.otp !== code) {
        const nextAttempts = secret.attempts + 1;
        // Standalone write so the attempt/lock persists even though we throw below.
        if (!isOwner && nextAttempts >= secret.maxAttempts) {
          // Cap hit → lock for a cooldown window and reset the counter (fresh tries after it lapses).
          await prisma.orderSecret.update({
            where: { orderId: order.id },
            data: { attempts: 0, lockedUntil: new Date(now.getTime() + OTP_LOCK_SECONDS * 1000) },
          });
          throw new ValidationError(`Incorrect code. Too many attempts — try again in ${OTP_LOCK_SECONDS}s.`);
        }
        await prisma.orderSecret.update({
          where: { orderId: order.id },
          data: { attempts: { increment: 1 } },
        });
        throw new ValidationError(`Incorrect code. ${secret.maxAttempts - nextAttempts} attempts remaining.`);
      }

      // Code matches — mark verified (+ clear any lock) and deliver in one batch.
      await prisma.$transaction([
        prisma.orderSecret.update({
          where: { orderId: order.id },
          data: { verified: true, attempts: 0, lockedUntil: null },
        }),
        prisma.order.update({
          where: { id: order.id },
          data: {
            status: "DELIVERED",
            deliveredAt: new Date(),
            paymentStatus: order.paymentMethod === "COD" ? "PAID" : order.paymentStatus,
            deliveryProofPhotoUrl: proofPhotoUrl ?? order.deliveryProofPhotoUrl,
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
          deliveryProofPhotoUrl: proofPhotoUrl ?? order.deliveryProofPhotoUrl,
        },
      });
    }

    notifyOrderStatusChange({ ...order, status: "DELIVERED" }).catch(() => {});
    // Referral commission: accrue the referrer's ongoing % on this order (idempotent + best-effort —
    // never blocks the delivery response).
    accrueReferralCommission(order.id).catch((e) => console.error("referral commission accrual failed:", e));
    checkTierUpOnDelivery(order.id).catch((e) => console.error("tier-up check failed:", e));

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
