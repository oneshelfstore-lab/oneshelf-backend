import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { signStoragePath } from "../lib/storageUrls.js";
import { recordCourierEvent, cancelCourierBooking } from "../services/courier.js";
import { assessBooking, FLAG_TEXT } from "../services/courierFlags.js";
import { buildCourierReport } from "../services/courierReport.js";
import { notifyCourierCustomer, notifyCourierRider } from "../services/fcmNotifier.js";

/**
 * The owner's courier board (COURIER_PLAN.md P3): see every booking, read its evidence timeline, and
 * step in — cancel + refund, assign/reassign a rider, re-attempt a failed delivery, or complete a
 * jammed handoff by hand.
 *
 * ⚠️ Every action here is an EVENT with actorType OWNER and a reason, never a silent edit: an
 * administrator changing a booking must leave the same kind of trail a rider does (brief #31-32).
 * The handoff codes are deliberately NOT returned — the owner overrides with a recorded reason, they
 * don't read the customer's code.
 */
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

const ACTIVE = ["SEARCHING", "ASSIGNED", "PICKED_UP"] as const;

function summary(b: any) {
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    speed: b.speed,
    distanceKm: Number(b.distanceKm),
    total: Number(b.total),
    paymentStatus: b.paymentStatus,
    customerName: b.customer?.name ?? "",
    riderId: b.riderId,
    riderName: b.rider?.name ?? null,
    pickupAddress: b.pickupAddress,
    dropAddress: b.dropAddress,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

// ─── GET /?filter=active|attention|all ───────────────────────────────
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const filter = String(req.query.filter ?? "active");
    const where =
      filter === "all" ? {}
      : filter === "attention" ? { status: { in: ["FAILED", "SEARCHING"] as any } }
      : { status: { in: [...ACTIVE] as any } };
    const [rows, active, attention] = await Promise.all([
      prisma.courierBooking.findMany({
        where, orderBy: { createdAt: "desc" }, take: 100,
        include: { customer: { select: { name: true } }, rider: { select: { name: true } } },
      }),
      prisma.courierBooking.count({ where: { status: { in: [...ACTIVE] as any } } }),
      prisma.courierBooking.count({ where: { status: { in: ["FAILED", "SEARCHING"] } } }),
    ]);
    res.json({ success: true, data: { counts: { active, attention }, bookings: rows.map(summary) } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /report?range=today|week|month|all ──────────────────────────
// Declared BEFORE /:id so "report" is never read as a booking id.
const REPORT_ROW_CAP = 5000;

function reportSince(range: string): Date | null {
  const IST = 5.5 * 60 * 60 * 1000;
  if (range === "today") {
    const n = new Date(Date.now() + IST);
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - IST); // IST midnight, as a UTC instant
  }
  if (range === "week") return new Date(Date.now() - 7 * 86_400_000);
  if (range === "month") return new Date(Date.now() - 30 * 86_400_000);
  return null;
}

router.get("/report", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const range = ["today", "week", "month", "all"].includes(String(req.query.range)) ? String(req.query.range) : "week";
    const since = reportSince(range);
    const rows = await prisma.courierBooking.findMany({
      where: since ? { createdAt: { gte: since } } : {},
      select: { status: true, total: true, deliveryFee: true, platformFee: true, createdAt: true, acceptedAt: true, deliveredAt: true, riderId: true, ratingStars: true },
      orderBy: { createdAt: "desc" },
      take: REPORT_ROW_CAP,
    });
    const riderIds = [...new Set(rows.map((r) => r.riderId).filter((x): x is string => !!x))];
    const riders = riderIds.length ? await prisma.user.findMany({ where: { id: { in: riderIds } }, select: { id: true, name: true } }) : [];
    const report = buildCourierReport(
      rows.map((r) => ({ ...r, total: Number(r.total), deliveryFee: Number(r.deliveryFee), platformFee: Number(r.platformFee) })),
      new Map(riders.map((u) => [u.id, u.name])),
    );
    // truncated = the window held more than the cap, so the figures cover the newest REPORT_ROW_CAP only.
    res.json({ success: true, data: { range, truncated: rows.length >= REPORT_ROW_CAP, ...report } });
  } catch (e) {
    sendError(res, e);
  }
});

