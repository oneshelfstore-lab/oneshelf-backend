import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import {
  notifyOrderStatusChange,
  notifyDeliveryArrived,
  notifyCashSettlementDeclared,
  notifyDeliveryFailed,
  notifyNewDeliveryAvailable,
} from "../services/fcmNotifier.js";
import { accrueReferralCommission, istMonthKey } from "../services/referralRewards.js";
import { checkTierUpOnDelivery } from "../services/loyalty.js";
import { syncInvoicePaymentStatus } from "../services/orderInvoice.js";
import { OTP_LOCK_SECONDS } from "../lib/otp.js";
import { signOrderMedia, signOrderMediaList } from "../lib/storageUrls.js";
import { getRiderOnboardingStatus, riderBlockedReason } from "./deliveryOnboarding.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("DELIVERY", "OWNER") as any);

/**
 * KYC gate. Until now the ONLY thing stopping an unverified rider was the Android NavGraph choosing
 * which screen to render — the server never looked at onboardingStatus at all, so a rider whose
 * documents were pending (or REJECTED) could call these endpoints directly and deliver.
 *
 * Placed as router-level middleware rather than per-route so a route added later is gated by
 * default. Mirrors the PHONE_REQUIRED gate in firebaseAuthMiddleware: a distinct code the client can
 * route on, plus a readable message.
 *
 * ⚠️ OWNER is exempt and that is load-bearing — the owner shares this router (they can deliver and
 * force-complete a jammed order) and has no DeliveryProfile at all, so gating them would lock the
 * store out of its own dispatch. Costs one indexed lookup per delivery request; same trade the
 * dashboard's tokenVersion check already makes.
 */