async function detail(id: string) {
  const b = await prisma.courierBooking.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true, phone: true } },
      rider: { select: { name: true, phone: true } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!b) throw new NotFoundError("Courier booking", id);
  const flags = assessBooking(
    b.events.map((e) => ({ type: e.type, at: e.createdAt, lat: e.lat != null ? Number(e.lat) : null, lng: e.lng != null ? Number(e.lng) : null })),
    Number(b.distanceKm),
  );
  return {
    ...summary(b),
    parcelType: b.parcelType,
    weightBand: b.weightBand,
    declaredValueBand: b.declaredValueBand,
    deliveryFee: Number(b.deliveryFee),
    platformFee: Number(b.platformFee),
    walletApplied: Number(b.walletApplied),
    cancelReason: b.cancelReason,
    ratingStars: b.ratingStars,
    ratingComment: b.ratingComment,
    customerPhone: b.customer?.phone ?? null,
    riderPhone: b.rider?.phone ?? null,
    pickup: { lat: Number(b.pickupLat), lng: Number(b.pickupLng), address: b.pickupAddress, contactName: b.pickupContactName, contactPhone: b.pickupContactPhone },
    drop: { lat: Number(b.dropLat), lng: Number(b.dropLng), address: b.dropAddress, landmark: b.dropLandmark, recipientName: b.recipientName, recipientPhone: b.recipientPhone },
    pickupPhotoUrl: await signStoragePath(b.pickupPhotoPath),
    dropPhotoUrl: await signStoragePath(b.dropPhotoPath),
    flags: flags.map((code) => ({ code, text: FLAG_TEXT[code] })),
    events: b.events.map((e) => ({
      type: e.type, at: e.createdAt, actorType: e.actorType,
      lat: e.lat != null ? Number(e.lat) : null, lng: e.lng != null ? Number(e.lng) : null,
      metadata: e.metadata ?? null,
    })),
  };
}

router.get("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: await detail(String(req.params.id)) });
  } catch (e) {
    sendError(res, e);
  }
});

const reasonSchema = z.object({ reason: z.string().trim().min(3, "Give a short reason").max(200) });

// ─── POST /:id/cancel — cancel + refund from ANY live state (incl. FAILED) ──
router.post("/:id/cancel", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const p = reasonSchema.safeParse(req.body);
    if (!p.success) throw new ValidationError(p.error.errors[0]?.message ?? "Invalid request", p.error.errors);
    const id = String(req.params.id);
    const before = await prisma.courierBooking.findUnique({ where: { id }, select: { riderId: true, status: true, number: true } });
    const r = await cancelCourierBooking(id, {
      actorType: "OWNER", actorId: req.appUser!.id, reason: p.data.reason,
      allowedFrom: ["PENDING_PAYMENT", "SEARCHING", "ASSIGNED", "PICKED_UP", "FAILED"],
    });
    if (r === "NOT_CANCELLABLE") throw new AppError(409, "NOT_CANCELLABLE", "This booking is already delivered or cancelled.");
    // A rider already on (or carrying) it would otherwise only find out when the job vanishes on their next refresh.
    if (before?.riderId && (before.status === "ASSIGNED" || before.status === "PICKED_UP")) {
      notifyCourierRider(before.riderId, {
        bookingId: id,
        title: "Courier booking cancelled",
        body: before.status === "PICKED_UP"
          ? `${before.number} was cancelled by the store. Keep the parcel safe — the store will contact you.`
          : `${before.number} was cancelled by the store. You don't need to collect it.`,
      }).catch((e: unknown) => console.error("[background task failed]", e));
    }
    const b = await prisma.courierBooking.findUnique({ where: { id }, select: { customerId: true, number: true, paymentStatus: true } });
    if (b) {
      notifyCourierCustomer(b.customerId, {
        bookingId: id, number: b.number, title: "Courier cancelled",
        body: p.data.reason + (b.paymentStatus === "PAID" || b.paymentStatus === "REFUND_INITIATED" || b.paymentStatus === "REFUNDED" ? ". You will be refunded in full." : "."),
      }).catch((e: unknown) => console.error("[background task failed]", e));
    }
    res.json({ success: true, data: await detail(id) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/assign — put a chosen rider on it (also the reassign) ──
router.post("/:id/assign", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const p = z.object({ riderId: z.string().min(1) }).safeParse(req.body);
    if (!p.success) throw new ValidationError("Choose a delivery partner", p.error.errors);
    const id = String(req.params.id);
    const rider = await prisma.user.findFirst({ where: { id: p.data.riderId, role: "DELIVERY", isActive: true }, select: { id: true, name: true } });
    if (!rider) throw new ValidationError("That delivery partner isn't available.");
    const busy = await prisma.courierBooking.count({ where: { riderId: rider.id, status: { in: ["ASSIGNED", "PICKED_UP"] }, NOT: { id } } });
    if (busy > 0) throw new ValidationError(`${rider.name} already has a courier parcel in hand.`);

    const prior = await prisma.courierBooking.findUnique({ where: { id }, select: { riderId: true, number: true } });
    const ok = await prisma.$transaction(async (tx) => {
      // Only before pickup: once a rider holds the parcel, swapping who holds it on paper would break the chain of custody.
      const upd = await tx.courierBooking.updateMany({
        where: { id, status: { in: ["SEARCHING", "ASSIGNED"] }, paymentStatus: "PAID" },
        data: { status: "ASSIGNED", riderId: rider.id, acceptedAt: new Date() },
      });
      if (upd.count === 0) return false;
      await recordCourierEvent(tx, { bookingId: id, type: "RIDER_ASSIGNED", actorType: "OWNER", actorId: req.appUser!.id, metadata: { assignedTo: rider.id, byOwner: true } });
      return true;
    });
    if (!ok) throw new ValidationError("Only a paid booking that hasn't been picked up can be assigned.");

    if (prior?.riderId && prior.riderId !== rider.id) {
      notifyCourierRider(prior.riderId, { bookingId: id, title: "Pickup reassigned", body: `${prior.number} was given to another delivery partner. You don't need to collect it.` })
        .catch((e: unknown) => console.error("[background task failed]", e));
    }
    const b = await prisma.courierBooking.findUnique({ where: { id }, select: { customerId: true, number: true } });
    if (b) {
      notifyCourierRider(rider.id, { bookingId: id, title: "Courier pickup assigned", body: `${b.number} has been assigned to you. Open the Courier tab.` })
        .catch((e: unknown) => console.error("[background task failed]", e));
      notifyCourierCustomer(b.customerId, { bookingId: id, number: b.number, title: "Delivery partner assigned", body: `${rider.name} is on the way to pick up your parcel.` })
        .catch((e: unknown) => console.error("[background task failed]", e));
    }
    res.json({ success: true, data: await detail(id) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/reattempt — a FAILED parcel goes back out with the same rider ──
router.post("/:id/reattempt", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const ok = await prisma.$transaction(async (tx) => {
      const upd = await tx.courierBooking.updateMany({ where: { id, status: "FAILED", riderId: { not: null } }, data: { status: "PICKED_UP", cancelReason: null } });
      if (upd.count === 0) return false;
      // A fresh delivery-code attempt budget for the new try.
      await tx.courierSecret.update({ where: { bookingId: id }, data: { deliveryAttempts: 0, deliveryLockedUntil: null } });
      await recordCourierEvent(tx, { bookingId: id, type: "OWNER_REATTEMPT", actorType: "OWNER", actorId: req.appUser!.id });
      return true;
    });
    if (!ok) throw new ValidationError("Only a failed delivery that a rider still holds can be re-attempted.");
    const b = await prisma.courierBooking.findUnique({ where: { id }, select: { riderId: true, number: true } });
    if (b?.riderId) {
      notifyCourierRider(b.riderId, { bookingId: id, title: "Re-attempt delivery", body: `${b.number}: the store asked you to try delivering again.` })
        .catch((e: unknown) => console.error("[background task failed]", e));
    }
    res.json({ success: true, data: await detail(id) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/override — complete a jammed handoff by hand ──────────
router.post("/:id/override", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const p = reasonSchema.extend({ step: z.enum(["PICKUP", "DELIVERY"]) }).safeParse(req.body);
    if (!p.success) throw new ValidationError(p.error.errors[0]?.message ?? "Invalid request", p.error.errors);
    const id = String(req.params.id);
    const from = p.data.step === "PICKUP" ? "ASSIGNED" : "PICKED_UP";
    const to = p.data.step === "PICKUP" ? "PICKED_UP" : "DELIVERED";
    const ok = await prisma.$transaction(async (tx) => {
      const upd = await tx.courierBooking.updateMany({
        where: { id, status: from },
        data: p.data.step === "PICKUP" ? { status: to, pickedUpAt: new Date() } : { status: to, deliveredAt: new Date() },
      });
      if (upd.count === 0) return false;
      await recordCourierEvent(tx, { bookingId: id, type: to, actorType: "OWNER", actorId: req.appUser!.id, metadata: { override: true, reason: p.data.reason } });
      return true;
    });
    if (!ok) throw new ValidationError(p.data.step === "PICKUP" ? "This parcel isn't waiting for pickup." : "This parcel isn't out for delivery.");
    const b = await prisma.courierBooking.findUnique({ where: { id }, select: { customerId: true, number: true } });
    if (b) {
      notifyCourierCustomer(b.customerId, {
        bookingId: id, number: b.number,
        title: to === "DELIVERED" ? "Parcel delivered" : "Parcel picked up",
        body: to === "DELIVERED" ? `${b.number} has been delivered.` : "Your parcel is on its way to the recipient.",
      }).catch((e: unknown) => console.error("[background task failed]", e));
    }
    res.json({ success: true, data: await detail(id) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