router.use(async (req: FirebaseAuthRequest, res: Response, next) => {
  try {
    if (req.appUser?.role === "OWNER") return next();
    const status = await getRiderOnboardingStatus(req.appUser!.id);
    const blocked = riderBlockedReason(status);
    if (blocked) throw new AppError(403, "KYC_REQUIRED", blocked);
    next();
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Everything that must happen once an order reaches DELIVERED, in ONE place so the two completion
 * paths (single `/:id/deliver` and the batched `/subscription-run/deliver-all`) can't drift — they
 * already had: deliver-all ran neither the referral accrual nor the tier-up check, so whether a
 * referrer earned their commission on a subscription delivery depended on which button the rider
 * tapped. Invoice sync was missing from BOTH, leaving every rider-completed COD order's invoice
 * unpaid in the books even though the cash was collected.
 *
 * All three are best-effort and fire-and-forget: a delivery must never fail because a push, a
 * ledger row, or an invoice update did.
 */
function runDeliveredHooks(order: { id: string; status: string; customerId: string; orderNumber: string }): void {
  notifyOrderStatusChange({ ...order, status: "DELIVERED" }).catch((e: unknown) => console.error("[background task failed]", e));
  syncInvoicePaymentStatus(order.id).catch((e) => console.error("Invoice sync failed:", e));
  accrueReferralCommission(order.id).catch((e) => console.error("referral commission accrual failed:", e));
  checkTierUpOnDelivery(order.id).catch((e) => console.error("tier-up check failed:", e));
}

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
        // ⚠️ Load-bearing: the card branches "Accept" vs "Picked up" on whether the order is already
        // this rider's. Omitting it made every claimed order still render as unclaimed, so Accept
        // just re-fired and the rider had no way to start the delivery.
        deliveryBoyId: true,
        // The real lines. This used to be `_count: { items: true }`, which nothing on the client ever
        // mapped — so the card read "0 Product Unit(s)" on every order, always.
        items: { select: { productName: true, quantity: true, lineTotal: true, isLoose: true, stepSize: true, stepUnit: true } },
        // The saved address the customer actually picked on the map. shippingAddress is only the
        // typed text, which geocodes to "somewhere on that street" — the rider needs the exact pin.
        address: { select: { id: true, label: true, addressLine: true, landmark: true, pincode: true, lat: true, lng: true } },
        // Who ordered. shippingName is the receiver at the door; customer.name is the account holder
        // — the card shows the receiver and falls back to the account name when it's blank.
        customer: { select: { id: true, name: true, phone: true } },
        // Bulk Express: "BULK_QUOTE" → delivery card shows a BULK badge. amountPaid (advance already
        // captured) lets the card show the correct cash-to-collect = totalAmount − amountPaid.
        source: true, amountPaid: true,
        // Customer-uploaded gate/door photo, shown on the delivery card to help find the address.
        gatePhotoUrl: true,
        // Customer-recorded voice note, played on the delivery card.
        voiceNoteUrl: true,
        // Set when this order was auto-generated from a subscription → the app shows a 🔁 chip.
        subscriptionId: true,
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
      // gatePhotoUrl / voiceNoteUrl are stored Storage paths — sign them for the agent's card.
      data: await signOrderMediaList(orders),
      serverTimestamp: new Date().toISOString(),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// Cash this agent has collected but not yet handed over/settled — since their LAST settlement (or
// all-time if they've never settled). This is the "still owed to the store" figure, independent of
// the calendar-day "today's stats" numbers below.
// Exported for ownerStaff.ts's remove-rider guard (route→route import, same as ownerOrders.ts
// pulling quoteMessageSchema from appUser.ts). Keeping the "since their last settlement" definition
// in one place matters: a second copy would eventually disagree with the rider's own screen.
export async function computeUnsettledCash(userId: string) {
  // ⚠️ CONFIRMED only. Counting a PENDING settlement here would let a rider zero their own debt by
  // tapping a button — which is exactly the hole the two-sided flow exists to close, and it would
  // also hand them a way to clear the cash-in-hand cap without handing over a rupee.
  const lastSettlement = await prisma.cashSettlement.findFirst({
    where: { deliveryBoyId: userId, status: "CONFIRMED" },
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
    // An open declaration the owner hasn't acknowledged yet — the rider's screen needs this or the
    // Settle button just looks broken (they tapped it, the debt didn't move, and nothing said why).
    const pending = await pendingSettlementFor(userId);
    res.json({
      success: true,
      data: {
        date: startUtc.toISOString(), orderCount: orders.length, totalCollected,
        unsettledCash: unsettled.amount, unsettledOrderCount: unsettled.orderCount, lastSettledAt: unsettled.lastSettledAt,
        pendingSettlementAmount: pending ? Number(pending.amount) : 0,
        pendingSettlementAt: pending?.settledAt ?? null,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

/** The rider's open (declared-but-unacknowledged) handover, if any. */
export async function pendingSettlementFor(userId: string) {
  return prisma.cashSettlement.findFirst({
    where: { deliveryBoyId: userId, status: "PENDING" },
    orderBy: { settledAt: "desc" },
    select: { id: true, amount: true, orderCount: true, settledAt: true },
  });
}

// ─── POST /api/app/delivery/cash-settle — rider DECLARES a cash handover ─
// Creates a PENDING settlement; the owner confirms receipt separately
// (POST /api/app/owner/delivery-agents/settlements/:id/confirm), and only that clears the debt.
// Amount is recomputed server-side — a client-sent figure is never trusted.
router.post("/cash-settle", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null;

    // One open declaration at a time, or the owner's queue fills with duplicates of the same money
    // and confirming one of them silently "settles" a figure computed at a different moment.
    const alreadyPending = await pendingSettlementFor(userId);
    if (alreadyPending) {
      throw new ValidationError(
        `You've already handed over ₹${Math.round(Number(alreadyPending.amount))} — waiting for the store to confirm it.`,
      );
    }

    const unsettled = await computeUnsettledCash(userId);
    if (unsettled.orderCount === 0) throw new ValidationError("Nothing to settle — no unsettled COD cash.");

    const settlement = await prisma.cashSettlement.create({
      data: {
        deliveryBoyId: userId,
        amount: unsettled.amount,
        orderCount: unsettled.orderCount,
        note,
        status: "PENDING",
      },
    });
    notifyCashSettlementDeclared(userId, Number(settlement.amount)).catch((e: unknown) =>
      console.error("[background task failed]", e),
    );
    res.json({
      success: true,
      data: {
        id: settlement.id,
        amount: Number(settlement.amount),
        orderCount: settlement.orderCount,
        settledAt: settlement.settledAt,
        status: settlement.status,
      },
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
          runDeliveredHooks(o);
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
    res.json({ success: true, data: await signOrderMedia(order) });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Cash-in-hand cap. A rider carrying more un-handed-over COD than the store allows can't take on
 * another COD order until they hand it over AND the owner confirms it.
 *
 * ⚠️ Reads the CONFIRMED figure (computeUnsettledCash), so a rider cannot unblock themselves by
 * declaring a settlement — that would make the cap self-service and therefore not a cap.
 * StoreConfig.maxRiderCashInHand = 0 means unenforced, which is the default: this must not start
 * refusing work at any existing store the moment it deploys.
 */
async function assertCashCapOk(userId: string, order: { paymentMethod: string; totalAmount: unknown; amountPaid: unknown }) {
  if (order.paymentMethod !== "COD") return; // prepaid carries no cash
  const config = await prisma.storeConfig.findFirst({ select: { maxRiderCashInHand: true } });
  const cap = Number(config?.maxRiderCashInHand ?? 0);
  if (cap <= 0) return;

  const held = (await computeUnsettledCash(userId)).amount;
  const incoming = Math.max(0, Number(order.totalAmount) - Number(order.amountPaid));
  if (held + incoming > cap) {
    throw new ValidationError(
      `You're holding Rs.${Math.round(held)} of the store's cash (limit Rs.${Math.round(cap)}). ` +
        "Hand it over and get it confirmed before taking another cash order.",
    );
  }
}

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

// ─── POST /api/app/delivery/orders/:id/accept — claim the job (NOT "on the way") ───
//
// ⚠️ Accept used to flip straight to OUT_FOR_DELIVERY. That was a lie about where the goods are:
// the rider taps Accept while still riding TO the shop, so the customer got an "out for delivery"
// push (and the handover code) for a bag nobody had picked up yet. Accept now only CLAIMS the order
// — status stays PACKED — and POST /:id/picked-up is what puts it on the road.

router.post("/:id/accept", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw new NotFoundError("Order", req.params.id!);
    if (order.status !== "PACKED") throw new ValidationError("Can only accept orders in PACKED status");

    await assertCashCapOk(userId, order);

    // Assigned to someone else → hands off. Unassigned (shared pool) → claim it atomically.
    if (order.deliveryBoyId && order.deliveryBoyId !== userId) {
      throw new AppError(403, "FORBIDDEN", "This order was already taken by another delivery partner");
    }
    if (!order.deliveryBoyId) {
      const claimed = await claimForAgent(order.id, userId);
      if (!claimed) throw new ValidationError("This order was just taken by another delivery partner");
    }

    res.json({ success: true, data: { orderId: order.id, status: "PACKED", claimed: true } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/delivery/orders/:id/picked-up — goods in the bag, now on the road ───
// The second half of the old /accept. Only from here does the order become OUT_FOR_DELIVERY, so
// the customer's "on the way" push and their handover code appear when they're actually true.
// Multi-seller orders reach OUT_FOR_DELIVERY through /collect/:subOrderId instead (last stop
// auto-advances), so this refuses while any shop is still uncollected.

router.post("/:id/picked-up", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const isOwner = req.appUser!.role === "OWNER";
    const orderId = String(req.params.id ?? "");

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundError("Order", orderId);
    if (!isOwner && order.deliveryBoyId !== userId) {
      throw new AppError(403, "FORBIDDEN", "Accept this order first");
    }
    // Idempotent: tapping twice (or a retry after a dropped response) is a no-op success.
    if (order.status === "OUT_FOR_DELIVERY") {
      return res.json({ success: true, data: { orderId: order.id, status: "OUT_FOR_DELIVERY" } });
    }
    if (order.status !== "PACKED") throw new ValidationError(`Cannot start delivery from '${order.status}'`);

    const pending = await prisma.subOrder.findMany({
      where: { orderId: order.id, seller: { isHouse: false }, status: { notIn: ["COLLECTED", "CANCELLED"] } },
      select: { seller: { select: { name: true } } },
    });
    if (pending.length > 0) {
      throw new ValidationError(
        `Collect from ${pending.map((p) => p.seller.name).join(", ")} first — this order has ` +
          `${pending.length} pickup stop${pending.length === 1 ? "" : "s"} still to go.`,
      );
    }

    // House stops sit at the dispatch point; taking the bag IS collecting them.
    await prisma.subOrder.updateMany({
      where: { orderId: order.id, seller: { isHouse: true }, status: { notIn: ["COLLECTED", "CANCELLED"] } },
      data: { status: "COLLECTED", collectedAt: new Date(), collectedById: userId },
    });

    const advanced = await prisma.order.updateMany({
      where: { id: order.id, status: "PACKED" },
      data: { status: "OUT_FOR_DELIVERY" },
    });
    if (advanced.count > 0) {
      notifyOrderStatusChange({ ...order, status: "OUT_FOR_DELIVERY" }).catch((e: unknown) =>
        console.error("[background task failed]", e),
      );
    }

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
      // Starting a collection run is taking the order on, same as /accept — cap applies here too,
      // or a capped rider just routes around it by collecting instead of accepting.
      await assertCashCapOk(userId, order);
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
      notifyOrderStatusChange({ ...order, status: "OUT_FOR_DELIVERY" }).catch((e: unknown) => console.error("[background task failed]", e));
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
    // PACKED is deliberately NOT deliverable by a rider: a delivery order becomes deliverable via
    // /accept (→ OUT_FOR_DELIVERY) and a pickup order via the owner marking READY_FOR_PICKUP.
    // Allowing PACKED let a rider jump straight to DELIVERED, so the customer never saw "out for
    // delivery" and got no such push — their order went from "packed" to "delivered" in one hop.
    // Kept open for the OWNER as the recovery path for an order already stuck at PACKED.
    const deliverable = isOwner
      ? ["OUT_FOR_DELIVERY", "READY_FOR_PICKUP", "PACKED"]
      : ["OUT_FOR_DELIVERY", "READY_FOR_PICKUP"];
    if (!deliverable.includes(order.status)) {
      throw new ValidationError(
        order.status === "PACKED"
          ? "Accept this order first — then you can mark it delivered."
          : `Cannot deliver order in '${order.status}' status`,
      );
    }

    // An order below the OTP threshold completes with no evidence whatsoever that a handover
    // happened — and those are the cheapest, most-disputed orders. When the owner turns this on, a
    // photo stands in for the OTP. Off by default; OTP orders already have their proof.
    if (!order.deliveryOtpRequired && !proofPhotoUrl && !order.deliveryProofPhotoUrl) {
      const config = await prisma.storeConfig.findFirst({ select: { requireDeliveryProofPhoto: true } });
      if (config?.requireDeliveryProofPhoto) {
        throw new ValidationError("Take a photo of the handover before marking this delivered.");
      }
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

    runDeliveredHooks(order);

    res.json({ success: true, data: { orderId: order.id, status: "DELIVERED" } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/delivery/orders/:id/delivery-failed — the drop didn't happen ──
//
// Before this, DELIVERED was the ONLY terminal state a rider could reach. A customer who wasn't home
// left the order pinned at OUT_FOR_DELIVERY forever, so the rider's real options were to mark it
// delivered anyway (which flips COD to PAID, accrues referral commission and fires a tier-up on
// goods nobody received) or leave it hanging. Both are worse than recording the truth.
//
// ⚠️ The order stays ASSIGNED to this rider on purpose — they still physically have the goods.
// Sending it back to the shared pool here would let a second rider "accept" an order sitting in the
// first one's bag. It drops to PACKED so they can re-attempt; the owner unassigns once the stock is
// physically back at the shop (POST /owner/orders/:id/unassign).
const FAILURE_REASONS: Record<string, string> = {
  CUSTOMER_UNAVAILABLE: "Customer not at the address",
  UNREACHABLE: "Customer didn't answer the phone",
  WRONG_ADDRESS: "Address is wrong or not findable",
  CUSTOMER_REFUSED: "Customer refused the order",
  RESCHEDULED: "Customer asked to deliver later",
  OTHER: "Other",
};

const failSchema = z.object({
  reason: z.enum(Object.keys(FAILURE_REASONS) as [string, ...string[]]),
  note: z.string().max(300).optional().nullable(),
  proofPhotoUrl: z.string().max(500).optional().nullable(),
});

router.post("/:id/delivery-failed", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = failSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Pick a reason for the failed delivery", parsed.error.errors);
    const { reason, note, proofPhotoUrl } = parsed.data;

    const userId = req.appUser!.id;
    const isOwner = req.appUser!.role === "OWNER";

    const orderId = String(req.params.id ?? "");
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundError("Order", orderId);
    if (!isOwner && order.deliveryBoyId !== userId) {
      throw new AppError(403, "FORBIDDEN", "Not assigned to you");
    }
    if (order.status === "DELIVERED" || order.status === "CANCELLED") {
      throw new ValidationError(`This order is already ${order.status.toLowerCase()}.`);
    }

    const label = FAILURE_REASONS[reason]!;
    const detail = note?.trim() ? `${label} — ${note.trim()}` : label;

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        // Back to PACKED (still theirs to re-attempt), never DELIVERED and never CANCELLED —
        // cancelling is the owner's call, and it has refund/stock consequences this must not trigger.
        status: "PACKED",
        deliveryAttempts: { increment: 1 },
        lastDeliveryFailure: detail,
        lastDeliveryFailedAt: new Date(),
        deliveryProofPhotoUrl: proofPhotoUrl ?? order.deliveryProofPhotoUrl,
      },
      select: { deliveryAttempts: true },
    });

    const rider = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    notifyDeliveryFailed(order, {
      riderName: rider?.name ?? "Delivery partner",
      reason: detail,
      attempts: updated.deliveryAttempts,
    }).catch((e: unknown) => console.error("[background task failed]", e));

    res.json({
      success: true,
      data: { orderId: order.id, status: "PACKED", attempts: updated.deliveryAttempts, reason: detail },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/delivery/orders/:id/release — hand an order back to the pool ──
// The rider can't do this job after all (breakdown, shift over, wrong area). Only valid while the
// order is still PACKED, i.e. before they've accepted it and physically taken the goods — once it's
// OUT_FOR_DELIVERY the stock is in their bag and /delivery-failed is the honest route instead.
router.post("/:id/release", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const orderId = String(req.params.id ?? "");
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundError("Order", orderId);
    if (order.deliveryBoyId !== userId) throw new AppError(403, "FORBIDDEN", "Not assigned to you");
    if (order.status !== "PACKED") {
      throw new ValidationError(
        "You've already got this order — mark it delivered, or report a failed delivery if you can't hand it over.",
      );
    }
    // A collection run already under way means they're holding some sellers' goods; releasing would
    // strand those items with a rider the order no longer points at.
    const collected = await prisma.subOrder.count({
      where: { orderId: order.id, seller: { isHouse: false }, status: "COLLECTED" },
    });
    if (collected > 0) {
      throw new ValidationError("You've already collected from some shops — report a failed delivery instead so the store knows where the goods are.");
    }

    const released = await prisma.order.updateMany({
      where: { id: order.id, deliveryBoyId: userId, status: "PACKED" },
      data: { deliveryBoyId: null },
    });
    if (released.count > 0) {
      notifyNewDeliveryAvailable({ ...order, deliveryBoyId: null }).catch((e: unknown) =>
        console.error("[background task failed]", e),
      );
    }
    res.json({ success: true, data: { orderId: order.id, released: released.count > 0 } });
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

    notifyDeliveryArrived(order).catch((e: unknown) => console.error("[background task failed]", e));
    res.json({ success: true, data: { orderId: order.id } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
